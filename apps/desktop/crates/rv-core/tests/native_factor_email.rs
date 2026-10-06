use rv_core::native::{
    Error,
    factor_email::{self, Intent, Remote},
    security::{Guard, RemoteFuture},
};
use rv_protocol::parity::{AuthChallenge, EmailDeliveryState, FactorEmailDelivery, RequestFactorEmail, SecondFactor};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

fn challenge() -> AuthChallenge {
    AuthChallenge {
        challenge_id: "a".repeat(64),
        methods: vec![SecondFactor::Email, SecondFactor::RecoveryCode],
        expires_at: (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
        resend_after_seconds: 0,
    }
}
fn intent(challenge: &AuthChallenge) -> Intent {
    Intent {
        input: RequestFactorEmail {
            challenge_id: challenge.challenge_id.clone(),
            delivery_id: "b".repeat(64),
            operation_id: "c".repeat(64),
        },
        status: None,
    }
}
#[derive(Clone)]
struct Server {
    challenge: AuthChallenge,
    saved: Arc<Mutex<Option<Intent>>>,
    accepted: Arc<Mutex<Option<RequestFactorEmail>>>,
    starts: Arc<AtomicUsize>,
    lose: Arc<AtomicBool>,
    cooldown: Arc<AtomicUsize>,
    cancel: Arc<Mutex<Option<Guard>>>,
    extend: Arc<AtomicBool>,
}
impl Server {
    fn new() -> Self {
        Self {
            challenge: challenge(),
            saved: Arc::default(),
            accepted: Arc::default(),
            starts: Arc::default(),
            lose: Arc::default(),
            cooldown: Arc::default(),
            cancel: Arc::default(),
            extend: Arc::default(),
        }
    }
    fn status(&self) -> FactorEmailDelivery {
        FactorEmailDelivery {
            expires_at: if self.extend.load(Ordering::SeqCst) {
                (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()
            } else {
                self.challenge.expires_at.clone()
            },
            delivery: EmailDeliveryState::Accepted,
            resend_after_seconds: self.cooldown.load(Ordering::SeqCst) as u32,
        }
    }
    async fn send(&self, resend: bool, guard: &Guard) -> Result<Intent, Error> {
        let previous = self.saved.lock().unwrap().clone();
        let saved = self.saved.clone();
        factor_email::send(&self.challenge, previous, resend, self, guard, move |intent| {
            let saved = saved.clone();
            async move {
                *saved.lock().unwrap() = Some(intent);
                Ok(())
            }
        })
        .await
    }
}
impl Remote for Server {
    fn begin(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let server = self.clone();
        Box::pin(async move {
            // Durable before the actual remote command; neither code nor password
            // is part of the record or this request.
            assert!(
                server
                    .saved
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .same_candidate(&Intent { input: input.clone(), status: None })
            );
            server.starts.fetch_add(1, Ordering::SeqCst);
            *server.accepted.lock().unwrap() = Some(input);
            if let Some(guard) = server.cancel.lock().unwrap().take() {
                guard.cancel();
            }
            if server.lose.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("connection_failed"));
            }
            Ok(server.status())
        })
    }
    fn resume(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let server = self.clone();
        Box::pin(async move {
            if server.accepted.lock().unwrap().as_ref().is_some_and(|accepted| {
                accepted.delivery_id == input.delivery_id
                    && accepted.operation_id == input.operation_id
                    && accepted.challenge_id == input.challenge_id
            }) {
                Ok(server.status())
            } else {
                Err(Error::Network(rv_client::Error::Server {
                    status: 400,
                    code: "factor_rejected".into(),
                    request_id: None,
                    retry_after: None,
                }))
            }
        })
    }
}
#[tokio::test]
async fn a_lost_start_resumes_one_saved_delivery_without_resending() {
    let server = Server::new();
    server.lose.store(true, Ordering::SeqCst);
    assert_eq!(server.send(false, &Guard::new()).await.err().unwrap().code(), "connection_failed");
    let original = server.saved.lock().unwrap().clone().unwrap();
    assert!(original.status.is_none());
    let recovered = server.send(false, &Guard::new()).await.unwrap();
    assert!(original.same_candidate(&recovered));
    assert!(recovered.status.is_some());
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
    assert_eq!(recovered.status.unwrap().expires_at, server.challenge.expires_at);
}
#[tokio::test]
async fn an_unsent_saved_candidate_is_retried_exactly_and_resend_requires_current_cooldown() {
    let server = Server::new();
    let original = intent(&server.challenge);
    *server.saved.lock().unwrap() = Some(original.clone());
    let recovered = server.send(false, &Guard::new()).await.unwrap();
    assert!(recovered.same_candidate(&original));
    server.cooldown.store(60, Ordering::SeqCst);
    assert_eq!(server.send(true, &Guard::new()).await.err().unwrap().code(), "email_resend_cooldown");
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
    server.cooldown.store(0, Ordering::SeqCst);
    let resent = server.send(true, &Guard::new()).await.unwrap();
    assert!(!resent.same_candidate(&original));
    assert_eq!(resent.status.unwrap().expires_at, server.challenge.expires_at);
    assert_eq!(server.starts.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn cancelled_views_and_failed_storage_leave_recoverable_intents_without_late_updates() {
    let server = Server::new();
    let guard = Guard::new();
    *server.cancel.lock().unwrap() = Some(guard.clone());
    assert_eq!(server.send(false, &guard).await.err().unwrap().code(), "session_closed");
    assert!(server.saved.lock().unwrap().as_ref().unwrap().status.is_none());
    server.send(false, &Guard::new()).await.unwrap();
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
    let fresh = Server::new();
    let failed = factor_email::send(&fresh.challenge, None, false, &fresh, &Guard::new(), |_| async {
        Err(Error::Protocol("secure_storage_unavailable"))
    })
    .await;
    assert_eq!(failed.err().unwrap().code(), "secure_storage_unavailable");
    assert_eq!(fresh.starts.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn a_delivery_cannot_extend_the_original_deadline_or_turn_an_ambiguous_result_into_a_resend() {
    let server = Server::new();
    *server.saved.lock().unwrap() = Some(intent(&server.challenge));
    assert_eq!(server.send(true, &Guard::new()).await.err().unwrap().code(), "credentials_changed");
    assert_eq!(server.starts.load(Ordering::SeqCst), 0);
    server.extend.store(true, Ordering::SeqCst);
    assert_eq!(server.send(false, &Guard::new()).await.err().unwrap().code(), "invalid_native_security");
    assert!(server.saved.lock().unwrap().as_ref().unwrap().status.is_none());
}
#[test]
fn private_metadata_refuses_secrets_unknown_fields_shared_nonces_and_other_challenges() {
    let challenge = challenge();
    let original = intent(&challenge);
    let mut raw = serde_json::to_value(&original).unwrap();
    raw["status"] =
        json!({"expires_at":challenge.expires_at,"delivery":"accepted","resend_after_seconds":0,"code":"PRIVATE-CODE"});
    assert!(serde_json::from_value::<Intent>(raw.clone()).is_err());
    raw["status"].as_object_mut().unwrap().remove("code");
    serde_json::from_value::<Intent>(raw.clone()).unwrap().validate(&challenge).unwrap();
    raw["input"]["operation_id"] = raw["input"]["delivery_id"].clone();
    assert!(serde_json::from_value::<Intent>(raw).unwrap().validate(&challenge).is_err());
    let mut other = challenge.clone();
    other.challenge_id = "d".repeat(64);
    assert!(original.validate(&other).is_err());
}
