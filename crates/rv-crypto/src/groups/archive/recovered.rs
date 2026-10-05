//! History recovered from another device of the account (path A) or from the
//! history backup (path B). Kept apart from this device's own journal indexes:
//! each period has its own chain and shows only up to the last count whose
//! chain digest was matched; a backed-up period may grow past it later.
use super::super::amendments::Amendments;
use super::*;
use crate::history::Record;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    scope: Scope,
    grant: Member,
    admission: Fingerprint,
    /// Origin: the sharing certificate (path A) or the backed-up period id (path B).
    sharer: Fingerprint,
}
/// The verified, visible prefix of a period.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Shown {
    count: u64,
    reference: Reference,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveredHead {
    version: u8,
    source: Source,
    total: u64,
    count: u64,
    position: u64,
    reference: Reference,
    shown: Option<Shown>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveredNode {
    version: u8,
    source: Source,
    index: u64,
    jumps: Vec<Reference>,
    #[serde(with = "super::super::bytes")]
    packet: Vec<u8>,
    #[serde(with = "super::super::messages::secret_bytes")]
    plaintext: Zeroizing<Vec<u8>>,
}
/// A document of a complete recovered period.
pub struct RecoveredMessage {
    pub message: ClearMessage,
    /// When the sharing device observed it, as it attested.
    pub observed_at: u64,
    /// Fingerprint of the sharing device's certificate.
    pub sharer: Fingerprint,
    /// Admission witness of the sharing device for this period.
    pub admission: Fingerprint,
    /// The author's latest edit (E2EE_AMENDMENTS.md).
    pub edit: Option<super::super::amendments::Edit>,
    pub reactions: Vec<super::super::amendments::Reaction>,
}
const PREFIX: &str = "crypto-recovered-archive-v1/";
fn key(source: &Source) -> Result<String> {
    Ok(format!(
        "{PREFIX}{}",
        HEXLOWER.encode(&fingerprint(
            "rocketvibe-recovered-archive-source-v1",
            source
        )?)
    ))
}
fn read_head(bytes: &[u8]) -> Result<RecoveredHead> {
    if bytes.len() > 4096 {
        return Err(Error::Limit);
    }
    let head: RecoveredHead = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
    if head.version != 1
        || head.count == 0
        || head.count > head.total
        || head
            .shown
            .is_some_and(|s| s.count == 0 || s.count > head.count)
        || head.count == head.total && head.shown.is_none_or(|s| s.count != head.count)
        || head.position == 0
        || head.position > i64::MAX as u64
    {
        return Err(Error::Changed);
    }
    Ok(head)
}
fn recovered_node(
    blocks: &Access<'_>,
    reference: &Reference,
    source: &Source,
) -> Result<RecoveredNode> {
    let bytes = blocks.read(reference)?;
    let value: RecoveredNode = serde_json::from_slice(&bytes).map_err(|_| Error::Changed)?;
    let levels = (u64::BITS - value.index.saturating_sub(1).leading_zeros()) as usize;
    if value.version != 1
        || value.source != *source
        || value.index == 0
        || value.jumps.len() != levels
    {
        return Err(Error::Changed);
    }
    Ok(value)
}
fn previous_node(
    blocks: &Access<'_>,
    value: &RecoveredNode,
    level: usize,
) -> Result<RecoveredNode> {
    let old = recovered_node(
        blocks,
        value.jumps.get(level).ok_or(Error::Changed)?,
        &value.source,
    )?;
    if value
        .index
        .checked_sub(1_u64.checked_shl(level as u32).ok_or(Error::Changed)?)
        != Some(old.index)
    {
        return Err(Error::Changed);
    }
    Ok(old)
}
/// Re-authenticates the stored packet and its document before any output.
fn opened(value: &RecoveredNode) -> Result<(Record, ClearMessage)> {
    let packet = Record::from_bytes(&value.packet).map_err(|_| Error::Changed)?;
    packet.authenticate().map_err(|_| Error::Changed)?;
    let origin = &packet.header.origin;
    if origin.header.scope != value.source.scope {
        return Err(Error::Changed);
    }
    messages::decode(&value.plaintext, &origin.header)?;
    Ok((
        packet.clone(),
        ClearMessage {
            receipt: packet.header.origin,
            payload: Zeroizing::new(value.plaintext.to_vec()),
        },
    ))
}
impl Coordinator {
    /// Appends verified documents of one shared period, in rank order. The
    /// period shows once `total` documents are stored.
    #[allow(clippy::too_many_arguments)]
    pub(in super::super) fn append_recovered(
        &self,
        records: &mut Records,
        blocks: &mut Access<'_>,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
        sharer: Fingerprint,
        total: u64,
        documents: &[(Record, &[u8])],
    ) -> Result<()> {
        let source = Source {
            scope: scope.clone(),
            grant: grant.clone(),
            admission,
            sharer,
        };
        let name = key(&source)?;
        let mut prior = match records.get(&name) {
            Some(bytes) => Some(read_head(bytes)?),
            None => None,
        };
        // A period continues towards its total, which may only grow (a backed-up
        // period gets later checkpoints); the visible prefix never shrinks.
        if prior
            .as_ref()
            .is_some_and(|h| h.source != source || total < h.total)
        {
            return Err(Error::Changed);
        }
        for (packet, plaintext) in documents {
            let position = packet.header.origin.position;
            let count = prior.as_ref().map_or(1, |h| h.count + 1);
            if count > total || prior.as_ref().is_some_and(|h| position <= h.position) {
                return Err(Error::JournalOrder);
            }
            let mut jumps = Vec::new();
            if let Some(prior) = &prior {
                let mut old = recovered_node(blocks, &prior.reference, &source)?;
                jumps.push(prior.reference);
                for level in 1..(u64::BITS - (count - 1).leading_zeros()) as usize {
                    let next = *old.jumps.get(level - 1).ok_or(Error::Changed)?;
                    old = previous_node(blocks, &old, level - 1)?;
                    jumps.push(next);
                }
            }
            let item = RecoveredNode {
                version: 1,
                source: source.clone(),
                index: count,
                jumps,
                packet: packet.to_bytes().map_err(|_| Error::Changed)?,
                plaintext: Zeroizing::new(plaintext.to_vec()),
            };
            opened(&item)?;
            let bytes = Zeroizing::new(serde_json::to_vec(&item).map_err(|_| Error::Changed)?);
            let reference = blocks.put(&bytes)?;
            let shown = if count == total {
                Some(Shown { count, reference })
            } else {
                prior.as_ref().and_then(|h| h.shown)
            };
            prior = Some(RecoveredHead {
                version: 1,
                source: source.clone(),
                total,
                count,
                position,
                reference,
                shown,
            });
        }
        let head = prior.ok_or(Error::Changed)?;
        records.insert(name, serde_json::to_vec(&head).map_err(|_| Error::Changed)?);
        Ok(())
    }
    /// Recovered history of `room`, newest first up to `query.limit`, then in
    /// position order: complete periods only, with the projection's thread filter.
    pub fn recovered_history(
        &self,
        room: &str,
        query: &ProjectionQuery,
    ) -> Result<Vec<RecoveredMessage>> {
        if query.limit == 0
            || query.limit > 200
            || query.before.is_some_and(|p| p == 0 || p > i64::MAX as u64)
        {
            return Err(Error::Limit);
        }
        self.inspect_with_blobs(|_, records, blocks| {
            let amendments = recovered_amendments(records, blocks, room, |_| true)?;
            Ok(recovered(records, blocks, room, query, |_| true, &amendments)?.0)
        })
    }
    /// The recovered document with this message id in `room`, for a thread
    /// root older than this device's own history.
    pub(in super::super) fn recovered_root(
        &self,
        records: &Records,
        blocks: &Access<'_>,
        scope: &Scope,
        id: &str,
        own: &Amendments,
    ) -> Result<Option<RecoveredMessage>> {
        let mut amendments = recovered_amendments(records, blocks, &scope.room, |source| {
            same_dataset(source, scope)
        })?;
        amendments.absorb(own);
        for (name, bytes) in records.range(PREFIX.to_string()..) {
            if !name.starts_with(PREFIX) {
                break;
            }
            let head = read_head(bytes)?;
            let Some(shown) = head.shown.filter(|_| same_dataset(&head.source, scope)) else {
                continue;
            };
            let mut entry = recovered_node(blocks, &shown.reference, &head.source)?;
            loop {
                let (packet, message) = opened(&entry)?;
                let origin = &packet.header.origin;
                if origin.message == id && origin.header.target.is_none() {
                    if amendments.deleted(origin) {
                        return Ok(None);
                    }
                    return Ok(Some(RecoveredMessage {
                        edit: amendments.edit(origin),
                        reactions: amendments.reactions(origin),
                        message,
                        observed_at: packet.observed_at,
                        sharer: head.source.sharer,
                        admission: head.source.admission,
                    }));
                }
                if entry.jumps.is_empty() {
                    break;
                }
                entry = previous_node(blocks, &entry, 0)?;
            }
        }
        Ok(None)
    }
    /// The newest `limit` recovered documents of this room whose shown text
    /// contains `needle`, newest first, leaving out `seen` ids, and whether
    /// more match.
    #[allow(clippy::too_many_arguments)]
    pub(in super::super) fn recovered_search(
        &self,
        records: &Records,
        blocks: &Access<'_>,
        scope: &Scope,
        needle: &str,
        limit: usize,
        own: &Amendments,
        seen: &std::collections::BTreeSet<String>,
    ) -> Result<(Vec<RecoveredMessage>, bool)> {
        let accept = |source: &Source| same_dataset(source, scope);
        let mut amendments = recovered_amendments(records, blocks, &scope.room, accept)?;
        amendments.absorb(own);
        let mut selected: std::collections::BTreeMap<u64, RecoveredMessage> =
            std::collections::BTreeMap::new();
        let mut more = false;
        for (name, bytes) in records.range(PREFIX.to_string()..) {
            if !name.starts_with(PREFIX) {
                break;
            }
            let head = read_head(bytes)?;
            let Some(shown) = head.shown.filter(|_| accept(&head.source)) else {
                continue;
            };
            let mut entry = recovered_node(blocks, &shown.reference, &head.source)?;
            loop {
                let (packet, message) = opened(&entry)?;
                let origin = &packet.header.origin;
                let edit = amendments.edit(origin);
                if origin.header.target.is_none()
                    && !amendments.deleted(origin)
                    && !seen.contains(&origin.message)
                    && !selected.contains_key(&origin.position)
                    && super::super::journal::matches(&message, edit.as_ref(), needle)?
                {
                    selected.insert(
                        origin.position,
                        RecoveredMessage {
                            edit,
                            reactions: amendments.reactions(origin),
                            message,
                            observed_at: packet.observed_at,
                            sharer: head.source.sharer,
                            admission: head.source.admission,
                        },
                    );
                    if selected.len() > limit {
                        selected.pop_first();
                        more = true;
                    }
                }
                if entry.jumps.is_empty() {
                    break;
                }
                entry = previous_node(blocks, &entry, 0)?;
            }
        }
        Ok((selected.into_values().rev().collect(), more))
    }
    /// The recovered documents older than `query.before` in this room, and
    /// whether still older ones exist.
    pub(in super::super) fn recovered_page(
        &self,
        records: &Records,
        blocks: &Access<'_>,
        scope: &Scope,
        query: &ProjectionQuery,
        own: &Amendments,
    ) -> Result<(Vec<RecoveredMessage>, bool)> {
        let accept = |source: &Source| same_dataset(source, scope);
        let mut amendments = recovered_amendments(records, blocks, &scope.room, accept)?;
        amendments.absorb(own);
        recovered(records, blocks, &scope.room, query, accept, &amendments)
    }
}

fn same_dataset(source: &Source, scope: &Scope) -> bool {
    source.scope.instance == scope.instance
        && source.scope.data_epoch == scope.data_epoch
        && source.scope.room == scope.room
}
/// The amendments in the shown periods of `room`, newest first per period.
fn recovered_amendments(
    records: &Records,
    blocks: &Access<'_>,
    room: &str,
    accept: impl Fn(&Source) -> bool,
) -> Result<Amendments> {
    let mut amendments = Amendments::default();
    for (name, bytes) in records.range(PREFIX.to_string()..) {
        if !name.starts_with(PREFIX) {
            break;
        }
        let head = read_head(bytes)?;
        let Some(shown) = head
            .shown
            .filter(|_| head.source.scope.room == room && accept(&head.source))
        else {
            continue;
        };
        let mut entry = recovered_node(blocks, &shown.reference, &head.source)?;
        loop {
            let (packet, message) = opened(&entry)?;
            let observed_at = packet.observed_at;
            amendments.observe(&packet.header.origin, || Ok((message, observed_at)))?;
            if entry.jumps.is_empty() {
                break;
            }
            entry = previous_node(blocks, &entry, 0)?;
        }
    }
    Ok(amendments)
}
/// Newest `query.limit` matching documents of the complete periods of `room`,
/// returned in position order, and whether older ones exist. Amendments are
/// never rows; deleted documents are left out and edits applied.
fn recovered(
    records: &Records,
    blocks: &Access<'_>,
    room: &str,
    query: &ProjectionQuery,
    accept: impl Fn(&Source) -> bool,
    amendments: &Amendments,
) -> Result<(Vec<RecoveredMessage>, bool)> {
    let wanted = query.limit.saturating_add(1);
    // Several sources may hold the same position: it shows once.
    let mut selected: std::collections::BTreeMap<u64, RecoveredMessage> =
        std::collections::BTreeMap::new();
    for (name, bytes) in records.range(PREFIX.to_string()..) {
        if !name.starts_with(PREFIX) {
            break;
        }
        let head = read_head(bytes)?;
        let Some(shown) = head
            .shown
            .filter(|_| head.source.scope.room == room && accept(&head.source))
        else {
            continue;
        };
        let mut entry = recovered_node(blocks, &shown.reference, &head.source)?;
        if entry.index != shown.count {
            return Err(Error::Changed);
        }
        loop {
            let (packet, message) = opened(&entry)?;
            let origin = &packet.header.origin;
            let position = origin.position;
            if query.before.is_none_or(|p| position < p)
                && origin.header.thread == query.thread
                && origin.header.target.is_none()
                && !amendments.deleted(origin)
            {
                selected.entry(position).or_insert(RecoveredMessage {
                    edit: amendments.edit(origin),
                    reactions: amendments.reactions(origin),
                    message,
                    observed_at: packet.observed_at,
                    sharer: head.source.sharer,
                    admission: head.source.admission,
                });
                while selected.len() > wanted {
                    selected.pop_first();
                }
                if selected.len() == wanted
                    && selected
                        .first_key_value()
                        .is_some_and(|(p, _)| *p > position)
                {
                    break;
                }
            }
            if entry.jumps.is_empty() {
                break;
            }
            entry = previous_node(blocks, &entry, 0)?;
        }
    }
    let more = selected.len() > query.limit;
    if more {
        selected.pop_first();
    }
    Ok((selected.into_values().collect(), more))
}
