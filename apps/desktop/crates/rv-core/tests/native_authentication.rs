mod common;
use common::{FakeHttp, respond};
use rv_core::native::{
    self,
    authentication::{self, LoginChallenge, PendingFactor, Step},
};
use rv_protocol::parity::SecondFactor;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn expiry() -> String {
    (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339()
}
fn discovery(f: &Value) -> Value {
    let mut d = f["discovery"].clone();
    d["capabilities"]["second_factors"] = json!(true);
    d["capabilities"]["device_sessions"] = json!(true);
    d
}
fn challenge(base: &str) -> LoginChallenge {
    let f = fixture();
    LoginChallenge {
        base_url: base.into(),
        identity: native::Identity {
            instance_id: f["discovery"]["instance_id"].as_str().unwrap().into(),
            data_epoch: f["discovery"]["data_epoch"].as_str().unwrap().into(),
        },
        user: serde_json::from_value(f["session"]["user"].clone()).unwrap(),
        challenge: rv_protocol::parity::AuthChallenge {
            challenge_id: "a".repeat(64),
            methods: vec![SecondFactor::Totp, SecondFactor::RecoveryCode],
            expires_at: expiry(),
            resend_after_seconds: 0,
        },
        pending: None,
        email: None,
    }
}
#[tokio::test]
async fn account_codes_follow_full_factor_login_and_cannot_redirect_to_another_uid() {
    for recovery in [false, true] {
        for scenario in ["ok", "uid", "capability"] {
            let accepted = Arc::new(AtomicUsize::new(0));
            let seen = accepted.clone();
            let f = fixture();
            let server=FakeHttp::start(move |request| {
            assert!(!request.headers.contains_key("authorization"));
            match request.path() {
                "/.well-known/rocketvibe"=>{let mut d=discovery(&f);d["capabilities"]["account_recovery"]=json!(scenario!="capability");d["capabilities"]["account_invitations"]=json!(scenario!="capability");respond(200,&d.to_string())},
                "/api/v1/auth/start"=>respond(200,&json!({"kind":"challenge","user":f["session"]["user"],"challenge":{"challenge_id":"a".repeat(64),"methods":["totp"],"expires_at":expiry(),"resend_after_seconds":0}}).to_string()),
                "/api/v1/auth/recovery"|"/api/v1/auth/invitations/accept"=>{
                    assert_eq!(request.path(),if recovery {"/api/v1/auth/recovery"} else {"/api/v1/auth/invitations/accept"});seen.fetch_add(1,Ordering::SeqCst);
                    let mut user=f["session"]["user"].clone();if scenario=="uid" {user["id"]=json!("other-user");}respond(200,&user.to_string())
                },
                _=>panic!("Unexpected account-code route"),
            }
        }).await;
            let d = serde_json::from_value(discovery(&fixture())).unwrap();
            let result = authentication::start_account_code(
                &server.url,
                &d,
                "alice",
                "transient-password",
                "operator-code",
                recovery,
            )
            .await;
            if scenario == "ok" {
                assert!(matches!(result.unwrap(), Step::Challenge(_)));
            } else {
                assert_eq!(
                    result.err().unwrap().code(),
                    if scenario == "uid" {
                        "server_identity_changed"
                    } else if recovery {
                        "recovery_unavailable"
                    } else {
                        "invitation_unavailable"
                    }
                );
            }
            assert_eq!(accepted.load(Ordering::SeqCst), usize::from(scenario != "capability"));
        }
    }
}

fn devices() -> Value {
    json!([{"id":"device-one","label":"Desktop","created_at":chrono::Utc::now().to_rfc3339(),"last_seen_at":chrono::Utc::now().to_rfc3339(),"expires_at":expiry(),"current":true}])
}

#[tokio::test]
async fn lost_factor_response_recovers_its_durable_candidate_after_challenge_expiry() {
    let saved = Arc::new(Mutex::new(None::<LoginChallenge>));
    let committed = Arc::new(AtomicBool::new(false));
    let submits = Arc::new(AtomicUsize::new(0));
    let (stored, done, count) = (saved.clone(), committed.clone(), submits.clone());
    let f = fixture();
    let server = FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe" => respond(200, &discovery(&f).to_string()),
        "/api/v1/auth/factors/verify" => {
            assert!(!request.headers.contains_key("authorization"));
            let body: Value = serde_json::from_str(&request.body).unwrap();
            let guard = stored.lock().unwrap();
            let pending = guard.as_ref().unwrap().pending.as_ref().unwrap();
            assert_eq!(body["next_token"], pending.next_token);
            assert_eq!(body["operation_id"], pending.operation_id);
            assert_eq!(body["code"], "123456");
            count.fetch_add(1, Ordering::SeqCst);
            done.store(true, Ordering::SeqCst);
            respond(503, r#"{"code":"lost_ack","request_id":"fixture"}"#)
        }
        "/api/v1/me" => {
            let guard = stored.lock().unwrap();
            let pending = guard.as_ref().unwrap().pending.as_ref().unwrap();
            assert_eq!(request.headers.get("authorization").unwrap(), &format!("Bearer {}", pending.next_token));
            assert!(done.load(Ordering::SeqCst));
            respond(200, &f["session"]["user"].to_string())
        }
        "/api/v1/me/sessions" => respond(200, &devices().to_string()),
        _ => panic!("Unexpected factor route"),
    })
    .await;
    let sink = saved.clone();
    let error = authentication::finish(
        challenge(server.url.as_str().trim_end_matches('/')),
        SecondFactor::Totp,
        "123456",
        move |record| {
            let sink = sink.clone();
            async move {
                *sink.lock().unwrap() = Some(record);
                Ok(())
            }
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code(), "lost_ack");
    let mut stored = saved.lock().unwrap().clone().unwrap();
    assert!(!serde_json::to_string(&stored).unwrap().contains("123456"));
    stored.challenge.expires_at = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
    let result = authentication::finish(stored.clone(), SecondFactor::Totp, "", |_| async {
        panic!("Do not clear pending before secure active-session commit")
    })
    .await
    .unwrap();
    assert_eq!(result.info.auth_token, stored.pending.unwrap().next_token);
    assert_eq!(submits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_vault_write_prevents_factor_mutation() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let f = fixture();
    let server = FakeHttp::start(move |request| {
        assert_eq!(request.path(), "/.well-known/rocketvibe");
        seen.fetch_add(1, Ordering::SeqCst);
        respond(200, &discovery(&f).to_string())
    })
    .await;
    let error = authentication::finish(
        challenge(server.url.as_str().trim_end_matches('/')),
        SecondFactor::Totp,
        "123456",
        |_| async { Err(native::Error::Protocol("secure_storage_unavailable")) },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code(), "secure_storage_unavailable");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn only_a_structured_candidate_rejection_allows_replaying_the_original_operation() {
    for scenario in ["ok", "proxy", "other-401", "uid", "devices", "bad-result", "after"] {
        let count = Arc::new(AtomicUsize::new(0));
        let submissions = count.clone();
        let discoveries = Arc::new(AtomicUsize::new(0));
        let reads = discoveries.clone();
        let f = fixture();
        let server = FakeHttp::start(move |request| match request.path() {
            "/.well-known/rocketvibe" => {
                let mut value = discovery(&f);
                if scenario == "after" && reads.fetch_add(1, Ordering::SeqCst) > 0 {
                    value["data_epoch"] = json!("restored");
                }
                respond(200, &value.to_string())
            }
            "/api/v1/me" => match scenario {
                "proxy" => respond(401, r#"{"message":"Proxy error"}"#),
                "other-401" => respond(401, r#"{"code":"unknown","request_id":"fixture"}"#),
                "uid" => {
                    let mut user = f["session"]["user"].clone();
                    user["id"] = json!("other-user");
                    respond(200, &user.to_string())
                }
                "devices" => respond(200, &f["session"]["user"].to_string()),
                _ => respond(401, r#"{"code":"session_rejected","request_id":"fixture"}"#),
            },
            "/api/v1/me/sessions" => {
                let d = devices();
                respond(200, &json!([d[0], d[0]]).to_string())
            }
            "/api/v1/auth/factors/verify" => {
                submissions.fetch_add(1, Ordering::SeqCst);
                let input: Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(input["operation_id"], "original-operation");
                assert_eq!(input["next_token"], "c".repeat(64));
                let mut session = f["session"].clone();
                session["token"] = json!("c".repeat(64));
                session["expires_at"] = json!(expiry());
                if scenario == "bad-result" {
                    session["user"]["id"] = json!("other-user");
                }
                respond(200, &session.to_string())
            }
            _ => panic!("Unexpected factor route"),
        })
        .await;
        let mut record = challenge(server.url.as_str().trim_end_matches('/'));
        record.pending = Some(PendingFactor { operation_id: "original-operation".into(), next_token: "c".repeat(64) });
        let result = authentication::finish(record, SecondFactor::RecoveryCode, "BACKUP", |_| async {
            panic!("Unexpected vault rewrite")
        })
        .await;
        assert_eq!(result.is_ok(), scenario == "ok", "{scenario}");
        assert_eq!(count.load(Ordering::SeqCst), usize::from(matches!(scenario, "ok" | "bad-result" | "after")));
    }
}

#[tokio::test]
async fn malformed_pending_is_rejected_before_network_and_login_pins_both_identity_reads() {
    let mut invalid = challenge("https://example.org");
    invalid.pending = Some(PendingFactor { operation_id: "original".into(), next_token: "short".into() });
    assert_eq!(authentication::recover(&invalid).await.err().unwrap().code(), "invalid_native_authentication");
    for scenario in ["legacy", "factor", "before", "after"] {
        let count = Arc::new(AtomicUsize::new(0));
        let reads = count.clone();
        let f = fixture();
        let server=FakeHttp::start(move |request| {
            assert!(!request.headers.contains_key("authorization"));
            if request.path()=="/.well-known/rocketvibe" {
                let mut d=discovery(&f);let n=reads.fetch_add(1,Ordering::SeqCst);
                if scenario=="legacy" {d["capabilities"]["second_factors"]=json!(false);}
                if scenario=="before" || scenario=="after" && n>0 {d["data_epoch"]=json!("restored");}
                return respond(200,&d.to_string());
            }
            if scenario=="legacy" {assert_eq!(request.path(),"/api/v1/auth/login");let mut session=f["session"].clone();session["token"]=json!("e".repeat(64));session["expires_at"]=json!(expiry());respond(200,&session.to_string())} else {
                assert_eq!(request.path(),"/api/v1/auth/start");respond(200,&json!({"kind":"challenge","user":f["session"]["user"],"challenge":{"challenge_id":"a".repeat(64),"methods":["totp"],"expires_at":expiry(),"resend_after_seconds":0}}).to_string())
            }
        }).await;
        let d = serde_json::from_value(discovery(&fixture())).unwrap();
        let result = authentication::start(&server.url, &d, "alice", "transient-password").await;
        match scenario {
            "legacy" => assert!(matches!(result.unwrap(), Step::Authenticated(_))),
            "factor" => assert!(matches!(result.unwrap(), Step::Challenge(_))),
            _ => assert_eq!(result.err().unwrap().code(), "server_identity_changed"),
        }
    }
}
