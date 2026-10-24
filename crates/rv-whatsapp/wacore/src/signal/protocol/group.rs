//! Group encrypt and decrypt through the sender key store. The callers hold
//! the group's `sender_key_lock`; these functions never take it.

use bytes::Bytes;
use rand::CryptoRng;

use super::error::{Result, SignalProtocolError};
use super::messages::{CiphertextMessageType, SenderKeyDistributionMessage, SenderKeyMessage};
use super::sender_keys::SenderKeyRecord;
use super::storage::SenderKeyStore;
use crate::signal::store::sender_key_name::SenderKeyName;

fn group_error(e: rv_signal::Error) -> SignalProtocolError {
    match e {
        rv_signal::Error::DuplicatedMessage(iteration) => {
            SignalProtocolError::DuplicatedMessage(iteration, iteration)
        }
        other => SignalProtocolError::from_signal(other, CiphertextMessageType::SenderKey),
    }
}

/// My sender key for the group, created on first use.
pub async fn create_sender_key_distribution_message<R: CryptoRng + ?Sized>(
    sender_key_name: &SenderKeyName,
    sender_key_store: &mut dyn SenderKeyStore,
    csprng: &mut R,
) -> Result<SenderKeyDistributionMessage> {
    let mut record = sender_key_store
        .load_sender_key(sender_key_name)
        .await?
        .unwrap_or_default();
    let distribution = record
        .with_signal(|r| Ok(r.distribution(csprng)))?
        .map_err(group_error)?;
    sender_key_store
        .store_sender_key(sender_key_name, record)
        .await?;
    Ok(distribution)
}

pub async fn process_sender_key_distribution_message(
    sender_key_name: &SenderKeyName,
    skdm: &SenderKeyDistributionMessage,
    sender_key_store: &mut dyn SenderKeyStore,
) -> Result<()> {
    let mut record = sender_key_store
        .load_sender_key(sender_key_name)
        .await?
        .unwrap_or_default();
    record
        .with_signal(|r| {
            r.process(skdm);
            Ok(())
        })?
        .map_err(group_error)?;
    sender_key_store
        .store_sender_key(sender_key_name, record)
        .await
}

pub async fn group_encrypt<S: SenderKeyStore + ?Sized, R: CryptoRng + ?Sized>(
    sender_key_store: &mut S,
    sender_key_name: &SenderKeyName,
    plaintext: &[u8],
    csprng: &mut R,
) -> Result<SenderKeyMessage> {
    let mut record = sender_key_store
        .load_sender_key(sender_key_name)
        .await?
        .ok_or_else(|| {
            SignalProtocolError::NoSenderKeyState(format!(
                "no sender key for {}",
                sender_key_name.cache_key()
            ))
        })?;
    let iteration = record
        .state()
        .ok_or(SignalProtocolError::InvalidSenderKeySession)?
        .chain_key()
        .index;
    record.reserve_iterations(iteration);
    let bytes = record
        .with_signal(|r| r.encrypt(plaintext, csprng))?
        .map_err(group_error)?;
    sender_key_store
        .store_sender_key(sender_key_name, record)
        .await?;
    super::messages::sender_key_message(bytes.as_slice())
}

pub async fn group_decrypt(
    skm_bytes: &[u8],
    sender_key_store: &mut dyn SenderKeyStore,
    sender_key_name: &SenderKeyName,
) -> Result<Vec<u8>> {
    // A message that does not parse is malformed whatever the store holds.
    super::messages::sender_key_message(skm_bytes)?;
    let mut record: SenderKeyRecord = sender_key_store
        .load_sender_key(sender_key_name)
        .await?
        .ok_or_else(|| {
            SignalProtocolError::NoSenderKeyState(format!(
                "no sender key for {}",
                sender_key_name.cache_key()
            ))
        })?;
    let plaintext = record
        .with_signal(|r| r.decrypt(skm_bytes))?
        .map_err(group_error)?;
    sender_key_store
        .store_sender_key(sender_key_name, record)
        .await?;
    Ok(plaintext)
}

pub async fn group_decrypt_shared(
    skm_bytes: Bytes,
    sender_key_store: &mut dyn SenderKeyStore,
    sender_key_name: &SenderKeyName,
) -> Result<Vec<u8>> {
    group_decrypt(&skm_bytes, sender_key_store, sender_key_name).await
}
