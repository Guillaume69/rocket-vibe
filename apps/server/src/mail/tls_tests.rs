use super::*;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    },
};

async fn relay(mode: TlsMode, host: &str) -> (u16, tokio::task::JoinHandle<bool>) {
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(
            include_bytes!("../../tests/fixtures/mail-cert.der").to_vec(),
        )],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            include_bytes!("../../tests/fixtures/mail-key.der").to_vec(),
        )),
    )
    .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind(format!("{host}:0")).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        if matches!(mode, TlsMode::Starttls) {
            let mut plain = BufReader::new(socket);
            plain
                .get_mut()
                .write_all(b"220 localhost SMTP\r\n")
                .await
                .unwrap();
            let mut line = String::new();
            plain.read_line(&mut line).await.unwrap();
            assert!(line.starts_with("EHLO "));
            plain
                .get_mut()
                .write_all(b"250-localhost\r\n250 STARTTLS\r\n")
                .await
                .unwrap();
            line.clear();
            plain.read_line(&mut line).await.unwrap();
            assert!(line == "STARTTLS\r\n");
            plain
                .get_mut()
                .write_all(b"220 start TLS\r\n")
                .await
                .unwrap();
            socket = plain.into_inner();
        }
        let Ok(tls) = acceptor.accept(socket).await else {
            return false;
        };
        let mut io = BufReader::new(tls);
        if matches!(mode, TlsMode::ImplicitTls) {
            io.get_mut()
                .write_all(b"220 localhost SMTP\r\n")
                .await
                .unwrap();
        }
        let mut captured = false;
        loop {
            let mut line = String::new();
            if io.read_line(&mut line).await.unwrap_or(0) == 0 {
                break;
            }
            let reply = if line.starts_with("EHLO ") {
                b"250-localhost\r\n250 AUTH PLAIN\r\n".as_slice()
            } else if line.starts_with("AUTH PLAIN ") {
                b"235 authenticated\r\n".as_slice()
            } else if line.starts_with("MAIL FROM:") || line.starts_with("RCPT TO:") {
                b"250 ok\r\n".as_slice()
            } else if line == "DATA\r\n" {
                io.get_mut().write_all(b"354 data\r\n").await.unwrap();
                let mut body = String::new();
                loop {
                    let mut part = String::new();
                    assert!(io.read_line(&mut part).await.unwrap() > 0);
                    if part == ".\r\n" {
                        break;
                    }
                    body.push_str(&part);
                }
                captured = body.contains("Code: 12345678");
                b"250 queued\r\n".as_slice()
            } else if line == "QUIT\r\n" {
                let _ = io.get_mut().write_all(b"221 bye\r\n").await;
                break;
            } else {
                panic!("Unexpected encrypted SMTP command");
            };
            io.get_mut().write_all(reply).await.unwrap();
        }
        captured
    });
    (port, task)
}
fn config(port: u16, tls: TlsMode, trusted: bool) -> Configuration {
    Configuration {
        host: "127.0.0.1".into(),
        port,
        from: "service@example.test".into(),
        tls,
        username: Some("synthetic-test-user".into()),
        password: Some("synthetic-test-password".into()),
        ca_file: trusted.then(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mail-cert.pem")
        }),
    }
}
#[tokio::test]
async fn required_starttls_and_implicit_tls_send_only_with_trusted_certificate() {
    for mode in [TlsMode::Starttls, TlsMode::ImplicitTls] {
        let (port, task) = relay(mode, "127.0.0.1").await;
        let sender = Sender::configured(config(port, mode, true)).unwrap();
        assert!(
            sender
                .send(
                    "owner@example.test".into(),
                    Purpose::VerifyAddress,
                    "12345678".into()
                )
                .await
                .is_ok()
        );
        assert!(task.await.unwrap());
    }
}
#[tokio::test]
async fn untrusted_relay_never_receives_credentials_or_code() {
    let (port, task) = relay(TlsMode::ImplicitTls, "127.0.0.1").await;
    let sender = Sender::configured(config(port, TlsMode::ImplicitTls, false)).unwrap();
    assert!(
        sender
            .send(
                "owner@example.test".into(),
                Purpose::VerifyAddress,
                "12345678".into()
            )
            .await
            .is_err_and(|e| e.code == "mail_delivery_unconfirmed")
    );
    assert!(!task.await.unwrap());
}
#[tokio::test]
async fn trusted_certificate_for_another_host_never_receives_code() {
    let (port, task) = relay(TlsMode::ImplicitTls, "127.0.0.2").await;
    let mut settings = config(port, TlsMode::ImplicitTls, true);
    settings.host = "127.0.0.2".into();
    let sender = Sender::configured(settings).unwrap();
    assert!(
        sender
            .send(
                "owner@example.test".into(),
                Purpose::VerifyAddress,
                "12345678".into()
            )
            .await
            .is_err_and(|e| e.code == "mail_delivery_unconfirmed")
    );
    assert!(!task.await.unwrap());
}
