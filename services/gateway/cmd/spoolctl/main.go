// spoolctl inspects or replays quarantine while the gateway is stopped.
package main

import (
	"encoding/json"
	"flag"
	"fleet/gateway/internal/spool"
	"fmt"
	"os"
	"strconv"
)

func main() {
	dir := flag.String("dir", "/spool", "Gateway spool directory (gateway must be stopped)")
	replay := flag.String("replay", "", "Quarantine filename to replay unchanged")
	flag.Parse()
	capacity := int64(1 << 30)
	if configured := os.Getenv("SPOOL_MAX_BYTES"); configured != "" {
		n, err := strconv.ParseInt(configured, 10, 64)
		if err != nil || n < 1 {
			fmt.Fprintln(os.Stderr, "Invalid SPOOL_MAX_BYTES")
			os.Exit(1)
		}
		capacity = n
	}
	q, err := spool.Open(*dir, capacity)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer q.Close()
	if *replay != "" {
		if err = q.Replay(*replay); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	items, err := q.Inventory()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"spool": q.Stats(), "quarantine": items})
}
