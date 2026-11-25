package main

import (
	"testing"
	"time"
)

func TestSessionLimitValidation(t *testing.T) {
	for _, key := range []string{"MAX_CONNECTIONS", "FORWARD_WORKERS", "LOGIN_TIMEOUT", "IDLE_TIMEOUT", "FRAME_TIMEOUT", "REGISTRY_TIMEOUT", "GT06N_UTC_OFFSET_MINUTES"} {
		t.Setenv(key, "")
	}
	l, err := readSessionLimits()
	if err != nil || l.maxConnections != 256 || l.registryTimeout != 3*time.Second {
		t.Fatalf("Bad defaults %+v %v", l, err)
	}
	for _, item := range []struct{ key, value string }{{"FORWARD_WORKERS", "0"}, {"FORWARD_WORKERS", "9"}, {"MAX_CONNECTIONS", "0"}, {"MAX_CONNECTIONS", "4097"}, {"LOGIN_TIMEOUT", "0s"}, {"FRAME_TIMEOUT", "invalid"}, {"REGISTRY_TIMEOUT", "6s"}} {
		t.Run(item.key+item.value, func(t *testing.T) {
			t.Setenv(item.key, item.value)
			if _, err := readSessionLimits(); err == nil {
				t.Fatal("Invalid limit accepted")
			}
		})
	}
}

func TestGT06NOffsetConfiguration(t *testing.T) {
	t.Setenv("GT06N_UTC_OFFSET_MINUTES", "")
	l, err := readSessionLimits()
	if err != nil || l.gt06nUTCOffsetMinutes != nil {
		t.Fatal("Default offset must remain unknown")
	}
	for _, value := range []string{"-720", "0", "330", "840"} {
		t.Setenv("GT06N_UTC_OFFSET_MINUTES", value)
		l, err = readSessionLimits()
		if err != nil || l.gt06nUTCOffsetMinutes == nil {
			t.Fatal("Valid offset rejected")
		}
	}
	for _, value := range []string{"UTC", "5.5", "-721", "841"} {
		t.Setenv("GT06N_UTC_OFFSET_MINUTES", value)
		if _, err := readSessionLimits(); err == nil {
			t.Fatal("Invalid offset accepted")
		}
	}
}
