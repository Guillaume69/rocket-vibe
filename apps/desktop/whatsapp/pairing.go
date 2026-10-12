package main

import (
	"context"
	"errors"
	"runtime"
	"time"

	"go.mau.fi/whatsmeow"
)

// What the phone shows in its linked devices: WhatsApp accepts only a common
// browser on a common system here.
func pairingClientName() string {
	switch runtime.GOOS {
	case "windows":
		return "Chrome (Windows)"
	case "darwin":
		return "Chrome (Mac OS)"
	}
	return "Chrome (Linux)"
}

// Links with a phone number instead of a QR (a phone cannot scan its own
// screen): WhatsApp returns an 8-character code, typed on the phone under
// Linked devices > Link with phone number instead, which also gets a push.
// The QR attempt must be running, which `connect` starts on an unpaired device.
func (c *connector) pairPhone(cmd command) {
	// Its own codes: a refused number or code leaves the QR attempt running.
	if c.client.Store.ID != nil || !c.client.IsConnected() {
		c.emit(wire{Type: "error", Code: "pairing_code_failed"})
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	code, err := c.client.PairPhone(ctx, cmd.Text, true, whatsmeow.PairClientChrome, pairingClientName())
	switch {
	case errors.Is(err, whatsmeow.ErrPhoneNumberTooShort) || errors.Is(err, whatsmeow.ErrPhoneNumberIsNotInternational):
		c.emit(wire{Type: "error", Code: "phone_invalid"})
	case err != nil:
		c.diag("pair phone failed: %v", err)
		c.emit(wire{Type: "error", Code: "pairing_code_failed"})
	default:
		c.emit(wire{Type: "pairing_code", Code: code})
	}
}
