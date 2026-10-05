//! Signed public values only; withdrawal consent stays on this native handle.
use super::*;
use rv_crypto::account;
use rv_protocol::e2ee;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {},
    Preview { device: String, fingerprint: String },
    Prepare { id: String },
    Pending {},
    Acknowledge { receipt: e2ee::OperationReceipt },
}

#[cfg(test)]
mod tests;
#[uniffi::export]
impl CryptoInstallation {
    pub fn withdrawal_action(&self, directory: String, input: String) -> Result<String> {
        if input.len() > 32768 {
            return Err(CryptoBridgeError::Integrity);
        }
        let action: Action =
            serde_json::from_str(&input).map_err(|_| CryptoBridgeError::Integrity)?;
        self.identity_call(&directory, |c, d, _| {
            // Historical own certificates can withdraw; new MLS work still needs
            // prepared() and a currently valid certificate.
            c.withdrawals(d)?;
            let output = match action {
                Action::View {} => serde_json::to_value(c.withdrawals(d)?),
                Action::Preview { device, fingerprint } => {
                    let preview = c.preview_withdrawal(d, &device, &fingerprint)?;
                    let mut nonce = [0; 16];
                    getrandom::fill(&mut nonce).map_err(|_| account::Error::Changed)?;
                    let id = data_encoding::HEXLOWER.encode(&nonce);
                    let output = serde_json::json!({"id":id,"device":preview.device,"incarnation":preview.incarnation,
                        "fingerprint":preview.fingerprint,"root_fingerprint":preview.root_fingerprint,"expires_at":preview.expires_at});
                    *self.withdrawal_approval.lock().map_err(|_| account::Error::Changed)? = Some((id, preview));
                    Ok(output)
                }
                Action::Prepare { id } => {
                    let (expected, preview) = self.withdrawal_approval.lock().map_err(|_| account::Error::Changed)?.take().ok_or(account::Error::Changed)?;
                    if id != expected { return Err(account::Error::Changed); }
                    serde_json::to_value(c.prepare_withdrawal(d, preview)?)
                }
                Action::Pending {} => serde_json::to_value(c.pending_withdrawal()?),
                Action::Acknowledge { receipt } => {
                    c.acknowledge_withdrawal(&c.pending_withdrawal()?, receipt)?;
                    serde_json::to_value(c.withdrawals(d)?)
                }
            }.map_err(|_| account::Error::Changed)?;
            serde_json::to_string(&output).map_err(|_| account::Error::Changed)
        })
    }
}
