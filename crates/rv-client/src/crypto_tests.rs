use super::*;
use std::{
    io::{Read as _, Write as _},
    net::TcpListener,
    thread,
};

fn server(
    reply: impl FnOnce(std::net::TcpStream) + Send + 'static,
) -> (NativeClient, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let n = stream.read(&mut chunk).unwrap();
            assert!(n > 0 && request.len() + n <= 16384);
            request.extend_from_slice(&chunk[..n]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..end]).unwrap();
                let length = headers
                    .lines()
                    .find_map(|h| {
                        let (name, value) = h.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        reply(stream);
    });
    let client = NativeClient::new(&format!("http://{address}")).unwrap();
    client.update_token("disposable-crypto-token".into());
    (client, worker)
}

#[tokio::test]
async fn oversized_content_length_is_refused_before_reading_or_parsing_body() {
    let (client, worker) = server(|mut stream| {
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4194305\r\nConnection: close\r\n\r\n").unwrap();
        // No body: a client waiting for JSON would report a transport failure.
    });
    assert!(matches!(
        client.crypto_group_roster("room").await,
        Err(Error::InvalidCrypto)
    ));
    worker.join().unwrap();
}

#[tokio::test]
async fn chunked_success_and_error_responses_are_bounded_before_serde() {
    for status in [200, 503] {
        let (client, worker) = server(move |mut stream| {
            write!(
                stream,
                "HTTP/1.1 {status} test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let spaces = vec![b' '; 1024 * 1024];
            for _ in 0..5 {
                if write!(stream, "100000\r\n")
                    .and_then(|_| stream.write_all(&spaces))
                    .and_then(|_| stream.write_all(b"\r\n"))
                    .is_err()
                {
                    return;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        assert!(matches!(
            client.crypto_group_roster("room").await,
            Err(Error::InvalidCrypto)
        ));
        worker.join().unwrap();
    }
}

#[tokio::test]
async fn valid_crypto_json_and_exact_decimal_fields_are_preserved() {
    let (client, worker) = server(|mut stream| {
        let body = r#"{"scope":{"instance_id":"instance","data_epoch":"epoch"},"room_id":"room","authority_version":"authority","members":[{"user_id":"alice","access_version":"access","activation_version":"activation"}],"group":{"scope":{"instance_id":"instance","data_epoch":"epoch"},"room_id":"room","incarnation":"01010101010101010101010101010101","operation_id":"rotate","revision":"9007199254740993","epoch":"9007199254740992","fingerprint":"0202020202020202020202020202020202020202020202020202020202020202"}}"#;
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    let roster = client.crypto_group_roster("room").await.unwrap();
    assert_eq!(roster.group.unwrap().revision, "9007199254740993");
    worker.join().unwrap();
}

#[tokio::test]
async fn bounded_crypto_errors_preserve_retry_policy_and_do_not_poison_gets() {
    let (client, worker) = server(|mut stream| {
        let body = r#"{"code":"rate_limited","request_id":"crypto-test"}"#;
        write!(stream,"HTTP/1.1 429 test\r\nRetry-After: 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    let input = rv_protocol::e2ee::PublishKeyPackages {
        scope: rv_protocol::e2ee::Scope {
            instance_id: "instance".into(),
            data_epoch: "epoch".into(),
        },
        operation_id: "publish".into(),
        device_revision: "1".into(),
        packages: vec![],
    };
    assert!(matches!(
        client.publish_key_packages(&input).await,
        Err(Error::Server {
            status: 429,
            retry_after: Some(2),
            ..
        })
    ));
    worker.join().unwrap();
    assert!(client.check_cooldown(Some("crypto")).is_err());
    assert!(
        client
            .check_cooldown(NativeClient::budget(
                "/api/v1/e2ee/rooms/room/roster",
                &Method::GET
            ))
            .is_ok()
    );
}
