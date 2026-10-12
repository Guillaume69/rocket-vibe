package engine

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// How far a receipt went for my message: delivered, then read, then played
// (a voice note heard). A receipt never moves it back.
var receiptRank = map[string]int{"": 0, "delivered": 1, "read": 2, "played": 3}

// Read receipts sent for one chat at a time, newest first.
const maxReadIDs = 100

func (c *connector) emitChat(jid string) {
	var unread int64
	_ = c.vault.db.QueryRowContext(c.ctx, `SELECT unread FROM rv_chats WHERE jid = ?`, jid).Scan(&unread)
	c.emit(wire{Type: "chat", JID: jid, Unread: &unread})
}

func (c *connector) replayChats() {
	rows, err := c.vault.db.QueryContext(c.ctx, `SELECT jid FROM rv_chats WHERE unread > 0`)
	if err != nil {
		return
	}
	var jids []string
	for rows.Next() {
		var jid string
		if rows.Scan(&jid) == nil {
			jids = append(jids, jid)
		}
	}
	rows.Close()
	for _, jid := range jids {
		c.emitChat(jid)
	}
}

// Sets a chat's unread count; `delta` adds to it instead when `set` is false.
func (c *connector) setUnread(chat string, value int64, set bool) {
	if c.stopped.Load() {
		return
	}
	query := `INSERT INTO rv_chats(jid,unread) VALUES(?1,max(?2,0)) ON CONFLICT(jid) DO UPDATE SET unread = max(?2,0)`
	if !set {
		query = `INSERT INTO rv_chats(jid,unread) VALUES(?1,max(?2,0)) ON CONFLICT(jid) DO UPDATE SET unread = max(unread + ?2,0)`
	}
	if _, err := c.vault.db.ExecContext(c.ctx, query, chat, value); err != nil {
		c.fail("local_storage_failed")
		return
	}
	c.emitChat(chat)
}

// A receipt for my messages from their recipient, or my own reading on
// another device (the phone): the chat is then read here too.
func (c *connector) receipt(evt *events.Receipt) {
	chat := c.canonical(evt.Chat).String()
	if evt.IsFromMe {
		if evt.Type == types.ReceiptTypeRead || evt.Type == types.ReceiptTypeReadSelf {
			c.setUnread(chat, 0, true)
		}
		return
	}
	state := ""
	switch evt.Type {
	case types.ReceiptTypeDelivered:
		state = "delivered"
	case types.ReceiptTypeRead:
		state = "read"
	case types.ReceiptTypePlayed:
		state = "played"
	default:
		return
	}
	// In a group one reader is not everyone: only delivery is shown there.
	if evt.IsGroup && state != "delivered" {
		return
	}
	for _, id := range evt.MessageIDs {
		key := chat + ":" + string(id)
		m, ok := c.load(key)
		if !ok || !m.Mine || receiptRank[state] <= receiptRank[m.Receipt] {
			continue
		}
		if _, err := c.vault.db.ExecContext(c.ctx, `UPDATE rv_messages SET receipt = ? WHERE id = ?`, state, key); err != nil {
			c.fail("local_storage_failed")
			return
		}
		c.emitStored(key)
	}
}

// The phone marked a chat read or unread.
func (c *connector) markedRead(evt *events.MarkChatAsRead) {
	chat := c.canonical(evt.JID).String()
	if evt.Action.GetRead() {
		c.setUnread(chat, 0, true)
		return
	}
	var unread int64
	_ = c.vault.db.QueryRowContext(c.ctx, `SELECT unread FROM rv_chats WHERE jid = ?`, chat).Scan(&unread)
	if unread == 0 {
		c.setUnread(chat, 1, true)
	}
}

// Reads a chat: the unread messages of others get a read receipt (or a
// private "read-self" when my privacy settings send none), the count drops
// to zero here and on my other devices.
func (c *connector) read(cmd command) {
	chat, err := validChat(cmd.Chat)
	if err != nil {
		c.fail("action_failed")
		return
	}
	var unread int64
	_ = c.vault.db.QueryRowContext(c.ctx, `SELECT unread FROM rv_chats WHERE jid = ?`, chat.String()).Scan(&unread)
	if unread == 0 {
		return
	}
	c.setUnread(chat.String(), 0, true)
	if !c.ready() {
		return
	}
	rows, err := c.vault.db.QueryContext(c.ctx, `SELECT id,raw_chat,raw_sender FROM rv_messages
 WHERE chat = ? AND mine = 0 AND deleted = 0 ORDER BY ts DESC LIMIT ?`, chat.String(), min(unread, maxReadIDs))
	if err != nil {
		return
	}
	type batch struct {
		chat, sender types.JID
		ids          []types.MessageID
	}
	batches := map[string]*batch{}
	for rows.Next() {
		var id, rawChat, rawSender string
		if rows.Scan(&id, &rawChat, &rawSender) != nil {
			continue
		}
		_, waid, _ := cutID(id)
		to, err := validChat(rawChat)
		if err != nil {
			to = chat
		}
		var sender types.JID
		if to.Server == types.GroupServer {
			if sender, err = types.ParseJID(rawSender); err != nil {
				continue
			}
		}
		key := to.String() + "|" + sender.String()
		if batches[key] == nil {
			batches[key] = &batch{chat: to, sender: sender}
		}
		batches[key].ids = append(batches[key].ids, types.MessageID(waid))
	}
	rows.Close()
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	var extra []types.ReceiptType
	if c.client.GetPrivacySettings(ctx).ReadReceipts == types.PrivacySettingNone {
		extra = []types.ReceiptType{types.ReceiptTypeReadSelf}
	}
	for _, b := range batches {
		// A failed receipt leaves the chat read here; the phone still shows it unread.
		_ = c.client.MarkRead(ctx, b.ids, time.Now(), b.chat, b.sender, extra...)
	}
}
