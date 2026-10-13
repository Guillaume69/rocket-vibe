//! The server rail's account menu for SwiftUI: mute an account for a while
//! or until unmuted (`rv_core::account_mute`, the file GTK reads too), and
//! sign out an account that is not the open one.

use rv_core::account_mute::{self, Mute, MuteFor};
use rv_core::provider::Chat as Account;

use crate::{Client, RvError, accounts, blocking, on_tokio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MuteChoice {
    OneHour,
    FourHours,
    UntilTomorrow,
    OneWeek,
    UntilUnmuted,
}

impl From<MuteChoice> for MuteFor {
    fn from(choice: MuteChoice) -> Self {
        match choice {
            MuteChoice::OneHour => MuteFor::OneHour,
            MuteChoice::FourHours => MuteFor::FourHours,
            MuteChoice::UntilTomorrow => MuteFor::UntilTomorrow,
            MuteChoice::OneWeek => MuteFor::OneWeek,
            MuteChoice::UntilUnmuted => MuteFor::UntilUnmuted,
        }
    }
}

/// An account's mute: until a time (ms) or until unmuted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AccountMute {
    Until { end: i64 },
    Forever,
}

/// The menu's choices, in order.
#[uniffi::export]
pub fn mute_choices() -> Vec<MuteChoice> {
    vec![
        MuteChoice::OneHour,
        MuteChoice::FourHours,
        MuteChoice::UntilTomorrow,
        MuteChoice::OneWeek,
        MuteChoice::UntilUnmuted,
    ]
}

/// A choice's catalog key, for `L`.
#[uniffi::export]
pub fn mute_choice_label(choice: MuteChoice) -> String {
    MuteFor::from(choice).label().to_owned()
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[uniffi::export]
impl Client {
    /// Mutes the account (`Account::key`) for the choice's time.
    pub fn mute_account(&self, account: String, choice: MuteChoice) {
        let until = MuteFor::from(choice).until(&chrono::Local::now());
        account_mute::mute(&self.dirs.config, &account, until);
    }

    pub fn unmute_account(&self, account: String) {
        account_mute::unmute(&self.dirs.config, &account);
    }

    /// The account's mute now, if it is muted.
    pub fn account_mute(&self, account: String) -> Option<AccountMute> {
        account_mute::muted(&self.dirs.config, &account, now()).map(|mute| match mute {
            Mute::Until(end) => AccountMute::Until { end },
            Mute::Forever => AccountMute::Forever,
        })
    }

    /// The muted accounts' keys now.
    pub fn muted_accounts(&self) -> Vec<String> {
        account_mute::active(&self.dirs.config, now()).into_keys().collect()
    }

    /// When the earliest timed mute ends (ms), to show the accounts again then.
    pub fn next_mute_end(&self) -> Option<i64> {
        account_mute::next_end(&self.dirs.config, now())
    }

    /// Signs out an account that is not open (the rail's "Log out"): told
    /// to its server, then forgotten with its cache, unmuted. A RocketVibe
    /// refusal keeps it. The open account signs out through its own chat.
    pub async fn sign_out_account(&self, account: String) -> Result<(), RvError> {
        let Some(chat) = self.accounts.chat(&account) else {
            return Err(RvError::local("unknown account"));
        };
        let info = chat.info().clone();
        match chat {
            Account::Legacy(session) => {
                let s = session.clone();
                let settled = on_tokio(async move { s.logout().await }).await;
                self.accounts.remove(&account);
                session.shutdown();
                session.store.close();
                let (dirs, info) = (self.dirs.clone(), info.clone());
                blocking(move || {
                    let database = dirs.database(&info);
                    accounts::remove(&dirs, &info);
                    if !settled {
                        accounts::keep_logout(&dirs, &info);
                    }
                    rv_core::store::Store::remove_files(&database);
                })
                .await;
            }
            Account::Native(session) => {
                let s = session.clone();
                if let Err(error) = on_tokio(async move { s.logout().await }).await
                    && !matches!(error.code(), "session_rejected" | "server_identity_changed")
                {
                    return Err(RvError::local(error));
                }
                self.accounts.remove(&account);
                session.shutdown();
                session.store.clear().map_err(RvError::local)?;
                let (dirs, info) = (self.dirs.clone(), info.clone());
                blocking(move || accounts::remove(&dirs, &info)).await;
            }
            // SwiftUI holds no WhatsApp account.
            Account::WhatsApp(_) => return Err(RvError::local("unknown account")),
        }
        account_mute::unmute(&self.dirs.config, &account);
        Ok(())
    }
}
