//go:build !sqlite_unlock_notify

package main

// The vault's shared in-memory database needs a write to wait for the one
// before it (see vault.go): build with `-tags sqlite_unlock_notify`.
func init() {
	panic("rv-whatsapp must be built with -tags sqlite_unlock_notify")
}
