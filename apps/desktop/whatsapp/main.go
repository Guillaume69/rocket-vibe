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
	"runtime/debug"
	"sync/atomic"

	"rocketvibe.local/whatsapp/engine"
)

// "rv-whatsapp, whatsmeow <version>", for the packages' checks.
func versions() string {
	whatsmeow := "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "go.mau.fi/whatsmeow" {
				whatsmeow = dep.Version
				if dep.Replace != nil {
					whatsmeow = dep.Replace.Path + " " + dep.Replace.Version
				}
			}
		}
	}
	return "rv-whatsapp, whatsmeow " + whatsmeow
}

// Frames to stdout, one per line; a closed pipe ends the engine's work.
type stdout struct {
	device atomic.Pointer[engine.Device]
}

func (s *stdout) Frame(frame string) {
	if _, err := fmt.Fprintln(os.Stdout, frame); err != nil {
		if d := s.device.Load(); d != nil {
			d.Cancel()
		}
	}
}

func run(path string, scan *bufio.Scanner) error {
	if !scan.Scan() {
		return fmt.Errorf("missing initialization")
	}
	var init struct {
		Type string `json:"type"`
		Key  string `json:"key"`
	}
	if json.Unmarshal(scan.Bytes(), &init) != nil || init.Type != "start" {
		return fmt.Errorf("invalid initialization")
	}
	key, err := base64.StdEncoding.DecodeString(init.Key)
	init.Key = ""
	if err != nil {
		return err
	}
	defer clear(key)
	out := &stdout{}
	device, err := engine.Open(path, key, out)
	if err != nil {
		return err
	}
	out.device.Store(device)
	defer device.Close()
	device.Connect()
	for scan.Scan() {
		if !device.Handle(scan.Text()) {
			return nil
		}
	}
	return scan.Err()
}

func main() {
	state := flag.String("state", "", "private encrypted state path")
	version := flag.Bool("version", false, "print the helper's and whatsmeow's versions")
	flag.Parse()
	if *version {
		fmt.Println(versions())
		return
	}
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), 1<<20)
	if *state == "" {
		fmt.Fprintln(os.Stderr, "WhatsApp: missing state path")
		os.Exit(2)
	}
	if err := run(*state, scan); err != nil {
		// Errors from the network or database may contain sensitive material.
		fmt.Println(`{"type":"error","code":"connector_start_failed"}`)
		os.Exit(1)
	}
}
