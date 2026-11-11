package spool

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Replay moves an operator-selected valid JSON event back into the queue without changing its identity.
// Stop the gateway first: a queue directory has one process owner.
func (q *Queue) Replay(name string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return errors.New("spool closed")
	}
	if !validName(name) || filepath.Ext(name) != ".json" {
		return errors.New("invalid quarantine filename")
	}
	source := filepath.Join(q.dir, "quarantine", name)
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	var event struct {
		EventID string `json:"eventId"`
	}
	if json.Unmarshal(data, &event) != nil || event.EventID == "" || strings.ContainsAny(event.EventID, "/\\") {
		return errors.New("invalid quarantined event")
	}
	target := q.nextName(event.EventID)
	if err := os.Rename(source, filepath.Join(q.dir, target)); err != nil {
		return err
	}
	q.names = append(q.names, target)
	q.sizes[target] = int64(len(data))
	q.identifiers[target] = deviceKey(data, target)
	q.quarantined--
	if err := syncDirectory(q.dir); err != nil {
		return err
	}
	return syncDirectory(filepath.Join(q.dir, "quarantine"))
}

// Inventory is an offline operator view. It never returns raw packet data.
func (q *Queue) Inventory() ([]map[string]any, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	entries, err := os.ReadDir(filepath.Join(q.dir, "quarantine"))
	if err != nil {
		return nil, err
	}
	result := []map[string]any{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		reason := "legacy"
		if parts := strings.SplitN(entry.Name(), "--", 2); len(parts) == 2 {
			reason = parts[0]
		}
		result = append(result, map[string]any{"name": entry.Name(), "reason": reason, "bytes": info.Size()})
	}
	return result, nil
}
