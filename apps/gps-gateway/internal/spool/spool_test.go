package spool

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestQueueSurvivesReopenAndQuarantine(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, 10000)
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Put("event", map[string]string{"eventId": "stable"}); err != nil {
		t.Fatal(err)
	}
	q, err = Open(dir, 10000)
	if err != nil {
		t.Fatal(err)
	}
	name, data, err := q.Next()
	if err != nil || name == "" {
		t.Fatal("lost record", err)
	}
	var parsed map[string]string
	if json.Unmarshal(data, &parsed) != nil || parsed["eventId"] != "stable" {
		t.Fatal("changed identity")
	}
	if err = q.Quarantine(name); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(dir, "quarantine", name)); err != nil {
		t.Fatal(err)
	}
	name, _, err = q.Next()
	if err != nil || name != "" {
		t.Fatal("quarantined record retried")
	}
}
func TestCapacityAndDone(t *testing.T) {
	q, err := Open(t.TempDir(), 50)
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Put("large", string(make([]byte, 100))); err == nil {
		t.Fatal("cap ignored")
	}
	if err = q.Put("small", "ok"); err != nil {
		t.Fatal(err)
	}
	name, _, err := q.Next()
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Done(name); err != nil {
		t.Fatal(err)
	}
	name, _, _ = q.Next()
	if name != "" {
		t.Fatal("record not removed")
	}
}
