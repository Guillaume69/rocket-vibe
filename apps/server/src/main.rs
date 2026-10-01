use clap::{Parser, Subcommand};
use rv_server::App;
use std::net::SocketAddr;

#[derive(Parser)]
#[command(about = "RocketVibe native server — experimental J1 foundation")]
struct Args {
    #[arg(long, env = "DATABASE_URL", hide_env_values = true)]
    database_url: String,
    #[arg(long, env = "RV_AUTH_KEY_FILE", hide_env_values = true)]
    auth_key_file: Option<std::path::PathBuf>,
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
    /// Issue a signup invitation; stdout contains its one-time secret.
    Invite {
        #[arg(long, default_value_t = 168)]
        hours: u32,
    },
    /// List invitation metadata, without secrets.
    ListInvitations,
    /// Revoke an invitation by its public identifier (never its secret).
    RevokeInvitation {
        id: String,
    },
    /// Issue a password recovery code for a verified owner; stdout is secret.
    RecoverUser {
        username: String,
        #[arg(long, default_value_t = 24)]
        hours: u32,
    },
    ListRecoveryCodes,
    RevokeRecoveryCode {
        id: String,
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
    let auth_key = args
        .auth_key_file
        .as_deref()
        .map(rv_server::factor_crypto::AuthKey::from_file)
        .transpose()?;
    let app = App::connect_with_auth_key(&args.database_url, auth_key).await?;
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
        Command::Invite { hours } => {
            let issued = rv_server::invitations::issue(&app, hours)
                .await
                .map_err(|e| format!("Cannot issue invitation: {}", e.code))?;
            println!("{}", serde_json::to_string(&issued)?);
        }
        Command::ListInvitations => {
            let invitations = rv_server::invitations::list(&app)
                .await
                .map_err(|e| format!("Cannot list invitations: {}", e.code))?;
            println!("{}", serde_json::to_string(&invitations)?);
        }
        Command::RevokeInvitation { id } => {
            rv_server::invitations::revoke(&app, &id)
                .await
                .map_err(|e| format!("Cannot revoke invitation: {}", e.code))?;
            println!("Invitation revoked");
        }
        Command::RecoverUser { username, hours } => {
            let issued = rv_server::recovery::issue(&app, &username, hours)
                .await
                .map_err(|e| format!("Cannot issue recovery code: {}", e.code))?;
            println!("{}", serde_json::to_string(&issued)?);
        }
        Command::ListRecoveryCodes => {
            let codes = rv_server::recovery::list(&app)
                .await
                .map_err(|e| format!("Cannot list recovery codes: {}", e.code))?;
            println!("{}", serde_json::to_string(&codes)?);
        }
        Command::RevokeRecoveryCode { id } => {
            rv_server::recovery::revoke(&app, &id)
                .await
                .map_err(|e| format!("Cannot revoke recovery code: {}", e.code))?;
            println!("Recovery code revoked");
        }
    }
    Ok(())
}
