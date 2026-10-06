use super::*;
use crypto::enrollment::history::ImportProgress;
use rv_crypto_public::history::Request as HistoryRequest;

/// History routes of one account: published requests, no share yet.
struct Shares {
    scope: Value,
    requests: Mutex<Vec<Value>>,
    acknowledged: Mutex<Vec<String>>,
}
impl Shares {
    fn attach(pilot: &Pilot) -> Arc<Self> {
        let scope = pilot.crypto_directory.lock().unwrap()["scope"].clone();
        let state = Arc::new(Self { scope, requests: Mutex::new(Vec::new()), acknowledged: Mutex::new(Vec::new()) });
        let state2 = state.clone();
        *pilot.room_handler.lock().unwrap() = Some(Arc::new(move |r| state2.reply(r)));
        state
    }
    fn reply(&self, r: &common::Request) -> Option<common::Response> {
        let path = r.path();
        let rest = path.strip_prefix("/api/v1/e2ee/history/requests")?;
        assert_eq!(r.headers["authorization"], "Bearer fixture-token");
        if rest.is_empty() && r.method == "GET" {
            let requests = self.requests.lock().unwrap().clone();
            return Some(respond(200, &json!({"scope":self.scope,"requests":requests}).to_string()));
        }
        if rest.is_empty() && r.method == "POST" {
            let input: rv_protocol::e2ee::PublishHistoryRequest = serde_json::from_str(&r.body).unwrap();
            let request = HistoryRequest::from_bytes(&B64.decode(&input.request).unwrap()).unwrap();
            let fingerprint = hex(&request.fingerprint().unwrap());
            let entry = json!({"fingerprint":fingerprint,"device_id":request.body.certificate.device.device,"request":input.request,"expires_at":request.body.expires_at.to_string(),"sharer_device_id":null,"committed":false});
            let mut requests = self.requests.lock().unwrap();
            requests.retain(|e| e["device_id"] != entry["device_id"]);
            requests.push(entry.clone());
            return Some(respond(200, &entry.to_string()));
        }
        if let Some(request) = rest.strip_prefix('/').and_then(|r| r.strip_suffix("/ack")) {
            self.acknowledged.lock().unwrap().push(request.into());
            self.requests.lock().unwrap().retain(|e| e["fingerprint"] != request);
            return Some(respond(204, ""));
        }
        if rest.ends_with("/share") && r.method == "GET" {
            return Some(respond(404, r#"{"code":"not_found","request_id":"history-pilot"}"#));
        }
        panic!("unexpected history route {} {path}", r.method)
    }
}

#[tokio::test]
async fn a_new_device_publishes_one_request_waits_for_a_share_and_never_answers_itself() {
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let server = Shares::attach(&pilot);
    // A finished request whose acknowledgement was lost is acknowledged.
    let device = pilot.crypto_directory.lock().unwrap()["devices"][0]["device_id"].clone();
    server.requests.lock().unwrap().push(json!({"fingerprint":"ab".repeat(32),"device_id":device,"request":"","expires_at":"1","sharer_device_id":"other","committed":true}));
    assert_eq!(access.import_history().await.unwrap(), ImportProgress::Idle);
    assert_eq!(*server.acknowledged.lock().unwrap(), vec!["ab".repeat(32)]);
    let request = access.request_history().await.unwrap();
    // Replayed, not drawn again: still one request on the server.
    assert_eq!(access.request_history().await.unwrap(), request);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(access.import_history().await.unwrap(), ImportProgress::Waiting { request: request.clone() });
    // Its own request is never offered to itself, and no share is pending.
    assert!(access.history_offers().await.unwrap().is_empty());
    assert!(!access.resume_history_share().await.unwrap());
    assert!(server.acknowledged.lock().unwrap().len() == 1);
    access.close();
    pilot.close().await;
}
