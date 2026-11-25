package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func gt06nVectors(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile("testdata/gt06n.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors map[string]string
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func TestGT06NDocumentVectors(t *testing.T) {
	vectors := gt06nVectors(t)
	zero := 0
	for _, item := range []struct{ name, event, ack string }{
		{"login", "LOGIN", "loginAck"}, {"location", "LOCATION", ""},
		{"heartbeat", "HEARTBEAT", "heartbeatAck"}, {"alarm", "DEVICE_EVENT", "alarmAck"},
	} {
		t.Run(item.name, func(t *testing.T) {
			raw := unhex(t, vectors[item.name])
			e, ack, err := GT06N(raw, "123456789012345", UUID(), time.Now(), &zero)
			if err != nil || e.Validation.DecodeStatus != "DECODED" || e.Validation.Checksum != "VALID" || e.EventType != item.event || e.Profile != GT06NProfile {
				t.Fatalf("Document vector failed: %+v %v", e, err)
			}
			if item.ack == "" {
				if len(ack) != 0 {
					t.Fatal("Invented location ACK")
				}
			} else if !bytes.Equal(ack, unhex(t, vectors[item.ack])) {
				t.Fatalf("Wrong ACK %x", ack)
			}
			if item.name == "login" && (e.Identifier != "123456789012345" || len(e.Data) != 0) {
				t.Fatal("Login invented model/timezone")
			}
			if item.name == "location" {
				if e.DeviceTime == nil || *e.DeviceTime != "2011-08-29T17:46:16Z" || e.Status["ignition"] != nil || e.Status["gpsValid"] != true || e.Historical {
					t.Fatalf("Wrong location: %+v", e)
				}
				if e.Location.Latitude != float64(0x027ac7eb)/1800000 || e.Location.Longitude != float64(0x0c465849)/1800000 || *e.Location.Heading != 143 || e.Data["cellId"] != uint32(0x1fb8) {
					t.Fatal("Coordinate/LBS offsets changed")
				}
			}
			if item.name == "heartbeat" && (e.Location != nil || e.DeviceTime != nil || e.Status["batteryLevel"] != 1 || e.Status["batteryPercent"] != nil || e.Data["charging"] != true) {
				t.Fatal("Heartbeat status misinterpreted")
			}
			if item.name == "alarm" && (e.Data["alarmCode"] != "0x01" || e.Data["terminalAlarmCode"] != byte(4) || e.Status["ignition"] != false || e.Status["batteryLevel"] != 6) {
				t.Fatal("Alarm fields lost")
			}
		})
	}
}

func TestGT06NTimeAndGPSStatus(t *testing.T) {
	raw := unhex(t, gt06nVectors(t)["location"])
	e, _, err := GT06N(raw, "", UUID(), time.Now(), nil)
	if err != nil || e.DeviceTime != nil || e.Data["deviceLocalTimestamp"] != "2011-08-29T17:46:16" || e.Data["timestampQuality"] != "UNVERIFIED_TIMEZONE" || len(e.Validation.Warnings) == 0 {
		t.Fatal("Unknown timezone became canonical time")
	}
	for _, offset := range []int{-720, 0, 330, 840} {
		e, _, _ := GT06N(raw, "", UUID(), time.Now(), &offset)
		want := time.Date(2011, 8, 29, 17, 46, 16, 0, time.UTC).Add(-time.Duration(offset) * time.Minute).Format(time.RFC3339)
		if e.DeviceTime == nil || *e.DeviceTime != want {
			t.Fatal("Wrong offset conversion")
		}
	}
	body := append([]byte{}, raw[4:len(raw)-6]...)
	for _, course := range []uint16{0x1400, 0x5400, 0xd400, 0xf400, 0x1800, 0x0000, 0x1568} {
		binary.BigEndian.PutUint16(body[16:18], course)
		e, ack, _ := GT06N(Reply(0x12, 4, body), "", UUID(), time.Now(), nil)
		if e.Validation.DecodeStatus != "DECODED" || len(ack) != 0 || e.Historical {
			t.Fatal("Valid course/differential flag rejected or interpreted as history")
		}
		if course&0x4000 == 0 {
			if e.Status["ignition"] != nil {
				t.Fatal("Unavailable ACC became OFF")
			}
		} else if e.Status["ignition"] != (course&0x8000 != 0) {
			t.Fatal("ACC validity ignored")
		}
		if (e.Location.Latitude < 0) != (course&0x0400 == 0) || (e.Location.Longitude < 0) != (course&0x0800 != 0) {
			t.Fatal("Wrong hemisphere")
		}
		if course == 0x1568 && *e.Location.Heading != 0 {
			t.Fatal("360 heading not normalized")
		}
	}
	body = binary.BigEndian.AppendUint32(body, 123456)
	e, _, _ = GT06N(Reply(0x12, 5, body), "", UUID(), time.Now(), nil)
	if e.Data["mileageRaw"] != uint32(123456) {
		t.Fatal("Optional mileage lost")
	}
}

func TestGT06NInvalidAndUnsupportedPackets(t *testing.T) {
	v := gt06nVectors(t)
	location := unhex(t, v["location"])
	body := location[4 : len(location)-6]
	cases := [][]byte{unhex(t, v["invalidLocation"]), unhex(t, v["invalidHeartbeat"]),
		Reply(0x01, 1, make([]byte, 12)), Reply(0x01, 1, []byte{0xfa, 0, 0, 0, 0, 0, 0, 0}),
		Reply(0x13, 2, []byte{0, 7, 4, 0, 1}), Reply(0x13, 2, []byte{0, 6, 5, 0, 1}),
		Reply(0x12, 3, body[:25]), Reply(0x22, 3, body), Reply(0x26, 3, make([]byte, 32)),
		Reply(0x23, 3, make([]byte, 6)), informationFrame(0, []byte{4, 159}),
	}
	for _, mutate := range []func([]byte){
		func(b []byte) { b[1] = 13 }, func(b []byte) { b[3] = 24 }, func(b []byte) { b[6] = 0xbf },
		func(b []byte) { binary.BigEndian.PutUint32(b[7:11], 162000001) },
		func(b []byte) { binary.BigEndian.PutUint32(b[11:15], 324000001) },
		func(b []byte) { binary.BigEndian.PutUint16(b[16:18], 0x1569) },
	} {
		b := append([]byte{}, body...)
		mutate(b)
		cases = append(cases, Reply(0x12, 6, b))
	}
	for _, raw := range cases {
		e, ack, err := GT06N(raw, "123456789012345", UUID(), time.Now(), nil)
		if err == nil && e.Validation.DecodeStatus == "DECODED" {
			t.Fatalf("Invalid frame decoded: %x", raw)
		}
		if len(ack) != 0 || e.Location != nil || len(e.Status) != 0 {
			t.Fatalf("Invalid/unsupported frame promoted: %x", raw)
		}
	}
	for _, legacy := range []string{"concox-v29-standard", "concox-v29-eg02", "unknown"} {
		for _, key := range []string{"login", "location", "alarm"} {
			e, ack, _ := Concox(unhex(t, v[key]), legacy, "", UUID(), time.Now())
			if e.Validation.DecodeStatus == "DECODED" || len(ack) != 0 {
				t.Fatalf("GT06N %s crossed profile %s", key, legacy)
			}
		}
	}
}

func TestIdentifyConcoxLoginDoesNotSelectProfile(t *testing.T) {
	v := gt06nVectors(t)
	for _, raw := range [][]byte{unhex(t, v["login"]), Reply(1, 2, unhex(t, "012345678901234570003201"))} {
		id, err := IdentifyConcoxLogin(raw)
		if err != nil || id != "123456789012345" {
			t.Fatal("Login identification failed")
		}
	}
	for _, key := range []string{"location", "heartbeat", "alarm", "invalidLocation", "invalidHeartbeat"} {
		if _, err := IdentifyConcoxLogin(unhex(t, v[key])); err == nil {
			t.Fatal("Non-login identified")
		}
	}
}

func FuzzGT06NDecode(f *testing.F) {
	for _, raw := range []string{"78780d01012345678901234500018cdd0d0a", "78780a134401040001000508450d0a", "78781f120b081d112e10cf027ac7eb0c46584900148f01cc00287d001fb8000380810d0a"} {
		b, _ := hex.DecodeString(raw)
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 16384 {
			return
		}
		e, ack, err := GT06N(raw, "123456789012345", UUID(), time.Now(), nil)
		if err != nil {
			return
		}
		if e.Validation.DecodeStatus != "DECODED" && (len(ack) != 0 || e.Location != nil || len(e.Status) != 0) {
			t.Fatal("Invalid packet promoted")
		}
		if e.DeviceTime != nil {
			t.Fatal("Timezone guessed")
		}
	})
}
