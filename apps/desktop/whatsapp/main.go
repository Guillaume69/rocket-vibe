// A local stdin/stdout connector. Never print QR payloads, keys or message bodies to logs.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofrs/flock"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

type command struct {
	Type string `json:"type"`
	Key  string `json:"key,omitempty"`
	ID   string `json:"id,omitempty"`
	Chat string `json:"chat,omitempty"`
	Text string `json:"text,omitempty"`
}
type message struct {
	ID     string `json:"id"`
	Chat   string `json:"chat"`
	Name   string `json:"name"`
	Sender string `json:"sender"`
	Author string `json:"author"`
	Text   string `json:"text"`
	TS     int64  `json:"ts"`
	Mine   bool   `json:"mine"`
	Status string `json:"status,omitempty"`
}
type wire struct {
	Type      string   `json:"type"`
	State     string   `json:"state,omitempty"`
	Code      string   `json:"code,omitempty"`
	ExpiresMS int64    `json:"expires_ms,omitempty"`
	Message   *message `json:"message,omitempty"`
	ID        string   `json:"id,omitempty"`
}
type connector struct {
	client   *whatsmeow.Client
	vault    *vault
	ctx      context.Context
	cancel   context.CancelFunc
	output   sync.Mutex
	pairing  sync.Mutex
	qrCancel context.CancelFunc
	stopped  atomic.Bool
}

func (c *connector) emit(event wire) {
	c.output.Lock()
	defer c.output.Unlock()
	if json.NewEncoder(os.Stdout).Encode(event) != nil {
		c.cancel()
	}
}
func (c *connector) fail(code string) { c.emit(wire{Type: "error", Code: code}) }
func validChat(value string) (types.JID, error) {
	jid, err := types.ParseJID(value)
	if err != nil || jid.User == "" || jid.Device != 0 ||
		(jid.Server != types.DefaultUserServer && jid.Server != types.GroupServer && jid.Server != types.HiddenUserServer) {
		return types.JID{}, fmt.Errorf("invalid chat")
	}
	return jid, nil
}
func (c *connector) remember(m message) {
	if c.stopped.Load() {
		return
	}
	_, err := c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_messages(id,chat,name,sender,author,text,ts,mine,status)
 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,author=excluded.author,text=excluded.text,ts=excluded.ts,status=excluded.status`,
		m.ID, m.Chat, m.Name, m.Sender, m.Author, m.Text, m.TS, m.Mine, m.Status)
	if err != nil {
		c.fail("local_storage_failed")
		return
	}
	c.emit(wire{Type: "message", Message: &m})
}
func (c *connector) receive(evt *events.Message, name string) {
	// This pilot must not keep view-once or disappearing content indefinitely.
	if evt.IsEphemeral || evt.IsViewOnce || evt.IsViewOnceV2 || evt.IsViewOnceV2Extension || evt.IsEdit {
		return
	}
	if evt.Message.GetExtendedTextMessage().GetContextInfo().GetExpiration() != 0 {
		return
	}
	text := evt.Message.GetConversation()
	if text == "" {
		text = evt.Message.GetExtendedTextMessage().GetText()
	}
	if text == "" {
		return
	}
	chat := evt.Info.Chat.ToNonAD()
	if _, err := validChat(chat.String()); err != nil {
		return
	}
	if name == "" {
		if !evt.Info.IsGroup && !evt.Info.IsFromMe {
			name = evt.Info.PushName
		}
		if contact, err := c.client.Store.Contacts.GetContact(c.ctx, chat); err == nil {
			if contact.FullName != "" {
				name = contact.FullName
			} else if name == "" {
				name = contact.PushName
			}
		}
	}
	if name == "" {
		name = chat.User
		_ = c.vault.db.QueryRowContext(c.ctx, "SELECT name FROM rv_messages WHERE chat=? ORDER BY ts DESC LIMIT 1", chat.String()).Scan(&name)
	}
	c.remember(message{ID: chat.String() + ":" + evt.Info.ID, Chat: chat.String(), Name: name,
		Sender: evt.Info.Sender.ToNonAD().String(), Author: evt.Info.PushName, Text: text,
		TS: evt.Info.Timestamp.UnixMilli(), Mine: evt.Info.IsFromMe})
}
func (c *connector) event(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		c.emit(wire{Type: "status", State: "connected"})
	case *events.Disconnected:
		c.emit(wire{Type: "status", State: "offline"})
	case *events.PairSuccess:
		if c.vault.checkpoint() != nil {
			c.stopOnStorageFailure()
			return
		}
		c.emit(wire{Type: "status", State: "paired"})
	case *events.LoggedOut:
		c.stopped.Store(true)
		if c.vault.revoke() != nil {
			c.fail("state_removal_failed")
		}
		c.emit(wire{Type: "status", State: "logged_out"})
	case *events.StreamReplaced:
		c.emit(wire{Type: "status", State: "replaced"})
	case *events.Message:
		c.receive(evt, "")
	case *events.HistorySync:
		for _, conversation := range evt.Data.GetConversations() {
			if conversation.GetEphemeralExpiration() != 0 {
				continue
			}
			jid, err := validChat(conversation.GetID())
			if err != nil {
				continue
			}
			for _, entry := range conversation.GetMessages() {
				parsed, err := c.client.ParseWebMessage(jid, entry.GetMessage())
				if err == nil {
					c.receive(parsed, conversation.GetName())
				}
			}
		}
	}
}
func (c *connector) stopOnStorageFailure() {
	if c.stopped.Swap(true) {
		return
	}
	c.client.Disconnect()
	c.fail("secure_storage_failed")
}
func (c *connector) connect() {
	c.pairing.Lock()
	defer c.pairing.Unlock()
	if c.stopped.Load() {
		c.fail("session_ended")
		return
	}
	if c.qrCancel != nil {
		c.qrCancel()
		c.qrCancel = nil
	}
	c.client.Disconnect()
	c.emit(wire{Type: "status", State: "connecting"})
	if c.client.Store.ID == nil {
		ctx, cancel := context.WithCancel(c.ctx)
		c.qrCancel = cancel
		channel, err := c.client.GetQRChannel(ctx)
		if err != nil {
			c.fail("pairing_failed")
			return
		}
		go func() {
			for item := range channel {
				if ctx.Err() != nil {
					return
				}
				if item.Event == "code" {
					c.emit(wire{Type: "qr", Code: item.Code, ExpiresMS: item.Timeout.Milliseconds()})
				}
				if item.Event == "timeout" {
					c.emit(wire{Type: "status", State: "qr_expired"})
				}
				if item.Event == "error" {
					c.fail("pairing_failed")
				}
			}
		}()
	}
	if err := c.client.ConnectContext(c.ctx); err != nil {
		c.fail("connection_failed")
	}
}
func (c *connector) send(cmd command) {
	if c.stopped.Load() || !c.client.IsLoggedIn() || !c.client.IsConnected() {
		c.fail("not_connected")
		return
	}
	jid, err := validChat(cmd.Chat)
	if err != nil || len(cmd.Text) == 0 || len(cmd.Text) > 20000 || len(cmd.ID) < 8 || len(cmd.ID) > 64 {
		c.fail("invalid_send")
		return
	}
	// Persist the send intent before the network request. Reopening never replays it.
	name := jid.User
	_ = c.vault.db.QueryRowContext(c.ctx, "SELECT name FROM rv_messages WHERE chat=? ORDER BY ts DESC LIMIT 1", cmd.Chat).Scan(&name)
	m := message{ID: cmd.Chat + ":" + cmd.ID, Chat: cmd.Chat, Name: name, Sender: "me", Author: "", Text: cmd.Text, TS: time.Now().UnixMilli(), Mine: true, Status: "sending"}
	result, err := c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_messages(id,chat,name,sender,author,text,ts,mine,status)
 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, m.ID, m.Chat, m.Name, m.Sender, m.Author, m.Text, m.TS, m.Mine, m.Status)
	if err != nil {
		c.fail("local_storage_failed")
		return
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		c.fail("send_already_recorded")
		return
	}
	if c.vault.checkpoint() != nil {
		c.stopOnStorageFailure()
		return
	}
	c.emit(wire{Type: "message", Message: &m})
	ctx, cancel := context.WithTimeout(c.ctx, 45*time.Second)
	defer cancel()
	response, err := c.client.SendMessage(ctx, jid, &waE2E.Message{Conversation: proto.String(cmd.Text)}, whatsmeow.SendRequestExtra{ID: types.MessageID(cmd.ID)})
	if err != nil {
		m.Status = "uncertain"
	} else {
		m.Status = ""
		m.TS = response.Timestamp.UnixMilli()
	}
	c.remember(m)
	if c.vault.checkpoint() != nil {
		c.stopOnStorageFailure()
		return
	}
	c.emit(wire{Type: "sent", ID: cmd.ID, State: m.Status})
}
func (c *connector) replay() error {
	// A crash while sending is an uncertain outcome, never an automatic retry.
	if _, err := c.vault.db.Exec(`UPDATE rv_messages SET status='uncertain' WHERE status='sending'`); err != nil {
		return err
	}
	rows, err := c.vault.db.Query(`SELECT id,chat,name,sender,author,text,ts,mine,status FROM rv_messages ORDER BY ts,id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var m message
		if err := rows.Scan(&m.ID, &m.Chat, &m.Name, &m.Sender, &m.Author, &m.Text, &m.TS, &m.Mine, &m.Status); err != nil {
			return err
		}
		c.emit(wire{Type: "message", Message: &m})
	}
	return rows.Err()
}
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
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	lock := flock.New(path + ".lock")
	ok, err := lock.TryLock()
	if err != nil || !ok {
		return fmt.Errorf("session busy")
	}
	defer lock.Unlock()
	v, err := openVault(path, key)
	if err != nil {
		return err
	}
	defer v.db.Close()
	container := sqlstore.NewWithDB(v.db, "sqlite3", waLog.Noop)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := container.Upgrade(ctx); err != nil {
		return err
	}
	if _, err := v.db.Exec(`CREATE TABLE IF NOT EXISTS rv_messages (
 id TEXT PRIMARY KEY,chat TEXT NOT NULL,name TEXT NOT NULL,sender TEXT NOT NULL,author TEXT NOT NULL,
 text TEXT NOT NULL,ts INTEGER NOT NULL,mine INTEGER NOT NULL,status TEXT NOT NULL)`); err != nil {
		return err
	}
	devices, err := container.GetAllDevices(ctx)
	if err != nil {
		return err
	}
	if len(devices) > 1 {
		return fmt.Errorf("ambiguous session")
	}
	device := container.NewDevice()
	if len(devices) == 1 {
		device = devices[0]
	}
	c := &connector{vault: v, ctx: ctx, cancel: cancel}
	c.client = whatsmeow.NewClient(device, waLog.Noop)
	c.client.AddEventHandler(c.event)
	if err := c.replay(); err != nil {
		return err
	}
	c.emit(wire{Type: "status", State: "loaded"})
	go c.connect()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !c.stopped.Load() && v.checkpoint() != nil {
					c.stopOnStorageFailure()
				}
			}
		}
	}()
	defer func() { cancel(); c.client.Disconnect(); <-done; _ = v.checkpoint() }()
	for scan.Scan() {
		var cmd command
		if json.Unmarshal(scan.Bytes(), &cmd) != nil {
			c.fail("invalid_command")
			continue
		}
		switch cmd.Type {
		case "connect":
			go c.connect()
		case "send":
			c.send(cmd)
		case "logout":
			if err := c.client.Logout(ctx); err != nil {
				c.fail("logout_failed")
				continue
			}
			c.stopped.Store(true)
			if err := v.revoke(); err != nil {
				c.fail("state_removal_failed")
			}
			c.emit(wire{Type: "status", State: "logged_out"})
			return nil
		case "stop":
			return nil
		default:
			c.fail("invalid_command")
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
