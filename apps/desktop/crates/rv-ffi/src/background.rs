//! Every signed-in account kept connected (`rv_core::supervisor`): the
//! sessions `Client` hands out come from it, and the accounts not on screen
//! speak through `AccountListener`.

use std::sync::{Arc, Mutex};

use rv_core::provider::Chat as Account;
use rv_core::session::{Session, SessionInfo};
use rv_core::supervisor::{self, AccountNotice, Notice, Supervisor};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::accounts::{self, Dirs};
use crate::{Client, Incoming, RvError, blocking, on_tokio, runtime};

/// The supervisor of `dirs`' accounts, and its notices.
pub(crate) fn supervise(dirs: Arc<Dirs>) -> (Supervisor, Mutex<Option<UnboundedReceiver<AccountNotice>>>) {
    let starter: supervisor::Starter = Arc::new(move |info: &SessionInfo| {
        let path = dirs.database(info);
        if info.native.is_some() {
            let credentials = Arc::new(crate::native::CredentialStore { dirs: dirs.clone() });
            return rv_core::native::NativeSession::start_with_credentials(info.clone(), &path, Some(credentials))
                .map(Account::from)
                .map_err(|e| e.to_string());
        }
        let session = Session::start(info.clone(), &path).map_err(|e| e.to_string())?;
        let resumed = session.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(jwk) = accounts::e2e_key(&resumed.info) {
                let _guard = runtime().enter();
                resumed.e2e_resume(&jwk);
            }
        });
        Ok(session.into())
    });
    let (accounts, notices) = Supervisor::new(runtime().handle().clone(), starter);
    (accounts, Mutex::new(Some(notices)))
}

/// A call ringing on an account in the background.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BackgroundCall {
    /// The account's key.
    pub account: String,
    /// Its server's host, to name it.
    pub server: String,
    /// The Rocket.Chat or kChat call, or the Vibez ring.
    pub id: String,
    pub rid: String,
    pub caller: String,
    /// A Vibez voice ring (answered by the voice session), else a call link.
    pub voice: bool,
    /// The account is in do not disturb: the prompt shows without the ringtone.
    pub quiet: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum AccountEvent {
    /// A message to notify; `scope` keys its notification and routes its click.
    Incoming { account: String, scope: String, incoming: Incoming },
    /// The call ringing on that account, or none any more.
    Call { account: String, call: Option<BackgroundCall> },
    /// Whether it has unread rooms, and what of it calls for me (the dock's count).
    Unread { account: String, unread: bool, attention: i64 },
    /// Its token was refused: it is stopped until opened again.
    Expired { account: String },
}

#[uniffi::export(with_foreign)]
pub trait AccountListener: Send + Sync {
    /// Called on a tokio thread.
    fn on_account_event(&self, event: AccountEvent);
}

/// Where a background account's notification leads.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BackgroundTarget {
    pub account: String,
    pub rid: String,
}

fn incoming(i: rv_core::notify::Incoming) -> Incoming {
    Incoming {
        rid: i.rid,
        id: i.id,
        author: i.author,
        room_name: i.room_name,
        direct: i.direct,
        body: i.body,
        mentions_me: i.mentions_me,
    }
}

fn event(accounts: &Supervisor, notice: AccountNotice) -> Option<AccountEvent> {
    let account = notice.key();
    let info = notice.info;
    Some(match notice.notice {
        Notice::Incoming(i) => {
            let chat = accounts.chat(&account)?;
            let scope = match &chat {
                Account::Native(session) => {
                    if session.quiet_now() {
                        return None;
                    }
                    session.notification_key(&i.rid)
                }
                Account::Legacy(_) => supervisor::notification_key(&info, &i.rid),
                // Never started here: the SwiftUI app lists no WhatsApp account.
                Account::WhatsApp(_) => return None,
            };
            AccountEvent::Incoming { account, scope, incoming: incoming(supervisor::from_account(i, &info)) }
        }
        Notice::Call(call) => {
            let call = call.map(|c| {
                let room = match accounts.chat(&account) {
                    Some(Account::Legacy(session)) => session.store.room_name(&c.rid).map(|(name, _)| name),
                    _ => None,
                };
                BackgroundCall {
                    account: account.clone(),
                    server: supervisor::server_label(&info),
                    id: c.call_id,
                    rid: c.rid,
                    caller: c.caller_name.or(room).unwrap_or_default(),
                    voice: false,
                    quiet: false,
                }
            });
            AccountEvent::Call { account, call }
        }
        Notice::Voice(call) => {
            let quiet = matches!(accounts.chat(&account), Some(Account::Native(s)) if s.quiet_now());
            let call = call.map(|c| BackgroundCall {
                account: account.clone(),
                server: supervisor::server_label(&info),
                id: c.id,
                rid: c.rid,
                caller: c.caller,
                voice: true,
                quiet,
            });
            AccountEvent::Call { account, call }
        }
        Notice::Unread(badge) => {
            let attention = match badge {
                rv_core::rooms::Badge::Count(n) => n,
                _ => 0,
            };
            AccountEvent::Unread { account, unread: badge != rv_core::rooms::Badge::None, attention }
        }
        Notice::Expired => AccountEvent::Expired { account },
    })
}

#[uniffi::export]
impl Client {
    /// Hears the accounts not on screen; only the first listener is kept.
    pub fn watch_accounts(&self, listener: Arc<dyn AccountListener>) {
        let Some(mut notices) = self.notices.lock().unwrap().take() else { return };
        let accounts = self.accounts.clone();
        runtime().spawn(async move {
            while let Some(notice) = notices.recv().await {
                let active = accounts.is_active(&notice.key());
                if active && !matches!(notice.notice, Notice::Unread(_)) {
                    continue;
                }
                if let Some(event) = event(&accounts, notice) {
                    listener.on_account_event(event);
                }
            }
        });
    }

    /// Every signed-in account connected; those signed out elsewhere stop.
    pub async fn keep_accounts_connected(&self) {
        let dirs = self.dirs.clone();
        let saved = blocking(move || accounts::load_all(&dirs)).await;
        let supervisor = self.accounts.clone();
        on_tokio(async move { supervisor.sync(&saved) }).await;
    }

    /// The account and room of a background account's notification.
    pub fn background_target(&self, scope: String) -> Option<BackgroundTarget> {
        supervisor::notification_target(&scope).map(|(account, rid)| BackgroundTarget { account, rid })
    }

    /// Answers a background account's notification in its room.
    pub async fn background_reply(&self, scope: String, text: String) -> Result<(), RvError> {
        let (account, rid) =
            supervisor::notification_target(&scope).ok_or_else(|| RvError::local("unknown notification"))?;
        let session = self
            .accounts
            .chat(&account)
            .and_then(|c| c.legacy().cloned())
            .ok_or_else(|| RvError::local("unknown account"))?;
        on_tokio(async move { session.send(&rid, &text).await }).await;
        Ok(())
    }

    /// Declines a background account's call or voice ring.
    pub async fn decline_background_call(&self, call: BackgroundCall) {
        match self.accounts.chat(&call.account) {
            Some(Account::Legacy(session)) => {
                let _ = on_tokio(async move { session.decline_call(&call.id).await }).await;
            }
            Some(Account::Native(session)) => {
                let _ = on_tokio(async move { session.decline_ring(&call.id).await }).await;
            }
            Some(Account::WhatsApp(_)) | None => {}
        }
    }

    /// A click outside or Escape: it stops ringing here, nothing is declined.
    pub fn ignore_background_call(&self, call: BackgroundCall) {
        if let Some(Account::Legacy(session)) = self.accounts.chat(&call.account) {
            session.dismiss_call();
        }
    }
}
