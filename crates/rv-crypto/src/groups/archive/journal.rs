//! A separate protected index admits only documents from verified journal pages.
//! Observing an own echo alone cannot publish it in the journal projection.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u8,
    binding: Binding,
    index: u64,
    receipt: packet::Receipt,
    document: Reference,
    jumps: Vec<Reference>,
}
fn key(binding: &Binding) -> Result<String> {
    Ok(format!(
        "crypto-journal-archive-v1/{}",
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
    let head: Head = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
    if head.version != 1
        || head.binding != *binding
        || !head.ordered
        || head.count == 0
        || head.count > i64::MAX as u64
        || head.position == 0
        || head.position > i64::MAX as u64
    {
        return Err(Error::Changed);
    }
    Ok(Some(head))
}
fn index(blocks: &Access<'_>, reference: &Reference, binding: &Binding) -> Result<Index> {
    let bytes = blocks.read(reference)?;
    let value: Index = serde_json::from_slice(&bytes).map_err(|_| Error::Changed)?;
    let levels = (u64::BITS - value.index.saturating_sub(1).leading_zeros()) as usize;
    if value.version != 1
        || value.binding != *binding
        || value.index == 0
        || value.index > i64::MAX as u64
        || value.jumps.len() != levels
        || value.receipt.header.scope != binding.scope
    {
        return Err(Error::Changed);
    }
    value.receipt.validate()?;
    Ok(value)
}
fn start(blocks: &Access<'_>, header: &Head) -> Result<Index> {
    let entry = index(blocks, &header.reference, &header.binding)?;
    if entry.index != header.count || entry.receipt.position != header.position {
        return Err(Error::Changed);
    }
    Ok(entry)
}
fn previous(blocks: &Access<'_>, value: &Index, level: usize) -> Result<Index> {
    let old = index(
        blocks,
        value.jumps.get(level).ok_or(Error::Changed)?,
        &value.binding,
    )?;
    if value
        .index
        .checked_sub(1_u64.checked_shl(level as u32).ok_or(Error::Changed)?)
        != Some(old.index)
        || old.receipt.position >= value.receipt.position
    {
        return Err(Error::Changed);
    }
    Ok(old)
}
fn document(blocks: &Access<'_>, entry: &Index) -> Result<ProjectedMessage> {
    let value = super::node(blocks, &entry.document, &entry.binding)?;
    if value.receipt != entry.receipt {
        return Err(Error::Changed);
    }
    super::projected(&value)
}
fn binding(scope: &Scope, grant: &Member, admission: Fingerprint) -> Binding {
    Binding {
        scope: scope.clone(),
        grant: grant.clone(),
        admission,
    }
}
impl Coordinator {
    pub(in super::super) fn has_journal_archive(
        &self,
        records: &Records,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
    ) -> Result<bool> {
        Ok(head(records, &binding(scope, grant, admission))?.is_some())
    }
    /// Position of the newest indexed document; none once retired.
    pub(in super::super) fn journal_archive_position(
        &self,
        records: &Records,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
    ) -> Result<Option<u64>> {
        Ok(head(records, &binding(scope, grant, admission))?
            .filter(|h| !h.retired)
            .map(|h| h.position))
    }
    #[allow(clippy::too_many_arguments)]
    pub(in super::super) fn index_archive_message(
        &self,
        records: &mut Records,
        blocks: &mut Access<'_>,
        reference: Reference,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
    ) -> Result<()> {
        let binding = binding(scope, grant, admission);
        let doc = super::node(blocks, &reference, &binding)?;
        let prior = head(records, &binding)?;
        if prior.as_ref().is_some_and(|h| h.retired) {
            return Err(Error::MessageRetired);
        }
        if prior
            .as_ref()
            .is_some_and(|h| h.position >= doc.receipt.position)
        {
            return Err(Error::JournalOrder);
        }
        let count = prior.as_ref().map_or(1, |h| h.count.saturating_add(1));
        if count > i64::MAX as u64 {
            return Err(Error::Limit);
        }
        let mut jumps = Vec::new();
        if let Some(prior) = prior {
            let mut old = start(blocks, &prior)?;
            jumps.push(prior.reference);
            for level in 1..(u64::BITS - (count - 1).leading_zeros()) as usize {
                let next = *old.jumps.get(level - 1).ok_or(Error::Changed)?;
                old = previous(blocks, &old, level - 1)?;
                jumps.push(next);
            }
        }
        let position = doc.receipt.position;
        let item = Index {
            version: 1,
            binding: binding.clone(),
            index: count,
            receipt: doc.receipt,
            document: reference,
            jumps,
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&item).map_err(|_| Error::Changed)?);
        let reference = blocks.put(&bytes)?;
        let header = Head {
            version: 1,
            binding,
            count,
            position,
            reference,
            ordered: true,
            retired: false,
        };
        records.insert(
            key(&header.binding)?,
            serde_json::to_vec(&header).map_err(|_| Error::Changed)?,
        );
        Ok(())
    }
    pub(in super::super) fn retire_observed_archive(
        &self,
        records: &mut Records,
        room: &str,
    ) -> Result<()> {
        let mut changed = Vec::new();
        for (name, bytes) in records.iter().filter(|(name, _)| {
            name.starts_with("crypto-observed-archive-v1/")
                || name.starts_with("crypto-journal-archive-v1/")
        }) {
            let mut head: Head = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
            if head.binding.scope.room == room {
                head.retired = true;
                changed.push((
                    name.clone(),
                    serde_json::to_vec(&head).map_err(|_| Error::Changed)?,
                ));
            }
        }
        records.extend(changed);
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub(in super::super) fn archive_journal_projection(
        &self,
        records: &Records,
        blocks: &Access<'_>,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
        through: u64,
        query: &ProjectionQuery,
    ) -> Result<Option<super::super::journal::RetainedProjection>> {
        let Some(header) = head(records, &binding(scope, grant, admission))? else {
            return Ok(None);
        };
        let mut projection = super::super::journal::RetainedProjection {
            messages: Vec::new(),
            has_older: false,
            root: None,
            replies: BTreeMap::new(),
        };
        if header.retired {
            return Ok(Some(projection));
        }
        let mut entry = start(blocks, &header)?;
        loop {
            if entry.receipt.position <= through {
                if let Some(thread) = &entry.receipt.header.thread {
                    let count = projection.replies.entry(thread.clone()).or_insert(0u32);
                    *count = count.checked_add(1).ok_or(Error::Limit)?;
                } else if query.thread.as_ref() == Some(&entry.receipt.message) {
                    if projection.root.is_some() {
                        return Err(Error::JournalOrder);
                    }
                    projection.root = Some(document(blocks, &entry)?);
                }
                if query.before.is_none_or(|p| entry.receipt.position < p)
                    && entry.receipt.header.thread == query.thread
                {
                    if projection.messages.len() < query.limit {
                        projection.messages.push(document(blocks, &entry)?);
                    } else {
                        projection.has_older = true
                    }
                }
            }
            if entry.jumps.is_empty() {
                break;
            }
            entry = previous(blocks, &entry, 0)?;
        }
        projection.messages.reverse();
        Ok(Some(projection))
    }
    /// Every indexed document up to `through`, oldest first: quote sources
    /// outlive the hot cache. Each one revalidates its original proof.
    pub(in super::super) fn archive_journal_sources(
        &self,
        records: &Records,
        blocks: &Access<'_>,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
        through: u64,
    ) -> Result<Option<Vec<ProjectedMessage>>> {
        let Some(header) = head(records, &binding(scope, grant, admission))? else {
            return Ok(None);
        };
        if header.retired {
            return Ok(Some(Vec::new()));
        }
        let mut sources = Vec::new();
        let mut entry = start(blocks, &header)?;
        loop {
            if entry.receipt.position <= through {
                sources.push(document(blocks, &entry)?);
            }
            if entry.jumps.is_empty() {
                break;
            }
            entry = previous(blocks, &entry, 0)?;
        }
        sources.reverse();
        Ok(Some(sources))
    }
    #[allow(clippy::too_many_arguments)]
    pub(in super::super) fn archive_journal_clear(
        &self,
        records: &Records,
        blocks: &Access<'_>,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
        positions: &[u64],
    ) -> Result<Option<Vec<ClearMessage>>> {
        let Some(header) = head(records, &binding(scope, grant, admission))? else {
            return Ok(None);
        };
        if header.retired {
            return Err(Error::MessageRetired);
        }
        let mut output = Vec::with_capacity(positions.len());
        for position in positions {
            let mut entry = start(blocks, &header)?;
            while entry.receipt.position > *position {
                let mut advanced = false;
                for level in (0..entry.jumps.len()).rev() {
                    let old = previous(blocks, &entry, level)?;
                    if old.receipt.position >= *position {
                        entry = old;
                        advanced = true;
                        break;
                    }
                }
                if !advanced {
                    if entry.jumps.is_empty() {
                        return Err(Error::MessageNotRetained);
                    }
                    entry = previous(blocks, &entry, 0)?;
                }
            }
            if entry.receipt.position != *position {
                return Err(Error::MessageNotRetained);
            }
            output.push(document(blocks, &entry)?.message);
        }
        Ok(Some(output))
    }
}
