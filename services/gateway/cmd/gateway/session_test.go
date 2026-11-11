package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"fleet/gateway/internal/protocol"
	"fleet/gateway/internal/spool"
)

func TestSessionAcceptsUnsupportedFramesAndLimitsConsecutiveCorruption(t *testing.T) {
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[{"imei":"752533678900242","profile":"concox-v29-standard","enabled":true}]}`)
	}))
	defer registry.Close()
	dir := t.TempDir()
	queue, err := spool.Open(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	g := &gateway{queue: queue, api: registry.URL, secret: "test-secret", client: registry.Client(), sessions: map[string]net.Conn{}}
	server, client := net.Pipe()
	defer client.Close()
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	g.wg.Add(1)
	go func() { defer close(done); g.session(ctx, server, "CONCOX") }()
	defer func() {
		client.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("Session failed to stop")
		}
	}()
	send := func(frame []byte) {
		t.Helper()
		if err := client.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
			t.Fatal(err)
		}
		if _, err := client.Write(frame); err != nil {
			t.Fatal(err)
		}
	}
	expectACK := func(expected []byte) {
		t.Helper()
		if err := client.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			t.Fatal(err)
		}
		actual := make([]byte, len(expected))
		if _, err := io.ReadFull(client, actual); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(actual, expected) {
			t.Fatalf("Unexpected ACK: %x", actual)
		}
	}
	login, _ := hex.DecodeString("78781101075253367890024270003201000512790d0a")
	send(login)
	expectACK(protocol.Reply(1, 5, nil))
	information := func(subtype byte, serial uint16) []byte {
		frame := []byte{0x79, 0x79, 0, 8, 0x94, subtype, 4, 159}
		frame = binary.BigEndian.AppendUint16(frame, serial)
		frame = binary.BigEndian.AppendUint16(frame, protocol.CRC(frame[2:]))
		return append(frame, 13, 10)
	}
	// Valid, unsupported subtype06 must not consume a corruption allowance or generate an ACK.
	for i := 0; i < 12; i++ {
		send(information(6, uint16(i+1)))
	}
	heartbeat := protocol.Reply(0x13, 99, []byte{4, 6, 4, 0, 2})
	send(heartbeat)
	expectACK(protocol.Reply(0x13, 99, nil))
	invalid := information(0, 100)
	invalid[len(invalid)-4] ^= 1
	// A valid packet resets the consecutive-corruption streak.
	for batch := 0; batch < 2; batch++ {
		for i := 0; i < 6; i++ {
			send(invalid)
		}
		send(heartbeat)
		expectACK(protocol.Reply(0x13, 99, nil))
	}
	// Sustained corrupt traffic is still bounded and never acknowledged.
	for i := 0; i < 11; i++ {
		send(invalid)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Consecutive corruption did not close session")
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) != 39 {
		t.Fatalf("Unexpected durable diagnostic/admission count: %d %v", len(files), err)
	}
}

func TestReadCloseReasons(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{io.EOF, "peer_eof"},
		{&net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}, "peer_reset"},
		{net.ErrClosed, "server_closed"},
		{os.ErrDeadlineExceeded, "read_timeout"},
		{io.ErrUnexpectedEOF, "read_failed"},
	}
	for _, test := range tests {
		if got := readCloseReason(test.err); got != test.want {
			t.Errorf("Got %s, expected %s", got, test.want)
		}
	}
}

// A Reader may return final bytes together with EOF/reset. The bytes still belong to the stream.
type scriptedConn struct {
	net.Conn
	reads    [][]byte
	terminal error
	writes   bytes.Buffer
}

func (c *scriptedConn) Read(p []byte) (int, error) {
	if len(c.reads) == 0 {
		return 0, c.terminal
	}
	frame := c.reads[0]
	c.reads = c.reads[1:]
	n := copy(p, frame)
	if len(c.reads) == 0 {
		return n, c.terminal
	}
	return n, nil
}
func (c *scriptedConn) Write(p []byte) (int, error)      { return c.writes.Write(p) }
func (c *scriptedConn) SetReadDeadline(time.Time) error  { return nil }
func (c *scriptedConn) SetWriteDeadline(time.Time) error { return nil }
func (c *scriptedConn) Close() error                     { return nil }
func TestSessionProcessesFinalBytesBeforeReadError(t *testing.T) {
	for _, terminal := range []error{io.EOF, &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}} {
		for _, split := range []bool{false, true} {
			t.Run(fmt.Sprintf("%v/split=%v", terminal, split), func(t *testing.T) {
				registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					io.WriteString(w, `{"items":[{"imei":"752533678900242","profile":"concox-v29-standard","enabled":true}]}`)
				}))
				defer registry.Close()
				q, err := spool.Open(t.TempDir(), 1<<20)
				if err != nil {
					t.Fatal(err)
				}
				login, _ := hex.DecodeString("78781101075253367890024270003201000512790d0a")
				heartbeat := protocol.Reply(0x13, 99, []byte{4, 6, 4, 0, 2})
				joined := append(append([]byte{}, login...), heartbeat...)
				reads := [][]byte{joined}
				if split {
					reads = [][]byte{joined[:7], joined[7:]}
				}
				conn := &scriptedConn{reads: reads, terminal: terminal}
				g := &gateway{queue: q, api: registry.URL, client: registry.Client(), sessions: map[string]net.Conn{}}
				g.wg.Add(1)
				g.session(context.Background(), conn, "CONCOX")
				if q.Stats().Pending != 2 {
					t.Fatalf("Lost final complete frame: %+v", q.Stats())
				}
				expected := append(protocol.Reply(1, 5, nil), protocol.Reply(0x13, 99, nil)...)
				if !bytes.Equal(conn.writes.Bytes(), expected) {
					t.Fatal("Final frames not acknowledged exactly once")
				}
			})
		}
	}
}
func TestSessionPartialFinalFrameIsNotAcknowledged(t *testing.T) {
	q, err := spool.Open(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	conn := &scriptedConn{reads: [][]byte{{0x78, 0x78, 17, 1}}, terminal: io.EOF}
	g := &gateway{queue: q, sessions: map[string]net.Conn{}}
	g.wg.Add(1)
	g.session(context.Background(), conn, "CONCOX")
	if q.Stats().Pending != 0 || conn.writes.Len() != 0 {
		t.Fatal("Incomplete frame was admitted")
	}
}
func TestCancellationClosesPreLoginConnection(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	g := &gateway{sessions: map[string]net.Conn{}}
	g.wg.Add(1)
	done := make(chan struct{})
	go func() { g.session(ctx, server, "CONCOX"); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Pre-login connection delayed shutdown")
	}
}
func TestSpoolFullDoesNotAcknowledgeLogin(t *testing.T) {
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"items":[{"imei":"752533678900242","profile":"concox-v29-standard","enabled":true}]}`)
	}))
	defer registry.Close()
	q, err := spool.Open(t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := hex.DecodeString("78781101075253367890024270003201000512790d0a")
	conn := &scriptedConn{reads: [][]byte{raw}, terminal: io.EOF}
	g := &gateway{queue: q, api: registry.URL, client: registry.Client(), sessions: map[string]net.Conn{}}
	g.wg.Add(1)
	g.session(context.Background(), conn, "CONCOX")
	if conn.writes.Len() != 0 || q.Stats().Pending != 0 {
		t.Fatal("Failed admission was acknowledged")
	}
}
