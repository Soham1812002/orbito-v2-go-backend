package main

import (
	"testing"
	"time"
)

func TestSessionLimitValidation(t *testing.T) {
	for _, key := range []string{"MAX_CONNECTIONS", "FORWARD_WORKERS", "LOGIN_TIMEOUT", "IDLE_TIMEOUT", "FRAME_TIMEOUT", "REGISTRY_TIMEOUT"} {
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
