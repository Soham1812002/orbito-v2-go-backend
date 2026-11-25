package protocol

import (
	"encoding/binary"
	"fmt"
	"strconv"
	"time"
)

// concoxEnvelope checks the complete frame before any model-specific offsets are used.
func concoxEnvelope(raw []byte, profile, identifier, session string, now time.Time) (Event, byte, uint16, []byte, error) {
	e := Base(raw, profile, session, now)
	e.Protocol = "CONCOX"
	e.Identifier = identifier
	_, consumed, err := Frame(raw, "CONCOX")
	if err != nil || consumed != len(raw) {
		return e, 0, 0, nil, fmt.Errorf("invalid Concox envelope")
	}
	start := 3
	if raw[0] == 0x79 {
		start = 4
	}
	code := raw[start]
	e.PacketType = fmt.Sprintf("0x%02X", code)
	serial := binary.BigEndian.Uint16(raw[len(raw)-6:])
	seq := strconv.Itoa(int(serial))
	e.Source.Sequence = &seq
	if CRC(raw[2:len(raw)-4]) != binary.BigEndian.Uint16(raw[len(raw)-4:]) {
		e.Validation.Checksum = "INVALID"
		return Diagnostic(e, "INVALID_CHECKSUM", "CRC mismatch"), code, serial, nil, nil
	}
	e.Validation.Checksum = "VALID"
	return e, code, serial, raw[start+1 : len(raw)-6], nil
}

// IdentifyConcoxLogin extracts only an identifier, never a model or an ACK.
// The caller must look up registration and re-decode using that exact profile.
func IdentifyConcoxLogin(raw []byte) (string, error) {
	e, code, _, body, err := concoxEnvelope(raw, "", "", "", time.Time{})
	if err != nil || e.Validation.Checksum != "VALID" || code != 0x01 || (len(body) != 8 && len(body) != 12) {
		return "", fmt.Errorf("valid Concox login required")
	}
	return DeviceID(body[:8])
}
