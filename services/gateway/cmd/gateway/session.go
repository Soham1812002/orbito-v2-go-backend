package main

import (
	"bytes"
	"context"
	"errors"
	"fleet/gateway/internal/observability"
	"fleet/gateway/internal/protocol"
	"io"
	"log/slog"
	"net"
	"syscall"
	"time"
)

func (g *gateway) session(ctx context.Context, conn net.Conn, family string) {
	defer g.wg.Done()
	defer conn.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopClose()
	limits := g.limits.withDefaults()
	session := protocol.UUID()
	sessionLog := slog.With("sessionId", session, "protocol", family)
	sessionLog.Info("Tracker session opened", "event", "session.opened")
	closeReason := "session_ended"
	pending := []byte{}
	admitted := 0
	defer func() {
		sessionLog.Info("Tracker session closed", "event", "session.closed", "closeReason", closeReason, "bufferedBytes", len(pending), "admittedFrames", admitted)
	}()
	identifier, profile := "", ""
	registered := device{}
	lastLookup := time.Time{}
	lastConfirmed := time.Time{}
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
		timeout := limits.idleTimeout
		if identifier == "" {
			timeout = limits.loginTimeout
		}
		if !incompleteSince.IsZero() {
			timeout = limits.frameTimeout - time.Since(incompleteSince)
			if timeout <= 0 {
				closeReason = "incomplete_frame_timeout"
				return
			}
		}
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			closeReason = "deadline_failed"
			return
		}
		n, readErr := conn.Read(scratch)
		pending = append(pending, scratch[:n]...)
		if len(pending) > 16384 {
			closeReason = "buffer_limit"
			return
		}
		for len(pending) > 0 {
			if ctx.Err() != nil {
				closeReason = "server_shutdown"
				return
			}
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
				sessionLog.Warn("Frame rejected", "event", "frame.rejected", "outcome", "rejected", "discardedBytes", consumed)
				if bad > 10 {
					closeReason = "malformed_limit"
					return
				}
				continue
			}
			incompleteSince = time.Time{}
			now := time.Now()
			trace := observability.NewTrace()
			packetLog := sessionLog.With("traceId", trace.TraceID, "spanId", trace.SpanID)
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
				packetLog.Warn("packet rejected", "event", "packet.rejected", "outcome", "rejected", "family", family, "reason", err.Error())
				if bad > 10 {
					closeReason = "malformed_limit"
					return
				}
				continue
			}
			event.Trace = &protocol.Trace{TraceID: trace.TraceID, SpanID: trace.SpanID}
			packetLog = packetLog.With("ingestionEventId", event.EventID, "packetType", event.PacketType, "packetLength", len(frame), "decodeStatus", event.Validation.DecodeStatus, "checksumStatus", event.Validation.Checksum)
			if subtype, ok := event.Data["informationType"]; ok {
				packetLog = packetLog.With("informationType", subtype)
			}
			switch event.Validation.DecodeStatus {
			case "DECODED":
				packetLog.Debug("Packet decoded", "event", "packet.decoded")
			case "UNSUPPORTED":
				packetLog.Info("Unsupported packet decoded as diagnostic", "event", "packet.unsupported", "outcome", "diagnostic")
			default:
				packetLog.Warn("Invalid packet decoded as diagnostic", "event", "packet.invalid", "outcome", "rejected")
			}
			if identifier == "" {
				if event.EventType != "LOGIN" || !protocol.ValidIMEI(event.Identifier) {
					closeReason = "login_required"
					return
				}
				registered, err = g.lookup(ctx, event.Identifier, trace)
				if err != nil {
					packetLog.Warn("device login rejected", "event", "session.login.rejected", "outcome", "rejected", "reason", err.Error())
					closeReason = "registration_rejected"
					return
				}
				profile = registered.Profile
				if family == "MARKON_AIS140" && (profile != "markon-v1-diagnostic" || !g.allowMarkon) {
					closeReason = "profile_mismatch"
					return
				}
				if family == "CONCOX" && profile != "concox-v29-standard" && profile != "concox-v29-eg02" {
					closeReason = "profile_mismatch"
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
					packetLog.Warn("duplicate live session rejected", "event", "session.duplicate", "outcome", "rejected")
					closeReason = "duplicate_session"
					return
				}
				lastLookup = now
				lastConfirmed = now
			} else {
				if event.Identifier != "" && event.Identifier != identifier {
					closeReason = "identity_changed"
					return
				}
				event.Identifier = identifier
				event.Profile = profile
				if now.Sub(lastLookup) > 30*time.Second {
					updated, lookupErr := g.lookup(ctx, identifier, trace)
					lastLookup = now
					if lookupErr != nil {
						if errors.Is(lookupErr, errUnregistered) {
							closeReason = "registration_disabled"
							return
						}
						if now.Sub(lastConfirmed) > 15*time.Minute {
							closeReason = "registration_unavailable"
							return
						}
						packetLog.Warn("registry unavailable; temporarily using session registration", "event", "registry.unavailable", "outcome", "retry")
					} else {
						if !updated.Enabled || updated.Profile != registered.Profile {
							closeReason = "registration_changed"
							return
						}
						lastConfirmed = now
					}
				}
			}
			if !protocol.ValidIMEI(event.Identifier) {
				closeReason = "invalid_identifier"
				return
			}
			if event.Validation.DecodeStatus == "MALFORMED" || event.Validation.DecodeStatus == "INVALID_CHECKSUM" {
				bad++
			} else {
				// Valid unsupported frames are normal protocol traffic, not malformed input.
				bad = 0
			}
			if err = g.queue.Put(event.EventID, event); err != nil {
				packetLog.Error("durable admission failed", "event", "packet.admission.failed", "outcome", "failure", "error", err)
				closeReason = "spool_failed"
				return
			}
			admitted++
			g.admittedTotal.Add(1)
			packetLog.Info("Packet durably admitted", "event", "packet.admitted")
			if bad > 10 {
				closeReason = "malformed_limit"
				return
			}
			if len(ack) > 0 {
				if err = conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
					closeReason = "deadline_failed"
					return
				}
				if _, err = io.Copy(conn, bytes.NewReader(ack)); err != nil {
					packetLog.Warn("ACK write failed", "event", "packet.ack.failed", "outcome", "failure")
					closeReason = "ack_write_failed"
					return
				}
				packetLog.Debug("ACK written to connection", "event", "packet.ack.written")
			}
		}
		// Readers can return both final bytes and an error. Never discard those bytes.
		if readErr != nil {
			closeReason = readCloseReason(readErr)
			if len(pending) > 0 {
				closeReason = "incomplete_frame_closed"
			}
			if ctx.Err() != nil {
				closeReason = "server_shutdown"
			}
			return
		}
	}
}

func readCloseReason(err error) string {
	if errors.Is(err, io.EOF) {
		return "peer_eof"
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return "peer_reset"
	}
	if errors.Is(err, net.ErrClosed) {
		return "server_closed"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "read_timeout"
	}
	return "read_failed"
}
