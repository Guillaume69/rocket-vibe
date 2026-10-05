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
const DOCUMENT_DOMAIN: &str = "rocketvibe-history-document-v1";
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
/// Key, key ID and nonce of the `ordinal`-th document (from 1) of a shared
/// period: HKDF-SHA256 of the period secret. Re-sealing a page reproduces its
/// packets, and a packet served at another rank does not open.
fn material(
    crypto: &impl OpenMlsCrypto,
    secret: &[u8; 32],
    ordinal: u64,
) -> Result<(archive::Key, [u8; 16], [u8; 24])> {
    let hash = openmls_traits::types::HashType::Sha2_256;
    let prk = crypto
        .hkdf_extract(hash, &[], secret)
        .map_err(|_| Error::Unavailable)?;
    let mut info = DOCUMENT_DOMAIN.as_bytes().to_vec();
    info.push(0);
    info.extend_from_slice(&ordinal.to_be_bytes());
    let okm = crypto
        .hkdf_expand(hash, prk.as_slice(), &info, 72)
        .map_err(|_| Error::Unavailable)?;
    let okm = okm.as_slice();
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(&okm[..32]);
    let key_id: [u8; 16] = okm[32..48].try_into().map_err(|_| Error::Changed)?;
    let nonce: [u8; 24] = okm[48..72].try_into().map_err(|_| Error::Changed)?;
    Ok((archive::Key::from_bytes(key), key_id, nonce))
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
/// One period to share: its binding and its documents, any order. Test and
/// small-history convenience over [`ShareJob`].
pub struct PeriodInput {
    pub scope: Scope,
    pub grant: Member,
    pub admission: Fingerprint,
    pub documents: Vec<Document>,
}
/// Seals every period at once and returns the share with its packets.
pub fn share(
    device: &LocalDevice,
    crypto: &impl OpenMlsCrypto,
    request: &Request,
    periods: Vec<PeriodInput>,
    now: u64,
) -> Result<(Share, Vec<Vec<Packet>>)> {
    let mut periods = periods;
    for period in &mut periods {
        period.documents.sort_by_key(|d| d.origin.position);
    }
    let plans = periods
        .iter()
        .map(|p| PeriodPlan {
            scope: p.scope.clone(),
            grant: p.grant.clone(),
            admission: p.admission,
            total: p.documents.len() as u64,
        })
        .collect();
    let mut job = ShareJob::new(device, request, plans, now)?;
    let mut packets = Vec::new();
    for period in periods.into_iter().filter(|p| !p.documents.is_empty()) {
        let (index, _) = job.next().ok_or(Error::Changed)?;
        let page = job.seal_page(crypto, device, index, &period.documents, now)?;
        packets.push(page.packets.clone());
        job.advance(&page)?;
    }
    Ok((job.finish(crypto, device, now)?, packets))
}

/// A period the sharing device will share: its binding and how many documents
/// its verified journal index held when the share began.
pub struct PeriodPlan {
    pub scope: Scope,
    pub grant: Member,
    pub admission: Fingerprint,
    pub total: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JobPeriod {
    scope: Scope,
    grant: Member,
    admission: Fingerprint,
    total: u64,
    #[serde(with = "seed")]
    secret: Zeroizing<[u8; 32]>,
    sealed: u64,
    first: u64,
    last: u64,
    chain: Fingerprint,
}
/// One sealed page of a period, identical when sealed again from the same job.
pub struct Page {
    pub period: usize,
    /// Documents of the period sealed before this page.
    pub start: u64,
    pub packets: Vec<Packet>,
    first: u64,
    last: u64,
    chain: Fingerprint,
}
/// Persistable progress of one share, kept in the sharing device's vault: the
/// request, the pinned sharing certificate, and per period its binding, secret
/// and sealed progress. Packets are derived, so a lost page is sealed again
/// byte for byte; only the final share (its HPKE envelope) is kept once drawn.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareJob {
    request: Request,
    certificate: Certificate,
    periods: Vec<JobPeriod>,
    share: Option<Share>,
}
impl ShareJob {
    /// Begins a share of `plans` for this request. The caller has verified the
    /// request's certificate against its own account directory and obtained
    /// the human approval of this request fingerprint. Empty periods are skipped.
    pub fn new(
        device: &LocalDevice,
        request: &Request,
        plans: Vec<PeriodPlan>,
        now: u64,
    ) -> Result<Self> {
        request.verify(now)?;
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
        let plans = plans
            .into_iter()
            .filter(|p| p.total > 0)
            .collect::<Vec<_>>();
        if plans.len() > rv_crypto_public::history::MAX_PERIODS
            || plans.iter().map(|p| p.total).sum::<u64>() > MAX_DOCUMENTS as u64
        {
            return Err(Error::Limit);
        }
        let periods = plans
            .into_iter()
            .map(|plan| {
                Ok(JobPeriod {
                    scope: plan.scope,
                    grant: plan.grant,
                    admission: plan.admission,
                    total: plan.total,
                    secret: Zeroizing::new(random()?),
                    sealed: 0,
                    first: 0,
                    last: 0,
                    chain: rv_crypto_public::history::chain_start()?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            request: request.clone(),
            certificate,
            periods,
            share: None,
        })
    }
    pub fn request(&self) -> &Request {
        &self.request
    }
    /// The next period to seal and how many of its documents are sealed.
    pub fn next(&self) -> Option<(usize, u64)> {
        self.periods
            .iter()
            .position(|p| p.sealed < p.total)
            .map(|index| (index, self.periods[index].sealed))
    }
    pub fn binding(&self, period: usize) -> Option<(&Scope, &Member, &Fingerprint, u64)> {
        self.periods
            .get(period)
            .map(|p| (&p.scope, &p.grant, &p.admission, p.total))
    }
    /// Seals the next documents of `period`, in position order, without
    /// changing the job. The same documents give the same packets.
    pub fn seal_page(
        &self,
        crypto: &impl OpenMlsCrypto,
        device: &LocalDevice,
        period: usize,
        documents: &[Document],
        now: u64,
    ) -> Result<Page> {
        let state = self.periods.get(period).ok_or(Error::Changed)?;
        let current = Certificate::from_credential(
            &device
                .credential(now)
                .map_err(|_| Error::Changed)?
                .credential,
        )?;
        if current != self.certificate
            || documents.is_empty()
            || state.sealed + documents.len() as u64 > state.total
        {
            return Err(Error::Changed);
        }
        let (mut first, mut last, mut chain) = (state.first, state.last, state.chain);
        let mut packets = Vec::with_capacity(documents.len());
        for (offset, document) in documents.iter().enumerate() {
            let position = document.origin.position;
            let empty = state.sealed == 0 && offset == 0;
            if document.origin.header.scope != state.scope || !empty && position <= last {
                return Err(Error::Changed);
            }
            let ordinal = state.sealed + offset as u64 + 1;
            let (key, key_id, nonce) = material(crypto, &state.secret, ordinal)?;
            let (packet, _) = archive::seal_with(
                device,
                &document.original_certificate,
                &document.origin,
                &document.membership,
                &document.message,
                now,
                key_id,
                nonce,
                key,
            )?;
            if empty {
                first = position;
            }
            last = position;
            chain = rv_crypto_public::history::chain_next(chain, packet.digest()?)?;
            packets.push(packet);
        }
        Ok(Page {
            period,
            start: state.sealed,
            packets,
            first,
            last,
            chain,
        })
    }
    /// Records a page once the server holds it.
    pub fn advance(&mut self, page: &Page) -> Result<()> {
        if self.share.is_some() {
            return Err(Error::Changed);
        }
        let state = self.periods.get_mut(page.period).ok_or(Error::Changed)?;
        if state.sealed != page.start {
            return Err(Error::Changed);
        }
        state.sealed += page.packets.len() as u64;
        state.first = page.first;
        state.last = page.last;
        state.chain = page.chain;
        Ok(())
    }
    /// The signed share once every period is sealed; drawn once, then kept.
    pub fn finish(
        &mut self,
        crypto: &impl OpenMlsCrypto,
        device: &LocalDevice,
        now: u64,
    ) -> Result<Share> {
        if let Some(share) = &self.share {
            return Ok(share.clone());
        }
        if self.next().is_some() || self.periods.is_empty() {
            return Err(Error::Changed);
        }
        let fingerprint = self.request.fingerprint()?;
        let manifest = Manifest {
            version: 1,
            request: fingerprint,
            periods: self
                .periods
                .iter()
                .map(|p| Period {
                    scope: p.scope.clone(),
                    grant: p.grant.clone(),
                    admission: p.admission,
                    first: p.first,
                    last: p.last,
                    count: p.sealed,
                    chain: p.chain,
                })
                .collect(),
        };
        let encoded: Zeroizing<Vec<String>> = Zeroizing::new(
            self.periods
                .iter()
                .map(|p| HEXLOWER.encode(p.secret.as_slice()))
                .collect(),
        );
        let plaintext = Zeroizing::new(serde_json::to_vec(&*encoded).map_err(|_| Error::Changed)?);
        let sealed = crypto
            .hpke_seal(
                CONFIG,
                &self.request.body.recipient,
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
            certificate: self.certificate.clone(),
            signature: Vec::new(),
        };
        share.signature = device
            .sign(&share.signing_bytes()?)
            .map_err(|_| Error::Changed)?;
        share.verify(now)?;
        self.share = Some(share.clone());
        Ok(share)
    }
    pub fn to_bytes(&self) -> Result<Zeroizing<Vec<u8>>> {
        Ok(Zeroizing::new(
            serde_json::to_vec(self).map_err(|_| Error::Changed)?,
        ))
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 4 * rv_crypto_public::history::SHARE_LIMIT {
            return Err(Error::Limit);
        }
        serde_json::from_slice(bytes).map_err(|_| Error::Changed)
    }
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

#[derive(Serialize, Deserialize)]
#[serde(transparent)]
struct Secret(#[serde(with = "seed")] Zeroizing<[u8; 32]>);
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportPeriod {
    imported: u64,
    last: u64,
    chain: Fingerprint,
}
/// Persistable progress of one import, kept in the new device's vault: the
/// opened share, its period secrets and, per period, the verified prefix.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportJob {
    share: Share,
    secrets: Vec<Secret>,
    periods: Vec<ImportPeriod>,
}
impl ImportJob {
    /// Opens a share answering this device's pending request. The caller has
    /// verified the share's certificate against its own account directory.
    pub fn open(
        crypto: &impl OpenMlsCrypto,
        records: &Records,
        share: &Share,
        now: u64,
    ) -> Result<Self> {
        let keys = open(crypto, records, share, now)?;
        Ok(Self {
            share: share.clone(),
            secrets: keys.into_iter().map(|key| Secret(key.0)).collect(),
            periods: share
                .manifest
                .periods
                .iter()
                .map(|_| {
                    Ok(ImportPeriod {
                        imported: 0,
                        last: 0,
                        chain: rv_crypto_public::history::chain_start()?,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        })
    }
    pub fn share(&self) -> &Share {
        &self.share
    }
    /// The next period to download and how many of its packets are imported.
    pub fn next(&self) -> Option<(usize, u64)> {
        self.share
            .manifest
            .periods
            .iter()
            .zip(&self.periods)
            .position(|(period, progress)| progress.imported < period.count)
            .map(|index| (index, self.periods[index].imported))
    }
    pub fn complete(&self, period: usize) -> bool {
        match (
            self.share.manifest.periods.get(period),
            self.periods.get(period),
        ) {
            (Some(period), Some(progress)) => progress.imported == period.count,
            _ => false,
        }
    }
    /// Verifies the next packets of `period`, in position order, and returns
    /// their documents. Nothing changes on a refusal. The period's chain must
    /// match its manifest entry once its last packet is accepted.
    pub fn accept(
        &mut self,
        crypto: &impl OpenMlsCrypto,
        period: usize,
        packets: &[Packet],
    ) -> Result<Vec<SendMessage>> {
        let entry = self
            .share
            .manifest
            .periods
            .get(period)
            .ok_or(Error::Changed)?;
        let progress = self.periods.get(period).ok_or(Error::Changed)?;
        let secret = self.secrets.get(period).ok_or(Error::Changed)?;
        if packets.is_empty() || progress.imported + packets.len() as u64 > entry.count {
            return Err(Error::Changed);
        }
        let key = PeriodKey(Zeroizing::new(*secret.0));
        let (mut imported, mut last, mut chain) =
            (progress.imported, progress.last, progress.chain);
        let mut messages = Vec::with_capacity(packets.len());
        for packet in packets {
            let position = packet.header.origin.position;
            if imported == 0 && position != entry.first || imported > 0 && position <= last {
                return Err(Error::Changed);
            }
            messages.push(open_packet(
                crypto,
                &self.share,
                entry,
                &key,
                imported + 1,
                packet,
            )?);
            chain = rv_crypto_public::history::chain_next(chain, packet.digest()?)?;
            imported += 1;
            last = position;
        }
        if imported == entry.count && (chain != entry.chain || last != entry.last) {
            return Err(Error::Changed);
        }
        self.periods[period] = ImportPeriod {
            imported,
            last,
            chain,
        };
        Ok(messages)
    }
    pub fn to_bytes(&self) -> Result<Zeroizing<Vec<u8>>> {
        Ok(Zeroizing::new(
            serde_json::to_vec(self).map_err(|_| Error::Changed)?,
        ))
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 4 * rv_crypto_public::history::SHARE_LIMIT {
            return Err(Error::Limit);
        }
        let job: Self = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
        if job.secrets.len() != job.share.manifest.periods.len()
            || job.periods.len() != job.share.manifest.periods.len()
        {
            return Err(Error::Changed);
        }
        Ok(job)
    }
}

/// Verifies and opens one recovered packet of `period`. The packet must be
/// signed by the share's certificate, bind a receipt of the period's room
/// within its bounds, and decrypt with the period's derived key.
pub fn open_packet(
    crypto: &impl OpenMlsCrypto,
    share: &Share,
    period: &Period,
    key: &PeriodKey,
    ordinal: u64,
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
    if ordinal == 0 || ordinal > period.count {
        return Err(Error::Changed);
    }
    let (document_key, key_id, nonce) = material(crypto, &key.0, ordinal)?;
    if packet.header.key_id != key_id || packet.header.nonce != nonce {
        return Err(Error::Changed);
    }
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
