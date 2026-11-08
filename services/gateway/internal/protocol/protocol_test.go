package protocol

import (
	"bytes"
	"encoding/hex"
	"testing"
	"time"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestLoginAndCRCVector(t *testing.T) {
	raw := unhex(t, "78781101075253367890024270003201000512790d0a")
	e, ack, err := Concox(raw, "concox-v29-standard", "", UUID(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if e.Identifier != "752533678900242" || e.Validation.Checksum != "VALID" {
		t.Fatalf("bad login: %+v", e)
	}
	if !bytes.Equal(ack, unhex(t, "7878050100059ff80d0a")) {
		t.Fatalf("bad ack: %x", ack)
	}
	raw[8] ^= 1
	e, ack, err = Concox(raw, "concox-v29-standard", "", UUID(), time.Now())
	if err != nil || e.Validation.DecodeStatus != "INVALID_CHECKSUM" || len(ack) != 0 {
		t.Fatal("bad CRC acknowledged")
	}
}
func TestStreamAllSplitsAndConcatenation(t *testing.T) {
	raw := Reply(0x13, 8, nil)
	joined := append(append([]byte{}, raw...), raw...)
	for i := 1; i < len(raw); i++ {
		_, _, err := Frame(raw[:i], "CONCOX")
		if err != ErrIncomplete {
			t.Fatalf("split %d: %v", i, err)
		}
	}
	first, n, err := Frame(joined, "CONCOX")
	if err != nil || n != len(raw) || !bytes.Equal(first, raw) {
		t.Fatal("combined framing failed")
	}
	_, n, err = Frame(joined[n:], "CONCOX")
	if err != nil || n != len(raw) {
		t.Fatal("second frame lost")
	}
}
func TestMarkonLoginAndHeartbeat(t *testing.T) {
	now := time.Date(2026, 11, 3, 7, 0, 0, 0, time.UTC)
	e, ack, err := Markon([]byte("$,LGN,MARK,000000000,358980100422519,V0.0.1,AIS140,26.854004,N,75.766891,E,*"), "markon-v1-diagnostic", UUID(), now)
	if err != nil || e.EventType != "LOGIN" || string(ack) != "$LGN03112026070000*" {
		t.Fatalf("bad login %v %+v %s", err, e, ack)
	}
	e, ack, err = Markon([]byte("$,HBT,MARK,V0.0.1,358980100422519,31,20,0,10,10,1010,0.0,0.2*"), "markon-v1-diagnostic", UUID(), now)
	if err != nil || e.EventType != "HEARTBEAT" || e.Location != nil || string(ack) != "$HBT*" {
		t.Fatalf("bad heartbeat: %v %+v", err, e)
	}
}
func TestHemisphereAndRanges(t *testing.T) {
	v, err := signed("23.5", "S", true)
	if err != nil || v != -23.5 {
		t.Fatal(v, err)
	}
	if _, err = signed("181", "W", false); err == nil {
		t.Fatal("invalid longitude accepted")
	}
	if _, err = numeric("NaN"); err == nil {
		t.Fatal("NaN accepted")
	}
}
func FuzzFrame(f *testing.F) {
	f.Add([]byte{0x78, 0x78, 5, 0x13, 0, 1, 0, 0, 13, 10})
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 16384 {
			return
		}
		for _, family := range []string{"CONCOX", "MARKON_AIS140"} {
			_, n, _ := Frame(data, family)
			if n < 0 || n > len(data) {
				t.Fatal("consumed outside buffer")
			}
		}
	})
}
