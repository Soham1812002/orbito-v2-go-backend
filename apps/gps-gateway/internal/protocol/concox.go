package protocol

import (
	"encoding/binary"
	"fmt"
	"strconv"
	"time"
)

// CRC is the supplied PDF appendix algorithm (reflected polynomial 0x8408).
func CRC(data []byte) uint16 {
	crc := uint16(0xffff)
	for _, b := range data {
		crc ^= uint16(b)
		for j := 0; j < 8; j++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0x8408
			} else {
				crc >>= 1
			}
		}
	}
	return ^crc
}
func Reply(code byte, serial uint16, body []byte) []byte {
	p := []byte{0x78, 0x78, byte(len(body) + 5), code}
	p = append(p, body...)
	p = binary.BigEndian.AppendUint16(p, serial)
	p = binary.BigEndian.AppendUint16(p, CRC(p[2:]))
	return append(p, 13, 10)
}
func DeviceID(raw []byte) (string, error) {
	if len(raw) != 8 {
		return "", fmt.Errorf("invalid BCD length")
	}
	s := ""
	for _, b := range raw {
		if b>>4 > 9 || b&15 > 9 {
			return "", fmt.Errorf("invalid BCD digit")
		}
		s += fmt.Sprintf("%02x", b)
	}
	if s[0] != '0' || !ValidIMEI(s[1:]) {
		return "", fmt.Errorf("unsupported terminal identifier padding")
	}
	return s[1:], nil
}
func binaryTime(data []byte) (*string, error) {
	if len(data) < 6 {
		return nil, fmt.Errorf("short timestamp")
	}
	year := 2000 + int(data[0])
	month, day, hour, min, sec := int(data[1]), int(data[2]), int(data[3]), int(data[4]), int(data[5])
	t := time.Date(year, time.Month(month), day, hour, min, sec, 0, time.UTC)
	if int(t.Month()) != month || t.Day() != day || t.Hour() != hour || t.Minute() != min || t.Second() != sec {
		return nil, fmt.Errorf("invalid timestamp")
	}
	s := t.Format(time.RFC3339)
	return &s, nil
}
func Concox(raw []byte, profile, identifier, session string, now time.Time) (Event, []byte, error) {
	e := Base(raw, profile, session, now)
	e.Protocol = "CONCOX"
	e.Identifier = identifier
	if len(raw) < 10 {
		return e, nil, fmt.Errorf("short packet")
	}
	width := 1
	if raw[0] == 0x79 {
		width = 2
	}
	start := 2 + width
	end := len(raw) - 6
	if end < start+1 {
		return e, nil, fmt.Errorf("short body")
	}
	code := raw[start]
	e.PacketType = fmt.Sprintf("0x%02X", code)
	serial := binary.BigEndian.Uint16(raw[len(raw)-6:])
	seq := strconv.Itoa(int(serial))
	e.Source.Sequence = &seq
	if CRC(raw[2:len(raw)-4]) != binary.BigEndian.Uint16(raw[len(raw)-4:]) {
		e.Validation.Checksum = "INVALID"
		return Diagnostic(e, "INVALID_CHECKSUM", "CRC mismatch"), nil, nil
	}
	e.Validation.Checksum = "VALID"
	body := raw[start+1 : end]
	var ack []byte
	switch code {
	case 0x01:
		if len(body) != 12 {
			return Diagnostic(e, "MALFORMED", "Unexpected login body length"), nil, nil
		}
		id, err := DeviceID(body[:8])
		if err != nil {
			return e, nil, err
		}
		e.Identifier = id
		e.EventType = "LOGIN"
		e.Data["modelCode"] = fmt.Sprintf("%04X", binary.BigEndian.Uint16(body[8:10]))
		e.Data["timezoneLanguage"] = fmt.Sprintf("%04X", binary.BigEndian.Uint16(body[10:]))
		ack = Reply(code, serial, nil)
	case 0x13, 0x23:
		expected := 5
		if code == 0x23 {
			expected = 6
		}
		if len(body) != expected || (code == 0x23) != (profile == "concox-v29-eg02") {
			return Diagnostic(e, "MALFORMED", "Heartbeat profile/length mismatch"), nil, nil
		}
		e.EventType = "HEARTBEAT"
		e.Status["ignition"] = body[0]&2 != 0
		e.Data["trackingEnabled"] = body[0]&64 != 0
		e.Data["charging"] = body[0]&4 != 0
		if code == 0x13 {
			if body[1] > 6 || body[2] > 4 {
				return Diagnostic(e, "MALFORMED", "Invalid heartbeat level"), nil, nil
			}
			e.Status["batteryLevel"] = int(body[1])
			e.Status["gsmLevel"] = int(body[2])
		} else {
			e.Status["batteryVoltage"] = float64(binary.BigEndian.Uint16(body[1:3])) / 100
			e.Status["gsmLevel"] = int(body[3])
		}
		ack = Reply(code, serial, nil)
	case 0x22:
		if len(body) != 29 && len(body) != 33 {
			return Diagnostic(e, "UNSUPPORTED", "Unsupported location optional-field layout"), nil, nil
		}
		timestamp, err := binaryTime(body)
		if err != nil {
			return Diagnostic(e, "MALFORMED", err.Error()), nil, nil
		}
		e.DeviceTime = timestamp
		lat := float64(binary.BigEndian.Uint32(body[7:11])) / 1800000
		lon := float64(binary.BigEndian.Uint32(body[11:15])) / 1800000
		course := binary.BigEndian.Uint16(body[16:18])
		if course&0x0400 == 0 {
			lat = -lat
		}
		if course&0x0800 != 0 {
			lon = -lon
		}
		heading := float64(course & 1023)
		if heading == 360 {
			heading = 0
		}
		speed := float64(body[15])
		if lat < -90 || lat > 90 || lon < -180 || lon > 180 || heading >= 360 || body[26] > 1 || body[28] > 1 {
			return Diagnostic(e, "MALFORMED", "Invalid GPS/status range"), nil, nil
		}
		e.EventType = "LOCATION"
		e.Location = &Location{Latitude: lat, Longitude: lon, Speed: &speed, Heading: &heading}
		e.Status["gpsValid"] = course&0x1000 != 0
		e.Status["ignition"] = body[26] == 1
		e.Historical = body[28] == 1
		e.Data["satellites"] = body[6] & 15
		e.Data["mcc"] = binary.BigEndian.Uint16(body[18:20])
		e.Data["mnc"] = body[20]
		e.Data["lac"] = binary.BigEndian.Uint16(body[21:23])
		e.Data["cellId"] = uint32(body[23])<<16 | uint32(body[24])<<8 | uint32(body[25])
		e.Data["uploadMode"] = body[27]
		if len(body) == 33 {
			e.Data["mileageRaw"] = binary.BigEndian.Uint32(body[29:])
		}
	case 0x26:
		if len(body) != 32 && len(body) != 36 {
			return Diagnostic(e, "UNSUPPORTED", "Unsupported alarm optional-field layout"), nil, nil
		}
		if body[31] == 0 {
			return Diagnostic(e, "UNSUPPORTED", "Alarm language zero acknowledgement policy needs confirmation"), nil, nil
		}
		if body[31] != 1 && body[31] != 2 {
			return Diagnostic(e, "MALFORMED", "Invalid alarm language"), nil, nil
		}
		timestamp, err := binaryTime(body)
		if err != nil {
			return Diagnostic(e, "MALFORMED", err.Error()), nil, nil
		}
		e.DeviceTime = timestamp
		lat := float64(binary.BigEndian.Uint32(body[7:11])) / 1800000
		lon := float64(binary.BigEndian.Uint32(body[11:15])) / 1800000
		course := binary.BigEndian.Uint16(body[16:18])
		if course&0x0400 == 0 {
			lat = -lat
		}
		if course&0x0800 != 0 {
			lon = -lon
		}
		heading := float64(course & 1023)
		if heading == 360 {
			heading = 0
		}
		speed := float64(body[15])
		if lat < -90 || lat > 90 || lon < -180 || lon > 180 || heading >= 360 || body[28] > 6 || body[29] > 4 || body[18] != 9 {
			return Diagnostic(e, "MALFORMED", "Invalid alarm field range or LBS layout"), nil, nil
		}
		e.EventType = "DEVICE_EVENT"
		e.Location = &Location{Latitude: lat, Longitude: lon, Speed: &speed, Heading: &heading}
		e.Status["gpsValid"] = course&0x1000 != 0
		e.Status["ignition"] = body[27]&2 != 0
		e.Status["batteryLevel"] = int(body[28])
		e.Status["gsmLevel"] = int(body[29])
		e.Data["alarmCode"] = fmt.Sprintf("0x%02X", body[30])
		e.Data["language"] = body[31]
		e.Data["satellites"] = body[6] & 15
		e.Data["mcc"] = binary.BigEndian.Uint16(body[19:21])
		e.Data["mnc"] = body[21]
		e.Data["lac"] = binary.BigEndian.Uint16(body[22:24])
		e.Data["cellId"] = uint32(body[24])<<16 | uint32(body[25])<<8 | uint32(body[26])
		if len(body) == 36 {
			e.Data["mileageRaw"] = binary.BigEndian.Uint32(body[32:])
		}
		ack = Reply(code, serial, nil)
	default:
		return Diagnostic(e, "UNSUPPORTED", "Packet type not enabled for this profile"), nil, nil
	}
	return e, ack, nil
}
