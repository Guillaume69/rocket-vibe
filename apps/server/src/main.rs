use clap::{Parser, Subcommand};
use rv_server::App;
use std::net::SocketAddr;

#[derive(Parser)]
#[command(about = "RocketVibe native server — experimental J1 foundation")]
struct Args {
    #[arg(long, env = "DATABASE_URL", hide_env_values = true)]
    database_url: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, env = "RV_BIND", default_value = "127.0.0.1:3400")]
        bind: SocketAddr,
    },
    /// Reads the initial password from RV_USER_PASSWORD, never from command arguments.
    CreateUser {
        username: String,
        #[arg(long)]
        admin: bool,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rv_server=info".into()),
        )
        .init();
    let args = Args::parse();
    let app = App::connect(&args.database_url).await?;
    match args.command {
        Command::Serve { bind } => {
            let maintenance = app.clone();
            let cleanup = tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    if let Err(error) = maintenance.cleanup().await {
                        tracing::error!(%error, "ephemeral cleanup failed");
                    }
                }
            });
            let listener = tokio::net::TcpListener::bind(bind).await?;
            tracing::info!(address = %listener.local_addr()?, "native server listening");
            axum::serve(
                listener,
                app.router()
                    .into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await?;
            cleanup.abort();
        }
        Command::CreateUser { username, admin } => {
            let password = std::env::var("RV_USER_PASSWORD")
                .map_err(|_| "RV_USER_PASSWORD is required (minimum 12 bytes)")?;
            match rv_server::auth::create_user(&app, &username, password, admin).await {
                Ok(user) => println!("Created {} ({})", user.username, user.id),
                Err(e) => return Err(format!("Cannot create user: {}", e.code).into()),
            }
        }
    }
    Ok(())
}
