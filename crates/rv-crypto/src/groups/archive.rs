//! Locally observed plaintext and its original proof, anchored in the same
//! protected transaction as the MLS ratchet. No public archive admission here.
use super::*;
use rv_crypto_public::messages as packet;
use vault::blobs::{Access, Reference};
use zeroize::Zeroizing;
mod journal;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    scope: Scope,
    grant: Member,
    admission: Fingerprint,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Head {
    version: u8,
    binding: Binding,
    count: u64,
    position: u64,
    reference: Reference,
    ordered: bool,
    #[serde(default)]
    retired: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    version: u8,
    binding: Binding,
    index: u64,
    observed_at: u64,
    jumps: Vec<Reference>,
    receipt: packet::Receipt,
    submission: MessageSubmission,
    #[serde(with = "super::messages::secret_bytes")]
    plaintext: Zeroizing<Vec<u8>>,
    /// The author's membership in the group plan at reception; absent on
    /// nodes written before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    author: Option<Member>,
}
fn key(binding: &Binding) -> Result<String> {
    Ok(format!(
        "crypto-observed-archive-v1/{}",
        HEXLOWER.encode(&fingerprint(
            "rocketvibe-observed-archive-binding-v1",
            binding
        )?)
    ))
}
fn head(records: &Records, binding: &Binding) -> Result<Option<Head>> {
    let Some(bytes) = records.get(&key(binding)?) else {
        return Ok(None);
    };
    if bytes.len() > 4096 {
        return Err(Error::Limit);
    }
    let value: Head = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
    if value.version != 1
        || value.binding != *binding
        || value.count == 0
        || value.count > i64::MAX as u64
        || value.position == 0
        || value.position > i64::MAX as u64
    {
        return Err(Error::Changed);
    }
    Ok(Some(value))
}
fn node(blocks: &Access<'_>, reference: &Reference, binding: &Binding) -> Result<Node> {
    let bytes = blocks.read(reference)?;
    let value: Node = serde_json::from_slice(&bytes).map_err(|_| Error::Changed)?;
    let levels = (u64::BITS - (value.index.saturating_sub(1)).leading_zeros()) as usize;
    if value.version != 1
        || value.binding != *binding
        || value.index == 0
        || value.index > i64::MAX as u64
        || value.observed_at > 253_402_300_799
        || value.jumps.len() != levels
        || value.receipt.header.scope != binding.scope
    {
        return Err(Error::Changed);
    }
    // Navigation trusts the authenticated local observation, not server rows.
    // Signature/document checks are repeated only for entries being returned.
    value.receipt.validate()?;
    Ok(value)
}
fn authenticate_entry(value: &Node) -> Result<()> {
    let proof = value.submission.checked_at(value.observed_at, true)?;
    value.receipt.matches(&proof)?;
    messages::decode(&value.plaintext, &value.receipt.header)?;
    Ok(())
}
fn projected(value: &Node) -> Result<ProjectedMessage> {
    authenticate_entry(value)?;
    Ok(ProjectedMessage {
        message: ClearMessage {
            receipt: value.receipt.clone(),
            payload: Zeroizing::new(value.plaintext.to_vec()),
        },
        observed_at: value.observed_at,
    })
}
fn previous(blocks: &Access<'_>, current: &Node, level: usize) -> Result<Node> {
    let reference = current.jumps.get(level).ok_or(Error::Changed)?;
    let old = node(blocks, reference, &current.binding)?;
    if current
        .index
        .checked_sub(1_u64.checked_shl(level as u32).ok_or(Error::Changed)?)
        != Some(old.index)
    {
        return Err(Error::Changed);
    }
    Ok(old)
}
impl Coordinator {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn archive_observed(
        &self,
        records: &mut Records,
        blocks: &mut Access<'_>,
        state: &State,
        grant: &Member,
        submission: &MessageSubmission,
        receipt: &packet::Receipt,
        plaintext: &[u8],
        observed_at: u64,
        existing: Option<Reference>,
    ) -> Result<Reference> {
        let plan = &state
            .active
            .as_ref()
            .ok_or(Error::NotReady)?
            .transition
            .plan;
        let binding = Binding {
            scope: receipt.header.scope.clone(),
            grant: grant.clone(),
            admission: self.admission_witness(plan, grant)?,
        };
        if let Some(reference) = existing {
            let prior = node(blocks, &reference, &binding)?;
            authenticate_entry(&prior)?;
            if prior.receipt != *receipt
                || prior.submission != *submission
                || prior.plaintext.as_slice() != plaintext
            {
                return Err(Error::Conflict);
            }
            return Ok(reference);
        }
        let prior = head(records, &binding)?;
        if prior.as_ref().is_some_and(|h| h.retired) {
            return Err(Error::MessageRetired);
        }
        let count = prior.as_ref().map_or(1, |h| h.count.saturating_add(1));
        if count > i64::MAX as u64 {
            return Err(Error::JournalOrder);
        }
        let ordered = prior
            .as_ref()
            .is_none_or(|h| h.ordered && receipt.position > h.position);
        if !ordered && let Some(prior) = &prior {
            let mut old = node(blocks, &prior.reference, &binding)?;
            loop {
                if old.receipt.position == receipt.position {
                    return Err(Error::Conflict);
                }
                if old.jumps.is_empty() {
                    break;
                }
                old = previous(blocks, &old, 0)?;
            }
        }
        let mut jumps = Vec::new();
        if let Some(prior) = prior {
            let mut old = node(blocks, &prior.reference, &binding)?;
            if old.index != prior.count || old.receipt.position != prior.position {
                return Err(Error::Changed);
            }
            jumps.push(prior.reference);
            for level in 1..(u64::BITS - (count - 1).leading_zeros()) as usize {
                let next = *old.jumps.get(level - 1).ok_or(Error::Changed)?;
                old = previous(blocks, &old, level - 1)?;
                jumps.push(next);
            }
        }
        let item = Node {
            version: 1,
            binding: binding.clone(),
            index: count,
            observed_at,
            jumps,
            receipt: receipt.clone(),
            submission: submission.clone(),
            plaintext: Zeroizing::new(plaintext.to_vec()),
            author: plan
                .members
                .iter()
                .find(|m| m.user == receipt.header.author)
                .cloned(),
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&item).map_err(|_| Error::Changed)?);
        let reference = blocks.put(&bytes)?;
        let header = Head {
            version: 1,
            binding,
            count,
            position: receipt.position,
            reference,
            ordered,
            retired: false,
        };
        records.insert(
            key(&header.binding)?,
            serde_json::to_vec(&header).map_err(|_| Error::Changed)?,
        );
        Ok(reference)
    }
    /// Protected local history only. Network/native reader policy must still
    /// validate this observation and prevent output from a closed viewer.
    pub fn observed_archive(
        &self,
        observation: &JournalObservation,
        query: &ProjectionQuery,
        now: u64,
    ) -> Result<Vec<ProjectedMessage>> {
        if query.limit == 0
            || query.limit > 200
            || query.before.is_some_and(|p| p == 0 || p > i64::MAX as u64)
            || query
                .thread
                .as_ref()
                .is_some_and(|id| !packet::identifier(id))
        {
            return Err(Error::Limit);
        }
        let current = &observation.current;
        check_request(&current.roster, "archive-control", &[])?;
        self.scope(&current.head.scope)?;
        let remote = Transition::from_bytes(&observation.transition)?;
        Verification::Historical(now).transition(&remote)?;
        check_receipt(&remote, &current.head)?;
        let grant = current
            .roster
            .members
            .iter()
            .find(|m| m.user == self.manager.scope().user)
            .ok_or(Error::JournalOrder)?;
        let binding = Binding {
            scope: current.head.scope.clone(),
            grant: grant.clone(),
            admission: self.admission_witness(&remote.plan, grant)?,
        };
        self.inspect_with_blobs(|_, records, blocks| {
            self.context(records, now)?;
            let state = super::read(records, &binding.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            let active = state.active.as_ref().ok_or(Error::NotReady)?;
            if current.roster.scope != binding.scope
                || active.receipt != current.head
                || self.admission_witness(&active.transition.plan, grant)? != binding.admission
            {
                return Err(Error::JournalOrder);
            }
            let Some(header) = head(records, &binding)? else {
                return Ok(Vec::new());
            };
            if header.retired {
                return Ok(Vec::new());
            }
            let mut entry = node(blocks, &header.reference, &binding)?;
            if entry.index != header.count || entry.receipt.position != header.position {
                return Err(Error::Changed);
            }
            if !header.ordered {
                // Original own echoes may arrive out of order. Keep their
                // documents without making a monotonic-search assumption.
                let mut selected = Vec::new();
                loop {
                    let next = if entry.jumps.is_empty() {
                        None
                    } else {
                        Some(previous(blocks, &entry, 0)?)
                    };
                    if query.before.is_none_or(|p| entry.receipt.position < p)
                        && entry.receipt.header.thread == query.thread
                    {
                        selected.push(entry);
                        selected.sort_by_key(|n| std::cmp::Reverse(n.receipt.position));
                        if selected.len() > query.limit {
                            selected.pop();
                        }
                    }
                    match next {
                        Some(next) => entry = next,
                        None => break,
                    }
                }
                selected.reverse();
                return selected.iter().map(projected).collect();
            }
            if let Some(before) = query.before {
                while entry.receipt.position >= before {
                    let mut advanced = false;
                    for level in (0..entry.jumps.len()).rev() {
                        let candidate = previous(blocks, &entry, level)?;
                        if candidate.receipt.position >= before {
                            entry = candidate;
                            advanced = true;
                            break;
                        }
                    }
                    if !advanced {
                        if entry.jumps.is_empty() {
                            return Ok(Vec::new());
                        }
                        entry = previous(blocks, &entry, 0)?;
                    }
                }
            }
            let mut output = Vec::new();
            loop {
                if entry.receipt.header.thread == query.thread {
                    authenticate_entry(&entry)?;
                    output.push(ProjectedMessage {
                        message: ClearMessage {
                            receipt: entry.receipt.clone(),
                            payload: Zeroizing::new(entry.plaintext.to_vec()),
                        },
                        observed_at: entry.observed_at,
                    });
                    if output.len() == query.limit {
                        break;
                    }
                }
                if entry.jumps.is_empty() {
                    break;
                }
                entry = previous(blocks, &entry, 0)?;
            }
            output.reverse();
            Ok(output)
        })
    }
}
