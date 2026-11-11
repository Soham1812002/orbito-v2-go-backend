// Package spool is a bounded, fsynced file queue. One process owns its directory.
// Acknowledged records survive process restart; host disk loss is outside this guarantee.
package spool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Queue struct {
	lock        *os.File
	closed      bool
	identifiers map[string]string
	claimed     map[string]bool
	busy        map[string]bool
	retries     map[string]retryState
	dir         string
	max         int64
	mu          sync.Mutex
	names       []string
	sizes       map[string]int64
	bytes       int64
	quarantined int
	lastStamp   int64
}

type Stats struct {
	Pending          int     `json:"pending"`
	Quarantined      int     `json:"quarantined"`
	Bytes            int64   `json:"bytes"`
	Capacity         int64   `json:"capacity"`
	OldestAgeSeconds float64 `json:"oldestAgeSeconds"`
}

func Open(dir string, max int64) (*Queue, error) {
	dir = filepath.Clean(dir)
	if max < 1 {
		return nil, errors.New("invalid spool capacity")
	}
	if err := os.MkdirAll(filepath.Join(dir, "quarantine"), 0700); err != nil {
		return nil, err
	}
	q := &Queue{dir: dir, max: max, sizes: map[string]int64{}, identifiers: map[string]string{}, claimed: map[string]bool{}, busy: map[string]bool{}, retries: map[string]retryState{}}
	lock, err := os.OpenFile(filepath.Join(dir, ".queue.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("spool is already owned by another process")
	}
	q.lock = lock
	opened := false
	defer func() {
		if !opened {
			_ = q.Close()
		}
	}()

	// Recover interrupted writes as quarantined evidence, never as admitted events.
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), ".pending-") {
			if err := os.Rename(filepath.Join(dir, entry.Name()), filepath.Join(dir, "quarantine", entry.Name())); err != nil {
				return nil, err
			}
		}
	}
	if err := syncDirectory(filepath.Join(dir, "quarantine")); err != nil {
		return nil, err
	}
	if err := syncDirectory(dir); err != nil {
		return nil, err
	}
	err = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		q.bytes += info.Size()
		if filepath.Dir(path) == dir && filepath.Ext(entry.Name()) == ".json" {
			q.names = append(q.names, entry.Name())
			q.sizes[entry.Name()] = info.Size()
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			q.identifiers[entry.Name()] = deviceKey(data, entry.Name())
			stamp, _ := strconv.ParseInt(strings.SplitN(entry.Name(), "-", 2)[0], 10, 64)
			if stamp > q.lastStamp {
				q.lastStamp = stamp
			}
		} else if filepath.Dir(path) == filepath.Join(dir, "quarantine") {
			q.quarantined++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(q.names)
	opened = true
	return q, nil
}
func syncDirectory(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func (q *Queue) nextName(id string) string {
	stamp := time.Now().UnixNano()
	if stamp <= q.lastStamp {
		stamp = q.lastStamp + 1
	}
	q.lastStamp = stamp
	return fmt.Sprintf("%020d-%s.json", stamp, id)
}
func (q *Queue) Put(id string, value any) error {
	if id == "" || strings.ContainsAny(id, "/\\") || id == ".." {
		return errors.New("invalid event identifier")
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return errors.New("spool closed")
	}
	if q.bytes+int64(len(data)) > q.max {
		return errors.New("spool capacity exceeded")
	}
	f, err := os.CreateTemp(q.dir, ".pending-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	name := q.nextName(id)
	if err = os.Rename(tmp, filepath.Join(q.dir, name)); err != nil {
		return err
	}
	// Track the renamed file even when directory sync fails: it must not become invisible.
	q.names = append(q.names, name)
	q.sizes[name] = int64(len(data))
	q.identifiers[name] = deviceKey(data, name)
	q.bytes += int64(len(data))
	return syncDirectory(q.dir)
}
func (q *Queue) forget(name string) {
	for i, current := range q.names {
		if current == name {
			if i == 0 {
				q.names = q.names[1:]
			} else {
				q.names = append(q.names[:i], q.names[i+1:]...)
			}
			break
		}
	}
	delete(q.sizes, name)
	delete(q.retries, name)
	if !q.claimed[name] {
		delete(q.identifiers, name)
	}
	if len(q.names) == 0 {
		q.names = nil
	}
}
func validName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && !strings.ContainsAny(name, "/\\")
}
func (q *Queue) Done(name string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return errors.New("spool closed")
	}
	size, ok := q.sizes[name]
	if !validName(name) || !ok {
		return errors.New("unknown queue filename")
	}
	if err := os.Remove(filepath.Join(q.dir, name)); err != nil {
		return err
	}
	q.forget(name)
	q.bytes -= size
	return syncDirectory(q.dir)
}
func (q *Queue) Quarantine(name string, reasons ...string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return errors.New("spool closed")
	}
	if _, ok := q.sizes[name]; !validName(name) || !ok {
		return errors.New("unknown queue filename")
	}
	target := name
	if len(reasons) > 0 {
		reason := reasons[0]
		if len(reason) == 0 || len(reason) > 40 || strings.IndexFunc(reason, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') }) >= 0 {
			return errors.New("invalid quarantine reason")
		}
		target = reason + "--" + name
	}
	if err := os.Rename(filepath.Join(q.dir, name), filepath.Join(q.dir, "quarantine", target)); err != nil {
		return err
	}
	q.forget(name)
	q.quarantined++
	if err := syncDirectory(filepath.Join(q.dir, "quarantine")); err != nil {
		return err
	}
	return syncDirectory(q.dir)
}

func (q *Queue) Stats() Stats {
	q.mu.Lock()
	defer q.mu.Unlock()
	s := Stats{Pending: len(q.names), Quarantined: q.quarantined, Bytes: q.bytes, Capacity: q.max}
	if len(q.names) > 0 {
		stamp, _ := strconv.ParseInt(strings.SplitN(q.names[0], "-", 2)[0], 10, 64)
		if stamp > 0 {
			s.OldestAgeSeconds = max(0, time.Since(time.Unix(0, stamp)).Seconds())
		}
	}
	return s
}
func (q *Queue) Healthy() error {
	s := q.Stats()
	if s.Bytes >= q.max*85/100 {
		return errors.New("spool pressure above 85 percent")
	}
	return nil
}

// Close releases the single-owner lock after sessions and forwarding workers have stopped.
func (q *Queue) Close() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return nil
	}
	q.closed = true
	if q.lock == nil {
		return nil
	}
	return q.lock.Close()
}
