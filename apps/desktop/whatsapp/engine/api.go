package engine

import (
	"encoding/json"
	"sync"
)

// The engine's exported surface, gomobile-legal (strings, bytes, an
// interface, a struct pointer): what the desktop helper and the Android
// binding both drive. Frames and commands are the JSON objects the wire
// protocol carries, one per call.

// Sink receives each frame the engine emits, as one JSON object. It is called
// from the engine's goroutines, one frame at a time.
type Sink interface {
	Frame(frame string)
}

// Device is one linked device opened on its sealed state.
type Device struct {
	c      *connector
	closer func()
	once   sync.Once
}

// Open loads the sealed state at path under its lock, with its 32-byte key;
// Connect then reaches WhatsApp. A state held by another engine is refused.
func Open(path string, key []byte, sink Sink) (*Device, error) {
	c, closer, err := open(path, key, func(event wire) {
		if frame, err := json.Marshal(event); err == nil {
			sink.Frame(string(frame))
		}
	})
	if err != nil {
		return nil, err
	}
	return &Device{c: c, closer: closer}, nil
}

// Connect reaches WhatsApp: the account's frames when linked, a QR otherwise.
func (d *Device) Connect() {
	go d.c.connect()
}

// Handle runs one command; it reports false once the engine ended (a stop, a
// logout), after which only Close is left to call.
func (d *Device) Handle(line string) bool {
	var cmd command
	if json.Unmarshal([]byte(line), &cmd) != nil {
		d.c.fail("invalid_command")
		return true
	}
	return d.c.handle(cmd)
}

// Cancel ends the engine's work without waiting, safe from inside a Sink
// (a transport that can no longer deliver frames).
func (d *Device) Cancel() {
	d.c.cancel()
}

// Close checkpoints the state and releases it and its lock; idempotent.
func (d *Device) Close() {
	d.once.Do(d.closer)
}
