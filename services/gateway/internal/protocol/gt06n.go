package protocol

import (
	"encoding/binary"
	"fmt"
	"time"
)

const GT06NProfile = "concox-gt06n-v1"

// GT06N implements the supplied PDF's ordinary 7878/01,12,13,16 layouts.
// UTC offset is operator-confirmed configuration, not a fact inferred from this PDF.
func GT06N(raw []byte, identifier, session string, now time.Time, utcOffsetMinutes *int) (Event, []byte, error) {
	e, code, serial, body, err := concoxEnvelope(raw, GT06NProfile, identifier, session, now)
	e.ParserVersion = "gt06n-1"
	if err != nil || e.Validation.DecodeStatus != "DECODED" {
		return e, nil, err
	}
	if raw[0] != 0x78 {
		return Diagnostic(e, "UNSUPPORTED", "GT06N extended envelope not documented"), nil, nil
	}
	var ack []byte
	switch code {
	case 0x01:
		if len(body) != 8 {
			return Diagnostic(e, "MALFORMED", "Unexpected GT06N login body length"), nil, nil
		}
		id, err := DeviceID(body)
		if err != nil {
			return Diagnostic(e, "MALFORMED", err.Error()), nil, nil
		}
		e.Identifier, e.EventType = id, "LOGIN"
		ack = Reply(code, serial, nil)
	case 0x13:
		if len(body) != 5 {
			return Diagnostic(e, "MALFORMED", "Unexpected GT06N heartbeat body length"), nil, nil
		}
		if err := gt06nStatus(&e, body); err != nil {
			return Diagnostic(e, "MALFORMED", err.Error()), nil, nil
		}
		e.EventType = "HEARTBEAT"
		ack = Reply(code, serial, nil)
	case 0x12, 0x16:
		if (code == 0x12 && len(body) != 26 && len(body) != 30) || (code == 0x16 && len(body) != 32) {
			return Diagnostic(e, "UNSUPPORTED", "Unsupported GT06N GPS layout"), nil, nil
		}
		if err := gt06nGPS(&e, body, utcOffsetMinutes); err != nil {
			return Diagnostic(e, "MALFORMED", err.Error()), nil, nil
		}
		lbs := 18
		if code == 0x16 {
			if body[18] != 9 {
				return Diagnostic(e, "UNSUPPORTED", "Unsupported GT06N alarm LBS layout"), nil, nil
			}
			lbs++
			if err := gt06nStatus(&e, body[27:32]); err != nil {
				return Diagnostic(e, "MALFORMED", err.Error()), nil, nil
			}
			e.EventType = "DEVICE_EVENT"
			ack = Reply(code, serial, nil)
		} else {
			e.EventType = "LOCATION"
			course := binary.BigEndian.Uint16(body[16:18])
			if course&0x4000 != 0 {
				e.Status["ignition"] = course&0x8000 != 0
			}
			if len(body) == 30 {
				e.Data["mileageRaw"] = binary.BigEndian.Uint32(body[26:30])
			}
		}
		e.Data["mcc"] = binary.BigEndian.Uint16(body[lbs : lbs+2])
		e.Data["mnc"] = body[lbs+2]
		e.Data["lac"] = binary.BigEndian.Uint16(body[lbs+3 : lbs+5])
		e.Data["cellId"] = uint32(body[lbs+5])<<16 | uint32(body[lbs+6])<<8 | uint32(body[lbs+7])
	default:
		return Diagnostic(e, "UNSUPPORTED", "Packet type not enabled for GT06N"), nil, nil
	}
	return e, ack, nil
}

func gt06nStatus(e *Event, body []byte) error {
	if body[1] > 6 || body[2] > 4 {
		return fmt.Errorf("invalid GT06N battery/GSM level")
	}
	// Only Chinese/English are documented. Retain unknown language codes for
	// inspection; the simple ACK in section5.3.2 is not conditional on language.
	e.Status["ignition"] = body[0]&2 != 0
	e.Status["batteryLevel"] = int(body[1])
	e.Status["gsmLevel"] = int(body[2])
	e.Data["terminalStatusRaw"] = fmt.Sprintf("0x%02X", body[0])
	e.Data["terminalAlarmCode"] = (body[0] >> 3) & 7
	e.Data["alarmCode"] = fmt.Sprintf("0x%02X", body[3])
	e.Data["language"] = body[4]
	e.Data["trackingEnabled"] = body[0]&64 != 0
	e.Data["charging"] = body[0]&4 != 0
	e.Data["oilElectricityCutOff"] = body[0]&128 != 0
	e.Data["defenseActivated"] = body[0]&1 != 0
	if body[4] != 1 && body[4] != 2 {
		e.Validation.Warnings = append(e.Validation.Warnings, "Undocumented GT06N language code retained")
	}
	return nil
}

func gt06nGPS(e *Event, body []byte, offset *int) error {
	calendar, err := binaryTime(body)
	if err != nil {
		return err
	}
	// binaryTime validates calendar fields; its temporary UTC basis is not
	// published as device time until the configured offset has been applied.
	local, _ := time.Parse(time.RFC3339, *calendar)
	e.Data["deviceLocalTimestamp"] = local.Format("2006-01-02T15:04:05")
	if offset == nil {
		e.Data["timestampQuality"] = "UNVERIFIED_TIMEZONE"
		e.Validation.Warnings = append(e.Validation.Warnings, "GT06N UTC offset unverified; device time unavailable")
	} else {
		if *offset < -720 || *offset > 840 {
			return fmt.Errorf("invalid GT06N UTC offset")
		}
		utc := local.Add(-time.Duration(*offset) * time.Minute).Format(time.RFC3339)
		e.DeviceTime = &utc
		e.Data["deviceUtcOffsetMinutes"] = *offset
		e.Data["timestampQuality"] = "CONFIGURED_OFFSET"
	}
	if body[6]>>4 != 12 {
		return fmt.Errorf("unsupported GT06N GPS information length")
	}
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
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 || heading >= 360 {
		return fmt.Errorf("invalid GT06N GPS range")
	}
	speed := float64(body[15])
	e.Location = &Location{Latitude: lat, Longitude: lon, Speed: &speed, Heading: &heading}
	e.Status["gpsValid"] = course&0x1000 != 0
	e.Data["courseStatusRaw"] = fmt.Sprintf("0x%04X", course)
	e.Data["differentialPositioning"] = course&0x2000 != 0
	e.Data["satellites"] = body[6] & 15
	e.Data["historyStatus"] = "NOT_PROVIDED"
	e.Validation.Warnings = append(e.Validation.Warnings, "GT06N packet does not establish live versus historical upload")
	return nil
}
