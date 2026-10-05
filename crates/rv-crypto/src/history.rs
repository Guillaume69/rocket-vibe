//! History share primitives: the request key, sealed periods and the HPKE
//! envelope of their secrets. Use only inside an owned protected operation.
//! No trust decision is made here: callers check the account directory, the
//! human approval and the reader's boundaries.
use crate::{
    archive::{self, Packet},
    identity::{Certificate, enrollment::LocalDevice},
    vault::Records,
};
use data_encoding::HEXLOWER;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    signatures::Signer,
    types::{HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType, HpkeKemType},
};
pub use rv_crypto_public::history::{
    Envelope, Manifest, Period, Request, RequestBody, Share, chain,
};
use rv_crypto_public::{
    Fingerprint,
    groups::{Member, Scope},
    messages::Receipt,
};
use rv_protocol::SendMessage;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

const CONFIG: HpkeConfig = HpkeConfig(
    HpkeKemType::DhKem25519,
    HpkeKdfType::HkdfSha256,
    HpkeAeadType::ChaCha20Poly1305,
);
const RECORD: &str = "crypto-history-request-v1";
const MAX_DOCUMENTS: usize = 100_000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("crypto_history_identity")]
    Identity(#[from] rv_crypto_public::Error),
    #[error("crypto_history_archive")]
    Archive(#[from] archive::Error),
    #[error("crypto_history_changed")]
    Changed,
    #[error("crypto_history_not_requested")]
    NotRequested,
    #[error("crypto_history_unavailable")]
    Unavailable,
    #[error("crypto_history_limit")]
    Limit,
}
pub type Result<T> = std::result::Result<T, Error>;

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable)?;
    Ok(bytes)
}
fn info(request: &Fingerprint) -> Vec<u8> {
    let mut info = rv_crypto_public::history::SHARE_DOMAIN.as_bytes().to_vec();
    info.push(0);
    info.extend_from_slice(request);
    info
}

/// The pending request and the seed of its X25519 key, in the vault only.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    request: Request,
    #[serde(with = "seed")]
    seed: Zeroizing<[u8; 32]>,
}
mod seed {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Zeroizing<[u8; 32]>,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let encoded = Zeroizing::new(HEXLOWER.encode(value.as_slice()));
        serializer.serialize_str(&encoded)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Zeroizing<[u8; 32]>, D::Error> {
        let encoded = Zeroizing::new(String::deserialize(deserializer)?);
        let mut bytes = HEXLOWER
            .decode(encoded.as_bytes())
            .map_err(serde::de::Error::custom)?;
        if bytes.len() != 32 {
            bytes.zeroize();
            return Err(serde::de::Error::custom("crypto_history_seed"));
        }
        let mut seed = Zeroizing::new([0; 32]);
        seed.copy_from_slice(&bytes);
        bytes.zeroize();
        Ok(seed)
    }
}
fn pending(records: &Records) -> Result<Option<Pending>> {
    let Some(bytes) = records.get(RECORD) else {
        return Ok(None);
    };
    if bytes.len() > 2 * rv_crypto_public::WIRE_LIMIT {
        return Err(Error::Limit);
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|_| Error::Changed)
}

/// The pending request, if any, for replay after a lost response.
pub fn pending_request(records: &Records) -> Result<Option<Request>> {
    Ok(pending(records)?.map(|p| p.request))
}

/// Creates and saves a history request of this device, or returns the one still
/// pending and unexpired. Its X25519 key is drawn for this request only.
pub fn request(
    device: &LocalDevice,
    crypto: &impl OpenMlsCrypto,
    records: &mut Records,
    now: u64,
    lifetime: u64,
) -> Result<Request> {
    if let Some(existing) = pending(records)?
        && existing.request.verify(now).is_ok()
    {
        return Ok(existing.request);
    }
    let certificate = Certificate::from_credential(
        &device
            .credential(now)
            .map_err(|_| Error::Changed)?
            .credential,
    )?;
    let seed = Zeroizing::new(random::<32>()?);
    let pair = crypto
        .derive_hpke_keypair(CONFIG, seed.as_slice())
        .map_err(|_| Error::Unavailable)?;
    let recipient: [u8; 32] = pair
        .public
        .as_slice()
        .try_into()
        .map_err(|_| Error::Changed)?;
    let body = RequestBody {
        version: 1,
        certificate,
        request_id: random()?,
        recipient,
        issued_at: now,
        expires_at: now.checked_add(lifetime).ok_or(Error::Limit)?,
    };
    let mut request = Request {
        body,
        signature: Vec::new(),
    };
    request.signature = device
        .sign(&request.body_bytes()?)
        .map_err(|_| Error::Changed)?;
    request.verify(now)?;
    let value = Zeroizing::new(
        serde_json::to_vec(&Pending {
            request: request.clone(),
            seed,
        })
        .map_err(|_| Error::Changed)?,
    );
    records.insert(RECORD.into(), value.to_vec());
    Ok(request)
}

/// Forgets the pending request and its key, once every period is imported or
/// the request is abandoned. Already imported documents stay.
pub fn forget_request(records: &mut Records) {
    if let Some(mut bytes) = records.remove(RECORD) {
        bytes.zeroize();
    }
}

/// One accepted document to share, from the sharing device's verified observation.
pub struct Document {
    pub origin: Receipt,
    pub original_certificate: Certificate,
    pub membership: Member,
    pub message: SendMessage,
}
/// One period to share: its binding and its documents, any order.
pub struct PeriodInput {
    pub scope: Scope,
    pub grant: Member,
    pub admission: Fingerprint,
    pub documents: Vec<Document>,
}
/// Seals every period for this exact request. The caller has verified the
/// request's certificate against its own account directory and obtained the
/// human approval of this request fingerprint.
pub fn share(
    device: &LocalDevice,
    crypto: &impl OpenMlsCrypto,
    request: &Request,
    periods: Vec<PeriodInput>,
    now: u64,
) -> Result<(Share, Vec<Vec<Packet>>)> {
    request.verify(now)?;
    let fingerprint = request.fingerprint()?;
    let certificate = Certificate::from_credential(
        &device
            .credential(now)
            .map_err(|_| Error::Changed)?
            .credential,
    )?;
    if certificate.device.root != request.body.certificate.device.root
        || certificate.device.device == request.body.certificate.device.device
    {
        return Err(Error::Changed);
    }
    let total: usize = periods.iter().map(|p| p.documents.len()).sum();
    if total > MAX_DOCUMENTS {
        return Err(Error::Limit);
    }
    let mut manifest = Vec::with_capacity(periods.len());
    let mut secrets = Zeroizing::new(Vec::with_capacity(periods.len()));
    let mut packets = Vec::with_capacity(periods.len());
    for mut period in periods {
        if period.documents.is_empty() {
            continue;
        }
        period.documents.sort_by_key(|d| d.origin.position);
        if period
            .documents
            .windows(2)
            .any(|pair| pair[0].origin.position == pair[1].origin.position)
            || period
                .documents
                .iter()
                .any(|d| d.origin.header.scope != period.scope)
        {
            return Err(Error::Changed);
        }
        let secret = Zeroizing::new(random::<32>()?);
        let mut sealed = Vec::with_capacity(period.documents.len());
        for document in &period.documents {
            let (packet, _) = archive::seal_with(
                device,
                &document.original_certificate,
                &document.origin,
                &document.membership,
                &document.message,
                now,
                |key_id| archive::Key::derive(crypto, &secret, key_id),
            )?;
            sealed.push(packet);
        }
        let digests = sealed
            .iter()
            .map(Packet::digest)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        manifest.push(Period {
            scope: period.scope,
            grant: period.grant,
            admission: period.admission,
            first: period.documents[0].origin.position,
            last: period.documents[period.documents.len() - 1].origin.position,
            count: sealed.len() as u64,
            chain: chain(digests)?,
        });
        secrets.push(*secret);
        packets.push(sealed);
    }
    let manifest = Manifest {
        version: 1,
        request: fingerprint,
        periods: manifest,
    };
    let encoded: Zeroizing<Vec<String>> =
        Zeroizing::new(secrets.iter().map(|s| HEXLOWER.encode(s)).collect());
    let plaintext = Zeroizing::new(serde_json::to_vec(&*encoded).map_err(|_| Error::Changed)?);
    let sealed = crypto
        .hpke_seal(
            CONFIG,
            &request.body.recipient,
            &info(&fingerprint),
            &manifest.digest()?,
            &plaintext,
        )
        .map_err(|_| Error::Unavailable)?;
    let mut share = Share {
        manifest,
        envelope: Envelope {
            kem_output: sealed.kem_output.as_slice().to_vec(),
            ciphertext: sealed.ciphertext.as_slice().to_vec(),
        },
        certificate,
        signature: Vec::new(),
    };
    share.signature = device
        .sign(&share.signing_bytes()?)
        .map_err(|_| Error::Changed)?;
    share.verify(now)?;
    Ok((share, packets))
}

/// The secret of one shared period. No Debug/Clone/serde or raw export.
pub struct PeriodKey(Zeroizing<[u8; 32]>);

/// Opens a share answering this device's pending request. The caller has
/// verified the share's certificate against its own account directory.
pub fn open(
    crypto: &impl OpenMlsCrypto,
    records: &Records,
    share: &Share,
    now: u64,
) -> Result<Vec<PeriodKey>> {
    let pending = pending(records)?.ok_or(Error::NotRequested)?;
    let fingerprint = pending.request.fingerprint()?;
    share.verify(now)?;
    let own = &pending.request.body.certificate.device;
    if share.manifest.request != fingerprint
        || share.certificate.device.root != own.root
        || share.certificate.device.device == own.device
    {
        return Err(Error::NotRequested);
    }
    let pair = crypto
        .derive_hpke_keypair(CONFIG, pending.seed.as_slice())
        .map_err(|_| Error::Unavailable)?;
    let input = HpkeCiphertext {
        kem_output: share.envelope.kem_output.clone().into(),
        ciphertext: share.envelope.ciphertext.clone().into(),
    };
    let plaintext = Zeroizing::new(
        crypto
            .hpke_open(
                CONFIG,
                &input,
                &pair.private,
                &info(&fingerprint),
                &share.manifest.digest()?,
            )
            .map_err(|_| Error::Changed)?,
    );
    let encoded: Zeroizing<Vec<String>> =
        Zeroizing::new(serde_json::from_slice(&plaintext).map_err(|_| Error::Changed)?);
    if encoded.len() != share.manifest.periods.len() {
        return Err(Error::Changed);
    }
    encoded
        .iter()
        .map(|text| {
            let mut bytes = HEXLOWER
                .decode(text.as_bytes())
                .map_err(|_| Error::Changed)?;
            if bytes.len() != 32 {
                bytes.zeroize();
                return Err(Error::Changed);
            }
            let mut key = Zeroizing::new([0; 32]);
            key.copy_from_slice(&bytes);
            bytes.zeroize();
            Ok(PeriodKey(key))
        })
        .collect()
}

/// Verifies and opens one recovered packet of `period`. The packet must be
/// signed by the share's certificate, bind a receipt of the period's room
/// within its bounds, and decrypt with the period's derived key.
pub fn open_packet(
    crypto: &impl OpenMlsCrypto,
    share: &Share,
    period: &Period,
    key: &PeriodKey,
    packet: &Packet,
) -> Result<SendMessage> {
    packet.authenticate()?;
    let origin = &packet.header.origin;
    if packet.certificate != share.certificate
        || packet.original_certificate.device.root.instance
            != share.certificate.device.root.instance
        || origin.header.scope != period.scope
        || origin.position < period.first
        || origin.position > period.last
    {
        return Err(Error::Changed);
    }
    let document_key = archive::Key::derive(crypto, &key.0, &packet.header.key_id)?;
    Ok(archive::open(
        packet,
        &document_key,
        origin,
        &packet.header.author_membership,
    )?)
}

/// Checks one period's complete packet list, in position order, against its
/// manifest entry: count, bounds and chain digest.
pub fn check_period(period: &Period, packets: &[Packet]) -> Result<()> {
    if packets.len() as u64 != period.count
        || packets.first().map(|p| p.header.origin.position) != Some(period.first)
        || packets.last().map(|p| p.header.origin.position) != Some(period.last)
        || packets
            .windows(2)
            .any(|pair| pair[0].header.origin.position >= pair[1].header.origin.position)
    {
        return Err(Error::Changed);
    }
    let digests = packets
        .iter()
        .map(Packet::digest)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if chain(digests)? != period.chain {
        return Err(Error::Changed);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
