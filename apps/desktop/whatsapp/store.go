package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// The engine's own tables, beside whatsmeow's, in the same sealed database.
// Ids are `<chat>:<WhatsApp message id>`, the chat in its canonical form
// (phone number rather than LID when the mapping is known); raw_chat and
// raw_sender keep the addressing WhatsApp used, which reactions, edits and
// revocations must reuse.
func migrate(db *sql.DB) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS rv_messages (
 id TEXT PRIMARY KEY,chat TEXT NOT NULL,name TEXT NOT NULL,sender TEXT NOT NULL,author TEXT NOT NULL,
 text TEXT NOT NULL,ts INTEGER NOT NULL,mine INTEGER NOT NULL,status TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS rv_reactions (
 message TEXT NOT NULL,sender TEXT NOT NULL,emoji TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(message,sender))`,
		`CREATE TABLE IF NOT EXISTS rv_chat_names (jid TEXT PRIMARY KEY,name TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS rv_avatars (jid TEXT PRIMARY KEY,picture TEXT NOT NULL,data BLOB,checked INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS rv_chats (jid TEXT PRIMARY KEY,unread INTEGER NOT NULL DEFAULT 0)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	for _, column := range []struct{ name, definition string }{
		{"edited", "INTEGER NOT NULL DEFAULT 0"},
		{"deleted", "INTEGER NOT NULL DEFAULT 0"},
		{"raw_chat", "TEXT NOT NULL DEFAULT ''"},
		{"raw_sender", "TEXT NOT NULL DEFAULT ''"},
		{"receipt", "TEXT NOT NULL DEFAULT ''"},
		{"reply_to", "TEXT NOT NULL DEFAULT ''"},
		{"quote_sender", "TEXT NOT NULL DEFAULT ''"},
		{"quote_text", "TEXT NOT NULL DEFAULT ''"},
		{"kind", "TEXT NOT NULL DEFAULT ''"},
		{"mime", "TEXT NOT NULL DEFAULT ''"},
		{"file_name", "TEXT NOT NULL DEFAULT ''"},
		{"size", "INTEGER NOT NULL DEFAULT 0"},
		{"width", "INTEGER NOT NULL DEFAULT 0"},
		{"height", "INTEGER NOT NULL DEFAULT 0"},
		{"seconds", "INTEGER NOT NULL DEFAULT 0"},
		{"thumb", "BLOB"},
		{"media", "BLOB"},
	} {
		var present int
		if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('rv_messages') WHERE name = ?`, column.name).Scan(&present); err != nil {
			return err
		}
		if present == 0 {
			if _, err := db.Exec(fmt.Sprintf(`ALTER TABLE rv_messages ADD COLUMN %s %s`, column.name, column.definition)); err != nil {
				return err
			}
		}
	}
	_, err := db.Exec(`CREATE INDEX IF NOT EXISTS rv_messages_chat ON rv_messages(chat, ts)`)
	return err
}

const messageColumns = `id,chat,name,sender,author,text,ts,mine,status,edited,deleted,raw_chat,raw_sender,receipt,
reply_to,quote_sender,quote_text,kind,mime,file_name,size,width,height,seconds,thumb,media`

// The values of messageColumns, in order.
const messageValues = `?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?`

func (m *message) values() []any {
	return []any{m.ID, m.Chat, m.Name, m.Sender, m.Author, m.Text, m.TS, m.Mine, m.Status, m.Edited, m.Deleted,
		m.RawChat, m.RawSender, m.Receipt, m.ReplyTo, m.QuoteSender, m.QuoteText,
		m.Kind, m.Mime, m.FileName, m.Size, m.Width, m.Height, m.Seconds, m.Thumb, m.MediaProto}
}

func scanMessage(row interface{ Scan(...any) error }) (message, error) {
	var m message
	err := row.Scan(&m.ID, &m.Chat, &m.Name, &m.Sender, &m.Author, &m.Text, &m.TS, &m.Mine, &m.Status, &m.Edited, &m.Deleted, &m.RawChat, &m.RawSender, &m.Receipt,
		&m.ReplyTo, &m.QuoteSender, &m.QuoteText,
		&m.Kind, &m.Mime, &m.FileName, &m.Size, &m.Width, &m.Height, &m.Seconds, &m.Thumb, &m.MediaProto)
	return m, err
}

func (c *connector) load(id string) (message, bool) {
	m, err := scanMessage(c.vault.db.QueryRowContext(c.ctx, `SELECT `+messageColumns+` FROM rv_messages WHERE id = ?`, id))
	return m, err == nil
}

// Re-reads a stored message and sends it, so the client sees what is kept.
func (c *connector) emitStored(id string) {
	if m, ok := c.load(id); ok {
		c.emit(wire{Type: "message", Message: &m})
	}
}

// Stores a received message, or settles a send. A message already kept is
// not rewritten by a later copy (history replays what live delivered).
func (c *connector) remember(m message) {
	if c.stopped.Load() {
		return
	}
	_, err := c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_messages(`+messageColumns+`)
 VALUES(`+messageValues+`) ON CONFLICT(id) DO UPDATE SET status=excluded.status,ts=excluded.ts
 WHERE rv_messages.status != ''`, m.values()...)
	if err != nil {
		c.fail("local_storage_failed")
		return
	}
	c.emitStored(m.ID)
}

// The latest addressing WhatsApp used for a chat, to send in the same form.
func (c *connector) rawChatFor(chat types.JID) types.JID {
	var raw string
	err := c.vault.db.QueryRowContext(c.ctx, `SELECT raw_chat FROM rv_messages WHERE chat = ? AND raw_chat != ''
 ORDER BY ts DESC LIMIT 1`, chat.String()).Scan(&raw)
	if err == nil {
		if jid, err := validChat(raw); err == nil {
			return jid
		}
	}
	return chat
}

func (c *connector) storeReaction(target, sender, emoji string, ts int64) {
	if c.stopped.Load() || target == "" || sender == "" {
		return
	}
	var err error
	if emoji == "" {
		_, err = c.vault.db.ExecContext(c.ctx, `DELETE FROM rv_reactions WHERE message = ? AND sender = ? AND ts <= ?`, target, sender, ts)
	} else {
		_, err = c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_reactions(message,sender,emoji,ts) VALUES(?,?,?,?)
 ON CONFLICT(message,sender) DO UPDATE SET emoji=excluded.emoji,ts=excluded.ts WHERE excluded.ts >= rv_reactions.ts`,
			target, sender, emoji, ts)
	}
	if err != nil {
		c.fail("local_storage_failed")
		return
	}
	kept := reaction{Message: target, Sender: sender}
	_ = c.vault.db.QueryRowContext(c.ctx, `SELECT emoji,ts FROM rv_reactions WHERE message = ? AND sender = ?`, target, sender).Scan(&kept.Emoji, &kept.TS)
	c.emit(wire{Type: "reaction", Reaction: &kept})
}

// Drops the oldest settled messages past the cache bound, and the reactions
// left without a message. An uncertain or in-flight send stays until it is
// settled, whatever its age.
func (c *connector) prune() {
	if c.stopped.Load() {
		return
	}
	_, err := c.vault.db.ExecContext(c.ctx, `DELETE FROM rv_messages WHERE status = '' AND id NOT IN
 (SELECT id FROM rv_messages ORDER BY ts DESC, id DESC LIMIT ?)`, maxCached)
	if err == nil {
		_, err = c.vault.db.ExecContext(c.ctx, `DELETE FROM rv_reactions WHERE message NOT IN (SELECT id FROM rv_messages)`)
	}
	if err != nil {
		c.fail("local_storage_failed")
	}
}

// Moves conversations and senders stored under a LID to the phone number
// WhatsApp has since mapped it to, so one person is one conversation. Reports
// whether anything moved: the client then reloads its projection.
func (c *connector) normalize() bool {
	if c.stopped.Load() || c.client == nil {
		return false
	}
	lids := func(query string) []string {
		rows, err := c.vault.db.QueryContext(c.ctx, query)
		if err != nil {
			return nil
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var value string
			if rows.Scan(&value) == nil {
				out = append(out, value)
			}
		}
		return out
	}
	moved := false
	for _, old := range lids(`SELECT DISTINCT chat FROM rv_messages WHERE chat LIKE '%@` + types.HiddenUserServer + `'`) {
		jid, err := types.ParseJID(old)
		if err != nil {
			continue
		}
		pn := c.canonical(jid).String()
		if pn == old {
			continue
		}
		prefix := len(old) + 1
		tx, err := c.vault.db.BeginTx(c.ctx, nil)
		if err != nil {
			return moved
		}
		for _, statement := range []string{
			`UPDATE OR IGNORE rv_messages SET id = ?1 || substr(id, ?2), chat = ?1 WHERE chat = ?3`,
			`DELETE FROM rv_messages WHERE chat = ?3`,
			`UPDATE OR IGNORE rv_reactions SET message = ?1 || substr(message, ?2) WHERE substr(message, 1, ?2) = ?3 || ':'`,
			`DELETE FROM rv_reactions WHERE substr(message, 1, ?2) = ?3 || ':'`,
			`INSERT INTO rv_chats(jid,unread) SELECT ?1, unread FROM rv_chats WHERE jid = ?3
 ON CONFLICT(jid) DO UPDATE SET unread = max(rv_chats.unread, excluded.unread)`,
			`DELETE FROM rv_chats WHERE jid = ?3`,
		} {
			if _, err := tx.ExecContext(c.ctx, statement, pn, prefix, old); err != nil {
				_ = tx.Rollback()
				return moved
			}
		}
		if tx.Commit() == nil {
			moved = true
		}
	}
	for _, old := range lids(`SELECT DISTINCT sender FROM rv_messages WHERE sender LIKE '%@` + types.HiddenUserServer + `'
 UNION SELECT DISTINCT sender FROM rv_reactions WHERE sender LIKE '%@` + types.HiddenUserServer + `'`) {
		jid, err := types.ParseJID(old)
		if err != nil {
			continue
		}
		pn := c.canonical(jid).String()
		if pn == old {
			continue
		}
		_, err1 := c.vault.db.ExecContext(c.ctx, `UPDATE rv_messages SET sender = ? WHERE sender = ?`, pn, old)
		_, err2 := c.vault.db.ExecContext(c.ctx, `UPDATE OR IGNORE rv_reactions SET sender = ? WHERE sender = ?`, pn, old)
		if err1 == nil && err2 == nil {
			moved = true
		}
	}
	return moved
}

// Sends the whole cache: messages oldest first, then reactions, avatars and names.
func (c *connector) replay() error {
	rows, err := c.vault.db.QueryContext(c.ctx, `SELECT `+messageColumns+` FROM rv_messages ORDER BY ts,id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			rows.Close()
			return err
		}
		c.emit(wire{Type: "message", Message: &m})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	reactions, err := c.vault.db.QueryContext(c.ctx, `SELECT message,sender,emoji,ts FROM rv_reactions ORDER BY ts`)
	if err != nil {
		return err
	}
	for reactions.Next() {
		var r reaction
		if err := reactions.Scan(&r.Message, &r.Sender, &r.Emoji, &r.TS); err != nil {
			reactions.Close()
			return err
		}
		c.emit(wire{Type: "reaction", Reaction: &r})
	}
	reactions.Close()
	if err := reactions.Err(); err != nil {
		return err
	}
	c.replayAvatars()
	c.replayChats()
	c.emitNames()
	return nil
}

// `<chat>:<WhatsApp id>` into its two parts.
func cutID(id string) (string, string, bool) {
	return strings.Cut(id, ":")
}

func now() int64 { return time.Now().UnixMilli() }

// `<chat>:<id>` into the chat as WhatsApp addressed it and the message id.
func (c *connector) target(id string) (message, types.JID, types.MessageID, bool) {
	m, ok := c.load(id)
	if !ok {
		return m, types.JID{}, "", false
	}
	chat, waid, found := cutID(m.ID)
	if !found || waid == "" {
		return m, types.JID{}, "", false
	}
	raw := m.RawChat
	if raw == "" {
		raw = chat
	}
	jid, err := validChat(raw)
	if err != nil {
		return m, types.JID{}, "", false
	}
	return m, jid, types.MessageID(waid), true
}
