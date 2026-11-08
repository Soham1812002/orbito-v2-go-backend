package observability

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"os"
	"strings"
)

type Trace struct {
	TraceID string `json:"traceId"`
	SpanID  string `json:"spanId"`
}

func randomID(size int) string {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		panic("trace random source failed")
	}
	return hex.EncodeToString(data)
}

func LegacyTrace(eventID string) *Trace {
	data := sha256.Sum256([]byte("fleet-legacy-trace:" + eventID))
	return &Trace{TraceID: hex.EncodeToString(data[:16]), SpanID: hex.EncodeToString(data[16:24])}
}

func Fatal(event, message string) {
	slog.Log(context.Background(), slog.Level(12), message, "event", event, "outcome", "failure")
	os.Exit(1)
}

func NewTrace() *Trace          { return &Trace{TraceID: randomID(16), SpanID: randomID(8)} }
func (t *Trace) Child() *Trace  { return &Trace{TraceID: t.TraceID, SpanID: randomID(8)} }
func (t *Trace) Header() string { return "00-" + t.TraceID + "-" + t.SpanID + "-01" }

func Configure() {
	level := slog.Level(-8)
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	case "fatal":
		level = slog.Level(12)
	case "silent":
		level = slog.Level(128)
	}
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level, ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
		switch attr.Key {
		case slog.TimeKey:
			attr.Key = "timestamp"
		case slog.LevelKey:
			if attr.Value.Any() == slog.Level(12) {
				attr.Value = slog.StringValue("fatal")
			} else {
				attr.Value = slog.StringValue(strings.ToLower(attr.Value.String()))
			}
		case slog.MessageKey:
			attr.Key = "message"
		case "error":
			return slog.String("errorType", "OperationError")
		case "reason":
			return slog.String("reason", "Operation rejected")
		}
		return attr
	}})
	slog.SetDefault(slog.New(handler).With("service", "gateway", "schemaVersion", 1))
}
