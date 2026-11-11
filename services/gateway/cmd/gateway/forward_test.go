package main

import (
	"context"
	"encoding/json"
	"fleet/gateway/internal/spool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestForwardLostResponseAndQuarantine(t *testing.T) {
	dir := t.TempDir()
	q, err := spool.Open(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	const id = "5d3d345e-335a-4b72-854f-9aa33e123456"
	if err = q.Put(id, map[string]string{"eventId": id, "deviceIdentifier": "752533678900242"}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	seen := map[string]bool{}
	reject := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("Missing forwarding credentials")
		}
		var event struct {
			ID string `json:"eventId"`
		}
		if json.NewDecoder(r.Body).Decode(&event) != nil {
			t.Error("Invalid event")
		}
		seen[event.ID] = true
		calls++
		if reject {
			w.WriteHeader(422)
			return
		}
		if calls == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
			return
		}
		io.WriteString(w, `{"eventId":"`+event.ID+`","persisted":true}`)
	}))
	defer server.Close()
	g := &gateway{queue: q, api: server.URL, secret: "test-secret", client: server.Client()}
	name, data, err := q.Claim()
	if err != nil {
		t.Fatal(err)
	}
	if !g.forwardRecord(context.Background(), name, data) || q.Stats().Pending != 1 {
		t.Fatal("Lost response removed an unconfirmed spool record")
	}
	if g.forwardRecord(context.Background(), name, data) || q.Stats().Pending != 0 {
		t.Fatal("Confirmed retry did not drain")
	}
	q.Release(name)
	if calls != 2 || len(seen) != 1 {
		t.Fatal("Retry identity was not stable")
	}
	if err = q.Put(id, map[string]string{"eventId": id}); err != nil {
		t.Fatal(err)
	}
	name, data, err = q.Claim()
	if err != nil {
		t.Fatal(err)
	}
	reject = true
	// A failed filesystem move must remain retryable, not be reported as quarantined.
	if err = os.Remove(filepath.Join(dir, "quarantine")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "quarantine"), []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	if !g.forwardRecord(context.Background(), name, data) || q.Stats().Pending != 1 {
		t.Fatal("Quarantine I/O failure lost the pending record")
	}
	if err = os.Remove(filepath.Join(dir, "quarantine")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(dir, "quarantine"), 0700); err != nil {
		t.Fatal(err)
	}

	if g.forwardRecord(context.Background(), name, data) {
		t.Fatal("Permanent rejection retried forever")
	}
	q.Release(name)
	inventory, err := q.Inventory()
	if err != nil || len(inventory) != 1 || !strings.HasPrefix(inventory[0]["name"].(string), "http_422--") {
		t.Fatalf("Missing durable rejection reason: %+v %v", inventory, err)
	}
	if err = q.Replay(inventory[0]["name"].(string)); err != nil {
		t.Fatal(err)
	}
	replayed, again, err := q.Claim()
	defer q.Release(replayed)
	if err != nil || string(data) != string(again) {
		t.Fatal("Operator replay changed the original event")
	}
}
