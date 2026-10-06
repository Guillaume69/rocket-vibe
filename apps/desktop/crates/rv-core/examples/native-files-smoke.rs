//! Existing desktop core against the real native server and PostgreSQL.
use rv_client::NativeClient;
use rv_core::{native::NativeSession, session::Connection};
use rv_protocol::{CreateRoom, parity::DeleteMessage};
use std::{path::Path, time::Duration};
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("desktop file condition timed out");
}
#[tokio::main]
async fn main() {
    let base = std::env::var("RV_FILE_TEST_SERVER").unwrap();
    let password = std::env::var("RV_FILE_TEST_PASSWORD").unwrap();
    let mut remote = NativeClient::new(&base).unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        while remote.discover().await.is_err() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    remote.login("desktop-files", &password).await.unwrap();
    let room = remote
        .create_room(&CreateRoom {
            operation_id: Some(format!("{:032x}", fastrand::u128(..))),
            name: format!("desktop-files-{:08x}", fastrand::u32(..)),
            private: true,
            voice: false,
        })
        .await
        .unwrap();
    let info = rv_core::session::login(&base.parse().unwrap(), "desktop-files", &password, None).await.unwrap();
    let folder = std::env::temp_dir().join(format!("rv-files-smoke-{:032x}", fastrand::u128(..)));
    std::fs::create_dir_all(&folder).unwrap();
    let db = folder.join("session.sqlite");
    let source = folder.join("original.txt");
    let destination = folder.join("saved.txt");
    let content = "file from the existing desktop provider\n".repeat(30000);
    std::fs::write(&source, &content).unwrap();
    let first = NativeSession::start(info.clone(), &db).unwrap();
    until(|| first.status().connection == Connection::Online && first.store.read_state(&room.id).unwrap().is_some())
        .await;
    assert!(first.supported_features().iter().any(|f| f == "uploads"));
    let membership = first.store.read_state(&room.id).unwrap().unwrap().membership_version.unwrap();
    first.suspend();
    first
        .attach_file(
            &room.id,
            &source,
            "original.txt",
            "text/plain",
            Some("durable desktop caption"),
            false,
            &membership,
        )
        .await
        .unwrap();
    let original = first.store.file_intents().unwrap()[0].clone();
    std::fs::write(&source, "the original changed after attachment selection").unwrap();
    first.shutdown();
    drop(first);
    let second = NativeSession::start(info.clone(), &db).unwrap();
    until(|| second.status().connection == Connection::Online && second.store.file_intents().unwrap().is_empty()).await;
    let history = remote.history(&room.id, None).await.unwrap();
    let messages: Vec<_> = history.messages.iter().filter(|m| m.system.is_none()).collect();
    assert_eq!(messages.len(), 1);
    let message = messages[0];
    assert_eq!(message.id, original.complete.operation_id);
    assert_eq!(message.text, "durable desktop caption");
    assert_eq!(message.files.len(), 1);
    let handle = format!("rv-file:{}", message.files[0].id);
    assert!(
        !second
            .store
            .messages(&room.id, 50)
            .unwrap()
            .into_iter()
            .find(|row| row.id == original.complete.operation_id)
            .unwrap()
            .attachments
            .unwrap()
            .contains("fixture-token")
    );
    second.download_file(&handle, &destination).await.unwrap();
    assert_eq!(std::fs::read_to_string(&destination).unwrap(), content);
    let cached = second.local_file(&handle).await.unwrap();
    assert!(cached.starts_with(db.with_extension("native-files")));
    assert_eq!(std::fs::read_to_string(&cached).unwrap(), content);
    let preview = second.file_media(&handle).await.unwrap();
    assert_eq!(preview.bytes, content.as_bytes());
    let mut outsider = NativeClient::new(&base).unwrap();
    outsider.login("files-outsider", &password).await.unwrap();
    assert!(outsider.file_response(&message.files[0].id, None).await.is_err());
    second.suspend();
    second.attach_file(&room.id, &source, "abandoned.txt", "text/plain", None, false, &membership).await.unwrap();
    let abandoned = second.store.file_intents().unwrap()[0].id.clone();
    second.discard_file(&abandoned).unwrap();
    second.shutdown();
    drop(second);
    let third = NativeSession::start(info, &db).unwrap();
    until(|| third.status().connection == Connection::Online && third.store.file_intents().unwrap().is_empty()).await;
    assert_eq!(remote.history(&room.id, None).await.unwrap().messages.iter().filter(|m| m.system.is_none()).count(), 1);
    remote
        .delete_message(
            &message.id,
            &DeleteMessage {
                operation_id: format!("{:032x}", fastrand::u128(..)),
                expected_revision: message.revision.clone(),
            },
        )
        .await
        .unwrap();
    until(|| !third.file_current(&handle)).await;
    assert!(third.local_file(&handle).await.is_err());
    assert!(remote.file_response(&message.files[0].id, None).await.is_err());
    third.shutdown();
    drop(third);
    remote
        .create_room(&CreateRoom {
            operation_id: Some(format!("{:032x}", fastrand::u128(..))),
            name: "Desktop files GTK pilot".into(),
            private: true,
            voice: false,
        })
        .await
        .unwrap();
    assert!(Path::new(&destination).exists()); // An explicitly saved copy belongs to the user.
    let _ = std::fs::remove_dir_all(folder);
    println!(
        "native desktop files: streamed upload, immutable private copy, restart, cancellation, private download and tombstone passed"
    );
}
