use super::*;

#[test]
fn rejects_special_networks_and_preserves_public_boundaries() {
    for ip in [
        "0.0.0.0",
        "10.1.2.3",
        "127.0.0.1",
        "100.64.0.1",
        "100.127.255.255",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.9",
        "192.0.2.10",
        "192.88.99.1",
        "192.168.1.1",
        "198.18.1.1",
        "198.19.255.255",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "64:ff9b::a00:1",
        "100::1",
        "2001::1",
        "2001:1::1",
        "2001:db8::1",
        "2002:808:808::1",
        "3fff::1",
        "3fff:fff::1",
        "5f00::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
    ] {
        assert!(!public_address(ip.parse().unwrap()), "accepted {ip}");
    }
    for ip in [
        "8.8.8.8",
        "1.1.1.1",
        "100.63.255.255",
        "100.128.0.1",
        "172.15.255.255",
        "172.32.0.0",
        "192.0.1.1",
        "198.17.255.255",
        "198.20.0.1",
        "2001:200::1",
        "2001:4860:4860::8888",
        "2606:4700:4700::1111",
        "3fff:1000::1",
    ] {
        assert!(public_address(ip.parse().unwrap()), "rejected {ip}");
    }
}
#[test]
fn validates_normalized_urls_not_just_their_spelling() {
    for url in [
        "file:///etc/passwd",
        "ftp://example.com/file",
        "http://localhost/",
        "http://metadata.internal/",
        "http://a.home.arpa/",
        "http://app/",
        "http://127.1/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://0177.0.0.1/",
        "http://[::ffff:127.0.0.1]/",
        "http://user:secret@example.com/",
        "https://example.com:8443/",
        "https://example.com/\npath",
        "http://[64:ff9b::a9fe:a9fe]/",
    ] {
        assert_eq!(
            web_url(url).unwrap_err(),
            Failure::Blocked,
            "accepted {url}"
        );
    }
    assert_eq!(
        web_url("https://example.com/a#fragment").unwrap().as_str(),
        "https://example.com/a"
    );
    assert!(web_url("https://[2606:4700:4700::1111]/").is_ok());
    assert!(
        web_url(&format!(
            "https://example.com/{}",
            "x".repeat(MAX_URL_BYTES)
        ))
        .is_err()
    );
}
#[test]
fn every_dns_answer_must_be_public() {
    let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
    let private: SocketAddr = "127.0.0.1:443".parse().unwrap();
    assert!(checked_addresses(vec![public]).is_ok());
    assert_eq!(
        checked_addresses(vec![public, private]).unwrap_err(),
        Failure::Blocked
    );
    assert!(checked_addresses(vec![]).is_err());
    assert!(checked_addresses(vec![public; 65]).is_err());
}
#[test]
fn redirects_repeat_policy_and_deny_tls_downgrade() {
    let start = web_url("https://example.com/page").unwrap();
    assert_eq!(
        redirect(&start, "../other#fragment").unwrap().as_str(),
        "https://example.com/other"
    );
    for url in [
        "http://example.com/",
        "//127.0.0.1/",
        "//user:pass@example.com/",
        "file:///tmp/a",
        "//example.com:22/",
    ] {
        assert!(redirect(&start, url).is_err(), "accepted {url}");
    }
}
#[test]
fn uses_message_structure_for_bounded_deduplicated_links() {
    let source = "`https://code.example/a`\n\n> https://quoted.example/a\n\n![alt](https://image.example/a.png)\n\nhttps://first.example/a#one [label](https://second.example/b) https://first.example/a#one\n\nhttps://third.example/c https://fourth.example/d";
    assert_eq!(
        links(source),
        [
            "https://first.example/a#one",
            "https://second.example/b",
            "https://third.example/c"
        ]
    );
    assert!(links("https://127.1/private [bad](file:///tmp/a)").is_empty());
}
fn page(source: &str) -> Resource {
    Resource {
        final_url: Url::parse("https://example.com/path/page").unwrap(),
        media_type: "text/html".into(),
        charset: None,
        bytes: source.as_bytes().to_vec(),
    }
}
#[test]
fn parses_entities_attribute_order_and_relative_images_without_html_or_base_override() {
    let resource = page(
        r#"<html><head><base href="http://127.0.0.1/">
        <title>Fallback</title><meta content="A &amp; B &#x1f680;" property="og:title">
        <meta NAME="DESCRIPTION" content=" Description   &quot;quoted&quot; ">
        <meta content="../thumb.png" property="og:image"><meta property="og:site_name" content="Site">
        </head><body><script>alert('not executed')</script><meta property="og:title" content="body poison"></body></html>"#,
    );
    let meta = metadata(&resource).unwrap();
    assert_eq!(meta.title.as_deref(), Some("A & B 🚀"));
    assert_eq!(meta.description.as_deref(), Some("Description \"quoted\""));
    assert_eq!(meta.site.as_deref(), Some("Site"));
    assert_eq!(
        meta.image_url.as_deref(),
        Some("https://example.com/thumb.png")
    );
    let mut resource = page(
        "<title>Caf\u{e9}</title><meta property='og:image' content='http://169.254.169.254/latest'>",
    );
    let meta = metadata(&resource).unwrap();
    assert_eq!(meta.image_url, None);
    resource.charset = Some("not-an-encoding".into());
    assert!(metadata(&resource).is_err());
}
#[test]
fn bounds_utf8_metadata_and_filters_controls() {
    assert_eq!(bounded_text(" a\n\t b\0c ", 512).as_deref(), Some("a bc"));
    assert_eq!(bounded_text("🚀🚀🚀", 9).as_deref(), Some("🚀🚀"));
    let meta = metadata(&page(&format!(
        "<meta property='og:title' content='{}'>",
        "🚀".repeat(1000)
    )))
    .unwrap();
    assert_eq!(meta.title.unwrap().len(), 512);
}
#[test]
fn normalizes_image_to_png_and_refuses_mime_spoofing() {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1600, 800)
        .write_to(&mut bytes, image::ImageFormat::Jpeg)
        .unwrap();
    let resource = Resource {
        final_url: Url::parse("https://example.com/a").unwrap(),
        media_type: "image/jpeg".into(),
        charset: None,
        bytes: bytes.into_inner(),
    };
    let image = normalize_image(resource).unwrap();
    assert_eq!((image.width, image.height), (1200, 600));
    assert!(image.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    let mut fake = page("<svg onload='alert(1)'></svg>");
    fake.media_type = "image/png".into();
    assert!(normalize_image(fake).is_err());
}
#[tokio::test]
async fn rejects_private_literal_before_any_network_request() {
    assert_eq!(
        collect("http://127.0.0.1/").await.unwrap_err(),
        Failure::Blocked
    );
}
#[tokio::test]
async fn http_client_pins_dns_sends_no_credentials_and_never_follows_redirects() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let host = "pinned.example.invalid";
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0u8; 8192];
        let size = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..size]).to_ascii_lowercase();
        assert!(request.contains("host: pinned.example.invalid:"));
        for forbidden in [
            "authorization:",
            "cookie:",
            "referer:",
            "x-auth-token:",
            "x-user-id:",
        ] {
            assert!(!request.contains(forbidden), "{request}");
        }
        socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/secret\r\nSet-Cookie: private=value\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    // Directly exercise the production client builder with a test socket.
    // The public policy above is never disabled in collect/fetch.
    let response = client(host, &[address])
        .unwrap()
        .get(format!("http://{host}:{}/page", address.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 302);
    server.await.unwrap();
}

#[tokio::test]
async fn response_reader_bounds_announced_and_chunked_bodies_and_refuses_compression_svg() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (raw, expected) in [
        (
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 99\r\nConnection: close\r\n\r\n",
            Failure::TooLarge,
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n",
            Failure::TooLarge,
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Type: image/svg+xml\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            Failure::Unsupported,
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            Failure::Unsupported,
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket.write_all(raw.as_bytes()).await.unwrap();
        });
        let url = Url::parse(&format!(
            "http://reader.example.invalid:{}/",
            address.port()
        ))
        .unwrap();
        let response = client("reader.example.invalid", &[address])
            .unwrap()
            .get(url.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(
            read_resource(response, url, 8, false).await.unwrap_err(),
            expected
        );
        server.await.unwrap();
    }
}
