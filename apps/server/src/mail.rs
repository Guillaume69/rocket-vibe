//! P02 SMTP transport. No secrets in Debug, errors, URLs or tracing.
//! Delivery can be ambiguous: the durable caller must retry the SAME message.
use lettre::{
    Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, header::ContentType},
    transport::smtp::authentication::Credentials,
};
use serde::Deserialize;
use std::{io::Read, path::Path, sync::Arc, time::Duration};
use zeroize::Zeroizing;

use crate::error::{Error, Result};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    host: String,
    port: u16,
    from: String,
    tls: TlsMode,
    username: Option<String>,
    password: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum TlsMode {
    Starttls,
    ImplicitTls,
}

#[derive(Clone, Copy)]
pub enum Purpose {
    VerifyAddress,
    Authentication,
    PasswordRecovery,
}
impl Purpose {
    fn subject(self) -> &'static str {
        match self {
            Self::VerifyAddress => "RocketVibe - verify your email address",
            Self::Authentication => "RocketVibe - confirm your identity",
            Self::PasswordRecovery => "RocketVibe - recover your password",
        }
    }
}

/// A private runtime capability, not a protocol capability. Routes advertise
/// email only once verified addresses, quotas and durable receipts are ready.
#[derive(Clone)]
pub struct Sender {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    slots: Arc<tokio::sync::Semaphore>,
    deadline: Duration,
}
impl Sender {
    /// Credentials live in a mounted regular 0600 file, never a CLI argument
    /// or database row. Unknown keys / invalid TLS modes fail before serving.
    pub fn from_file(path: &Path) -> std::result::Result<Self, &'static str> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Cannot read RV_SMTP_CONFIG_FILE")?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 {
            return Err("RV_SMTP_CONFIG_FILE must be a regular file of at most 16 KiB");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(
                    "RV_SMTP_CONFIG_FILE must not grant group or other access (use mode 600)",
                );
            }
        }
        let mut data = Zeroizing::new(Vec::new());
        std::fs::File::open(path)
            .map_err(|_| "Cannot read RV_SMTP_CONFIG_FILE")?
            .take(16 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "Cannot read RV_SMTP_CONFIG_FILE")?;
        if data.len() > 16 * 1024 {
            return Err("RV_SMTP_CONFIG_FILE is oversized");
        }
        let config: Configuration =
            serde_json::from_slice(&data).map_err(|_| "RV_SMTP_CONFIG_FILE is malformed")?;
        Self::configured(config)
    }
    fn configured(config: Configuration) -> std::result::Result<Self, &'static str> {
        if config.host.is_empty()
            || config.host.len() > 253
            || config.port == 0
            || !config
                .host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b))
        {
            return Err("SMTP host or port is invalid");
        }
        let from = address(&config.from).map_err(|_| "SMTP sender address is invalid")?;
        // relay / starttls_relay require encryption and certificate/hostname
        // validation. There is no public plaintext or opportunistic-TLS mode.
        let mut builder = match config.tls {
            TlsMode::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host),
            TlsMode::ImplicitTls => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host),
        }
        .map_err(|_| "SMTP TLS configuration is invalid")?
        .port(config.port)
        .timeout(Some(Duration::from_secs(10)));
        match (config.username, config.password) {
            (None, None) => {}
            (Some(user), Some(password))
                if !user.is_empty()
                    && user.len() <= 256
                    && !password.is_empty()
                    && password.len() <= 1024 =>
            {
                builder = builder.credentials(Credentials::new(user, password));
            }
            _ => return Err("SMTP username and password must both be present or absent"),
        }
        Ok(Self {
            transport: builder.build(),
            from: Mailbox::new(None, from),
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
            deadline: Duration::from_secs(30),
        })
    }

    /// Only a bounded operation code enters a fixed plain-text template.
    /// The caller owns expiration, deduplication and authorization in PostgreSQL.
    pub async fn send(&self, recipient: String, purpose: Purpose, code: String) -> Result<()> {
        let recipient = address(&recipient)?;
        let code = Zeroizing::new(code);
        if code.is_empty()
            || code.len() > 128
            || !code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(Error::invalid());
        }
        let message = Message::builder().from(self.from.clone()).to(Mailbox::new(None, recipient))
            .subject(purpose.subject()).header(ContentType::TEXT_PLAIN)
            .body(format!("{}\n\nCode: {}\n\nEnter this code only in the RocketVibe action you requested. If you did not request it, ignore this message.\n", purpose.subject(), code.as_str()))
            .map_err(|_| Error::invalid())?;
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::throttled("mail_busy", 1))?;
        let transport = self.transport.clone();
        let deadline = self.deadline;
        // Own the permit and network work in the actual job. Dropping an HTTP
        // caller cannot admit another send while this delivery is still running.
        tokio::spawn(async move {
            let _permit = permit;
            match tokio::time::timeout(deadline, transport.send(message)).await {
                Ok(Ok(_)) => Ok(()),
                _ => Err(unconfirmed()),
            }
        })
        .await
        .map_err(|_| unconfirmed())?
    }
}
fn address(value: &str) -> Result<Address> {
    if value.len() > 254
        || !value.is_ascii()
        || value
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err(Error::invalid());
    }
    value.parse().map_err(|_| Error::invalid())
}
fn unconfirmed() -> Error {
    // Raw SMTP diagnostics can echo addresses / secrets; never propagate them.
    Error::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "mail_delivery_unconfirmed",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    fn config(port: u16) -> Configuration {
        Configuration {
            host: "127.0.0.1".into(),
            port,
            from: "service@example.test".into(),
            tls: TlsMode::Starttls,
            username: None,
            password: None,
        }
    }
    #[test]
    fn configuration_rejects_plaintext_credential_pairs_and_header_injection() {
        let json = r#"{"host":"smtp.example.test","port":25,"from":"service@example.test","tls":"plaintext"}"#;
        assert!(serde_json::from_str::<Configuration>(json).is_err());
        let mut wrong = config(587);
        wrong.username = Some("account".into());
        assert!(Sender::configured(wrong).is_err());
        let mut wrong = config(587);
        wrong.from = "service@example.test\r\nBcc: stranger@example.test".into();
        assert!(Sender::configured(wrong).is_err());
        let mut wrong = config(587);
        wrong.host = "smtp.example.test/credentials".into();
        assert!(Sender::configured(wrong).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn private_configuration_file_rejects_symlinks_broad_access_and_oversize() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir =
            std::env::temp_dir().join(format!("rv-smtp-config-{}", crate::auth::random_token()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("smtp.json");
        let json = r#"{"host":"smtp.example.test","port":587,"from":"service@example.test","tls":"starttls"}"#;
        std::fs::write(&path, json).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Sender::from_file(&path).is_ok());
        let link = dir.join("link.json");
        symlink(&path, &link).unwrap();
        assert!(Sender::from_file(&link).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Sender::from_file(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&path, vec![b'a'; 16 * 1024 + 1]).unwrap();
        assert!(Sender::from_file(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn transport_sends_one_fixed_message_and_rejects_header_or_code_injection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sender = Sender {
            transport: AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(listener.local_addr().unwrap().port())
                .build(),
            from: "service@example.test".parse().unwrap(),
            slots: Arc::new(tokio::sync::Semaphore::new(1)),
            deadline: Duration::from_secs(3),
        };
        assert!(
            sender
                .send(
                    "owner@example.test\r\nBcc: stranger@example.test".into(),
                    Purpose::Authentication,
                    "123456".into()
                )
                .await
                .is_err()
        );
        assert!(
            sender
                .send(
                    "owner@example.test".into(),
                    Purpose::Authentication,
                    "123456\r\nInjected".into()
                )
                .await
                .is_err()
        );
        let relay = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut io = BufReader::new(socket);
            io.get_mut()
                .write_all(b"220 localhost SMTP\r\n")
                .await
                .unwrap();
            let mut deliveries = 0;
            loop {
                let mut line = String::new();
                if io.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let reply = if line.starts_with("EHLO ")
                    || line.starts_with("MAIL FROM:")
                    || line.starts_with("RCPT TO:")
                {
                    b"250 localhost\r\n".as_slice()
                } else if line == "DATA\r\n" {
                    io.get_mut()
                        .write_all(b"354 send message\r\n")
                        .await
                        .unwrap();
                    let mut message = String::new();
                    loop {
                        let mut chunk = String::new();
                        io.read_line(&mut chunk).await.unwrap();
                        if chunk == ".\r\n" {
                            break;
                        }
                        message.push_str(&chunk);
                    }
                    // Boolean checks avoid printing a private payload on failure.
                    assert!(message.contains("Code: 123456"));
                    assert!(message.contains("RocketVibe - confirm your identity"));
                    assert!(!message.contains("Bcc:"));
                    deliveries += 1;
                    b"250 queued\r\n".as_slice()
                } else if line == "QUIT\r\n" {
                    io.get_mut().write_all(b"221 bye\r\n").await.unwrap();
                    break;
                } else {
                    panic!("Unexpected SMTP command");
                };
                io.get_mut().write_all(reply).await.unwrap();
            }
            assert_eq!(deliveries, 1);
        });
        assert!(
            sender
                .send(
                    "owner@example.test".into(),
                    Purpose::Authentication,
                    "123456".into()
                )
                .await
                .is_ok()
        );
        relay.await.unwrap();
    }
    #[tokio::test]
    async fn required_starttls_does_not_send_recipient_credentials_or_code_to_plaintext_relay() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut settings = config(listener.local_addr().unwrap().port());
        settings.username = Some("private-test-user".into());
        settings.password = Some("private-test-password".into());
        let sender = Sender::configured(settings).unwrap();
        let relay = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut io = BufReader::new(socket);
            io.get_mut()
                .write_all(b"220 localhost SMTP\r\n")
                .await
                .unwrap();
            let mut line = String::new();
            io.read_line(&mut line).await.unwrap();
            assert!(line.starts_with("EHLO "));
            io.get_mut()
                .write_all(b"250-localhost\r\n250 AUTH PLAIN LOGIN\r\n")
                .await
                .unwrap();
            let mut remainder = String::new();
            let _ =
                tokio::time::timeout(Duration::from_secs(3), io.read_line(&mut remainder)).await;
            assert!(
                !remainder.starts_with("AUTH ")
                    && !remainder.starts_with("MAIL ")
                    && !remainder.starts_with("RCPT ")
                    && !remainder.starts_with("DATA")
            );
        });
        let result = sender
            .send(
                "owner@example.test".into(),
                Purpose::Authentication,
                "123456".into(),
            )
            .await;
        assert!(result.is_err_and(|error| error.code == "mail_delivery_unconfirmed"));
        relay.await.unwrap();
    }
    #[tokio::test]
    async fn actual_send_keeps_its_slot_after_caller_is_aborted() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        // Plain SMTP exists ONLY in this in-process unit fixture.
        let sender = Sender {
            transport: AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(listener.local_addr().unwrap().port())
                .build(),
            from: "service@example.test".parse().unwrap(),
            slots: Arc::new(tokio::sync::Semaphore::new(1)),
            deadline: Duration::from_secs(2),
        };
        let started = Arc::new(tokio::sync::Notify::new());
        let observed = started.clone();
        let relay = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            observed.notify_one();
            // Keep the actual network job waiting until its total deadline.
            tokio::time::sleep(Duration::from_secs(3)).await;
            drop(socket);
        });
        let cloned = sender.clone();
        let caller = tokio::spawn(async move {
            cloned
                .send(
                    "owner@example.test".into(),
                    Purpose::VerifyAddress,
                    "operation-code".into(),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), started.notified())
            .await
            .unwrap();
        caller.abort();
        let _ = caller.await;
        let second = sender
            .send(
                "owner@example.test".into(),
                Purpose::PasswordRecovery,
                "operation-code".into(),
            )
            .await;
        assert!(second.is_err_and(|error| error.code == "mail_busy"));
        for _ in 0..300 {
            if sender.slots.available_permits() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(sender.slots.available_permits(), 1);
        relay.await.unwrap();
    }
}
