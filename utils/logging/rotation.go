package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type rotatingFile struct {
	dir      string
	max      int64
	archives int
	age      time.Duration
	file     *os.File
	size     int64
	opened   time.Time
	lock     *os.File
}

func (r *rotatingFile) open() error {
	if err := os.MkdirAll(r.dir, 0750); err != nil {
		return err
	}
	if r.lock == nil {
		lock, err := os.OpenFile(filepath.Join(r.dir, ".writer.lock"), os.O_CREATE|os.O_RDWR, 0640)
		if err != nil {
			return err
		}
		if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			lock.Close()
			return err
		}
		r.lock = lock
	}
	// Remove only our numbered archives, never arbitrary files in the mounted directory.
	for i := 1; i <= r.archives; i++ {
		name := filepath.Join(r.dir, fmt.Sprintf("archive-%d.jsonl", i))
		if info, err := os.Stat(name); err == nil && time.Since(info.ModTime()) > r.age {
			if err = os.Remove(name); err != nil {
				return err
			}
		}
	}
	name := filepath.Join(r.dir, "current.jsonl")
	f, err := os.OpenFile(name, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0640)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.file, r.size = f, info.Size()
	r.opened = info.ModTime()
	if r.size > 0 && time.Since(info.ModTime()) > r.age {
		return r.rotate()
	}
	return nil
}

func (r *rotatingFile) rotate() error {
	if r.file != nil {
		if err := r.file.Close(); err != nil {
			return err
		}
		r.file = nil
	}
	for i := r.archives; i >= 1; i-- {
		from := filepath.Join(r.dir, fmt.Sprintf("archive-%d.jsonl", i))
		to := filepath.Join(r.dir, fmt.Sprintf("archive-%d.jsonl", i+1))
		if i == r.archives {
			if err := os.Remove(from); err != nil && !os.IsNotExist(err) {
				return err
			}
		} else if err := os.Rename(from, to); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Rename(filepath.Join(r.dir, "current.jsonl"), filepath.Join(r.dir, "archive-1.jsonl")); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := r.open(); err != nil {
		return err
	}
	r.opened = time.Now()
	return nil
}

func (r *rotatingFile) write(data []byte) error {
	if r.file == nil {
		if err := r.open(); err != nil {
			return err
		}
	}
	if r.size > 0 && (r.size+int64(len(data)) > r.max || time.Since(r.opened) > r.age) {
		if err := r.rotate(); err != nil {
			return err
		}
	}
	n, err := r.file.Write(data)
	r.size += int64(n)
	return err
}

func (r *rotatingFile) maintain() error {
	if r.file == nil {
		return nil
	}
	if r.size > 0 && time.Since(r.opened) > r.age {
		if err := r.rotate(); err != nil {
			return err
		}
	}
	for i := 1; i <= r.archives; i++ {
		name := filepath.Join(r.dir, fmt.Sprintf("archive-%d.jsonl", i))
		if info, err := os.Stat(name); err == nil && time.Since(info.ModTime()) > r.age {
			if err = os.Remove(name); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *rotatingFile) close() {
	if r.file != nil {
		_ = r.file.Sync()
		_ = r.file.Close()
	}
	if r.lock != nil {
		_ = r.lock.Close()
		r.lock = nil
	}
}
