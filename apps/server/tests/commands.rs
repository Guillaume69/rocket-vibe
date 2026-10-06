use rv_client::NativeClient;
use rv_protocol::{CreateRoom, commands::RunCommand};
use rv_server::{App, auth};
use sqlx::PgPool;

struct Bench {
    app: App,
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Bench {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Bench {
    async fn start(pool: PgPool) -> Self {
        let app = App::from_pool(pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self { app, base, task }
    }
    async fn user(&self, name: &str) -> (NativeClient, String) {
        let user = auth::create_user(&self.app, name, "command-test-password-2026".into(), false)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client
            .login(name, "command-test-password-2026")
            .await
            .unwrap();
        (client, user.id)
    }
}
async fn run(
    client: &NativeClient,
    room: &str,
    command: &str,
    params: &str,
) -> Result<(), rv_client::Error> {
    client
        .run_command(&RunCommand {
            room_id: room.into(),
            command: command.into(),
            params: params.into(),
        })
        .await
}
fn code(result: Result<(), rv_client::Error>, expected: &str) {
    assert!(
        matches!(&result, Err(rv_client::Error::Server { code, .. }) if code == expected),
        "{result:?} is not {expected}"
    );
}
async fn member(client: &NativeClient, room: &str) -> bool {
    client.rooms().await.unwrap().iter().any(|r| r.id == room)
}

#[sqlx::test]
async fn slash_commands_act_through_the_operations_they_name(pool: PgPool) {
    let bench = Bench::start(pool).await;
    let (owner, _) = bench.user("command-owner").await;
    let (alice, _) = bench.user("command-alice").await;
    let (bob, _) = bench.user("command-bob").await;

    assert!(owner.discover().await.unwrap().capabilities.slash_commands);
    let list = owner.commands().await.unwrap().commands;
    assert_eq!(list.len(), 13);
    assert!(list.iter().any(|c| c.command == "shrug" && c.client_side));
    assert!(list.iter().any(|c| c.command == "topic" && !c.client_side));

    let room = owner
        .create_room(&CreateRoom {
            name: "Commands".into(),
            private: true,
            operation_id: Some("commands-room".into()),
        })
        .await
        .unwrap()
        .id;
    run(&owner, &room, "invite", "@command-alice")
        .await
        .unwrap();
    assert!(member(&alice, &room).await);
    run(&owner, &room, "topic", "  Plans for the week ")
        .await
        .unwrap();
    assert_eq!(
        owner.room_details(&room).await.unwrap().topic,
        "Plans for the week"
    );
    code(
        run(&alice, &room, "topic", "Mine now").await,
        "permission_denied",
    );
    run(&owner, &room, "kick", "command-alice").await.unwrap();
    assert!(!member(&alice, &room).await);
    code(run(&owner, &room, "kick", "").await, "invalid_request");
    code(
        run(&owner, &room, "invite", "@nobody-here").await,
        "not_found",
    );

    let lobby = owner
        .create_room(&CreateRoom {
            name: "Lobby".into(),
            private: false,
            operation_id: Some("commands-lobby".into()),
        })
        .await
        .unwrap()
        .id;
    run(&bob, &room, "join", "#lobby").await.unwrap();
    assert!(member(&bob, &lobby).await);
    code(run(&bob, &room, "join", "#nowhere").await, "not_found");
    run(&bob, &lobby, "leave", "").await.unwrap();
    assert!(!member(&bob, &lobby).await);

    run(&bob, &room, "msg", "@command-owner hello   there")
        .await
        .unwrap();
    let direct = owner
        .rooms()
        .await
        .unwrap()
        .into_iter()
        .find(|r| matches!(r.kind, rv_protocol::RoomKind::Direct))
        .unwrap();
    let page = owner.history(&direct.id, None).await.unwrap();
    assert!(page.messages.iter().any(|m| m.text == "hello   there"));
    code(
        run(&bob, &room, "msg", "@command-owner").await,
        "invalid_request",
    );

    run(&bob, &room, "status", "Out for lunch").await.unwrap();
    assert_eq!(
        bob.own_profile().await.unwrap().profile.status_text,
        "Out for lunch"
    );

    code(run(&bob, &room, "shrug", "").await, "client_side_command");
    code(run(&bob, &room, "nope", "").await, "unknown_command");
}
