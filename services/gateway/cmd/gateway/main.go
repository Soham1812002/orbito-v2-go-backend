package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fleet/gateway/internal/protocol"
	"fleet/gateway/internal/spool"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var errUnregistered = errors.New("device not registered or disabled")

type device struct {
	IMEI    string `json:"imei"`
	Profile string `json:"profile"`
	Enabled bool   `json:"enabled"`
}
type gateway struct {
	queue       *spool.Queue
	api, secret string
	client      *http.Client
	allowMarkon bool
	mu          sync.Mutex
	sessions    map[string]net.Conn
	wg          sync.WaitGroup
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func (g *gateway) lookup(ctx context.Context, imei string) (device, error) {
	lookupCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(lookupCtx, "GET", g.api+"/internal/v1/device-registry?imei="+url.QueryEscape(imei), nil)
	if err != nil {
		return device{}, err
	}
	req.Header.Set("Authorization", "Bearer "+g.secret)
	res, err := g.client.Do(req)
	if err != nil {
		return device{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return device{}, fmt.Errorf("registry status %d", res.StatusCode)
	}
	var result struct {
		Items []device `json:"items"`
	}
	if err = json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&result); err != nil {
		return device{}, err
	}
	if len(result.Items) != 1 || !result.Items[0].Enabled {
		return device{}, errUnregistered
	}
	return result.Items[0], nil
}
func (g *gateway) session(ctx context.Context, conn net.Conn, family string) {
	defer g.wg.Done()
	defer conn.Close()
	session := protocol.UUID()
	identifier, profile := "", ""
	registered := device{}
	lastLookup := time.Time{}
	lastConfirmed := time.Time{}
	pending := []byte{}
	scratch := make([]byte, 4096)
	bad := 0
	incompleteSince := time.Time{}
	defer func() {
		if identifier != "" {
			g.mu.Lock()
			if g.sessions[identifier] == conn {
				delete(g.sessions, identifier)
			}
			g.mu.Unlock()
		}
	}()
	for {
		timeout := 180 * time.Second
		if identifier == "" {
			timeout = 15 * time.Second
		}
		if !incompleteSince.IsZero() {
			timeout = 15*time.Second - time.Since(incompleteSince)
			if timeout <= 0 {
				return
			}
		}
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return
		}
		n, err := conn.Read(scratch)
		if err != nil {
			return
		}
		pending = append(pending, scratch[:n]...)
		if len(pending) > 16384 {
			return
		}
		for len(pending) > 0 {
			frame, consumed, err := protocol.Frame(pending, family)
			if errors.Is(err, protocol.ErrIncomplete) {
				if incompleteSince.IsZero() {
					incompleteSince = time.Now()
				}
				break
			}
			if consumed > 0 {
				pending = pending[consumed:]
			}
			if err != nil {
				bad++
				if bad > 10 {
					return
				}
				continue
			}
			incompleteSince = time.Time{}
			now := time.Now()
			var event protocol.Event
			var ack []byte
			if family == "MARKON_AIS140" {
				event, ack, err = protocol.Markon(frame, "markon-v1-diagnostic", session, now)
			} else {
				parseProfile := profile
				if parseProfile == "" {
					parseProfile = "concox-v29-standard"
				}
				event, ack, err = protocol.Concox(frame, parseProfile, identifier, session, now)
			}
			if err != nil {
				bad++
				slog.Warn("packet rejected", "family", family, "reason", err.Error())
				if bad > 10 {
					return
				}
				continue
			}
			if identifier == "" {
				if event.EventType != "LOGIN" || !protocol.ValidIMEI(event.Identifier) {
					return
				}
				registered, err = g.lookup(ctx, event.Identifier)
				if err != nil {
					slog.Warn("device login rejected", "reason", err.Error())
					return
				}
				profile = registered.Profile
				if family == "MARKON_AIS140" && (profile != "markon-v1-diagnostic" || !g.allowMarkon) {
					return
				}
				if family == "CONCOX" && profile != "concox-v29-standard" && profile != "concox-v29-eg02" {
					return
				}
				event.Profile = profile
				g.mu.Lock()
				_, exists := g.sessions[event.Identifier]
				if !exists {
					g.sessions[event.Identifier] = conn
					identifier = event.Identifier
				}
				g.mu.Unlock()
				if exists {
					slog.Warn("duplicate live session rejected")
					return
				}
				lastLookup = now
				lastConfirmed = now
			} else {
				if event.Identifier != "" && event.Identifier != identifier {
					return
				}
				event.Identifier = identifier
				event.Profile = profile
				if now.Sub(lastLookup) > 30*time.Second {
					updated, lookupErr := g.lookup(ctx, identifier)
					lastLookup = now
					if lookupErr != nil {
						if errors.Is(lookupErr, errUnregistered) {
							return
						}
						if now.Sub(lastConfirmed) > 15*time.Minute {
							return
						}
						slog.Warn("registry unavailable; temporarily using session registration")
					} else {
						if !updated.Enabled || updated.Profile != registered.Profile {
							return
						}
						lastConfirmed = now
					}
				}
			}
			if !protocol.ValidIMEI(event.Identifier) {
				return
			}
			if event.Validation.DecodeStatus != "DECODED" {
				bad++
				if bad > 10 {
					return
				}
			}
			if err = g.queue.Put(event.EventID, event); err != nil {
				slog.Error("durable admission failed", "error", err)
				return
			}
			if len(ack) > 0 {
				if err = conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
					return
				}
				if _, err = io.Copy(conn, bytes.NewReader(ack)); err != nil {
					return
				}
			}
			// A session may upload stored history quickly; bound work without one goroutine per packet.
			select {
			case <-ctx.Done():
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
}
func (g *gateway) forward(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		name, data, err := g.queue.Next()
		if err != nil {
			slog.Error("spool read failed", "error", err)
		}
		if err != nil || name == "" {
			if !wait(ctx, time.Second) {
				return
			}
			continue
		}
		req, err := http.NewRequestWithContext(ctx, "POST", g.api+"/internal/v1/events", bytes.NewReader(data))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+g.secret)
		res, err := g.client.Do(req)
		success := false
		permanent := false
		if err == nil {
			var result struct {
				EventID   string `json:"eventId"`
				Persisted bool   `json:"persisted"`
			}
			if res.StatusCode == 200 {
				decodeErr := json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&result)
				var original struct {
					EventID string `json:"eventId"`
				}
				_ = json.Unmarshal(data, &original)
				success = decodeErr == nil && result.Persisted && result.EventID == original.EventID
			}
			permanent = res.StatusCode == 400 || res.StatusCode == 422 || res.StatusCode == 409
			res.Body.Close()
		}
		if success {
			if err = g.queue.Done(name); err != nil {
				slog.Error("spool completion failed", "error", err)
				if !wait(ctx, time.Second) {
					return
				}
			}
			backoff = time.Second
			continue
		}
		if permanent {
			slog.Error("event quarantined; operator action required", "file", name)
			if err = g.queue.Quarantine(name); err != nil {
				slog.Error("quarantine failed", "error", err)
				if !wait(ctx, time.Second) {
					return
				}
			}
			continue
		}
		slog.Warn("event forwarding retry", "error", err)
		if !wait(ctx, backoff+time.Duration(rand.IntN(500))*time.Millisecond) {
			return
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}
func wait(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}
func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	secret := os.Getenv("GATEWAY_SECRET")
	if len(secret) < 32 {
		slog.Error("GATEWAY_SECRET must contain at least 32 characters")
		os.Exit(1)
	}
	api := strings.TrimRight(env("API_URL", "http://localhost:3000"), "/")
	if _, err := url.ParseRequestURI(api); err != nil {
		panic(err)
	}
	capBytes, err := strconv.ParseInt(env("SPOOL_MAX_BYTES", "1073741824"), 10, 64)
	if err != nil || capBytes < 1048576 {
		panic("invalid spool cap")
	}
	queue, err := spool.Open(env("SPOOL_DIR", "./data/spool"), capBytes)
	if err != nil {
		panic(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	g := &gateway{queue: queue, api: api, secret: secret, client: &http.Client{Timeout: 5 * time.Second}, allowMarkon: os.Getenv("ALLOW_UNVERIFIED_MARKON") == "true", sessions: map[string]net.Conn{}}
	g.wg.Add(1)
	go func() { defer g.wg.Done(); g.forward(ctx) }()
	health := &http.Server{Addr: env("CONTROL_ADDR", ":8081"), ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health/live" && r.URL.Path != "/health/ready" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/health/ready" {
			if err := queue.Healthy(); err != nil {
				http.Error(w, "spool pressure", 503)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})}
	go func() {
		if err := health.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("health listener failed", "error", err)
			cancel()
		}
	}()
	listeners := []net.Listener{}
	slots := make(chan struct{}, 256)
	for _, spec := range []struct{ addr, family string }{{env("MARKON_ADDR", ":5001"), "MARKON_AIS140"}, {env("CONCOX_ADDR", ":5002"), "CONCOX"}} {
		listener, err := net.Listen("tcp", spec.addr)
		if err != nil {
			panic(err)
		}
		listeners = append(listeners, listener)
		g.wg.Add(1)
		go func(l net.Listener, family string) {
			defer g.wg.Done()
			for {
				conn, err := l.Accept()
				if err != nil {
					return
				}
				select {
				case slots <- struct{}{}:
					g.wg.Add(1)
					go func() { defer func() { <-slots }(); g.session(ctx, conn, family) }()
				default:
					conn.Close()
				}
			}
		}(listener, spec.family)
	}
	<-ctx.Done()
	for _, listener := range listeners {
		listener.Close()
	}
	g.mu.Lock()
	for _, conn := range g.sessions {
		conn.Close()
	}
	g.mu.Unlock()
	shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	_ = health.Shutdown(shutdownCtx)
	g.wg.Wait()
}
