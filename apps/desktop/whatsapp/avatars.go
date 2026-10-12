package main

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

const (
	// A checked photo is asked again after a week, or when WhatsApp says it changed.
	avatarFresh = 7 * 24 * time.Hour
	// One query at a time, spaced, so a large account does not trip rate limits.
	avatarPause   = 400 * time.Millisecond
	maxAvatarSize = 512 << 10
	// Chats by latest activity, then the authors of recent group messages.
	avatarChats   = 300
	avatarAuthors = 3000
)

func (c *connector) emitAvatar(jid string, data []byte) {
	encoded := base64.StdEncoding.EncodeToString(data)
	c.emit(wire{Type: "avatar", JID: jid, Data: &encoded})
}

func (c *connector) replayAvatars() {
	rows, err := c.vault.db.QueryContext(c.ctx, `SELECT jid,data FROM rv_avatars WHERE length(data) > 0`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var jid string
		var data []byte
		if rows.Scan(&jid, &data) == nil {
			c.emitAvatar(jid, data)
		}
	}
}

func (c *connector) invalidateAvatar(jid types.JID) {
	_, _ = c.vault.db.ExecContext(c.ctx, `UPDATE rv_avatars SET checked = 0 WHERE jid = ?`, jid.String())
	c.kickAvatars()
}

func (c *connector) kickAvatars() {
	select {
	case c.avatarKick <- struct{}{}:
	default:
	}
}

// Runs while the engine lives: a pass over the stale photos after each
// connection or change notice.
func (c *connector) avatarWorker() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-c.avatarKick:
		}
		for _, jid := range c.staleAvatars() {
			if c.ctx.Err() != nil || c.stopped.Load() || !c.client.IsConnected() {
				break
			}
			c.fetchAvatar(jid)
			select {
			case <-c.ctx.Done():
				return
			case <-time.After(avatarPause):
			}
		}
	}
}

func (c *connector) staleAvatars() []types.JID {
	rows, err := c.vault.db.QueryContext(c.ctx, `WITH wanted(jid, recent) AS (
   SELECT chat, max(ts) FROM rv_messages GROUP BY chat ORDER BY max(ts) DESC LIMIT ?
 ), authors(jid, recent) AS (
   SELECT sender, max(ts) FROM (SELECT sender, ts FROM rv_messages WHERE chat LIKE '%@g.us' AND sender != 'me'
   ORDER BY ts DESC LIMIT ?) GROUP BY sender
 )
 SELECT jid FROM (SELECT jid, recent FROM wanted UNION ALL SELECT jid, recent - 1 FROM authors)
 WHERE jid NOT IN (SELECT jid FROM rv_avatars WHERE checked > ?)
 GROUP BY jid ORDER BY max(recent) DESC`, avatarChats, avatarAuthors, time.Now().Add(-avatarFresh).UnixMilli())
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []types.JID
	// My own photo first: my messages and the account show it.
	if c.client.Store.ID != nil {
		own := c.canonical(*c.client.Store.ID)
		var checked int64
		_ = c.vault.db.QueryRowContext(c.ctx, `SELECT checked FROM rv_avatars WHERE jid = ?`, own.String()).Scan(&checked)
		if checked <= time.Now().Add(-avatarFresh).UnixMilli() {
			out = append(out, own)
		}
	}
	for rows.Next() {
		var value string
		if rows.Scan(&value) != nil {
			continue
		}
		if jid, err := validChat(value); err == nil {
			out = append(out, jid)
		}
	}
	return out
}

func (c *connector) fetchAvatar(jid types.JID) {
	var existing string
	_ = c.vault.db.QueryRowContext(c.ctx, `SELECT picture FROM rv_avatars WHERE jid = ? AND length(data) > 0`, jid.String()).Scan(&existing)
	ctx, cancel := context.WithTimeout(c.ctx, 20*time.Second)
	defer cancel()
	info, err := c.client.GetProfilePictureInfo(ctx, jid, &whatsmeow.GetProfilePictureParams{Preview: true, ExistingID: existing})
	switch {
	case errors.Is(err, whatsmeow.ErrProfilePictureNotSet) || errors.Is(err, whatsmeow.ErrProfilePictureUnauthorized):
		c.keepAvatar(jid, "", nil)
		return
	case err != nil:
		// Network or server trouble: asked again at the next pass.
		return
	case info == nil:
		// Unchanged since the photo kept.
		_, _ = c.vault.db.ExecContext(c.ctx, `UPDATE rv_avatars SET checked = ? WHERE jid = ?`, now(), jid.String())
		return
	}
	data, err := download(ctx, info.URL)
	if err != nil {
		return
	}
	c.keepAvatar(jid, info.ID, data)
}

func (c *connector) keepAvatar(jid types.JID, picture string, data []byte) {
	_, err := c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_avatars(jid,picture,data,checked) VALUES(?,?,?,?)
 ON CONFLICT(jid) DO UPDATE SET picture=excluded.picture,data=excluded.data,checked=excluded.checked`,
		jid.String(), picture, data, now())
	if err == nil {
		c.emitAvatar(jid.String(), data)
	}
}

// Fetches a photo from WhatsApp's own CDN only, bounded in size.
func download(ctx context.Context, address string) ([]byte, error) {
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "https" || !strings.HasSuffix(parsed.Hostname(), ".whatsapp.net") {
		return nil, errors.New("unexpected photo address")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("photo unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxAvatarSize+1))
	if err != nil || len(data) > maxAvatarSize {
		return nil, errors.New("photo too large")
	}
	return data, nil
}
