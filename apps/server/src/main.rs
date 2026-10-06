use clap::{Parser, Subcommand};
use rv_server::App;
use std::net::SocketAddr;

#[derive(Parser)]
#[command(about = "RocketVibe native server and operator CLI")]
struct Args {
    #[arg(long, env = "DATABASE_URL", hide_env_values = true)]
    database_url: String,
    #[arg(long, env = "RV_AUTH_KEY_FILE", hide_env_values = true)]
    auth_key_file: Option<std::path::PathBuf>,
    #[arg(long, env = "RV_SMTP_CONFIG_FILE", hide_env_values = true)]
    smtp_config_file: Option<std::path::PathBuf>,
    /// Firebase HTTP v1 service-account JSON, kept outside the repository.
    #[arg(long, env = "RV_FCM_CONFIG_FILE", hide_env_values = true)]
    fcm_config_file: Option<std::path::PathBuf>,
    /// The LiveKit SFU of voice sessions: client origin, API origin and key.
    #[arg(long, env = "RV_LIVEKIT_CONFIG_FILE", hide_env_values = true)]
    livekit_config_file: Option<std::path::PathBuf>,
    /// Offer native end-to-end encryption to clients (`e2ee` capability). On
    /// by default; `RV_E2EE=false` turns it off for this instance.
    #[arg(
        long,
        env = "RV_E2EE",
        default_value_t = true,
        action = clap::ArgAction::Set,
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    e2ee: bool,
    /// Durable volume; include it with PostgreSQL in backups.
    #[arg(long, env = "RV_OBJECTS_DIR", default_value = "data/objects")]
    objects_dir: std::path::PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage the instance custom emoji catalogue on the operator-owned volume.
    Emoji {
        #[command(subcommand)]
        command: EmojiCommand,
    },
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
    /// Public account metadata only; no email, password, factor or bearer.
    ListUsers {
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// Change account policy by stable UID; changes revoke its device sessions.
    SetUser {
        id: String,
        #[arg(long)]
        revision: Option<String>,
        #[arg(long)]
        disabled: Option<bool>,
        #[arg(long)]
        admin: Option<bool>,
        #[arg(long)]
        create_public_room: Option<bool>,
        #[arg(long)]
        create_private_room: Option<bool>,
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Room metadata only; never reads chat content or encryption keys.
    ListRooms {
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    CreateRoom {
        owner_id: String,
        name: String,
        #[arg(long)]
        private: bool,
        /// A voice channel: selecting it joins its voice session.
        #[arg(long)]
        voice: bool,
        #[arg(long)]
        operation_id: Option<String>,
    },
    SetRoom {
        id: String,
        #[arg(long)]
        revision: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        private: Option<bool>,
        #[arg(long)]
        read_only: Option<bool>,
        #[arg(long)]
        topic: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        announcement: Option<String>,
        #[arg(long)]
        voice: Option<bool>,
        #[arg(long)]
        operation_id: Option<String>,
    },
    ListMembers {
        room: String,
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// Add/change a role or remove a member, using the room's current revision.
    SetMember {
        room: String,
        user_id: String,
        #[arg(long, value_parser=["owner","moderator","member"], required_unless_present="remove", conflicts_with="remove")]
        role: Option<String>,
        #[arg(long)]
        remove: bool,
        #[arg(long)]
        revision: String,
        #[arg(long)]
        operation_id: Option<String>,
    },
    Audit {
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// Database, epoch, migration and counts; no connection string or secret.
    Health,
}

type CliResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

#[derive(Subcommand)]
enum EmojiCommand {
    List,
    Put {
        name: String,
        file: std::path::PathBuf,
        #[arg(long = "alias")]
        aliases: Vec<String>,
        #[arg(long)]
        revision: Option<String>,
        #[arg(long)]
        operation_id: Option<String>,
    },
    Remove {
        name: String,
        #[arg(long)]
        revision: String,
        #[arg(long)]
        operation_id: Option<String>,
    },
}
fn output(value: impl serde::Serialize) -> CliResult {
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}
fn operator_output(value: Result<impl serde::Serialize, impl std::fmt::Debug>) -> CliResult {
    output(value.map_err(|e| format!("Operator read failed: {e:?}"))?)
}
async fn apply_operator(
    app: &App,
    operation: Option<String>,
    command: rv_server::operator::Command,
) -> CliResult {
    let operation = operation.unwrap_or_else(rv_server::auth::random_token);
    let receipt = rv_server::operator::apply(app, &operation, command)
        .await
        .map_err(|e| format!("Operator command failed: {}", e.code))?;
    output(receipt)
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
    let mail = args
        .smtp_config_file
        .as_deref()
        .map(rv_server::mail::Sender::from_file)
        .transpose()?;
    let app = App::connect_with_auth_key(&args.database_url, auth_key)
        .await?
        .with_mail(mail)
        .with_push(
            args.fcm_config_file
                .as_deref()
                .map(rv_server::push::Sender::from_file)
                .transpose()?,
        )
        .with_livekit(
            args.livekit_config_file
                .as_deref()
                .map(rv_server::livekit::LiveKit::from_file)
                .transpose()?,
        )
        .with_e2ee(args.e2ee);
    match args.command {
        Command::Emoji { command } => match command {
            EmojiCommand::List => operator_output(rv_server::custom_emojis::catalog(&app).await)?,
            EmojiCommand::Put {
                name,
                file,
                aliases,
                revision,
                operation_id,
            } => {
                use tokio::io::AsyncReadExt;
                let mut bytes = Vec::new();
                tokio::fs::File::open(file)
                    .await?
                    .take((rv_server::custom_emojis::MAX_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .await?;
                let app =
                    app.with_objects(rv_server::objects::LocalObjects::open(&args.objects_dir)?);
                operator_output(
                    rv_server::custom_emojis::put(
                        &app,
                        &operation_id.unwrap_or_else(rv_server::auth::random_token),
                        &name,
                        aliases,
                        revision.as_deref(),
                        bytes,
                    )
                    .await,
                )?;
            }
            EmojiCommand::Remove {
                name,
                revision,
                operation_id,
            } => operator_output(
                rv_server::custom_emojis::remove(
                    &app,
                    &operation_id.unwrap_or_else(rv_server::auth::random_token),
                    &name,
                    &revision,
                )
                .await,
            )?,
        },
        Command::Serve { bind } => {
            let app = app.with_objects(rv_server::objects::LocalObjects::open(&args.objects_dir)?);
            app.cleanup().await?;
            let delivery_app = app.clone();
            let mail_worker = tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    if let Err(error) = rv_server::email_delivery::drain(&delivery_app).await {
                        tracing::error!(code = error.code, "email delivery iteration failed");
                    }
                }
            });
            let maintenance = app.clone();
            let push_app = app.clone();
            let push_worker = tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    if let Err(error) = rv_server::push::drain(&push_app).await {
                        tracing::error!(code = error.code, "push delivery iteration failed");
                    }
                }
            });
            let voice_app = app.clone();
            let voice_worker = tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tick.tick().await;
                    if let Err(error) = rv_server::voice::reconcile(&voice_app).await {
                        tracing::error!(code = error.code, "voice worker iteration failed");
                    }
                }
            });
            let preview_app = app.clone();
            let preview_worker = tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    if let Err(error) = rv_server::link_previews::drain(&preview_app).await {
                        tracing::error!(code = error.code, "link preview iteration failed");
                    }
                }
            });
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
            mail_worker.abort();
            preview_worker.abort();
            push_worker.abort();
            voice_worker.abort();
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
        Command::ListUsers { after, limit } => {
            operator_output(rv_server::operator::users(&app, after.as_deref(), limit).await)?
        }
        Command::SetUser {
            id,
            revision,
            disabled,
            admin,
            create_public_room,
            create_private_room,
            operation_id,
        } => {
            apply_operator(
                &app,
                operation_id,
                rv_server::operator::Command::User {
                    id,
                    expected: revision,
                    changes: rv_server::operator::UserChanges {
                        disabled,
                        admin,
                        create_public_room,
                        create_private_room,
                    },
                },
            )
            .await?;
        }
        Command::ListRooms { after, limit } => {
            operator_output(rv_server::operator::rooms(&app, after.as_deref(), limit).await)?
        }
        Command::CreateRoom {
            owner_id,
            name,
            private,
            voice,
            operation_id,
        } => {
            apply_operator(
                &app,
                operation_id,
                rv_server::operator::Command::CreateRoom {
                    owner: owner_id,
                    name,
                    private,
                    voice,
                },
            )
            .await?
        }
        Command::SetRoom {
            id,
            revision,
            name,
            private,
            read_only,
            topic,
            description,
            announcement,
            voice,
            operation_id,
        } => {
            apply_operator(
                &app,
                operation_id,
                rv_server::operator::Command::Room {
                    id,
                    expected: revision,
                    changes: rv_server::operator::RoomChanges {
                        name,
                        private,
                        read_only,
                        topic,
                        description,
                        announcement,
                        voice,
                    },
                },
            )
            .await?;
        }
        Command::ListMembers { room, after, limit } => operator_output(
            rv_server::operator::members(&app, &room, after.as_deref(), limit).await,
        )?,
        Command::SetMember {
            room,
            user_id,
            revision,
            role,
            remove: _,
            operation_id,
        } => {
            apply_operator(
                &app,
                operation_id,
                rv_server::operator::Command::Member {
                    room,
                    user: user_id,
                    expected: revision,
                    role,
                },
            )
            .await?
        }
        Command::Audit { after, limit } => {
            operator_output(rv_server::operator::audit(&app, after.as_deref(), limit).await)?
        }
        Command::Health => operator_output(rv_server::operator::health(&app).await)?,
    }
    Ok(())
}
