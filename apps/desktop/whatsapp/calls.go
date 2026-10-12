package main

import (
	"context"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// A WhatsApp call as the app shows it: ringing, then ended. Audio and video
// are not carried here (whatsmeow implements no VoIP): it can be declined, or
// answered on the phone.
type call struct {
	ID string `json:"id"`
	// The caller (canonical JID), and the group a group call rings in.
	From  string `json:"from"`
	Group string `json:"group,omitempty"`
	Video bool   `json:"video,omitempty"`
	// "ringing" or "ended".
	State string `json:"state"`
}

// The addressing of calls ringing now, to decline them as WhatsApp sent them.
type ringing struct {
	mu    sync.Mutex
	calls map[string]types.JID
}

func (r *ringing) put(id string, from types.JID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.calls == nil {
		r.calls = map[string]types.JID{}
	}
	r.calls[id] = from
}

func (r *ringing) take(id string) (types.JID, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	from, ok := r.calls[id]
	delete(r.calls, id)
	return from, ok
}

func (c *connector) callEvent(raw any) {
	emit := func(meta types.BasicCallMeta, state string, video bool) {
		caller := meta.CallCreator
		if caller.IsEmpty() {
			caller = meta.From
		}
		x := &call{ID: meta.CallID, From: c.canonical(caller).String(), Video: video, State: state}
		if !meta.GroupJID.IsEmpty() {
			x.Group = meta.GroupJID.String()
		}
		c.emit(wire{Type: "call", Call: x})
	}
	switch evt := raw.(type) {
	case *events.CallOffer:
		// A call I place from my phone rings nowhere here.
		if c.client.Store.ID != nil && evt.CallCreator.User == c.client.Store.ID.User {
			return
		}
		c.calls.put(evt.CallID, evt.From)
		video := evt.Data != nil && len(evt.Data.GetChildrenByTag("video")) > 0
		emit(evt.BasicCallMeta, "ringing", video)
	case *events.CallOfferNotice:
		c.calls.put(evt.CallID, evt.From)
		emit(evt.BasicCallMeta, "ringing", evt.Media == "video")
	case *events.CallAccept:
		// Answered on another of my devices, or by the callee: no longer ringing here.
		c.calls.take(evt.CallID)
		emit(evt.BasicCallMeta, "ended", false)
	case *events.CallTerminate:
		c.calls.take(evt.CallID)
		emit(evt.BasicCallMeta, "ended", false)
	case *events.CallReject:
		c.calls.take(evt.CallID)
		emit(evt.BasicCallMeta, "ended", false)
	}
}

// Declines a call ringing here, for all my devices.
func (c *connector) rejectCall(cmd command) {
	from, ok := c.calls.take(cmd.ID)
	if !ok || !c.ready() {
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	if err := c.client.RejectCall(ctx, from, cmd.ID); err != nil {
		c.fail("action_failed")
		return
	}
	c.emit(wire{Type: "call", Call: &call{ID: cmd.ID, From: c.canonical(from).String(), State: "ended"}})
}
