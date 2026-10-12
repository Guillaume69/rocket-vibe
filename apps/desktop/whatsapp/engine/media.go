package engine

import (
	"context"
	"errors"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// The attachment of a message: what the timeline shows before any download
// (kind, size, dimensions, thumbnail) and the protobuf it is fetched with.
type attachment struct {
	Kind     string
	Mime     string
	FileName string
	Size     int64
	Width    int
	Height   int
	Seconds  int
	Thumb    []byte
	Proto    []byte
}

// Files over this size are not fetched by the app.
const maxDownload = 200 << 20

// The attachment of a message and its caption; nil for text and for what
// this client does not show.
func attachmentOf(m *waE2E.Message) (*attachment, string) {
	marshal := func(p proto.Message) []byte {
		b, _ := proto.Marshal(p)
		return b
	}
	switch {
	case m.GetImageMessage() != nil:
		x := m.GetImageMessage()
		return &attachment{Kind: "image", Mime: x.GetMimetype(), Size: int64(x.GetFileLength()), Width: int(x.GetWidth()),
			Height: int(x.GetHeight()), Thumb: x.GetJPEGThumbnail(), Proto: marshal(x)}, x.GetCaption()
	case m.GetVideoMessage() != nil:
		x := m.GetVideoMessage()
		kind := "video"
		if x.GetGifPlayback() {
			kind = "gif"
		}
		return &attachment{Kind: kind, Mime: x.GetMimetype(), Size: int64(x.GetFileLength()), Width: int(x.GetWidth()),
			Height: int(x.GetHeight()), Seconds: int(x.GetSeconds()), Thumb: x.GetJPEGThumbnail(), Proto: marshal(x)}, x.GetCaption()
	case m.GetAudioMessage() != nil:
		x := m.GetAudioMessage()
		kind := "audio"
		if x.GetPTT() {
			kind = "voice"
		}
		return &attachment{Kind: kind, Mime: x.GetMimetype(), Size: int64(x.GetFileLength()), Seconds: int(x.GetSeconds()),
			Proto: marshal(x)}, ""
	case m.GetDocumentMessage() != nil:
		x := m.GetDocumentMessage()
		name := x.GetFileName()
		if name == "" {
			name = x.GetTitle()
		}
		return &attachment{Kind: "document", Mime: x.GetMimetype(), FileName: name, Size: int64(x.GetFileLength()),
			Thumb: x.GetJPEGThumbnail(), Proto: marshal(x)}, x.GetCaption()
	case m.GetStickerMessage() != nil:
		x := m.GetStickerMessage()
		return &attachment{Kind: "sticker", Mime: x.GetMimetype(), Size: int64(x.GetFileLength()), Width: int(x.GetWidth()),
			Height: int(x.GetHeight()), Thumb: x.GetPngThumbnail(), Proto: marshal(x)}, ""
	}
	return nil, ""
}

// The context (quoted message) of whichever kind of message carries one.
func contextOf(m *waE2E.Message) *waE2E.ContextInfo {
	for _, info := range []*waE2E.ContextInfo{
		m.GetExtendedTextMessage().GetContextInfo(), m.GetImageMessage().GetContextInfo(),
		m.GetVideoMessage().GetContextInfo(), m.GetAudioMessage().GetContextInfo(),
		m.GetDocumentMessage().GetContextInfo(), m.GetStickerMessage().GetContextInfo(),
	} {
		if info != nil {
			return info
		}
	}
	return nil
}

func downloadable(kind string, raw []byte) (whatsmeow.DownloadableMessage, error) {
	var m interface {
		proto.Message
		whatsmeow.DownloadableMessage
	}
	switch kind {
	case "image":
		m = &waE2E.ImageMessage{}
	case "video", "gif":
		m = &waE2E.VideoMessage{}
	case "audio", "voice":
		m = &waE2E.AudioMessage{}
	case "document":
		m = &waE2E.DocumentMessage{}
	case "sticker":
		m = &waE2E.StickerMessage{}
	default:
		return nil, errors.New("no attachment")
	}
	if err := proto.Unmarshal(raw, m); err != nil {
		return nil, err
	}
	return m, nil
}

// What WhatsApp sends most, named as people expect (Go's own table says .jfif).
var commonExtensions = map[string]string{
	"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
	"video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "application/pdf": ".pdf",
}

// The file name an attachment is kept under: the message id, made safe, and
// an extension from its type.
func mediaFile(id, kind, mimeType, name string) string {
	safe := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, id)
	ext := filepath.Ext(name)
	if ext == "" || len(ext) > 8 {
		base := strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0])
		ext = commonExtensions[base]
		if exts, _ := mime.ExtensionsByType(base); ext == "" && len(exts) > 0 {
			ext = exts[0]
		}
	}
	if ext == "" {
		ext = map[string]string{"image": ".jpg", "video": ".mp4", "gif": ".mp4", "voice": ".ogg", "audio": ".ogg",
			"sticker": ".webp"}[kind]
	}
	return safe + ext
}

// Fetches and decrypts a message's attachment into the account's private
// folder (gone with the account), and says where; an empty path is a failure.
func (c *connector) download(cmd command) {
	answer := func(path string) { c.emit(wire{Type: "file", ID: cmd.ID, Path: path}) }
	m, ok := c.load(cmd.ID)
	if ok && m.LinkImage {
		answer(c.linkImage(m))
		return
	}
	if !ok || m.Kind == "" || len(m.MediaProto) == 0 || m.Size > maxDownload || !c.ready() {
		answer("")
		return
	}
	dir := filepath.Join(filepath.Dir(c.vault.path), "media")
	path := filepath.Join(dir, mediaFile(m.ID, m.Kind, m.Mime, m.FileName))
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		answer(path)
		return
	}
	msg, err := downloadable(m.Kind, m.MediaProto)
	if err != nil || os.MkdirAll(dir, 0700) != nil {
		answer("")
		return
	}
	partial := path + ".part"
	file, err := os.OpenFile(partial, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0600)
	if err != nil {
		answer("")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Minute)
	defer cancel()
	err = c.client.DownloadToFile(ctx, msg, file)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(partial, path)
	}
	if err != nil {
		_ = os.Remove(partial)
		answer("")
		return
	}
	answer(path)
}

func (c *connector) linkImagePath(id string) string {
	return filepath.Join(filepath.Dir(c.vault.path), "media", mediaFile(id+"-link", "image", "image/jpeg", ""))
}

// Writes a link preview's picture where linkImage serves it from.
func (c *connector) keepLinkImage(id string, data []byte) string {
	path := c.linkImagePath(id)
	if os.MkdirAll(filepath.Dir(path), 0700) != nil || os.WriteFile(path+".part", data, 0600) != nil ||
		os.Rename(path+".part", path) != nil {
		_ = os.Remove(path + ".part")
		return ""
	}
	return path
}

// A link preview's picture: the large one the sender uploaded, else the
// small one inline in the message. The small one is not kept when the large
// one could not be had, so a later look tries again.
func (c *connector) linkImage(m message) string {
	path := c.linkImagePath(m.ID)
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		return path
	}
	if len(m.MediaProto) > 0 && c.ready() {
		var x waE2E.ExtendedTextMessage
		if proto.Unmarshal(m.MediaProto, &x) == nil {
			ctx, cancel := context.WithTimeout(c.ctx, time.Minute)
			full, err := c.client.DownloadThumbnail(ctx, &x)
			cancel()
			if err == nil && len(full) > 0 {
				return c.keepLinkImage(m.ID, full)
			}
		}
	}
	if len(m.Thumb) == 0 {
		return ""
	}
	if len(m.MediaProto) > 0 {
		inline := path + ".inline.jpg"
		if os.MkdirAll(filepath.Dir(path), 0700) != nil || os.WriteFile(inline, m.Thumb, 0600) != nil {
			return ""
		}
		return inline
	}
	return c.keepLinkImage(m.ID, m.Thumb)
}
