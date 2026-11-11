package main

import (
	"fmt"
	"strconv"
	"time"
)

type sessionLimits struct {
	forwardWorkers                          int
	maxConnections                          int
	loginTimeout, idleTimeout, frameTimeout time.Duration
	registryTimeout                         time.Duration
}

func (l sessionLimits) withDefaults() sessionLimits {
	if l.forwardWorkers == 0 {
		l.forwardWorkers = 4
	}
	if l.maxConnections == 0 {
		l.maxConnections = 256
	}
	if l.registryTimeout == 0 {
		l.registryTimeout = 3 * time.Second
	}
	if l.loginTimeout == 0 {
		l.loginTimeout = 15 * time.Second
	}
	if l.idleTimeout == 0 {
		l.idleTimeout = 180 * time.Second
	}
	if l.frameTimeout == 0 {
		l.frameTimeout = 15 * time.Second
	}
	return l
}

func readSessionLimits() (sessionLimits, error) {
	l := sessionLimits{}.withDefaults()
	n, err := strconv.Atoi(env("MAX_CONNECTIONS", "256"))
	if err != nil || n < 1 || n > 4096 {
		return l, fmt.Errorf("invalid MAX_CONNECTIONS")
	}
	l.maxConnections = n
	workers, err := strconv.Atoi(env("FORWARD_WORKERS", "4"))
	if err != nil || workers < 1 || workers > 8 {
		return l, fmt.Errorf("invalid FORWARD_WORKERS")
	}
	l.forwardWorkers = workers
	for _, item := range []struct {
		key    string
		target *time.Duration
	}{
		{"LOGIN_TIMEOUT", &l.loginTimeout}, {"IDLE_TIMEOUT", &l.idleTimeout}, {"FRAME_TIMEOUT", &l.frameTimeout}, {"REGISTRY_TIMEOUT", &l.registryTimeout},
	} {
		d, err := time.ParseDuration(env(item.key, item.target.String()))
		if err != nil || d < time.Second || d > 24*time.Hour || (item.key == "REGISTRY_TIMEOUT" && d > 5*time.Second) {
			return l, fmt.Errorf("invalid %s", item.key)
		}
		*item.target = d
	}
	return l, nil
}
