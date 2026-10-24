//! Pairwise encrypt and decrypt through the stores. Each call checks the
//! session out, runs `rv-signal` on it, and hands it back stored, or cancels
//! the checkout when it fails, leaving the session as it was. A decrypted
//! prekey message reports the one-time prekey it used rather than deleting
//! it: the caller deletes it once the new session is durable.

use rand::CryptoRng;

use super::address::ProtocolAddress;
use super::error::{Result, SignalProtocolError};
use super::keys::{KeyPair, PublicKey, local_identity};
use super::messages::{
    CiphertextMessage, CiphertextMessageType, OwnedCiphertextMessage, PreKeySignalMessage,
    SignalMessage,
};
use super::prekeys::{GenericSignedPreKey, PreKeyId, SignedPreKeyId};
use super::session::{AliceSignalProtocolParameters, SessionRecord, UsePQRatchet};
use super::storage::{
    CheckoutGuard, Direction, IdentityChange, IdentityKeyStore, PreKeyStore, SessionStore,
    SignedPreKeyStore, is_trusted_identity, save_identity,
};

pub const SIGNED_PRE_KEY_SIGNATURE_LEN: usize = 64;

#[derive(Debug)]
pub struct DecryptionResult {
    pub plaintext: Vec<u8>,
    /// The one-time prekey this message used, to delete once the session it
    /// started is stored.
    pub consumed_prekey_id: Option<PreKeyId>,
    pub identity_change: IdentityChange,
}

pub use rv_signal::PreKeyBundle;

/// A peer's published keys as `rv-signal` takes them; a signature that is not
/// 64 bytes is refused.
pub fn prekey_bundle(
    registration_id: u32,
    pre_key: Option<(PreKeyId, PublicKey)>,
    signed_pre_key_id: SignedPreKeyId,
    signed_pre_key_public: PublicKey,
    signed_pre_key_signature: impl TryInto<[u8; SIGNED_PRE_KEY_SIGNATURE_LEN]>,
    identity_key: PublicKey,
) -> Result<PreKeyBundle> {
    let signed_prekey_signature = signed_pre_key_signature.try_into().map_err(|_| {
        SignalProtocolError::InvalidArgument("signed prekey signature must be 64 bytes".to_owned())
    })?;
    Ok(PreKeyBundle {
        registration_id,
        identity: identity_key,
        signed_prekey_id: signed_pre_key_id.into(),
        signed_prekey: signed_pre_key_public,
        signed_prekey_signature,
        prekey: pre_key.map(|(id, key)| (u32::from(id), key)),
    })
}

async fn require_trusted(
    identities: &dyn IdentityKeyStore,
    address: &ProtocolAddress,
    identity: &PublicKey,
    direction: Direction,
) -> Result<()> {
    if is_trusted_identity(identities, address, identity, direction).await? {
        Ok(())
    } else {
        Err(SignalProtocolError::UntrustedIdentity(address.clone()))
    }
}

pub async fn message_encrypt(
    ptext: &[u8],
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
) -> Result<CiphertextMessage> {
    let (checkout, record) = CheckoutGuard::take(session_store, remote_address).await?;
    let mut record = record
        .filter(|r| r.session_state().is_some())
        .ok_or_else(|| SignalProtocolError::SessionNotFound(remote_address.clone()))?;
    let message = encrypt_checked_out(&mut record, ptext, remote_address, identity_store).await?;
    checkout.store(record).await?;
    Ok(message)
}

async fn encrypt_checked_out(
    record: &mut SessionRecord,
    ptext: &[u8],
    remote_address: &ProtocolAddress,
    identity_store: &mut dyn IdentityKeyStore,
) -> Result<CiphertextMessage> {
    let state = record
        .session_state()
        .ok_or_else(|| SignalProtocolError::SessionNotFound(remote_address.clone()))?;
    let remote =
        state
            .remote_identity_key()?
            .ok_or(SignalProtocolError::InvalidSessionStructure(
                "session has no remote identity key",
            ))?;
    let counter = state.get_sender_chain_key()?.index();
    require_trusted(identity_store, remote_address, &remote, Direction::Sending).await?;
    record.reserve_sender_chain_counters(counter);
    let (kind, bytes) = record
        .with_signal(|r| r.encrypt(ptext))?
        .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::Whisper))?;
    Ok(match kind {
        rv_signal::Kind::PreKey => CiphertextMessage::PreKeySignalMessage(
            super::messages::prekey_signal_message(bytes.as_slice())?,
        ),
        _ => CiphertextMessage::SignalMessage(super::messages::signal_message(bytes.as_slice())?),
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn message_decrypt<R: CryptoRng + ?Sized>(
    ciphertext: &CiphertextMessage,
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    pre_key_store: &mut dyn PreKeyStore,
    signed_pre_key_store: &dyn SignedPreKeyStore,
    csprng: &mut R,
    use_pq_ratchet: UsePQRatchet,
) -> Result<DecryptionResult> {
    match ciphertext {
        CiphertextMessage::SignalMessage(m) => {
            message_decrypt_signal(m, remote_address, session_store, identity_store, csprng).await
        }
        CiphertextMessage::PreKeySignalMessage(m) => {
            message_decrypt_prekey(
                m,
                remote_address,
                session_store,
                identity_store,
                pre_key_store,
                signed_pre_key_store,
                csprng,
                use_pq_ratchet,
            )
            .await
        }
        other => Err(SignalProtocolError::InvalidArgument(format!(
            "message_decrypt cannot be used to decrypt {:?} messages",
            other.message_type()
        ))),
    }
}

/// `message_decrypt` on a message it may take; it is taken once decrypted.
#[allow(clippy::too_many_arguments)]
pub async fn message_decrypt_owned<R: CryptoRng + ?Sized>(
    ciphertext: &mut OwnedCiphertextMessage,
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    pre_key_store: &mut dyn PreKeyStore,
    signed_pre_key_store: &dyn SignedPreKeyStore,
    csprng: &mut R,
    use_pq_ratchet: UsePQRatchet,
) -> Result<DecryptionResult> {
    let message = ciphertext
        .get()
        .ok_or_else(|| SignalProtocolError::InvalidArgument("message already consumed".to_owned()))?
        .clone();
    message_decrypt(
        &message,
        remote_address,
        session_store,
        identity_store,
        pre_key_store,
        signed_pre_key_store,
        csprng,
        use_pq_ratchet,
    )
    .await
}

pub async fn message_decrypt_signal<R: CryptoRng + ?Sized>(
    ciphertext: &SignalMessage,
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    csprng: &mut R,
) -> Result<DecryptionResult> {
    let (checkout, record) = CheckoutGuard::take(session_store, remote_address).await?;
    let mut record = record
        .filter(|r| r.session_state().is_some() || r.previous_session_count() > 0)
        .ok_or_else(|| SignalProtocolError::SessionNotFound(remote_address.clone()))?;
    let decrypted = async {
        let plaintext = record
            .with_signal(|r| r.decrypt(ciphertext.serialized(), csprng))?
            .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::Whisper))?;
        let remote = record
            .session_state()
            .and_then(|s| s.remote_identity_key().ok().flatten())
            .ok_or(SignalProtocolError::InvalidSessionStructure(
                "cannot decrypt without remote identity key",
            ))?;
        require_trusted(
            identity_store,
            remote_address,
            &remote,
            Direction::Receiving,
        )
        .await?;
        let identity_change = save_identity(identity_store, remote_address, &remote).await?;
        Ok::<_, SignalProtocolError>(DecryptionResult {
            plaintext,
            consumed_prekey_id: None,
            identity_change,
        })
    }
    .await?;
    checkout.store(record).await?;
    Ok(decrypted)
}

#[allow(clippy::too_many_arguments)]
pub async fn message_decrypt_prekey<R: CryptoRng + ?Sized>(
    ciphertext: &PreKeySignalMessage,
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    pre_key_store: &mut dyn PreKeyStore,
    signed_pre_key_store: &dyn SignedPreKeyStore,
    csprng: &mut R,
    _use_pq_ratchet: UsePQRatchet,
) -> Result<DecryptionResult> {
    let (checkout, record) = CheckoutGuard::take(session_store, remote_address).await?;
    let mut record = record.unwrap_or_default();
    let decrypted = async {
        require_trusted(
            identity_store,
            remote_address,
            &ciphertext.identity_key,
            Direction::Receiving,
        )
        .await?;
        let base_key = ciphertext.base_key.serialize();
        let known = record
            .session_state()
            .is_some_and(|s| s.alice_base_key() == &base_key[..])
            || record
                .previous_session_states()
                .any(|s| s.is_ok_and(|s| s.alice_base_key() == &base_key[..]));
        let (signed, one_time) = if known {
            (None, None)
        } else {
            let signed = signed_pre_key_store
                .get_signed_pre_key(ciphertext.signed_prekey_id.into())
                .await?
                .key_pair()?;
            let one_time = match ciphertext.prekey_id {
                Some(id) => Some(pre_key_store.get_pre_key(id.into()).await?.key_pair()?),
                None => None,
            };
            (Some(signed), one_time)
        };
        let identity = identity_store.get_identity_key_pair().await?;
        let registration_id = identity_store.get_local_registration_id().await?;
        let local = local_identity(&identity, registration_id);
        let out = record
            .with_signal(|r| {
                r.decrypt_prekey(
                    ciphertext,
                    &local,
                    signed.as_ref(),
                    one_time.as_ref(),
                    csprng,
                )
            })?
            .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::PreKey))?;
        let identity_change =
            save_identity(identity_store, remote_address, &ciphertext.identity_key).await?;
        Ok::<_, SignalProtocolError>(DecryptionResult {
            plaintext: out.plaintext,
            consumed_prekey_id: out.used_prekey.map(PreKeyId::from),
            identity_change,
        })
    }
    .await?;
    checkout.store(record).await?;
    Ok(decrypted)
}

/// Starts a session from a peer's bundle, as the initiator.
pub async fn process_prekey_bundle<R: CryptoRng + ?Sized>(
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    bundle: &PreKeyBundle,
    csprng: &mut R,
    _use_pq_ratchet: UsePQRatchet,
) -> Result<IdentityChange> {
    require_trusted(
        identity_store,
        remote_address,
        &bundle.identity,
        Direction::Sending,
    )
    .await?;
    let identity = identity_store.get_identity_key_pair().await?;
    let registration_id = identity_store.get_local_registration_id().await?;
    let local = local_identity(&identity, registration_id);
    let (checkout, record) = CheckoutGuard::take(session_store, remote_address).await?;
    let mut record = record.unwrap_or_default();
    record
        .with_signal(|r| r.initiate(&local, bundle, csprng))?
        .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::PreKey))?;
    let change = save_identity(identity_store, remote_address, &bundle.identity).await?;
    checkout.store(record).await?;
    Ok(change)
}

/// A session started from bare keys, without a signed bundle (their ratchet
/// key must be their signed prekey, as WhatsApp's always is).
pub fn initialize_alice_session_record<R: CryptoRng + ?Sized>(
    parameters: &AliceSignalProtocolParameters,
    csprng: &mut R,
) -> Result<SessionRecord> {
    if parameters.their_ratchet_key != parameters.their_signed_pre_key {
        return Err(SignalProtocolError::InvalidArgument(
            "the ratchet key must be the signed prekey".to_owned(),
        ));
    }
    let local = local_identity(&parameters.our_identity_key_pair, 0);
    let bundle = PreKeyBundle {
        registration_id: 0,
        identity: parameters.their_identity_key,
        signed_prekey_id: 0,
        signed_prekey: parameters.their_signed_pre_key,
        signed_prekey_signature: [0; 64],
        prekey: parameters.their_one_time_pre_key.map(|k| (0, k)),
    };
    let base: KeyPair = parameters.our_base_key_pair.clone();
    let mut record = SessionRecord::new_fresh();
    record
        .with_signal(|r| r.initiate_unverified(&local, &bundle, base, csprng))?
        .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::PreKey))?;
    Ok(record)
}
