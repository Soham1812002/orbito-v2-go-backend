package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fleet/gateway/internal/observability"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// Forwarding is bounded; spool claims preserve per-device order even during retries.
func (g *gateway) forward(ctx context.Context) {
	for ctx.Err() == nil {
		name, data, err := g.queue.Claim()
		if name == "" {
			if err != nil {
				slog.Error("Spool selection failed", "event", "spool.read.failed", "error", err)
			}
			if !wait(ctx, 100*time.Millisecond) {
				return
			}
			continue
		}
		retry := true
		if err != nil {
			slog.Error("Spool read failed", "event", "spool.read.failed", "error", err)
		} else {
			retry = g.forwardRecord(ctx, name, data)
		}
		if retry {
			g.queue.Retry(name)
		} else {
			g.queue.Release(name)
		}
	}
}
func (g *gateway) forwardRecord(ctx context.Context, name string, data []byte) bool {
	var original struct {
		EventID string               `json:"eventId"`
		Trace   *observability.Trace `json:"trace"`
	}
	if json.Unmarshal(data, &original) != nil || original.EventID == "" {
		slog.Error("Invalid spool record", "event", "spool.invalid", "outcome", "failure")
		return g.quarantine(slog.Default(), name, "invalid_json")
	}
	if original.Trace == nil {
		original.Trace = observability.LegacyTrace(original.EventID)
	}
	trace := original.Trace.Child()
	log := slog.With("traceId", trace.TraceID, "spanId", trace.SpanID, "ingestionEventId", original.EventID)
	request, err := http.NewRequestWithContext(ctx, "POST", g.api+"/internal/v1/events", bytes.NewReader(data))
	if err != nil {
		log.Error("Forward request failed", "event", "packet.forward.retry", "error", err)
		return true
	}
	request.Header.Set("traceparent", trace.Header())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+g.secret)
	log.Debug("Forwarding packet", "event", "packet.forward.started")
	response, err := g.client.Do(request)
	if err != nil {
		log.Warn("Packet forwarding will retry", "event", "packet.forward.retry", "outcome", "retry", "error", err)
		return true
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		var result struct {
			EventID   string `json:"eventId"`
			Persisted bool   `json:"persisted"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result) == nil && result.Persisted && result.EventID == original.EventID {
			if err := g.queue.Done(name); err != nil {
				log.Error("Spool completion failed", "event", "spool.completion.failed", "error", err)
				return true
			}
			log.Info("Backend committed packet", "event", "packet.forward.committed")
			return false
		}
	}
	if response.StatusCode == 400 || response.StatusCode == 409 || response.StatusCode == 422 {
		return g.quarantine(log.With("statusCode", response.StatusCode), name, fmt.Sprintf("http_%d", response.StatusCode))
	}
	log.Warn("Packet forwarding will retry", "event", "packet.forward.retry", "outcome", "retry", "statusCode", response.StatusCode)
	return true
}

func wait(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func (g *gateway) quarantine(log *slog.Logger, name, reason string) bool {
	if err := g.queue.Quarantine(name, reason); err != nil {
		log.Error("Quarantine failed; record remains queued", "event", "spool.quarantine.failed", "outcome", "retry", "error", err)
		return true
	}
	log.Error("Packet quarantined; operator action required", "event", "packet.quarantined", "outcome", "failure", "file", name, "rejectionCode", reason)
	return false
}
