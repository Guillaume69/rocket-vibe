package engine

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/mattn/go-sqlite3"
)

const maxStateBytes = 128 << 20

var stateHeader = []byte("RVWA1")

// SQLite lives in RAM. Only an authenticated ciphertext reaches disk.
//
// whatsmeow needs more than one connection: decrypting a message, it reads
// the identity store outside the transaction it holds, and a one-connection
// ":memory:" database waited for itself there (no message after the first
// one received offline). The database is a shared in-memory cache across a
// pool: reads are read-uncommitted, so they never wait for a transaction, and
// a write waits for the writer before it (go-sqlite3's unlock notify, see
// tags.go) instead of failing. One connection is kept for sealing; it keeps
// the database alive.
type vault struct {
	db      *sql.DB
	seal    *sql.Conn
	path    string
	aead    cipher.AEAD
	mu      sync.Mutex
	revoked bool
	// The digest of the image last sealed: an unchanged one is not rewritten.
	sealed [32]byte
}

func (v *vault) close() {
	_ = v.seal.Close()
	_ = v.db.Close()
}

// The pool's driver: every connection reads without waiting for writers, and
// checks foreign keys like whatsmeow's schema expects.
func init() {
	sql.Register("sqlite3_rv", &sqlite3.SQLiteDriver{ConnectHook: func(conn *sqlite3.SQLiteConn) error {
		_, err := conn.Exec("PRAGMA read_uncommitted = 1; PRAGMA foreign_keys = ON;", nil)
		return err
	}})
}

func openVault(path string, key []byte) (*vault, error) {
	if len(key) != 32 {
		return nil, errors.New("invalid storage key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	name := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, name); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3_rv", fmt.Sprintf("file:rvwa-%x?mode=memory&cache=shared&_busy_timeout=15000", name))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetConnMaxIdleTime(0)
	seal, err := db.Conn(context.Background())
	if err != nil {
		db.Close()
		return nil, err
	}
	v := &vault{db: db, seal: seal, path: path, aead: aead}
	if info, statErr := os.Stat(path); statErr == nil && info.Size() > maxStateBytes {
		v.close()
		return nil, errors.New("state too large")
	}
	blob, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		v.close()
		return nil, err
	}
	if len(blob) > 0 {
		plain, err := v.unseal(blob)
		if err != nil {
			v.close()
			return nil, err
		}
		err = v.restore(plain)
		v.sealed = sha256.Sum256(plain)
		clear(plain)
		if err != nil {
			v.close()
			return nil, err
		}
	} else if err == nil {
		v.close()
		return nil, errors.New("empty state")
	}
	return v, nil
}

// Restores a serialized database. sqlite3_deserialize as go-sqlite3 calls
// it makes a buffer that cannot grow ("database or disk is full" on the first
// write past it), so the image goes to a scratch connection and SQLite's
// backup copies it into the main in-memory database, which grows freely.
func (v *vault) restore(image []byte) error {
	scratch, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		return err
	}
	defer scratch.Close()
	scratch.SetMaxOpenConns(1)
	conn, err := scratch.Conn(context.Background())
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Raw(func(driver any) error {
		source, ok := driver.(*sqlite3.SQLiteConn)
		if !ok {
			return errors.New("wrong database driver")
		}
		if err := source.Deserialize(image, "main"); err != nil {
			return err
		}
		return v.raw(func(target *sqlite3.SQLiteConn) error {
			backup, err := target.Backup("main", source, "main")
			if err != nil {
				return err
			}
			done, err := backup.Step(-1)
			if finish := backup.Finish(); err == nil {
				err = finish
			}
			if err == nil && !done {
				err = errors.New("incomplete restore")
			}
			return err
		})
	})
}

// Runs `f` on the sealing connection's driver.
func (v *vault) raw(f func(*sqlite3.SQLiteConn) error) error {
	return v.seal.Raw(func(driver any) error {
		sqlite, ok := driver.(*sqlite3.SQLiteConn)
		if !ok {
			return errors.New("wrong database driver")
		}
		return f(sqlite)
	})
}
func (v *vault) unseal(blob []byte) ([]byte, error) {
	n := len(stateHeader)
	if len(blob) > maxStateBytes || len(blob) < n+v.aead.NonceSize()+v.aead.Overhead() || string(blob[:n]) != string(stateHeader) {
		return nil, errors.New("invalid state")
	}
	return v.aead.Open(nil, blob[n:n+v.aead.NonceSize()], blob[n+v.aead.NonceSize():], stateHeader)
}

func (v *vault) checkpoint() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.revoked {
		return nil
	}
	var plain []byte
	err := v.raw(func(c *sqlite3.SQLiteConn) error {
		var err error
		plain, err = c.Serialize("main")
		return err
	})
	if err != nil {
		return err
	}
	defer clear(plain)
	if len(plain) > maxStateBytes-128 {
		return errors.New("state too large")
	}
	// An image like the one sealed last is not written again.
	digest := sha256.Sum256(plain)
	if digest == v.sealed {
		return nil
	}
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	blob := append(append([]byte{}, stateHeader...), nonce...)
	blob = v.aead.Seal(blob, nonce, plain, stateHeader)
	if err := os.MkdirAll(filepath.Dir(v.path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(v.path), ".state-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(blob); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, v.path); err != nil {
		return err
	}
	v.sealed = digest
	return nil
}
func (v *vault) revoke() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.revoked = true
	err := os.Remove(v.path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
