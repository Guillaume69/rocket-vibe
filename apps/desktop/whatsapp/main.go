// The desktop transport of the engine: JSON lines over the process's private
// pipes. Stdout carries protocol frames only.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

func run(path string, scan *bufio.Scanner) error {
	if !scan.Scan() {
		return fmt.Errorf("missing initialization")
	}
	var init command
	if json.Unmarshal(scan.Bytes(), &init) != nil || init.Type != "start" {
		return fmt.Errorf("invalid initialization")
	}
	key, err := base64.StdEncoding.DecodeString(init.Key)
	init.Key = ""
	if err != nil {
		return err
	}
	defer clear(key)
	encoder := json.NewEncoder(os.Stdout)
	var c *connector
	sink := func(event wire) {
		if encoder.Encode(event) != nil && c != nil {
			c.cancel()
		}
	}
	c, closer, err := open(path, key, sink)
	if err != nil {
		return err
	}
	defer closer()
	go c.connect()
	for scan.Scan() {
		var cmd command
		if json.Unmarshal(scan.Bytes(), &cmd) != nil {
			c.fail("invalid_command")
			continue
		}
		if !c.handle(cmd) {
			return nil
		}
	}
	return scan.Err()
}

func main() {
	state := flag.String("state", "", "private encrypted state path")
	flag.Parse()
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), 1<<20)
	if *state == "" {
		fmt.Fprintln(os.Stderr, "WhatsApp: missing state path")
		os.Exit(2)
	}
	if err := run(*state, scan); err != nil {
		// Errors from the network or database may contain sensitive material.
		_ = json.NewEncoder(os.Stdout).Encode(wire{Type: "error", Code: "connector_start_failed"})
		os.Exit(1)
	}
}
