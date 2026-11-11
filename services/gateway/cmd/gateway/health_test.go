package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestImageReadinessProbe(t *testing.T) {
	var status atomic.Int64
	status.Store(503)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health/ready" {
			t.Error("Wrong readiness route")
		}
		w.WriteHeader(int(status.Load()))
	}))
	defer server.Close()
	t.Setenv("CONTROL_ADDR", strings.TrimPrefix(server.URL, "http://"))
	if checkHealth() == nil {
		t.Fatal("Unready gateway was reported healthy")
	}
	status.Store(200)
	if err := checkHealth(); err != nil {
		t.Fatal(err)
	}
}
