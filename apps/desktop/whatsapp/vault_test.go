package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofrs/flock"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
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
		{Message: &waE2E.Message{}, IsEdit: true},
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
