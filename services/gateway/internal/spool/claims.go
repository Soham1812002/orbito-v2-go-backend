package spool

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type retryState struct {
	attempts int
	ready    time.Time
}

func deviceKey(data []byte, fallback string) string {
	var event struct {
		Identifier string `json:"deviceIdentifier"`
	}
	if json.Unmarshal(data, &event) == nil && event.Identifier != "" {
		return event.Identifier
	}
	return fallback
}

// Claim chooses the oldest eligible head of a device queue. A delayed device does not stall others.
func (q *Queue) Claim() (string, []byte, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return "", nil, errors.New("spool closed")
	}
	seen := map[string]bool{}
	for _, name := range q.names {
		key := q.identifiers[name]
		if seen[key] {
			continue
		}
		seen[key] = true
		if q.busy[key] || q.retries[name].ready.After(time.Now()) {
			continue
		}
		q.claimed[name] = true
		q.busy[key] = true
		data, err := os.ReadFile(filepath.Join(q.dir, name))
		return name, data, err
	}
	return "", nil, nil
}
func (q *Queue) release(name string) {
	if q.claimed[name] {
		delete(q.busy, q.identifiers[name])
		delete(q.claimed, name)
	}
	if _, exists := q.sizes[name]; !exists {
		delete(q.identifiers, name)
	}
}
func (q *Queue) Release(name string) { q.mu.Lock(); defer q.mu.Unlock(); q.release(name) }

// Retry delays only this device's queue head. Retry timing resets on process restart; identity does not.
func (q *Queue) Retry(name string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, exists := q.sizes[name]; exists {
		state := q.retries[name]
		state.attempts++
		state.ready = time.Now().Add(time.Duration(1<<min(state.attempts-1, 5)) * time.Second)
		q.retries[name] = state
	}
	q.release(name)
}
