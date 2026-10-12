package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// WhatsApp's own ceiling for media; larger files are refused before upload.
const maxUpload = 100 << 20

// What an outgoing file is sent as, from its type: a voice note only when the
// app recorded it (Ogg/Opus), a video only as MP4, anything else a document.
func outgoingKind(mimeType string, voice bool) (string, whatsmeow.MediaType) {
	base := strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0])
	switch {
	case voice && base == "audio/ogg":
		return "voice", whatsmeow.MediaAudio
	case base == "image/jpeg" || base == "image/png" || base == "image/webp":
		return "image", whatsmeow.MediaImage
	case base == "video/mp4":
		return "video", whatsmeow.MediaVideo
	case strings.HasPrefix(base, "audio/"):
		return "audio", whatsmeow.MediaAudio
	}
	return "document", whatsmeow.MediaDocument
}

// An Ogg stream's length: the last page's granule position at Opus's 48 kHz.
func oggSeconds(data []byte) int {
	last := bytes.LastIndex(data, []byte("OggS"))
	if last < 0 || last+14 > len(data) {
		return 0
	}
	granule := binary.LittleEndian.Uint64(data[last+6 : last+14])
	if granule == ^uint64(0) {
		return 0
	}
	return int(granule / 48000)
}

// An image's size and a small JPEG preview, as WhatsApp shows before download.
func imagePreview(data []byte) (int, int, []byte) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return 0, 0, nil
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	const side = 96
	scale := float64(side) / float64(max(w, h))
	if scale > 1 {
		scale = 1
	}
	tw, th := max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))
	thumb := image.NewRGBA(image.Rect(0, 0, tw, th))
	for y := 0; y < th; y++ {
		for x := 0; x < tw; x++ {
			thumb.Set(x, y, img.At(bounds.Min.X+x*w/tw, bounds.Min.Y+y*h/th))
		}
	}
	var out bytes.Buffer
	if jpeg.Encode(&out, thumb, &jpeg.Options{Quality: 60}) != nil {
		return w, h, nil
	}
	return w, h, out.Bytes()
}

// The quoted message of a send that answers one.
func (c *connector) replyContext(cmd command, m *message) (*waE2E.ContextInfo, bool) {
	if cmd.Reply == "" {
		return nil, true
	}
	quoted, quotedChat, waid, ok := c.target(cmd.Reply)
	if !ok || quoted.Chat != cmd.Chat || quoted.Deleted {
		return nil, false
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
	return info, true
}

// Sends a file. The upload comes first: until the message itself is sent
// nobody sees anything, so a failed upload is a plain refusal. Then, like a
// text, the intent is recorded before the send and never replayed.
func (c *connector) upload(cmd command) {
	if !c.ready() {
		c.refuse(cmd.ID, "not_connected")
		return
	}
	chat, err := validChat(cmd.Chat)
	if err != nil || len(cmd.ID) < 8 || len(cmd.ID) > 64 || len(cmd.Text) > maxText || cmd.Path == "" {
		c.refuse(cmd.ID, "invalid_send")
		return
	}
	info, err := os.Stat(cmd.Path)
	if err != nil || info.Size() == 0 || info.Size() > maxUpload {
		c.refuse(cmd.ID, "file_refused")
		return
	}
	data, err := os.ReadFile(cmd.Path)
	if err != nil {
		c.refuse(cmd.ID, "file_refused")
		return
	}
	kind, mediaType := outgoingKind(cmd.Mime, cmd.Voice)
	raw := c.rawChatFor(chat)
	m := message{ID: cmd.Chat + ":" + cmd.ID, Chat: cmd.Chat, Name: chat.User, Sender: "me", Text: cmd.Text,
		TS: now(), Mine: true, Status: "sending", RawChat: raw.String(), Kind: kind, Mime: cmd.Mime,
		FileName: filepath.Base(cmd.Name), Size: int64(len(data))}
	quoteInfo, ok := c.replyContext(cmd, &m)
	if !ok {
		c.refuse(cmd.ID, "invalid_send")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 3*time.Minute)
	defer cancel()
	uploaded, err := c.client.Upload(ctx, data, mediaType)
	if err != nil {
		c.refuse(cmd.ID, "upload_failed")
		return
	}
	content := &waE2E.Message{}
	switch kind {
	case "image":
		m.Width, m.Height, m.Thumb = imagePreview(data)
		x := &waE2E.ImageMessage{Caption: proto.String(cmd.Text), Mimetype: proto.String(cmd.Mime),
			URL: proto.String(uploaded.URL), DirectPath: proto.String(uploaded.DirectPath), MediaKey: uploaded.MediaKey,
			FileEncSHA256: uploaded.FileEncSHA256, FileSHA256: uploaded.FileSHA256, FileLength: proto.Uint64(uploaded.FileLength),
			Width: proto.Uint32(uint32(m.Width)), Height: proto.Uint32(uint32(m.Height)), JPEGThumbnail: m.Thumb, ContextInfo: quoteInfo}
		content.ImageMessage, m.MediaProto = x, marshalled(x)
	case "video":
		x := &waE2E.VideoMessage{Caption: proto.String(cmd.Text), Mimetype: proto.String(cmd.Mime),
			URL: proto.String(uploaded.URL), DirectPath: proto.String(uploaded.DirectPath), MediaKey: uploaded.MediaKey,
			FileEncSHA256: uploaded.FileEncSHA256, FileSHA256: uploaded.FileSHA256, FileLength: proto.Uint64(uploaded.FileLength),
			ContextInfo: quoteInfo}
		content.VideoMessage, m.MediaProto = x, marshalled(x)
	case "voice", "audio":
		m.Seconds = oggSeconds(data)
		mimeType := cmd.Mime
		if kind == "voice" {
			mimeType = "audio/ogg; codecs=opus"
		}
		m.Mime = mimeType
		x := &waE2E.AudioMessage{Mimetype: proto.String(mimeType), PTT: proto.Bool(kind == "voice"),
			Seconds: proto.Uint32(uint32(m.Seconds)), URL: proto.String(uploaded.URL), DirectPath: proto.String(uploaded.DirectPath),
			MediaKey: uploaded.MediaKey, FileEncSHA256: uploaded.FileEncSHA256, FileSHA256: uploaded.FileSHA256,
			FileLength: proto.Uint64(uploaded.FileLength), ContextInfo: quoteInfo}
		content.AudioMessage, m.MediaProto = x, marshalled(x)
	default:
		x := &waE2E.DocumentMessage{Caption: proto.String(cmd.Text), Mimetype: proto.String(cmd.Mime),
			FileName: proto.String(m.FileName), Title: proto.String(m.FileName), URL: proto.String(uploaded.URL),
			DirectPath: proto.String(uploaded.DirectPath), MediaKey: uploaded.MediaKey, FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256: uploaded.FileSHA256, FileLength: proto.Uint64(uploaded.FileLength), ContextInfo: quoteInfo}
		content.DocumentMessage, m.MediaProto = x, marshalled(x)
	}
	if kind == "voice" || kind == "audio" {
		// A voice note carries no caption.
		m.Text = ""
	}
	result, err := c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_messages(`+messageColumns+`)
 VALUES(`+messageValues+`) ON CONFLICT(id) DO NOTHING`, m.values()...)
	if err != nil {
		c.refuse(cmd.ID, "local_storage_failed")
		return
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		c.refuse(cmd.ID, "send_already_recorded")
		return
	}
	if c.vault.checkpoint() != nil {
		c.stopOnStorageFailure()
		return
	}
	// My copy, where `download` finds it: the message shows at once.
	dir := filepath.Join(filepath.Dir(c.vault.path), "media")
	if os.MkdirAll(dir, 0700) == nil {
		_ = os.WriteFile(filepath.Join(dir, mediaFile(m.ID, m.Kind, m.Mime, m.FileName)), data, 0600)
	}
	c.emit(wire{Type: "message", Message: &m})
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

func marshalled(p proto.Message) []byte {
	b, _ := proto.Marshal(p)
	return b
}
