package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/mattn/go-sqlite3"
)

const maxStateBytes = 128 << 20

var stateHeader = []byte("RVWA1")

// SQLite lives in RAM. Only an authenticated ciphertext reaches disk.
type vault struct {
	db      *sql.DB
	path    string
	aead    cipher.AEAD
	mu      sync.Mutex
	revoked bool
	// SQLite's total_changes() at the last sealed snapshot, -1 before the first.
	saved int64
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
	db, err := sql.Open("sqlite3", ":memory:?_foreign_keys=on")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	v := &vault{db: db, path: path, aead: aead, saved: -1}
	if info, statErr := os.Stat(path); statErr == nil && info.Size() > maxStateBytes {
		db.Close()
		return nil, errors.New("state too large")
	}
	blob, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		db.Close()
		return nil, err
	}
	if len(blob) > 0 {
		plain, err := v.unseal(blob)
		if err != nil {
			db.Close()
			return nil, err
		}
		err = v.raw(func(c *sqlite3.SQLiteConn) error { return c.Deserialize(plain, "main") })
		clear(plain)
		if err == nil {
			v.saved, err = v.changes()
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	} else if err == nil {
		db.Close()
		return nil, errors.New("empty state")
	}
	return v, nil
}

func (v *vault) raw(f func(*sqlite3.SQLiteConn) error) error {
	conn, err := v.db.Conn(context.Background())
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Raw(func(driver any) error {
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

// The rows written on the single in-memory connection since it opened.
func (v *vault) changes() (int64, error) {
	var n int64
	err := v.db.QueryRow("SELECT total_changes()").Scan(&n)
	return n, err
}
func (v *vault) checkpoint() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.revoked {
		return nil
	}
	// Sealing serializes the whole database: skip it when nothing was written.
	changes, err := v.changes()
	if err != nil {
		return err
	}
	if changes == v.saved {
		return nil
	}
	var plain []byte
	err = v.raw(func(c *sqlite3.SQLiteConn) error {
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
	v.saved = changes
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
