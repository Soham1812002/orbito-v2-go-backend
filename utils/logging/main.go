// logrunner captures a single container process. Each service owns a separate host directory.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func setting(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func number(key string, fallback int) int {
	n, err := strconv.Atoi(setting(key, strconv.Itoa(fallback)))
	if err != nil || n < 1 {
		fmt.Fprintln(os.Stderr, "Invalid positive log setting:", key)
		os.Exit(1)
	}
	return n
}

func normalize(line []byte, service, stream string) []byte {
	fields := map[string]any{}
	if json.Unmarshal(line, &fields) != nil || fields == nil {
		text := string(line)
		level := "info"
		upper := strings.ToUpper(text)
		switch {
		case strings.Contains(upper, "FATAL:") || strings.Contains(upper, "PANIC:") || strings.Contains(upper, "[EMERG]") || strings.Contains(upper, "[CRIT]"):
			level = "fatal"
		case strings.Contains(upper, "ERROR:") || strings.Contains(upper, "[ERROR]"):
			level = "error"
		case strings.Contains(upper, "WARNING:") || strings.Contains(upper, "[WARN]") || strings.Contains(upper, "DETAIL:") || strings.Contains(upper, "CONTEXT:") || strings.Contains(upper, "STATEMENT:") || strings.Contains(upper, "HINT:"):
			level = "warn"
		}
		// Infrastructure failures may embed SQL, URLs or client input. Keep severity without that payload.
		if (service == "database" || service == "proxy") && level != "info" {
			text = "Infrastructure operation reported a failure or warning"
		}
		fields = map[string]any{"message": text, "event": "process.output", "level": level}
	}
	if value, ok := fields["msg"]; ok {
		fields["message"] = value
		delete(fields, "msg")
	}
	if value, ok := fields["time"]; ok {
		fields["timestamp"] = value
		delete(fields, "time")
	}
	if _, ok := fields["timestamp"]; !ok {
		fields["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if value, ok := fields["level"].(string); ok {
		fields["level"] = strings.ToLower(value)
	} else {
		fields["level"] = "info"
	}
	if _, ok := fields["event"]; !ok {
		fields["event"] = "process.output"
	}
	if _, ok := fields["outcome"]; !ok {
		if fields["level"] == "error" || fields["level"] == "fatal" {
			fields["outcome"] = "failure"
		} else {
			fields["outcome"] = "success"
		}
	}
	fields["service"], fields["stream"], fields["schemaVersion"] = service, stream, 1
	fields["environment"] = setting("NODE_ENV", "development")
	data, _ := json.Marshal(fields)
	return append(data, '\n')
}

type record struct{ data []byte }

func capture(reader io.Reader, service, stream string, records chan<- record, dropped chan<- struct{}) {
	readerBuf := bufio.NewReaderSize(reader, 65536)
	for {
		line, prefix, err := readerBuf.ReadLine()
		if len(line) > 0 {
			// Oversized lines are discarded rather than retaining raw payload fragments.
			if prefix {
				for prefix && err == nil {
					_, prefix, err = readerBuf.ReadLine()
				}
				line = []byte(`{"level":"warn","event":"logging.oversized","outcome":"rejected","message":"Oversized process log discarded"}`)
			}
			data := normalize(line, service, stream)
			select {
			case records <- record{data}:
			default:
				select {
				case dropped <- struct{}{}:
				default:
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "logrunner requires a child command")
		os.Exit(1)
	}
	service := setting("SERVICE_NAME", "application")
	files := &rotatingFile{dir: setting("LOG_DIR", "/logs"), max: int64(number("LOG_MAX_BYTES", 10485760)), archives: number("LOG_MAX_FILES", 5), age: time.Duration(number("LOG_RETENTION_DAYS", 7)) * 24 * time.Hour}
	records, dropped := make(chan record, 1024), make(chan struct{}, 1)
	var writer sync.WaitGroup
	writer.Add(1)
	go func() {
		defer writer.Done()
		defer files.close()
		lastFailure := time.Time{}
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			var item record
			select {
			case next, ok := <-records:
				if !ok {
					return
				}
				item = next
			case <-ticker.C:
				if err := files.maintain(); err != nil {
					_, _ = os.Stderr.Write(normalize([]byte(`{"level":"error","event":"logging.retention.failed","outcome":"failure","message":"Host log retention failed"}`), service, "stderr"))
				}
				continue
			}
			_, _ = os.Stdout.Write(item.data)
			if err := files.write(item.data); err != nil && time.Since(lastFailure) > time.Minute {
				// Do not recurse into the failing file sink or expose filesystem errors containing secrets.
				_, _ = os.Stderr.Write(normalize([]byte(`{"level":"error","event":"logging.file.failed","outcome":"failure","message":"Host log write failed; console logging continues"}`), service, "stderr"))
				lastFailure = time.Now()
			}
			select {
			case <-dropped:
				_, _ = os.Stderr.Write(normalize([]byte(`{"level":"warn","event":"logging.buffer.full","outcome":"failure","message":"Log records dropped because the output buffer is full"}`), service, "stderr"))
			default:
			}
		}
	}()
	cmd := exec.Command(os.Args[1], os.Args[2:]...)
	cmd.Stdin = os.Stdin
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		panic(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		panic(err)
	}
	if err = cmd.Start(); err != nil {
		records <- record{normalize([]byte(`{"level":"fatal","event":"process.start.failed","outcome":"failure","message":"Service command could not start"}`), service, "stderr")}
		close(records)
		writer.Wait()
		os.Exit(1)
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case sig := <-signals:
				_ = syscall.Kill(-cmd.Process.Pid, sig.(syscall.Signal))
			case <-done:
				return
			}
		}
	}()
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); capture(stdout, service, "stdout", records, dropped) }()
	go func() { defer readers.Done(); capture(stderr, service, "stderr", records, dropped) }()
	// Drain pipes before Wait closes them. Child shutdown closes its pipe descriptors.
	readers.Wait()
	err = cmd.Wait()
	close(done)
	signal.Stop(signals)
	if err != nil {
		records <- record{normalize([]byte(`{"level":"error","event":"process.exited","outcome":"failure","message":"Service command exited unsuccessfully"}`), service, "stderr")}
	}
	close(records)
	flushed := make(chan struct{})
	go func() { writer.Wait(); close(flushed) }()
	select {
	case <-flushed:
	case <-time.After(5 * time.Second):
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}
}
