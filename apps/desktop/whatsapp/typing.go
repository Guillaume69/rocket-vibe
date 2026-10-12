package main

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Someone typing or recording in a chat, as WhatsApp tells an online device.
type typing struct {
	Chat   string `json:"chat"`
	Sender string `json:"sender"`
	// "composing", "recording" or "paused".
	State string `json:"state"`
}

func (c *connector) chatPresence(evt *events.ChatPresence) {
	if evt.IsFromMe {
		return
	}
	state := "paused"
	if evt.State == types.ChatPresenceComposing {
		state = "composing"
		if evt.Media == types.ChatPresenceMediaAudio {
			state = "recording"
		}
	}
	c.emit(wire{Type: "typing", Typing: &typing{
		Chat:   c.canonical(evt.Chat).String(),
		Sender: c.canonical(evt.Sender).String(),
		State:  state,
	}})
}

// Online while the app is in front, like WhatsApp Web: WhatsApp then tells
// this device who types, and holds the phone's own notifications back.
func (c *connector) presence(cmd command) {
	if !c.ready() {
		return
	}
	state := types.PresenceUnavailable
	if cmd.Text == "available" {
		state = types.PresenceAvailable
	}
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	_ = c.client.SendPresence(ctx, state)
}

// Tells a chat I am typing (`composing`) or stopped (`paused`).
func (c *connector) typing(cmd command) {
	if !c.ready() {
		return
	}
	chat, err := validChat(cmd.Chat)
	if err != nil {
		return
	}
	state := types.ChatPresencePaused
	if cmd.Text == "composing" {
		state = types.ChatPresenceComposing
	}
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	_ = c.client.SendChatPresence(ctx, c.rawChatFor(chat), state, types.ChatPresenceMediaText)
}
