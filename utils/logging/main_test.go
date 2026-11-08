package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRotationAndRetention(t *testing.T) {
	dir := t.TempDir()
	r := &rotatingFile{dir: dir, max: 25, archives: 2, age: 24 * time.Hour}
	for i := 0; i < 8; i++ {
		if err := r.write([]byte("{\"message\":\"hello\"}\n")); err != nil {
			t.Fatal(err)
		}
	}
	r.close()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 4 {
		t.Fatalf("Expected current and two archives: %v %v", entries, err)
	}
	old := filepath.Join(dir, "archive-1.jsonl")
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	next := &rotatingFile{dir: dir, max: 25, archives: 2, age: 24 * time.Hour}
	if err := next.open(); err != nil {
		t.Fatal(err)
	}
	defer next.close()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("Expired archive was retained")
	}
}

func TestFileFailureAndNormalizedOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	r := &rotatingFile{dir: path, max: 100, archives: 2, age: time.Hour}
	if err := r.write([]byte("x")); err == nil {
		t.Fatal("Expected invalid directory failure")
	}
	var fields map[string]any
	if err := json.Unmarshal(normalize([]byte(`{"level":"WARN","msg":"Retry","traceId":"abc"}`), "gateway", "stderr"), &fields); err != nil {
		t.Fatal(err)
	}
	if fields["service"] != "gateway" || fields["level"] != "warn" || fields["traceId"] != "abc" {
		t.Fatal(fields)
	}
}

func TestConcurrentWriterFallsBackAndCanRecover(t *testing.T) {
	dir := t.TempDir()
	first := &rotatingFile{dir: dir, max: 1000, archives: 2, age: time.Hour}
	second := &rotatingFile{dir: dir, max: 1000, archives: 2, age: time.Hour}
	if err := first.write([]byte("first\n")); err != nil {
		t.Fatal(err)
	}
	if err := second.write([]byte("second\n")); err == nil {
		t.Fatal("Two writers acquired the same directory")
	}
	first.close()
	if err := second.write([]byte("recovered\n")); err != nil {
		t.Fatal(err)
	}
	second.close()
}

func TestCaptureBoundsOversizedLinesAndBackpressure(t *testing.T) {
	records, dropped := make(chan record, 1), make(chan struct{}, 1)
	capture(strings.NewReader(strings.Repeat("sensitive", 20000)+"\nsecond\n"), "test", "stderr", records, dropped)
	first := <-records
	if strings.Contains(string(first.data), "sensitive") || !strings.Contains(string(first.data), "logging.oversized") {
		t.Fatal("Oversized data leaked")
	}
	select {
	case <-dropped:
	default:
		t.Fatal("Expected bounded buffer overflow notification")
	}
}
