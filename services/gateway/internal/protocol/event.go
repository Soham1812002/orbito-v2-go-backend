package protocol

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type Location struct {
	Latitude  float64  `json:"latitude"`
	Longitude float64  `json:"longitude"`
	Speed     *float64 `json:"speedKph"`
	Heading   *float64 `json:"headingDegrees"`
}
type Validation struct {
	DecodeStatus string   `json:"decodeStatus"`
	Checksum     string   `json:"checksum"`
	Warnings     []string `json:"warnings"`
}
type Source struct {
	Sequence  *string `json:"sequence"`
	RawHash   string  `json:"rawSha256"`
	SessionID string  `json:"sessionId"`
	Raw       string  `json:"raw,omitempty"`
}
type Trace struct {
	TraceID string `json:"traceId"`
	SpanID  string `json:"spanId"`
}

type Event struct {
	Trace         *Trace         `json:"trace,omitempty"`
	SchemaVersion int            `json:"schemaVersion"`
	EventID       string         `json:"eventId"`
	Identifier    string         `json:"deviceIdentifier"`
	Protocol      string         `json:"protocol"`
	Profile       string         `json:"profile"`
	PacketType    string         `json:"packetType"`
	EventType     string         `json:"eventType"`
	DeviceTime    *string        `json:"deviceTimestamp"`
	ReceivedAt    string         `json:"receivedAt"`
	Historical    bool           `json:"historical"`
	Location      *Location      `json:"location"`
	Status        map[string]any `json:"status"`
	Validation    Validation     `json:"validation"`
	Source        Source         `json:"source"`
	Data          map[string]any `json:"protocolData"`
}

func UUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func Base(raw []byte, profile, session string, now time.Time) Event {
	sum := sha256.Sum256(raw)
	return Event{SchemaVersion: 1, EventID: UUID(), Profile: profile, EventType: "DIAGNOSTIC", ReceivedAt: now.UTC().Format(time.RFC3339Nano), Status: map[string]any{}, Data: map[string]any{}, Validation: Validation{DecodeStatus: "DECODED", Checksum: "NOT_PRESENT", Warnings: []string{}}, Source: Source{RawHash: hex.EncodeToString(sum[:]), SessionID: session, Raw: hex.EncodeToString(raw)}}
}
func Diagnostic(e Event, status, warning string) Event {
	e.EventType = "DIAGNOSTIC"
	e.Location = nil
	e.Status = map[string]any{}
	e.Validation.DecodeStatus = status
	e.Validation.Warnings = append(e.Validation.Warnings, warning)
	return e
}
func (e Event) JSON() ([]byte, error) { return json.Marshal(e) }
func ValidIMEI(s string) bool {
	if len(s) != 15 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

var ErrIncomplete = errors.New("incomplete frame")

// Frame consumes one bounded frame; caller retains the unconsumed TCP stream.
func Frame(buf []byte, family string) ([]byte, int, error) {
	if len(buf) == 0 {
		return nil, 0, ErrIncomplete
	}
	if family == "MARKON_AIS140" {
		if buf[0] != '$' {
			return nil, 1, errors.New("invalid ASCII start")
		}
		for i, b := range buf {
			if b == '*' {
				return append([]byte(nil), buf[:i+1]...), i + 1, nil
			}
		}
		if len(buf) > 8192 {
			return nil, len(buf), errors.New("oversized ASCII frame")
		}
		return nil, 0, ErrIncomplete
	}
	if len(buf) < 2 {
		return nil, 0, ErrIncomplete
	}
	width := 1
	if buf[0] == 0x79 && buf[1] == 0x79 {
		width = 2
	} else if buf[0] != 0x78 || buf[1] != 0x78 {
		return nil, 1, errors.New("invalid binary start")
	}
	if len(buf) < 2+width {
		return nil, 0, ErrIncomplete
	}
	length := int(buf[2])
	if width == 2 {
		length = length*256 + int(buf[3])
	}
	total := length + 4 + width
	if length < 5 || total > 8192 {
		return nil, 2, errors.New("invalid binary length")
	}
	if len(buf) < total {
		return nil, 0, ErrIncomplete
	}
	if buf[total-2] != 13 || buf[total-1] != 10 {
		return nil, 2, errors.New("invalid binary stop")
	}
	return append([]byte(nil), buf[:total]...), total, nil
}
