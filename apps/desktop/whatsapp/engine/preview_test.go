package engine

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFirstLinkTakesTheLinkAsTyped(t *testing.T) {
	for text, want := range map[string]string{
		"see https://example.org/a.":                   "https://example.org/a",
		"(www.example.org/x) and more":                 "www.example.org/x",
		"https://en.wikipedia.org/wiki/Go_(game), ok":  "https://en.wikipedia.org/wiki/Go_(game)",
		"no link here, or a file.txt":                  "",
		"http://localhost:8080 is no page":             "",
		"two: https://a.example.com https://b.example": "https://a.example.com",
	} {
		if got := firstLink(text); got != want {
			t.Errorf("firstLink(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestHeadTagsPreferOpenGraph(t *testing.T) {
	tags := headTags(strings.NewReader(`<html><head><title> Plain
	title </title><meta name="description" content="plain">
	<meta property="og:title" content="Rich &amp; title"><meta property="og:image" content="/i.png">
	</head><body><meta property="og:title" content="late"></body></html>`))
	if firstOf(tags, "og:title", "<title>") != "Rich & title" || firstOf(tags, "<title>") != "Plain title" ||
		firstOf(tags, "og:description", "description") != "plain" || tags["og:image"] != "/i.png" {
		t.Fatalf("tags: %v", tags)
	}
}

func TestPrivateAddressesAreNotReached(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "192.168.1.1", "10.0.0.2", "169.254.1.1", "::1", "fd00::1"} {
		if publicAddress(net.ParseIP(ip)) {
			t.Errorf("%s counted as public", ip)
		}
	}
	if !publicAddress(net.ParseIP("93.184.216.34")) {
		t.Error("a public address refused")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<title>local</title>`))
	}))
	defer server.Close()
	if _, err := fetchPreview(context.Background(), server.URL); err == nil {
		t.Fatal("a local page was fetched")
	}
}

func TestAPreviewReadsThePageAndItsImage(t *testing.T) {
	reachable = func(net.IP) bool { return true }
	defer func() { reachable = publicAddress }()
	picture := image.NewRGBA(image.Rect(0, 0, 1200, 600))
	for x := 0; x < 1200; x++ {
		picture.Set(x, 300, color.RGBA{R: 200, A: 255})
	}
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, picture)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<head><meta property="og:title" content="Été"><meta property="og:description" content="A page">
			<meta property="og:image" content="/pic.png"></head>`))
		case "/pic.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(encoded.Bytes())
		case "/moved":
			http.Redirect(w, r, "/page", http.StatusFound)
		default:
			w.Header().Set("Content-Type", "application/pdf")
		}
	}))
	defer server.Close()
	p, err := fetchPreview(context.Background(), server.URL+"/moved")
	if err != nil || p.title != "Été" || p.description != "A page" || p.image == nil {
		t.Fatalf("preview: %+v %v", p, err)
	}
	small, w, h := scaledJPEG(p.image, 160, 70)
	if len(small) == 0 || w != 160 || h != 80 {
		t.Fatalf("thumbnail %d bytes, %dx%d", len(small), w, h)
	}
	if _, err := fetchPreview(context.Background(), server.URL+"/file.pdf"); err == nil {
		t.Fatal("a file that is no page gave a preview")
	}
}
