package spool

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestQueueSurvivesReopenAndQuarantine(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, 10000)
	t.Cleanup(func() {
		if q != nil {
			_ = q.Close()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Put("event", map[string]string{"eventId": "stable"}); err != nil {
		t.Fatal(err)
	}
	_ = q.Close()
	q, err = Open(dir, 10000)
	if err != nil {
		t.Fatal(err)
	}
	name, data, err := peek(q)
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
	name, _, err = peek(q)
	if err != nil || name != "" {
		t.Fatal("quarantined record retried")
	}
}
func TestCapacityAndDone(t *testing.T) {
	q, err := Open(t.TempDir(), 50)
	t.Cleanup(func() {
		if q != nil {
			_ = q.Close()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Put("large", string(make([]byte, 100))); err == nil {
		t.Fatal("cap ignored")
	}
	if err = q.Put("small", "ok"); err != nil {
		t.Fatal(err)
	}
	name, _, err := peek(q)
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Done(name); err != nil {
		t.Fatal(err)
	}
	name, _, _ = peek(q)
	if name != "" {
		t.Fatal("record not removed")
	}
}

func TestIndexRecoveryAndReplayPreserveIdentity(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, 1<<20)
	t.Cleanup(func() {
		if q != nil {
			_ = q.Close()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Put("first", map[string]string{"eventId": "stable"}); err != nil {
		t.Fatal(err)
	}
	name, data, err := peek(q)
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Quarantine(name); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, ".pending-interrupted"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	_ = q.Close()
	q, err = Open(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if q.Stats().Pending != 0 || q.Stats().Quarantined != 2 {
		t.Fatalf("Incorrect recovery: %+v", q.Stats())
	}
	if err = q.Replay("../bad.json"); err == nil {
		t.Fatal("Traversal accepted")
	}
	if err = q.Replay(name); err != nil {
		t.Fatal(err)
	}
	replay, actual, err := peek(q)
	if err != nil || string(actual) != string(data) {
		t.Fatal("Replay changed bytes/identity")
	}
	before := q.Stats().Bytes
	if err = q.Done(replay); err != nil {
		t.Fatal(err)
	}
	if q.Stats().Pending != 0 || q.Stats().Bytes != before-int64(len(data)) {
		t.Fatal("Index accounting mismatch")
	}
}
func TestConcurrentAdmissionsReopenAndDrain(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, 1<<20)
	t.Cleanup(func() {
		if q != nil {
			_ = q.Close()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				if err := q.Put(fmt.Sprintf("%d-%d", i, j), map[string]int{"device": i, "packet": j}); err != nil {
					t.Error(err)
				}
			}
		}(i)
	}
	wg.Wait()
	_ = q.Close()
	q, err = Open(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for {
		n, _, err := peek(q)
		if err != nil {
			t.Fatal(err)
		}
		if n == "" {
			break
		}
		if seen[n] {
			t.Fatal("Duplicate queue record")
		}
		seen[n] = true
		if err = q.Done(n); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 160 || q.Stats().Bytes != 0 {
		t.Fatalf("Missing concurrent records: %d %+v", len(seen), q.Stats())
	}
}

func TestClaimsPreserveDeviceOrderAndDoNotBlockOtherDevices(t *testing.T) {
	q, err := Open(t.TempDir(), 1<<20)
	t.Cleanup(func() {
		if q != nil {
			_ = q.Close()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range []struct{ id, device string }{{"a1", "A"}, {"a2", "A"}, {"b1", "B"}, {"c1", "C"}} {
		if err = q.Put(event.id, map[string]string{"eventId": event.id, "deviceIdentifier": event.device}); err != nil {
			t.Fatal(err)
		}
	}
	a, _, err := q.Claim()
	if err != nil {
		t.Fatal(err)
	}
	b, body, err := q.Claim()
	if err != nil || !strings.Contains(string(body), `"eventId":"b1"`) {
		t.Fatal("Device A overtook its active head", err, string(body))
	}
	q.Retry(a)
	c, body, err := q.Claim()
	if err != nil || !strings.Contains(string(body), `"eventId":"c1"`) {
		t.Fatal("Retry blocked an unrelated device", err, string(body))
	}
	if next, _, _ := q.Claim(); next != "" {
		t.Fatal("Delayed device head was bypassed")
	}
	if err = q.Done(b); err != nil {
		t.Fatal(err)
	}
	q.Release(b)
	if err = q.Done(c); err != nil {
		t.Fatal(err)
	}
	q.Release(c)
	// Advance only the retry clock; packet ordering and identity remain unchanged.
	q.mu.Lock()
	state := q.retries[a]
	state.ready = time.Now().Add(-time.Second)
	q.retries[a] = state
	q.mu.Unlock()
	next, _, _ := q.Claim()
	if next != a {
		t.Fatal("Retry identity changed")
	}
	if err = q.Done(next); err != nil {
		t.Fatal(err)
	}
	q.Release(next)
	next, body, err = q.Claim()
	if err != nil || !strings.Contains(string(body), `"eventId":"a2"`) {
		t.Fatal("Device order changed", err, string(body))
	}
}

func TestQueueHasOneOwnerAndCannotWriteAfterClose(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, 1000)
	t.Cleanup(func() {
		if q != nil {
			_ = q.Close()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if other, err := Open(dir, 1000); err == nil {
		other.Close()
		t.Fatal("Second writer opened the same spool")
	}
	if err = q.Close(); err != nil {
		t.Fatal(err)
	}
	if err = q.Put("closed", map[string]string{"eventId": "closed"}); err == nil {
		t.Fatal("Closed owner wrote without a lock")
	}
	q, err = Open(dir, 1000)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
}

// Tests may inspect a record without leaving a live delivery claim.
func peek(q *Queue) (string, []byte, error) {
	name, data, err := q.Claim()
	if name != "" {
		q.Release(name)
	}
	return name, data, err
}
