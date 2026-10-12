// The WhatsApp engine: one linked device, its sealed state and the events
// the client projects. It knows no transport: main.go speaks JSON lines over
// pipes, a mobile binding can drive the same methods. Never log QR payloads,
// keys or message bodies.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofrs/flock"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

const (
	// The text cache keeps the newest messages, like the client's projection.
	maxCached = 20000
	maxText   = 20000
	// WhatsApp's own windows: recipients ignore later edits and revocations.
	editWindow   = 15 * time.Minute
	revokeWindow = 48 * time.Hour
)

type command struct {
	Type string `json:"type"`
	Key  string `json:"key,omitempty"`
	ID   string `json:"id,omitempty"`
	Chat string `json:"chat,omitempty"`
	Text string `json:"text,omitempty"`
	// For a send: the scoped id of the message it answers.
	Reply string `json:"reply,omitempty"`
}
type message struct {
	ID      string `json:"id"`
	Chat    string `json:"chat"`
	Name    string `json:"name"`
	Sender  string `json:"sender"`
	Author  string `json:"author"`
	Text    string `json:"text"`
	TS      int64  `json:"ts"`
	Mine    bool   `json:"mine"`
	Status  string `json:"status,omitempty"`
	Edited  bool   `json:"edited,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
	// How far my message went: delivered, read or played.
	Receipt string `json:"receipt,omitempty"`
	// A reply: the quoted message's id, its sender ("me" for mine) and its
	// text as quoted (the client prefers the cached message's current text).
	ReplyTo     string `json:"reply_to,omitempty"`
	QuoteSender string `json:"quote_sender,omitempty"`
	QuoteText   string `json:"quote_text,omitempty"`
	// An attachment: image, gif, video, audio, voice, document or sticker;
	// the text is then its caption. Fetched with `download`.
	Kind       string `json:"kind,omitempty"`
	Mime       string `json:"mime,omitempty"`
	FileName   string `json:"file_name,omitempty"`
	Size       int64  `json:"size,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	Seconds    int    `json:"seconds,omitempty"`
	Thumb      []byte `json:"thumb,omitempty"`
	MediaProto []byte `json:"-"`
	RawChat    string `json:"-"`
	RawSender  string `json:"-"`
}
type reaction struct {
	Message string `json:"message"`
	Sender  string `json:"sender"`
	// Empty once the reaction was taken back.
	Emoji string `json:"emoji"`
	TS    int64  `json:"ts"`
}
type wire struct {
	Type      string            `json:"type"`
	State     string            `json:"state,omitempty"`
	Code      string            `json:"code,omitempty"`
	ExpiresMS int64             `json:"expires_ms,omitempty"`
	Message   *message          `json:"message,omitempty"`
	ID        string            `json:"id,omitempty"`
	Names     map[string]string `json:"names,omitempty"`
	JID       string            `json:"jid,omitempty"`
	// A photo in base64, empty when the person has none.
	Data     *string   `json:"data,omitempty"`
	Reaction *reaction `json:"reaction,omitempty"`
	Unread   *int64    `json:"unread,omitempty"`
	// The linked account's display name (an `account` frame).
	Name string `json:"name,omitempty"`
	// The answer to a `search` (a `found` frame), never omitted when empty.
	People []person `json:"people"`
	// Where a downloaded attachment is (a `file` frame); empty on failure.
	Path string `json:"path,omitempty"`
}
type connector struct {
	client     *whatsmeow.Client
	vault      *vault
	ctx        context.Context
	cancel     context.CancelFunc
	sink       func(wire)
	output     sync.Mutex
	pairing    sync.Mutex
	qrCancel   context.CancelFunc
	stopped    atomic.Bool
	namesDirty atomic.Bool
	avatarKick chan struct{}
}

func (c *connector) emit(event wire) {
	c.output.Lock()
	defer c.output.Unlock()
	if c.sink != nil {
		c.sink(event)
	}
}
func (c *connector) fail(code string) { c.emit(wire{Type: "error", Code: code}) }

// A send that never reached the network: the client keeps its draft.
func (c *connector) refuse(id, code string) { c.emit(wire{Type: "error", Code: code, ID: id}) }

func validChat(value string) (types.JID, error) {
	jid, err := types.ParseJID(value)
	if err != nil || jid.User == "" || jid.Device != 0 ||
		(jid.Server != types.DefaultUserServer && jid.Server != types.GroupServer && jid.Server != types.HiddenUserServer) {
		return types.JID{}, fmt.Errorf("invalid chat")
	}
	return jid, nil
}

func textOf(m *waE2E.Message) string {
	if text := m.GetConversation(); text != "" {
		return text
	}
	return m.GetExtendedTextMessage().GetText()
}

// Stores a message; true when it is a new message of someone else.
func (c *connector) receive(evt *events.Message, name string) bool {
	// Not kept: view-once and disappearing content must not outlive WhatsApp's own copy.
	if evt.IsEphemeral || evt.IsViewOnce || evt.IsViewOnceV2 || evt.IsViewOnceV2Extension {
		return false
	}
	if contextOf(evt.Message).GetExpiration() != 0 {
		return false
	}
	if r := evt.Message.GetReactionMessage(); r != nil {
		chat := c.canonical(evt.Info.Chat)
		c.storeReaction(chat.String()+":"+r.GetKey().GetID(), c.senderKey(evt.Info.IsFromMe, evt.Info.Sender),
			r.GetText(), evt.Info.Timestamp.UnixMilli())
		return false
	}
	if p := evt.Message.GetProtocolMessage(); p != nil {
		c.protocol(evt, p)
		return false
	}
	text := textOf(evt.Message)
	media, caption := attachmentOf(evt.Message)
	if text == "" && media == nil {
		return false
	}
	if media != nil {
		text = caption
	}
	raw := evt.Info.Chat.ToNonAD()
	if _, err := validChat(raw.String()); err != nil {
		return false
	}
	chat := c.canonical(raw)
	if name != "" {
		c.setChatName(chat, name)
	}
	id := chat.String() + ":" + evt.Info.ID
	_, known := c.load(id)
	m := message{ID: id, Chat: chat.String(), Name: chat.User,
		Sender: c.senderKey(evt.Info.IsFromMe, evt.Info.Sender), Author: evt.Info.PushName, Text: text,
		TS: evt.Info.Timestamp.UnixMilli(), Mine: evt.Info.IsFromMe,
		RawChat: raw.String(), RawSender: evt.Info.Sender.ToNonAD().String()}
	if media != nil {
		m.Kind, m.Mime, m.FileName, m.Size = media.Kind, media.Mime, media.FileName, media.Size
		m.Width, m.Height, m.Seconds, m.Thumb, m.MediaProto = media.Width, media.Height, media.Seconds, media.Thumb, media.Proto
	}
	c.quoted(&m, chat, contextOf(evt.Message))
	c.remember(m)
	c.namesDirty.Store(true)
	return !known && !evt.Info.IsFromMe
}

// The message a reply answers, as WhatsApp quoted it.
func (c *connector) quoted(m *message, chat types.JID, info *waE2E.ContextInfo) {
	if info.GetStanzaID() == "" {
		return
	}
	m.ReplyTo = chat.String() + ":" + info.GetStanzaID()
	m.QuoteText = textOf(info.GetQuotedMessage())
	if quoted, caption := attachmentOf(info.GetQuotedMessage()); m.QuoteText == "" && quoted != nil {
		m.QuoteText = caption
		if m.QuoteText == "" {
			m.QuoteText = quoted.Kind
		}
	}
	if participant, err := types.ParseJID(info.GetParticipant()); err == nil && info.GetParticipant() != "" {
		sender := c.canonical(participant)
		if c.client != nil && c.client.Store.ID != nil && sender.User == c.canonical(*c.client.Store.ID).User {
			m.QuoteSender = "me"
		} else {
			m.QuoteSender = sender.String()
		}
	} else if chat.Server != types.GroupServer {
		m.QuoteSender = chat.String()
	}
}

// An edit or a revocation, accepted from the author only; in a group an
// admin may also revoke someone else's message.
func (c *connector) protocol(evt *events.Message, p *waE2E.ProtocolMessage) {
	chat := c.canonical(evt.Info.Chat)
	id := chat.String() + ":" + p.GetKey().GetID()
	stored, ok := c.load(id)
	if !ok {
		return
	}
	author := stored.Sender == c.senderKey(evt.Info.IsFromMe, evt.Info.Sender)
	switch p.GetType() {
	case waE2E.ProtocolMessage_REVOKE:
		if !author && !evt.Info.IsGroup {
			return
		}
		c.markDeleted(id)
	case waE2E.ProtocolMessage_MESSAGE_EDIT:
		text := textOf(p.GetEditedMessage())
		if !author || text == "" {
			return
		}
		c.markEdited(id, text)
	}
}

func (c *connector) markDeleted(id string) {
	_, err := c.vault.db.ExecContext(c.ctx, `UPDATE rv_messages SET text = '', deleted = 1 WHERE id = ?`, id)
	if err == nil {
		_, err = c.vault.db.ExecContext(c.ctx, `DELETE FROM rv_reactions WHERE message = ?`, id)
	}
	if err != nil {
		c.fail("local_storage_failed")
		return
	}
	c.emitStored(id)
}

func (c *connector) markEdited(id, text string) {
	if _, err := c.vault.db.ExecContext(c.ctx, `UPDATE rv_messages SET text = ?, edited = 1 WHERE id = ? AND deleted = 0`, text, id); err != nil {
		c.fail("local_storage_failed")
		return
	}
	c.emitStored(id)
}

// History arrives newest first: replayed oldest first so edits and
// revocations find their message.
func (c *connector) history(evt *events.HistorySync) {
	for _, conversation := range evt.Data.GetConversations() {
		if conversation.GetEphemeralExpiration() != 0 {
			continue
		}
		jid, err := validChat(conversation.GetID())
		if err != nil {
			continue
		}
		// The phone's own count, from the first full sync: newer than mine.
		if evt.Data.GetSyncType() == waHistorySync.HistorySync_INITIAL_BOOTSTRAP || evt.Data.GetSyncType() == waHistorySync.HistorySync_FULL {
			unread := int64(conversation.GetUnreadCount())
			if conversation.GetMarkedAsUnread() && unread == 0 {
				unread = 1
			}
			c.setUnread(c.canonical(jid).String(), unread, true)
		}
		entries := conversation.GetMessages()
		for i := len(entries) - 1; i >= 0; i-- {
			web := entries[i].GetMessage()
			if parsed, err := c.client.ParseWebMessage(jid, web); err == nil {
				c.receive(parsed, conversation.GetName())
			}
			c.historyReactions(jid, web)
		}
	}
	if c.normalize() {
		c.reload()
	}
	c.prune()
	c.namesDirty.Store(true)
	c.kickAvatars()
}

func (c *connector) historyReactions(chat types.JID, web *waWeb.WebMessageInfo) {
	target := c.canonical(chat).String() + ":" + web.GetKey().GetID()
	for _, r := range web.GetReactions() {
		key := r.GetKey()
		sender := "me"
		if !key.GetFromMe() {
			from := key.GetParticipant()
			if from == "" {
				from = key.GetRemoteJID()
			}
			jid, err := types.ParseJID(from)
			if err != nil {
				continue
			}
			sender = c.canonical(jid).String()
		}
		c.storeReaction(target, sender, r.GetText(), r.GetSenderTimestampMS())
	}
}

// The client drops its projection and takes the whole cache again.
func (c *connector) reload() {
	c.emit(wire{Type: "reload"})
	if err := c.replay(); err != nil {
		c.fail("local_storage_failed")
	}
}

func (c *connector) event(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		c.emit(wire{Type: "status", State: "connected"})
		go c.refreshGroups()
		c.kickAvatars()
	case *events.Disconnected:
		c.emit(wire{Type: "status", State: "offline"})
	case *events.PairSuccess:
		if c.vault.checkpoint() != nil {
			c.stopOnStorageFailure()
			return
		}
		c.emit(wire{Type: "status", State: "paired"})
		c.emitAccount()
	case *events.LoggedOut:
		c.stopped.Store(true)
		if c.vault.revoke() != nil {
			c.fail("state_removal_failed")
		}
		c.emit(wire{Type: "status", State: "logged_out"})
	case *events.StreamReplaced:
		c.emit(wire{Type: "status", State: "replaced"})
	case *events.Message:
		if c.receive(evt, "") {
			c.setUnread(c.canonical(evt.Info.Chat).String(), 1, false)
		}
	case *events.Receipt:
		c.receipt(evt)
	case *events.MarkChatAsRead:
		c.markedRead(evt)
	case *events.HistorySync:
		c.history(evt)
	case *events.Contact, *events.PushName, *events.BusinessName, *events.AppStateSyncComplete:
		c.namesDirty.Store(true)
	case *events.GroupInfo:
		if evt.Name != nil {
			c.setChatName(c.canonical(evt.JID), evt.Name.Name)
		}
	case *events.JoinedGroup:
		c.setChatName(c.canonical(evt.JID), evt.Name)
	case *events.Picture:
		c.invalidateAvatar(c.canonical(evt.JID))
	}
}

// Which WhatsApp account this device is linked to, once it is.
func (c *connector) emitAccount() {
	if c.client.Store.ID == nil {
		return
	}
	c.emit(wire{Type: "account", JID: c.client.Store.ID.ToNonAD().String(), Name: c.client.Store.PushName})
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
				switch item.Event {
				case whatsmeow.QRChannelEventCode:
					c.emit(wire{Type: "qr", Code: item.Code, ExpiresMS: item.Timeout.Milliseconds()})
				case whatsmeow.QRChannelSuccess.Event:
				case whatsmeow.QRChannelTimeout.Event:
					c.emit(wire{Type: "status", State: "qr_expired"})
				case whatsmeow.QRChannelClientOutdated.Event:
					c.fail("client_outdated")
				default:
					// Scanned by a phone without multi-device, unexpected state, or a pairing error.
					c.fail("pairing_failed")
				}
			}
		}()
	}
	if err := c.client.ConnectContext(c.ctx); err != nil {
		c.fail("connection_failed")
	}
}
func (c *connector) ready() bool {
	return !c.stopped.Load() && c.client.IsLoggedIn() && c.client.IsConnected()
}
func (c *connector) send(cmd command) {
	if !c.ready() {
		c.refuse(cmd.ID, "not_connected")
		return
	}
	chat, err := validChat(cmd.Chat)
	if err != nil || len(cmd.Text) == 0 || len(cmd.Text) > maxText || len(cmd.ID) < 8 || len(cmd.ID) > 64 {
		c.refuse(cmd.ID, "invalid_send")
		return
	}
	raw := c.rawChatFor(chat)
	// Persist the send intent before the network request. Reopening never replays it.
	m := message{ID: cmd.Chat + ":" + cmd.ID, Chat: cmd.Chat, Name: chat.User, Sender: "me", Text: cmd.Text,
		TS: now(), Mine: true, Status: "sending", RawChat: raw.String()}
	content := &waE2E.Message{Conversation: proto.String(cmd.Text)}
	if cmd.Reply != "" {
		quoted, quotedChat, waid, ok := c.target(cmd.Reply)
		if !ok || quoted.Chat != cmd.Chat || quoted.Deleted {
			c.refuse(cmd.ID, "invalid_send")
			return
		}
		m.ReplyTo, m.QuoteSender, m.QuoteText = quoted.ID, quoted.Sender, quoted.Text
		info := &waE2E.ContextInfo{
			StanzaID:      proto.String(string(waid)),
			Participant:   proto.String(c.keySender(quoted, quotedChat).String()),
			QuotedMessage: &waE2E.Message{Conversation: proto.String(quoted.Text)},
		}
		if quotedChat.Server == types.GroupServer {
			info.RemoteJID = proto.String(quotedChat.String())
		}
		content = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(cmd.Text), ContextInfo: info}}
	}
	result, err := c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_messages(`+messageColumns+`)
 VALUES(`+messageValues+`) ON CONFLICT(id) DO NOTHING`, m.values()...)
	if err != nil {
		c.refuse(cmd.ID, "local_storage_failed")
		return
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		c.refuse(cmd.ID, "send_already_recorded")
		return
	}
	if c.vault.checkpoint() != nil {
		c.stopOnStorageFailure()
		return
	}
	c.emit(wire{Type: "message", Message: &m})
	ctx, cancel := context.WithTimeout(c.ctx, 45*time.Second)
	defer cancel()
	response, err := c.client.SendMessage(ctx, raw, content, whatsmeow.SendRequestExtra{ID: types.MessageID(cmd.ID)})
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

// The JID my own messages are keyed under in a chat's addressing.
func (c *connector) ownJID(chat types.JID) types.JID {
	if chat.Server == types.HiddenUserServer && !c.client.Store.LID.IsEmpty() {
		return c.client.Store.LID.ToNonAD()
	}
	if c.client.Store.ID != nil {
		return c.client.Store.ID.ToNonAD()
	}
	return types.JID{}
}

// The key's sender: me, or the author as WhatsApp addressed them.
func (c *connector) keySender(m message, chat types.JID) types.JID {
	if m.Mine {
		return c.ownJID(chat)
	}
	if jid, err := types.ParseJID(m.RawSender); err == nil && m.RawSender != "" {
		return jid
	}
	jid, _ := types.ParseJID(m.Sender)
	return jid
}

// Reacts with an emoji, or takes my reaction back with an empty one.
func (c *connector) react(cmd command) {
	m, chat, waid, ok := c.target(cmd.ID)
	if !c.ready() || !ok || m.Deleted || len(cmd.Text) > 64 {
		c.fail("action_failed")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	if _, err := c.client.SendMessage(ctx, chat, c.client.BuildReaction(chat, c.keySender(m, chat), waid, cmd.Text)); err != nil {
		c.fail("action_failed")
		return
	}
	c.storeReaction(m.ID, "me", cmd.Text, now())
}

func (c *connector) edit(cmd command) {
	m, chat, waid, ok := c.target(cmd.ID)
	if !c.ready() || !ok || !m.Mine || m.Deleted || m.Status != "" || len(cmd.Text) == 0 || len(cmd.Text) > maxText {
		c.fail("action_failed")
		return
	}
	if time.Since(time.UnixMilli(m.TS)) > editWindow {
		c.fail("edit_expired")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	if _, err := c.client.SendMessage(ctx, chat, c.client.BuildEdit(chat, waid, &waE2E.Message{Conversation: proto.String(cmd.Text)})); err != nil {
		c.fail("action_failed")
		return
	}
	c.markEdited(m.ID, cmd.Text)
}

// Deletes my message for everyone.
func (c *connector) revoke(cmd command) {
	m, chat, waid, ok := c.target(cmd.ID)
	if !c.ready() || !ok || !m.Mine || m.Deleted || m.Status != "" {
		c.fail("action_failed")
		return
	}
	if time.Since(time.UnixMilli(m.TS)) > revokeWindow {
		c.fail("delete_expired")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	if _, err := c.client.SendMessage(ctx, chat, c.client.BuildRevoke(chat, c.ownJID(chat), waid)); err != nil {
		c.fail("action_failed")
		return
	}
	c.markDeleted(m.ID)
}

// open loads the sealed state under its lock and prepares the client. The
// returned closer checkpoints and releases everything.
func open(path string, key []byte, sink func(wire)) (*connector, func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, nil, err
	}
	lock := flock.New(path + ".lock")
	ok, err := lock.TryLock()
	if err != nil || !ok {
		return nil, nil, fmt.Errorf("session busy")
	}
	v, err := openVault(path, key)
	if err != nil {
		_ = lock.Unlock()
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	fail := func(err error) (*connector, func(), error) {
		cancel()
		v.db.Close()
		_ = lock.Unlock()
		return nil, nil, err
	}
	container := sqlstore.NewWithDB(v.db, "sqlite3", waLog.Noop)
	if err := container.Upgrade(ctx); err != nil {
		return fail(err)
	}
	if err := migrate(v.db); err != nil {
		return fail(err)
	}
	devices, err := container.GetAllDevices(ctx)
	if err != nil {
		return fail(err)
	}
	if len(devices) > 1 {
		return fail(fmt.Errorf("ambiguous session"))
	}
	device := container.NewDevice()
	if len(devices) == 1 {
		device = devices[0]
	}
	c := &connector{vault: v, ctx: ctx, cancel: cancel, sink: sink, avatarKick: make(chan struct{}, 1)}
	c.client = whatsmeow.NewClient(device, waLog.Noop)
	c.client.AddEventHandler(c.event)
	// A crash while sending is an uncertain outcome, never an automatic retry.
	if _, err := v.db.Exec(`UPDATE rv_messages SET status='uncertain' WHERE status='sending'`); err != nil {
		return fail(err)
	}
	c.normalize()
	c.prune()
	if err := c.replay(); err != nil {
		return fail(err)
	}
	c.emitAccount()
	c.emit(wire{Type: "status", State: "loaded"})
	done := make(chan struct{})
	go c.avatarWorker()
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for tick := 1; ; tick++ {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if c.stopped.Load() {
					continue
				}
				if tick%30 == 0 && c.normalize() {
					c.reload()
				}
				if c.namesDirty.Swap(false) {
					c.emitNames()
				}
				if v.checkpoint() != nil {
					c.stopOnStorageFailure()
				}
			}
		}
	}()
	closer := func() {
		cancel()
		c.client.Disconnect()
		<-done
		_ = v.checkpoint()
		v.db.Close()
		_ = lock.Unlock()
	}
	return c, closer, nil
}

// handle runs one client command; it reports false once the engine ended.
func (c *connector) handle(cmd command) bool {
	switch cmd.Type {
	case "connect":
		go c.connect()
	case "send":
		c.send(cmd)
	case "react":
		c.react(cmd)
	case "edit":
		c.edit(cmd)
	case "delete":
		c.revoke(cmd)
	case "read":
		c.read(cmd)
	case "search":
		go c.search(cmd)
	case "download":
		go c.download(cmd)
	case "logout":
		if err := c.client.Logout(c.ctx); err != nil {
			c.fail("logout_failed")
			return true
		}
		c.stopped.Store(true)
		if err := c.vault.revoke(); err != nil {
			c.fail("state_removal_failed")
		}
		c.emit(wire{Type: "status", State: "logged_out"})
		return false
	case "stop":
		return false
	default:
		c.fail("invalid_command")
	}
	return true
}
