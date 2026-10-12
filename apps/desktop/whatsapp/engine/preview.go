package engine

// Link previews of my own messages, made here as WhatsApp's own apps make
// them: the page is fetched once from this device and its title, description
// and image travel inside the message, since recipients never fetch it.

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
	"google.golang.org/protobuf/proto"
)

const (
	// The whole preview, page, image and upload: the send waits for it.
	previewTimeout  = 10 * time.Second
	maxPreviewPage  = 512 << 10
	maxPreviewImage = 5 << 20
	previewAgent    = "Mozilla/5.0 (compatible; RocketVibe link preview)"
)

var errPrivateAddress = errors.New("not a public address")

// Which addresses a preview may reach: public ones (tests serve locally).
var reachable = publicAddress

// Pages on the internet only: a link never makes this device reach its own
// network (a router, a printer, a local service).
var previewClient = &http.Client{
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 5 * time.Second,
			Control: func(_, address string, _ syscall.RawConn) error {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return err
				}
				if ip := net.ParseIP(host); ip == nil || !reachable(ip) {
					return errPrivateAddress
				}
				return nil
			},
		}).DialContext,
		TLSHandshakeTimeout:    5 * time.Second,
		ResponseHeaderTimeout:  6 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || (req.URL.Scheme != "https" && req.URL.Scheme != "http") {
			return errors.New("redirect refused")
		}
		return nil
	},
}

func publicAddress(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() &&
		!ip.IsInterfaceLocalMulticast() && !ip.IsUnspecified()
}

// The first web link of a text, as typed: WhatsApp's matchedText.
func firstLink(text string) string {
	for _, token := range strings.FieldsFunc(text, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune("<>\"", r)
	}) {
		token = strings.TrimRight(strings.TrimLeft(token, "([{'*_~"), ".,;:!?]}'*_~")
		// A closing parenthesis ends the link unless the link opened one.
		for strings.HasSuffix(token, ")") && strings.Count(token, "(") < strings.Count(token, ")") {
			token = strings.TrimRight(strings.TrimSuffix(token, ")"), ".,;:!?]}'*_~")
		}
		lower := strings.ToLower(token)
		if !strings.HasPrefix(lower, "https://") && !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "www.") {
			continue
		}
		if u, err := url.Parse(withScheme(token)); err == nil && strings.Contains(u.Hostname(), ".") {
			return token
		}
	}
	return ""
}

func withScheme(link string) string {
	if strings.Contains(link, "://") {
		return link
	}
	return "https://" + link
}

type pagePreview struct {
	title, description string
	image              image.Image
}

func fetch(ctx context.Context, link string, limit int64, accept func(mediaType string) bool) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("User-Agent", previewAgent)
	resp, err := previewClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if resp.StatusCode != http.StatusOK || !accept(mediaType) {
		return nil, nil, errors.New("not a preview")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	return resp, body, err
}

// The page's title, description and image, from its Open Graph and Twitter
// tags, else its <title> and description.
func fetchPreview(ctx context.Context, link string) (pagePreview, error) {
	resp, body, err := fetch(ctx, link, maxPreviewPage, func(t string) bool {
		return t == "text/html" || t == "application/xhtml+xml"
	})
	if err != nil {
		return pagePreview{}, err
	}
	reader, err := charset.NewReader(bytes.NewReader(body), resp.Header.Get("Content-Type"))
	if err != nil {
		reader = bytes.NewReader(body)
	}
	tags := headTags(reader)
	p := pagePreview{
		title:       clip(firstOf(tags, "og:title", "twitter:title", "<title>"), 200),
		description: clip(firstOf(tags, "og:description", "twitter:description", "description"), 300),
	}
	if src := firstOf(tags, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"); src != "" {
		if u, err := resp.Request.URL.Parse(src); err == nil && (u.Scheme == "https" || u.Scheme == "http") {
			_, data, err := fetch(ctx, u.String(), maxPreviewImage, func(t string) bool {
				return strings.HasPrefix(t, "image/") && t != "image/svg+xml"
			})
			if err == nil {
				p.image, _, _ = image.Decode(bytes.NewReader(data))
			}
		}
	}
	if p.title == "" && p.image == nil {
		return p, errors.New("nothing to show")
	}
	return p, nil
}

// The meta tags of the page's head, by property or name, and its <title>.
func headTags(r io.Reader) map[string]string {
	tags := map[string]string{}
	z := html.NewTokenizer(r)
	inTitle := false
	for {
		switch z.Next() {
		case html.ErrorToken:
			return tags
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "body":
				return tags
			case "title":
				inTitle = true
			case "meta":
				var key, content string
				for hasAttr {
					var k, v []byte
					k, v, hasAttr = z.TagAttr()
					switch string(k) {
					case "property", "name":
						if key == "" {
							key = strings.ToLower(strings.TrimSpace(string(v)))
						}
					case "content":
						content = strings.TrimSpace(string(v))
					}
				}
				if _, seen := tags[key]; key != "" && content != "" && !seen {
					tags[key] = content
				}
			}
		case html.TextToken:
			if inTitle {
				if _, seen := tags["<title>"]; !seen {
					tags["<title>"] = strings.TrimSpace(string(z.Text()))
				}
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "head":
				return tags
			case "title":
				inTitle = false
			}
		}
	}
}

func firstOf(tags map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := strings.Join(strings.Fields(tags[k]), " "); v != "" {
			return v
		}
	}
	return ""
}

func clip(text string, runes int) string {
	if utf8.RuneCountInString(text) <= runes {
		return text
	}
	return string([]rune(text)[:runes-1]) + "…"
}

// A JPEG of the image within side x side pixels, and its size.
func scaledJPEG(img image.Image, side, quality int) ([]byte, int, int) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, 0, 0
	}
	scale := min(1, float64(side)/float64(max(w, h)))
	tw, th := max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))
	out := image.NewRGBA(image.Rect(0, 0, tw, th))
	draw.CatmullRom.Scale(out, out.Bounds(), img, b, draw.Src, nil)
	var buf bytes.Buffer
	if jpeg.Encode(&buf, out, &jpeg.Options{Quality: quality}) != nil {
		return nil, 0, 0
	}
	return buf.Bytes(), tw, th
}

// Adds the preview of the text's first link to my message, as an extended
// text; a page that gives nothing leaves the message as it was. The large
// image is uploaded for the recipients and kept as my own card's picture.
func (c *connector) attachPreview(content *waE2E.Message, m *message) {
	link := firstLink(m.Text)
	if link == "" {
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, previewTimeout)
	defer cancel()
	p, err := fetchPreview(ctx, withScheme(link))
	if err != nil {
		c.diag("no link preview: %v", err)
		return
	}
	x := content.GetExtendedTextMessage()
	if x == nil {
		x = &waE2E.ExtendedTextMessage{Text: proto.String(m.Text)}
		content.Conversation, content.ExtendedTextMessage = nil, x
	}
	x.MatchedText = proto.String(link)
	x.PreviewType = waE2E.ExtendedTextMessage_NONE.Enum()
	if p.title != "" {
		x.Title = proto.String(p.title)
	}
	if p.description != "" {
		x.Description = proto.String(p.description)
	}
	var large []byte
	if p.image != nil {
		x.JPEGThumbnail, _, _ = scaledJPEG(p.image, 160, 70)
		var w, h int
		large, w, h = scaledJPEG(p.image, 720, 80)
		if up, err := c.client.Upload(ctx, large, whatsmeow.MediaLinkThumbnail); err == nil && len(large) > 0 {
			x.ThumbnailDirectPath = proto.String(up.DirectPath)
			x.ThumbnailSHA256, x.ThumbnailEncSHA256, x.MediaKey = up.FileSHA256, up.FileEncSHA256, up.MediaKey
			x.MediaKeyTimestamp = proto.Int64(time.Now().Unix())
			x.ThumbnailWidth, x.ThumbnailHeight = proto.Uint32(uint32(w)), proto.Uint32(uint32(h))
		} else if err != nil {
			c.diag("link thumbnail upload failed: %v", err)
		}
	}
	m.setLink(content)
	if len(large) > 0 {
		c.keepLinkImage(m.ID, large)
	}
}
