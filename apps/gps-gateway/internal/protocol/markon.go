package protocol

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

func numeric(s string) (float64, error) {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("invalid numeric value")
	}
	return v, nil
}
func signed(value, hemisphere string, latitude bool) (float64, error) {
	v, err := numeric(value)
	max := 180.0
	if latitude {
		max = 90
	}
	if err != nil || v < 0 || v > max {
		return 0, fmt.Errorf("invalid coordinate")
	}
	switch hemisphere {
	case "N":
		if !latitude {
			return 0, fmt.Errorf("invalid hemisphere")
		}
	case "S":
		if !latitude {
			return 0, fmt.Errorf("invalid hemisphere")
		}
		v = -v
	case "E":
		if latitude {
			return 0, fmt.Errorf("invalid hemisphere")
		}
	case "W":
		if latitude {
			return 0, fmt.Errorf("invalid hemisphere")
		}
		v = -v
	default:
		return 0, fmt.Errorf("invalid hemisphere")
	}
	return v, nil
}
func Markon(raw []byte, profile, session string, now time.Time) (Event, []byte, error) {
	e := Base(raw, profile, session, now)
	e.Protocol = "MARKON_AIS140"
	e.Source.Raw = string(raw)
	s := strings.TrimSuffix(string(raw), "*")
	fields := strings.Split(s, ",")
	if len(fields) < 2 || fields[0] != "$" {
		return e, nil, fmt.Errorf("unsupported ASCII framing")
	}
	e.PacketType = fields[1]
	fail := func(message string) (Event, []byte, error) { return Diagnostic(e, "MALFORMED", message), nil, nil }
	switch fields[1] {
	case "LGN":
		if len(fields) != 12 {
			return fail("Unexpected LGN field count")
		}
		e.Identifier = fields[4]
		e.EventType = "LOGIN"
		e.Data["vendor"] = fields[2]
		e.Data["registration"] = fields[3]
		e.Data["firmware"] = fields[5]
		e.Data["protocolVersion"] = fields[6]
		e.Data["latitudeRaw"] = fields[7]
		e.Data["latitudeDirection"] = fields[8]
		e.Data["longitudeRaw"] = fields[9]
		e.Data["longitudeDirection"] = fields[10]
		return e, []byte("$LGN" + now.UTC().Format("02012006150405") + "*"), nil
	case "HBT":
		if len(fields) != 13 {
			return fail("Unexpected HBT field count")
		}
		e.Identifier = fields[4]
		e.EventType = "HEARTBEAT"
		battery, err := numeric(fields[5])
		if err != nil || battery < 0 || battery > 100 {
			return fail("Invalid battery percentage")
		}
		e.Status["batteryPercent"] = battery
		e.Data["firmware"] = fields[3]
		e.Data["ignitionOnIntervalSeconds"] = fields[8]
		e.Data["ignitionOffIntervalSeconds"] = fields[9]
		e.Data["digitalInputs"] = fields[10]
		e.Data["lowBatteryThresholdPercent"] = fields[6]
		e.Data["memoryPercent"] = fields[7]
		e.Data["analogInput1"] = fields[11]
		e.Data["analogInput2"] = fields[12]
		return e, []byte("$HBT*"), nil
	case "NRM":
		if len(fields) < 55 {
			return fail("Short NRM layout")
		}
		e.Identifier = fields[7]
		e.Validation.Checksum = "UNVERIFIED"
		e.Validation.Warnings = append(e.Validation.Warnings, "Markon checksum algorithm not supplied")
		if fields[6] != "H" && fields[6] != "L" {
			return fail("Invalid history indicator")
		}
		e.Historical = fields[6] == "H"
		e.Data["packetType"] = fields[4]
		e.Data["alertId"] = fields[5]
		seq := fields[50]
		e.Source.Sequence = &seq
		e.EventType = "LOCATION"
		if fields[4] != "NR" {
			e.EventType = "DEVICE_EVENT"
		}
		timestamp, err := time.ParseInLocation("02012006150405", fields[10]+fields[11], time.UTC)
		if err != nil {
			return fail("Invalid device timestamp")
		}
		ts := timestamp.Format(time.RFC3339)
		e.DeviceTime = &ts
		lat, err := signed(fields[12], fields[13], true)
		if err != nil {
			return fail(err.Error())
		}
		lon, err := signed(fields[14], fields[15], false)
		if err != nil {
			return fail(err.Error())
		}
		speed, err := numeric(fields[16])
		if err != nil || speed < 0 || speed > 550 {
			return fail("Invalid speed")
		}
		heading, err := numeric(fields[17])
		if err != nil || heading < 0 || heading >= 360 {
			return fail("Invalid heading")
		}
		if (fields[9] != "0" && fields[9] != "1") || (fields[23] != "0" && fields[23] != "1") || (fields[24] != "0" && fields[24] != "1") {
			return fail("Invalid fix/ignition/power flag")
		}
		e.Location = &Location{Latitude: lat, Longitude: lon, Speed: &speed, Heading: &heading}
		e.Status["gpsValid"] = fields[9] == "1"
		e.Status["ignition"] = fields[23] == "1"
		e.Status["externalPowerConnected"] = fields[24] == "1"
		e.Data["satellites"] = fields[18]
		e.Data["mainVoltage"] = fields[25]
		e.Data["internalVoltage"] = fields[26]
		e.Data["emergency"] = fields[27]
		e.Data["cover"] = fields[28]
		e.Data["gsmSignal"] = fields[29]
		e.Data["mcc"] = fields[30]
		e.Data["mnc"] = fields[31]
		e.Data["lac"] = fields[32]
		e.Data["cellId"] = fields[33]
		for key, index := range map[string]int{"altitudeMetres": 19, "pdop": 20, "hdop": 21, "mainVoltage": 25, "internalVoltage": 26, "analogInputVoltage": 48, "deltaDistanceMetres": 49} {
			value, parseErr := numeric(fields[index])
			if parseErr != nil {
				return fail("Invalid " + key)
			}
			e.Data[key] = value
		}
		e.Data["operator"] = fields[22]
		e.Data["digitalInputs"] = fields[46]
		e.Data["digitalOutputs"] = fields[47]
		e.Data["extensionFieldCount"] = len(fields) - 51
		neighbors := []map[string]string{}
		for index := 34; index < 46; index += 3 {
			neighbors = append(neighbors, map[string]string{"lac": fields[index], "cellId": fields[index+1], "signal": fields[index+2]})
		}
		e.Data["neighbors"] = neighbors
		return e, nil, nil
	default:
		return Diagnostic(e, "UNSUPPORTED", "Packet type not enabled"), nil, nil
	}
}
