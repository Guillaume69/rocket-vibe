use rv_client::NativeClient;
use rv_server::{App, auth, objects::LocalObjects};
use sqlx::PgPool;
use std::{io::Cursor, path::PathBuf};

struct Bench {
    app: App,
    root: PathBuf,
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Bench {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl Bench {
    async fn new(pool: PgPool) -> Self {
        let root = std::env::temp_dir().join(format!("rv-icon-{}", auth::random_token()));
        let app = App::from_pool(pool)
            .await
            .unwrap()
            .with_objects(LocalObjects::open(&root).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = app.clone().router();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            app,
            root,
            base,
            task,
        }
    }
    async fn client(&self, name: &str, admin: bool) -> NativeClient {
        auth::create_user(&self.app, name, "disposable-icon-password".into(), admin)
            .await
            .unwrap();
        let mut client = NativeClient::new(&self.base).unwrap();
        client
            .login(name, "disposable-icon-password")
            .await
            .unwrap();
        client
    }
}
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(width, height)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
fn status(error: rv_client::Error) -> u16 {
    match error {
        rv_client::Error::Server { status, .. } => status,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[sqlx::test]
async fn an_administrator_sets_and_removes_the_public_square_icon(pool: PgPool) {
    let bench = Bench::new(pool).await;
    let admin = bench.client("icon-admin", true).await;
    let member = bench.client("icon-member", false).await;
    let found = admin.discover().await.unwrap();
    assert!(found.capabilities.instance_icon);
    assert_eq!(found.icon_revision, None);
    // A member is refused.
    assert_eq!(
        status(
            member
                .admin_set_icon(&auth::random_token(), Some(("image/png", png(4, 4))))
                .await
                .unwrap_err()
        ),
        403
    );
    // A wide image becomes a square of at most 256 pixels, readable by anyone.
    let operation = auth::random_token();
    let set = admin
        .admin_set_icon(&operation, Some(("image/png", png(600, 300))))
        .await
        .unwrap();
    let revision = set.revision.clone().unwrap();
    assert_eq!(
        admin
            .admin_set_icon(&operation, Some(("image/png", png(600, 300))))
            .await
            .unwrap(),
        set,
        "a replay applies nothing"
    );
    let anonymous = NativeClient::new(&bench.base).unwrap();
    assert_eq!(
        anonymous.discover().await.unwrap().icon_revision.as_deref(),
        Some(revision.as_str())
    );
    let bytes = anonymous.instance_icon(&revision).await.unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (256, 256));
    // Not an image: refused, the icon stays.
    assert_eq!(
        status(
            admin
                .admin_set_icon(&auth::random_token(), Some(("image/png", b"nope".to_vec())))
                .await
                .unwrap_err()
        ),
        400
    );
    // Removed: discovery says so and the image is gone.
    let removed = admin
        .admin_set_icon(&auth::random_token(), None)
        .await
        .unwrap();
    assert_eq!(removed.revision, None);
    assert_eq!(anonymous.discover().await.unwrap().icon_revision, None);
    assert_eq!(
        status(anonymous.instance_icon(&revision).await.unwrap_err()),
        404
    );
    let actors: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT actor_id FROM operator_audit WHERE action='instance.icon' ORDER BY id",
    )
    .fetch_all(&bench.app.pool)
    .await
    .unwrap();
    assert_eq!(actors.len(), 2);
    assert!(actors.iter().all(Option::is_some));
}
