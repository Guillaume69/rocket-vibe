// The Android face of the engine: a C shared library (librv_whatsapp.so)
// the app's Kotlin loads through JNA (apps/mobile/modules/whatsapp). An
// engine is a positive handle; its frames reach Kotlin through the callback
// given at open, called from the engine's goroutines, one frame at a time.
// Never pass a QR payload, a key or a message body to a log.
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef void (*rvwa_frame)(int64_t handle, const char *frame);

static inline void rvwa_call(rvwa_frame callback, int64_t handle, const char *frame) {
	callback(handle, frame);
}
*/
import "C"

import (
	"errors"
	"sync"
	"unsafe"

	"rocketvibe.local/whatsapp/engine"
)

var (
	mu      sync.Mutex
	next    int64
	devices = map[int64]*engine.Device{}
)

type sink struct {
	handle   int64
	callback C.rvwa_frame
}

func (s *sink) Frame(frame string) {
	text := C.CString(frame)
	defer C.free(unsafe.Pointer(text))
	C.rvwa_call(s.callback, C.int64_t(s.handle), text)
}

func device(handle C.int64_t) *engine.Device {
	mu.Lock()
	defer mu.Unlock()
	return devices[int64(handle)]
}

// Opens the sealed state at path with its 32-byte key. Returns the engine's
// handle, -1 when another engine holds the state, -2 on any other failure
// (a wrong key, an unreadable state).
//
//export rvwa_open
func rvwa_open(path *C.char, key *C.uint8_t, keyLen C.int, callback C.rvwa_frame) C.int64_t {
	if path == nil || key == nil || keyLen != 32 || callback == nil {
		return -2
	}
	secret := C.GoBytes(unsafe.Pointer(key), keyLen)
	defer clear(secret)
	mu.Lock()
	next++
	handle := next
	mu.Unlock()
	d, err := engine.Open(C.GoString(path), secret, &sink{handle: handle, callback: callback})
	switch {
	case errors.Is(err, engine.ErrBusy):
		return -1
	case err != nil:
		return -2
	}
	mu.Lock()
	devices[handle] = d
	mu.Unlock()
	return C.int64_t(handle)
}

// Reaches WhatsApp: the account's frames when linked, a QR otherwise.
//
//export rvwa_connect
func rvwa_connect(handle C.int64_t) {
	if d := device(handle); d != nil {
		d.Connect()
	}
}

// Runs one JSON command; 1 while the engine runs, 0 once it ended (a stop,
// a logout) or for an unknown handle, after which only rvwa_close is left.
//
//export rvwa_handle
func rvwa_handle(handle C.int64_t, command *C.char) C.int {
	d := device(handle)
	if d == nil || command == nil {
		return 0
	}
	if d.Handle(C.GoString(command)) {
		return 1
	}
	return 0
}

// Checkpoints the state and releases it and its lock; the handle is gone.
//
//export rvwa_close
func rvwa_close(handle C.int64_t) {
	mu.Lock()
	d := devices[int64(handle)]
	delete(devices, int64(handle))
	mu.Unlock()
	if d != nil {
		d.Close()
	}
}

func main() {}
