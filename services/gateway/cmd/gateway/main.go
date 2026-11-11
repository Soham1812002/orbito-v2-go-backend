package main

import (
	"context"
	"encoding/json"
	"errors"
	"fleet/gateway/internal/observability"
	"fleet/gateway/internal/spool"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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
	queue            *spool.Queue
	api, secret      string
	client           *http.Client
	allowMarkon      bool
	limits           sessionLimits
	capacityRejected atomic.Uint64
	admittedTotal    atomic.Uint64
	mu               sync.Mutex
	sessions         map[string]net.Conn
	wg               sync.WaitGroup
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func (g *gateway) lookup(ctx context.Context, imei string, trace *observability.Trace) (device, error) {
	lookupCtx, cancel := context.WithTimeout(ctx, g.limits.withDefaults().registryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(lookupCtx, "GET", g.api+"/internal/v1/device-registry?imei="+url.QueryEscape(imei), nil)
	if err != nil {
		return device{}, err
	}
	req.Header.Set("traceparent", trace.Child().Header())
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
	if len(result.Items) != 1 || !result.Items[0].Enabled || result.Items[0].IMEI != imei {
		return device{}, errUnregistered
	}
	return result.Items[0], nil
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		if checkHealth() != nil {
			os.Exit(1)
		}
		return
	}
	observability.Configure()
	slog.Info("Gateway starting", "event", "service.starting")
	secret := os.Getenv("GATEWAY_SECRET")
	if len(secret) < 32 {
		observability.Fatal("service.config.invalid", "GATEWAY_SECRET must contain at least 32 characters")
	}
	api := strings.TrimRight(env("API_URL", "http://localhost:3000"), "/")
	if _, err := url.ParseRequestURI(api); err != nil {
		observability.Fatal("service.start.failed", "Gateway startup operation failed")
	}
	capBytes, err := strconv.ParseInt(env("SPOOL_MAX_BYTES", "1073741824"), 10, 64)
	if err != nil || capBytes < 1048576 {
		observability.Fatal("service.config.invalid", "Invalid spool capacity")
	}
	queue, err := spool.Open(env("SPOOL_DIR", "./data/spool"), capBytes)
	if err != nil {
		observability.Fatal("service.start.failed", "Gateway startup operation failed")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	defer queue.Close()
	limits, err := readSessionLimits()
	if err != nil {
		observability.Fatal("service.config.invalid", "Invalid gateway connection limits")
	}
	g := &gateway{limits: limits, queue: queue, api: api, secret: secret, client: &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{MaxIdleConns: 32, MaxIdleConnsPerHost: 32, MaxConnsPerHost: 32, IdleConnTimeout: 90 * time.Second}}, allowMarkon: os.Getenv("ALLOW_UNVERIFIED_MARKON") == "true", sessions: map[string]net.Conn{}}
	for worker := 0; worker < limits.forwardWorkers; worker++ {
		g.wg.Add(1)
		go func() { defer g.wg.Done(); g.forward(ctx) }()
	}
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
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "spool": queue.Stats(), "admittedFrames": g.admittedTotal.Load(), "capacityRejected": g.capacityRejected.Load()})
	})}
	go func() {
		if err := health.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("health listener failed", "error", err)
			cancel()
		}
	}()
	listeners := []net.Listener{}
	slots := make(chan struct{}, limits.maxConnections)
	for _, spec := range []struct{ addr, family string }{{env("MARKON_ADDR", ":5001"), "MARKON_AIS140"}, {env("CONCOX_ADDR", ":5002"), "CONCOX"}} {
		listener, err := net.Listen("tcp", spec.addr)
		if err != nil {
			observability.Fatal("service.start.failed", "Gateway startup operation failed")
		}
		listeners = append(listeners, listener)
		g.wg.Add(1)
		go func(l net.Listener, family string) {
			defer g.wg.Done()
			for {
				conn, err := l.Accept()
				if err != nil {
					if ctx.Err() == nil {
						slog.Error("Tracker listener failed", "event", "listener.failed", "error", err)
						cancel()
					}
					return
				}
				select {
				case slots <- struct{}{}:
					g.wg.Add(1)
					go func() { defer func() { <-slots }(); g.session(ctx, conn, family) }()
				default:
					g.capacityRejected.Add(1)
					slog.Warn("Connection capacity reached", "event", "session.capacity.rejected", "outcome", "rejected")
					conn.Close()
				}
			}
		}(listener, spec.family)
	}
	<-ctx.Done()
	slog.Info("Gateway stopping", "event", "service.stopping")
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
