package protocol

import (
	"encoding/binary"
	"encoding/hex"
	"testing"
	"time"
)

// Synthetic information frames follow V5_UPDATED pp.26/31. No hardware model is inferred.
func informationFrame(subtype byte, data []byte) []byte {
	body := append([]byte{subtype}, data...)
	frame := []byte{0x79, 0x79, 0, byte(len(body) + 5), 0x94}
	frame = append(frame, body...)
	frame = binary.BigEndian.AppendUint16(frame, 1)
	frame = binary.BigEndian.AppendUint16(frame, CRC(frame[2:]))
	return append(frame, 13, 10)
}

func TestConcoxInformationVoltage(t *testing.T) {
	for _, raw := range []uint16{0, 1183, 65535} {
		data := binary.BigEndian.AppendUint16(nil, raw)
		frame := informationFrame(0, data)
		event, ack, err := Concox(frame, "concox-v29-standard", "", UUID(), time.Now())
		if err != nil || event.EventType != "STATUS" || event.Validation.DecodeStatus != "DECODED" || event.Validation.Checksum != "VALID" {
			t.Fatalf("Voltage decoding failed: %v", err)
		}
		if event.Status["externalPowerVoltage"] != float64(raw)/100 || event.Data["informationType"] != "0x00" {
			t.Fatal("Voltage or subtype mismatch")
		}
		if event.Location != nil || event.DeviceTime != nil || len(ack) != 0 {
			t.Fatal("Information packet invented position, device time or ACK")
		}
	}
}

func TestConcoxUnknownInformationAndInvalidCRC(t *testing.T) {
	for _, frame := range [][]byte{informationFrame(6, []byte{1, 2}), informationFrame(0, []byte{1}), informationFrame(0, []byte{1, 2, 3})} {
		event, ack, err := Concox(frame, "concox-v29-standard", "", UUID(), time.Now())
		if err != nil || event.Validation.DecodeStatus != "UNSUPPORTED" || event.Location != nil || len(event.Status) != 0 || len(ack) != 0 {
			t.Fatal("Unknown information layout was decoded or acknowledged")
		}
	}
	frame := informationFrame(0, []byte{4, 159})
	frame[6] ^= 1
	event, ack, err := Concox(frame, "concox-v29-standard", "", UUID(), time.Now())
	if err != nil || event.Validation.DecodeStatus != "INVALID_CHECKSUM" || len(ack) != 0 || len(event.Status) != 0 {
		t.Fatal("Corrupt voltage was admitted as decoded")
	}
}

func TestCapturedStandardHeartbeatFields(t *testing.T) {
	frame := unhex(t, "78780a130406040002013d98e50d0a")
	event, ack, err := Concox(frame, "concox-v29-standard", "", UUID(), time.Now())
	if err != nil || event.Validation.DecodeStatus != "DECODED" {
		t.Fatal("Captured heartbeat failed")
	}
	if event.Status["ignition"] != false || event.Status["batteryLevel"] != 6 || event.Status["gsmLevel"] != 4 {
		t.Fatal("Captured status mismatch")
	}
	if event.Data["trackingEnabled"] != false || event.Data["charging"] != true || event.Data["terminalStatusRaw"] != "0x04" || event.Data["languageExtendedStatusRaw"] != "0x0002" {
		t.Fatal("Captured flags mismatch")
	}
	if event.Location != nil || string(ack) != string(unhex(t, "78780513013d0bc60d0a")) {
		t.Fatal("Heartbeat invented coordinates or changed ACK")
	}
}

func TestEG02VoltageIsExternal(t *testing.T) {
	frame := unhex(t, "78780b23050f9204000200088a370d0a")
	event, _, err := Concox(frame, "concox-v29-eg02", "", UUID(), time.Now())
	if err != nil || event.Status["externalPowerVoltage"] != 39.86 || event.Status["batteryVoltage"] != nil {
		t.Fatal("EG02 external voltage mislabeled")
	}
	if event.Data["languageExtendedStatusRaw"] != "0x0002" {
		t.Fatal("EG02 status bytes shifted")
	}
}

// V5_UPDATED p.8 uses the same 0..4 GSM strength categories for EG02 heartbeat.
func TestEG02RejectsInvalidGSMLevel(t *testing.T) {
	for _, level := range []byte{5, 31, 255} {
		event, ack, err := Concox(Reply(0x23, 8, []byte{5, 15, 146, level, 0, 2}), "concox-v29-eg02", "", UUID(), time.Now())
		if err != nil || event.Validation.DecodeStatus != "MALFORMED" || len(ack) != 0 || len(event.Status) != 0 {
			t.Fatal("Invalid EG02 GSM level accepted")
		}
	}
}

func TestConcoxDateAndDocumentedLocation(t *testing.T) {
	for _, data := range [][]byte{{26, 1, 1, 24, 0, 0}, {26, 1, 1, 12, 60, 0}, {26, 1, 1, 12, 0, 60}, {26, 2, 30, 12, 0, 0}} {
		if _, err := binaryTime(data); err == nil {
			t.Fatal("Normalized an invalid device timestamp")
		}
	}
	frame := unhex(t, "787822220f0c1d023305c9027ac8180c46586000140001cc00287d001f71000001000820860d0a")
	event, ack, err := Concox(frame, "concox-v29-standard", "", UUID(), time.Now())
	if err != nil || event.Location == nil || event.Validation.DecodeStatus != "DECODED" {
		t.Fatal("Documented location rejected")
	}
	if event.Location.Latitude != float64(41601048)/1800000 || event.Location.Longitude != float64(205936736)/1800000 {
		t.Fatal("Coordinate scaling changed")
	}
	if *event.Location.Speed != 0 || event.Status["gpsValid"] != true || !event.Historical || len(ack) != 0 {
		t.Fatal("Documented location fields or no-ACK rule changed")
	}
	body := append([]byte(nil), frame[4:len(frame)-6]...)
	body = binary.BigEndian.AppendUint32(body, 123456)
	event, _, err = Concox(Reply(0x22, 9, body), "concox-v29-standard", "", UUID(), time.Now())
	if err != nil || event.Data["mileageRaw"] != uint32(123456) {
		t.Fatal("Optional raw mileage lost")
	}
}

func TestDocumentedAlarmAndSupportedVariants(t *testing.T) {
	// V5_UPDATED physical p.17, standard 0x26 alarm example.
	frame := unhex(t, "7878252612030c063816c3026c10540c38c9700144030901cc002866000eee0c06040302000da2db0d0a")
	event, ack, err := Concox(frame, "concox-v29-standard", "", UUID(), time.Now())
	if err != nil || event.Validation.DecodeStatus != "DECODED" || event.Location == nil || event.Data["alarmCode"] != "0x03" || event.Status["batteryLevel"] != 6 || event.Status["gsmLevel"] != 4 {
		t.Fatalf("Bad documented alarm: %v %+v", err, event)
	}
	if string(ack) != string(Reply(0x26, 13, nil)) {
		t.Fatal("Alarm ACK serial/CRC mismatch")
	}
	body := append([]byte{}, frame[4:len(frame)-6]...)
	for _, language := range []byte{0, 1, 2, 3} {
		body[31] = language
		event, ack, err = Concox(Reply(0x26, 14, body), "concox-v29-standard", "", UUID(), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if language == 1 || language == 2 {
			if event.Validation.DecodeStatus != "DECODED" || len(ack) == 0 {
				t.Fatal("Supported alarm rejected")
			}
		} else if event.Location != nil || len(ack) != 0 {
			t.Fatal("Ambiguous alarm acknowledged")
		}
	}
}
func FuzzConcoxDecode(f *testing.F) {
	f.Add([]byte{0x78, 0x78, 5, 0x13, 0, 1, 0, 0, 13, 10})
	for _, sample := range []string{
		"78781101075253367890024270003201000512790d0a",
		"78780a130406040002013d98e50d0a",
		"787822220f0c1d023305c9027ac8180c46586000140001cc00287d001f71000001000820860d0a",
		"7878252612030c063816c3026c10540c38c9700144030901cc002866000eee0c06040302000da2db0d0a",
	} {
		raw, _ := hex.DecodeString(sample)
		f.Add(raw)
	}
	f.Add(informationFrame(0, []byte{4, 159}))

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 16384 {
			return
		}
		frame, _, err := Frame(data, "CONCOX")
		if err != nil {
			return
		}
		for _, profile := range []string{"concox-v29-standard", "concox-v29-eg02"} {
			event, ack, err := Concox(frame, profile, "752533678900242", UUID(), time.Now())
			if err != nil {
				continue
			}
			if event.Validation.DecodeStatus != "DECODED" && (event.Location != nil || len(ack) > 0) {
				t.Fatal("Invalid/unsupported packet promoted")
			}
		}
	})
}
