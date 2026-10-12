package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofrs/flock"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

func testVault(t *testing.T) (*vault, []byte) {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	v, err := openVault(filepath.Join(t.TempDir(), "state.bin"), key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { v.db.Close() })
	return v, key
}
func TestStateIsAuthenticatedEncryptedAndRestoresSQLite(t *testing.T) {
	v, key := testVault(t)
	if _, err := v.db.Exec("CREATE TABLE secrets (value TEXT); INSERT INTO secrets VALUES ('a-private-session-and-message')"); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(v.path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte("a-private-session-and-message")) || bytes.Contains(blob, []byte("SQLite format")) {
		t.Fatal("plaintext reached disk")
	}
	restored, err := openVault(v.path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.db.Close()
	var value string
	if err := restored.db.QueryRow("SELECT value FROM secrets").Scan(&value); err != nil || value != "a-private-session-and-message" {
		t.Fatalf("restore failed: %v", err)
	}
	wrong := append([]byte{}, key...)
	wrong[0] ^= 1
	if broken, err := openVault(v.path, wrong); err == nil {
		broken.db.Close()
		t.Fatal("wrong key accepted")
	}
	blob[len(blob)-1] ^= 1
	if err := os.WriteFile(v.path, blob, 0600); err != nil {
		t.Fatal(err)
	}
	if broken, err := openVault(v.path, key); err == nil {
		broken.db.Close()
		t.Fatal("tampered state accepted")
	}
}
func TestRevocationCannotBeUndoneByCheckpoint(t *testing.T) {
	v, _ := testVault(t)
	if _, err := v.db.Exec("CREATE TABLE test(value)"); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	if err := v.revoke(); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(v.path); !os.IsNotExist(err) {
		t.Fatal("revoked session restored")
	}
}
func TestTwoProcessesCannotUseOneState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.lock")
	a, b := flock.New(path), flock.New(path)
	ok, err := a.TryLock()
	if err != nil || !ok {
		t.Fatal("first lock failed")
	}
	defer a.Unlock()
	ok, err = b.TryLock()
	if err != nil || ok {
		t.Fatal("concurrent session accepted")
	}
}
func TestUnsupportedPrivateMessageIsNotStored(t *testing.T) {
	c := &connector{ctx: context.Background()}
	for _, evt := range []*events.Message{
		{Message: &waE2E.Message{}, IsEphemeral: true},
		{Message: &waE2E.Message{}, IsViewOnce: true},
	} {
		c.receive(evt, "") // A database/client access would panic.
	}
}
func TestRecipientScope(t *testing.T) {
	for _, chat := range []string{"123@s.whatsapp.net", "123@g.us", "123@lid"} {
		if _, err := validChat(chat); err != nil {
			t.Fatalf("valid recipient rejected: %s", chat)
		}
	}
	for _, chat := range []string{"", "@g.us", "123@evil.example", "123:4@s.whatsapp.net"} {
		if _, err := validChat(chat); err == nil {
			t.Fatalf("invalid recipient accepted: %s", chat)
		}
	}
}

func TestFreshProtocolStoreCanInitializeAndRestore(t *testing.T) {
	v, key := testVault(t)
	container := sqlstore.NewWithDB(v.db, "sqlite3", waLog.Noop)
	if err := container.Upgrade(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	restored, err := openVault(v.path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.db.Close()
	if err := sqlstore.NewWithDB(restored.db, "sqlite3", waLog.Noop).Upgrade(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestCheckpointSkipsAnUnchangedDatabase(t *testing.T) {
	v, key := testVault(t)
	if _, err := v.db.Exec("CREATE TABLE test(value); INSERT INTO test VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(v.path); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(v.path); !os.IsNotExist(err) {
		t.Fatal("an unchanged database was sealed again")
	}
	if _, err := v.db.Exec("INSERT INTO test VALUES (2)"); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	restored, err := openVault(v.path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.db.Close()
	if err := restored.checkpoint(); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := restored.db.QueryRow("SELECT count(*) FROM test").Scan(&n); err != nil || n != 2 {
		t.Fatalf("restored %d rows: %v", n, err)
	}
}
func TestPruneKeepsTheNewestAndUnsettledMessages(t *testing.T) {
	v, _ := testVault(t)
	if err := migrate(v.db); err != nil {
		t.Fatal(err)
	}
	insert := func(id string, ts int64, status string) {
		if _, err := v.db.Exec(`INSERT INTO rv_messages(id,chat,name,sender,author,text,ts,mine,status) VALUES(?,?,?,?,?,?,?,?,?)`, id, "c", "", "", "", "x", ts, false, status); err != nil {
			t.Fatal(err)
		}
	}
	insert("oldest-uncertain", 0, "uncertain")
	for i := int64(1); i <= maxCached+5; i++ {
		insert(fmt.Sprintf("m%06d", i), i, "")
	}
	c := &connector{vault: v, ctx: context.Background()}
	c.prune()
	var n int
	if err := v.db.QueryRow("SELECT count(*) FROM rv_messages WHERE status = ''").Scan(&n); err != nil || n != maxCached {
		t.Fatalf("kept %d settled messages: %v", n, err)
	}
	var oldest int64
	if err := v.db.QueryRow("SELECT min(ts) FROM rv_messages WHERE status = ''").Scan(&oldest); err != nil || oldest != 6 {
		t.Fatalf("oldest kept %d: %v", oldest, err)
	}
	if err := v.db.QueryRow("SELECT count(*) FROM rv_messages WHERE id = 'oldest-uncertain'").Scan(&n); err != nil || n != 1 {
		t.Fatal("an uncertain send was pruned")
	}
}

func engineWithCache(t *testing.T) *connector {
	t.Helper()
	v, _ := testVault(t)
	if err := migrate(v.db); err != nil {
		t.Fatal(err)
	}
	return &connector{vault: v, ctx: context.Background()}
}

func received(c *connector, chat, sender types.JID, id string, m *waE2E.Message) {
	c.receive(&events.Message{Info: types.MessageInfo{
		MessageSource: types.MessageSource{Chat: chat, Sender: sender},
		ID:            types.MessageID(id), Timestamp: time.UnixMilli(1000),
	}, Message: m}, "")
}

func TestOnlyTheAuthorEditsAndRevokesInADirectChat(t *testing.T) {
	c := engineWithCache(t)
	alice := types.NewJID("33600000001", types.DefaultUserServer)
	mallory := types.NewJID("33600000002", types.DefaultUserServer)
	received(c, alice, alice, "X1", &waE2E.Message{Conversation: proto.String("first")})
	edit := func(from types.JID, text string) *waE2E.Message {
		return &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: &waCommon.MessageKey{ID: proto.String("X1")},
			EditedMessage: &waE2E.Message{Conversation: proto.String(text)},
		}}
	}
	received(c, alice, mallory, "X2", edit(mallory, "forged"))
	if m, _ := c.load(alice.String() + ":X1"); m.Text != "first" || m.Edited {
		t.Fatalf("someone else's edit applied: %+v", m)
	}
	received(c, alice, alice, "X3", edit(alice, "second"))
	if m, _ := c.load(alice.String() + ":X1"); m.Text != "second" || !m.Edited {
		t.Fatalf("the author's edit lost: %+v", m)
	}
	revoke := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: proto.String("X1")},
	}}
	received(c, alice, mallory, "X4", revoke)
	if m, _ := c.load(alice.String() + ":X1"); m.Deleted {
		t.Fatal("someone else revoked a direct message")
	}
	received(c, alice, alice, "X5", revoke)
	if m, _ := c.load(alice.String() + ":X1"); !m.Deleted || m.Text != "" {
		t.Fatalf("the author's revocation lost: %+v", m)
	}
}

func TestReactionsReplaceAndRetract(t *testing.T) {
	c := engineWithCache(t)
	alice := types.NewJID("33600000001", types.DefaultUserServer)
	received(c, alice, alice, "X1", &waE2E.Message{Conversation: proto.String("hello")})
	react := func(emoji string, ts int64) {
		c.receive(&events.Message{Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: alice, Sender: alice}, ID: "R", Timestamp: time.UnixMilli(ts),
		}, Message: &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
			Key: &waCommon.MessageKey{ID: proto.String("X1")}, Text: proto.String(emoji),
		}}}, "")
	}
	count := func() (n int, emoji string) {
		_ = c.vault.db.QueryRow(`SELECT count(*), coalesce(max(emoji), '') FROM rv_reactions`).Scan(&n, &emoji)
		return
	}
	react("👍", 2000)
	react("❤️", 3000)
	react("😂", 2500) // older than the kept one: ignored
	if n, emoji := count(); n != 1 || emoji != "❤️" {
		t.Fatalf("kept %d reactions, %q", n, emoji)
	}
	react("", 4000)
	if n, _ := count(); n != 0 {
		t.Fatal("a retracted reaction stayed")
	}
}

func TestUnreadCountsAndReceipts(t *testing.T) {
	c := engineWithCache(t)
	alice := types.NewJID("33600000001", types.DefaultUserServer)
	c.event(&events.Message{Info: types.MessageInfo{
		MessageSource: types.MessageSource{Chat: alice, Sender: alice}, ID: "X1", Timestamp: time.UnixMilli(1000),
	}, Message: &waE2E.Message{Conversation: proto.String("hello")}})
	unread := func() (n int64) {
		_ = c.vault.db.QueryRow(`SELECT unread FROM rv_chats WHERE jid = ?`, alice.String()).Scan(&n)
		return
	}
	if unread() != 1 {
		t.Fatalf("unread %d after one message", unread())
	}
	// The same message again (history after live) does not count twice.
	c.event(&events.Message{Info: types.MessageInfo{
		MessageSource: types.MessageSource{Chat: alice, Sender: alice}, ID: "X1", Timestamp: time.UnixMilli(1000),
	}, Message: &waE2E.Message{Conversation: proto.String("hello")}})
	if unread() != 1 {
		t.Fatalf("unread %d after a duplicate", unread())
	}
	// Read on the phone.
	c.event(&events.Receipt{MessageSource: types.MessageSource{Chat: alice, Sender: alice, IsFromMe: true},
		MessageIDs: []types.MessageID{"X1"}, Type: types.ReceiptTypeReadSelf})
	if unread() != 0 {
		t.Fatal("reading on the phone left the chat unread")
	}
	// My message, then Alice's receipts: delivered then read, never back.
	if _, err := c.vault.db.Exec(`INSERT INTO rv_messages(id,chat,name,sender,author,text,ts,mine,status)
 VALUES(?,?,'','me','','mine',2000,1,'')`, alice.String()+":M1", alice.String()); err != nil {
		t.Fatal(err)
	}
	receipt := func(kind types.ReceiptType) string {
		c.event(&events.Receipt{MessageSource: types.MessageSource{Chat: alice, Sender: alice},
			MessageIDs: []types.MessageID{"M1"}, Type: kind})
		m, _ := c.load(alice.String() + ":M1")
		return m.Receipt
	}
	if got := receipt(types.ReceiptTypeRead); got != "read" {
		t.Fatalf("receipt %q", got)
	}
	if got := receipt(types.ReceiptTypeDelivered); got != "read" {
		t.Fatalf("a delivery moved a read message back: %q", got)
	}
}

func TestAReplyKeepsItsQuote(t *testing.T) {
	c := engineWithCache(t)
	alice := types.NewJID("33600000001", types.DefaultUserServer)
	received(c, alice, alice, "X1", &waE2E.Message{Conversation: proto.String("question")})
	received(c, alice, alice, "X2", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: proto.String("answer"),
		ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("X1"), Participant: proto.String(alice.String()),
			QuotedMessage: &waE2E.Message{Conversation: proto.String("question")}},
	}})
	m, _ := c.load(alice.String() + ":X2")
	if m.ReplyTo != alice.String()+":X1" || m.QuoteSender != alice.String() || m.QuoteText != "question" {
		t.Fatalf("quote lost: %+v", m)
	}
}

// A restored state grows: the first session after a restart writes keys,
// history and messages far past the size it was sealed at.
func TestARestoredStateGrows(t *testing.T) {
	v, key := testVault(t)
	if _, err := v.db.Exec("CREATE TABLE test(value TEXT); INSERT INTO test VALUES ('seed')"); err != nil {
		t.Fatal(err)
	}
	if err := v.checkpoint(); err != nil {
		t.Fatal(err)
	}
	restored, err := openVault(v.path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.db.Close()
	if err := migrate(restored.db); err != nil {
		t.Fatalf("migration on a restored state: %v", err)
	}
	payload := strings.Repeat("x", 4096)
	for i := 0; i < 2000; i++ {
		if _, err := restored.db.Exec("INSERT INTO test VALUES (?)", payload); err != nil {
			t.Fatalf("write %d after a restore: %v", i, err)
		}
	}
	if err := restored.checkpoint(); err != nil {
		t.Fatal(err)
	}
	again, err := openVault(v.path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer again.db.Close()
	var n int
	if err := again.db.QueryRow("SELECT count(*) FROM test").Scan(&n); err != nil || n != 2001 {
		t.Fatalf("restored %d rows: %v", n, err)
	}
}

func TestPhoneNumbersAreRecognised(t *testing.T) {
	for query, want := range map[string]string{"+33 6 12 34 56 78": "33612345678", "06-12-34-56-78": "0612345678"} {
		if got, ok := phoneDigits(query); !ok || got != want {
			t.Fatalf("%q: %q %v", query, got, ok)
		}
	}
	for _, query := range []string{"Alice", "12345", "+33 6 alice"} {
		if _, ok := phoneDigits(query); ok {
			t.Fatalf("%q taken for a number", query)
		}
	}
}
