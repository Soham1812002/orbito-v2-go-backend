// Package spool is a bounded, fsynced file queue. Acknowledged records survive
// process restart; durability still depends on the host filesystem and disk.
package spool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type Queue struct {
	dir string
	max int64
	mu  sync.Mutex
}

func Open(dir string, max int64) (*Queue, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(dir, "quarantine"), 0700); err != nil {
		return nil, err
	}
	return &Queue{dir: dir, max: max}, nil
}
func (q *Queue) syncDir() error {
	d, err := os.Open(q.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func (q *Queue) usage() (int64, error) {
	var size int64
	err := filepath.WalkDir(q.dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			size += info.Size()
		}
		return nil
	})
	return size, err
}
func (q *Queue) Put(id string, value any) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	size, err := q.usage()
	if err != nil {
		return err
	}
	if size+int64(len(data)) > q.max {
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
	name := fmt.Sprintf("%020d-%s.json", time.Now().UnixNano(), id)
	if err = os.Rename(tmp, filepath.Join(q.dir, name)); err != nil {
		return err
	}
	return q.syncDir()
}
func (q *Queue) Next() (string, []byte, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return "", nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return "", nil, nil
	}
	data, err := os.ReadFile(filepath.Join(q.dir, names[0]))
	return names[0], data, err
}
func (q *Queue) Done(name string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if filepath.Base(name) != name {
		return errors.New("invalid queue filename")
	}
	if err := os.Remove(filepath.Join(q.dir, name)); err != nil {
		return err
	}
	return q.syncDir()
}
func (q *Queue) Quarantine(name string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if filepath.Base(name) != name {
		return errors.New("invalid queue filename")
	}
	if err := os.Rename(filepath.Join(q.dir, name), filepath.Join(q.dir, "quarantine", name)); err != nil {
		return err
	}
	d, err := os.Open(filepath.Join(q.dir, "quarantine"))
	if err != nil {
		return err
	}
	defer d.Close()
	if err = d.Sync(); err != nil {
		return err
	}
	return q.syncDir()
}
func (q *Queue) Healthy() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	size, err := q.usage()
	if err != nil {
		return err
	}
	if size >= q.max*85/100 {
		return errors.New("spool pressure above 85 percent")
	}
	return nil
}
