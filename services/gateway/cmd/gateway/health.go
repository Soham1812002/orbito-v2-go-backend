package main

import (
	"fmt"
	"net"
	"net/http"
	"time"
)

// The scratch image probes readiness using the existing gateway binary, without curl or a shell.
func checkHealth() error {
	host, port, err := net.SplitHostPort(env("CONTROL_ADDR", ":8081"))
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	response, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + net.JoinHostPort(host, port) + "/health/ready")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway not ready")
	}
	return nil
}
