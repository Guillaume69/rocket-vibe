//! Compose text stays in the protected installation, scoped to the actual
//! admission and personal membership grant. It never enters ordinary SQLite.
use super::*;

const LIMIT: usize = 64 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    scope: vault::Scope,
    group: Scope,
    grant: Member,
    admission: Fingerprint,
    thread: Option<String>,
    text: String,
}
impl Coordinator {
    pub(super) fn draft_binding(
        &self,
        records: &Records,
        roster: &Roster,
        thread: &Option<String>,
        now: u64,
    ) -> Result<(String, Member)> {
        check_request(roster, "draft-control", &[])?;
        self.scope(&roster.scope)?;
        if thread
            .as_ref()
            .is_some_and(|id| !wire::valid_identifier(id))
        {
            return Err(Error::Changed);
        }
        self.context(records, now)?;
        let state = read(records, &roster.scope.room)?.ok_or(Error::NotReady)?;
        check_clock(Some(&state), now)?;
        let active = state.active.as_ref().ok_or(Error::NotReady)?;
        let grant = roster
            .members
            .iter()
            .find(|m| m.user == self.manager.scope().user)
            .ok_or(Error::Changed)?;
        let root = self.root.fingerprint()?;
        if state.scope != roster.scope
            || active
                .transition
                .plan
                .members
                .iter()
                .find(|m| m.user == grant.user)
                != Some(grant)
            || !active.transition.plan.participants.iter().any(|p| {
                p.user == grant.user
                    && p.device == self.manager.scope().device
                    && HEXLOWER.encode(&p.incarnation) == self.manager.scope().incarnation
                    && p.root == root
            })
        {
            return Err(Error::Changed);
        }
        let hash = fingerprint(
            "rocketvibe-private-draft-v1",
            &(
                &roster.scope,
                grant,
                self.admission_witness(&active.transition.plan, grant)?,
                thread,
            ),
        )?;
        Ok((
            format!("crypto-draft:{}", HEXLOWER.encode(&hash)),
            grant.clone(),
        ))
    }
    pub fn draft(
        &self,
        roster: &Roster,
        thread: Option<String>,
        now: u64,
    ) -> Result<zeroize::Zeroizing<String>> {
        self.inspect(|_, records| {
            let (key, grant) = self.draft_binding(records, roster, &thread, now)?;
            let Some(bytes) = records.get(&key) else {
                return Ok(zeroize::Zeroizing::new(String::new()));
            };
            if bytes.len() > LIMIT + 4096 {
                return Err(Error::Limit);
            }
            let value: Draft = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
            let state = read(records, &roster.scope.room)?.ok_or(Error::NotReady)?;
            let plan = &state
                .active
                .as_ref()
                .ok_or(Error::NotReady)?
                .transition
                .plan;
            if value.scope != *self.manager.scope()
                || value.group != roster.scope
                || value.grant != grant
                || value.admission != self.admission_witness(plan, &grant)?
                || value.thread != thread
                || value.text.len() > LIMIT
            {
                return Err(Error::Changed);
            }
            Ok(zeroize::Zeroizing::new(value.text))
        })
    }
    pub fn set_draft(
        &self,
        roster: &Roster,
        thread: Option<String>,
        text: String,
        now: u64,
    ) -> Result<()> {
        if text.len() > LIMIT {
            return Err(Error::Limit);
        }
        self.transact(|_, records| {
            let (key, grant) = self.draft_binding(records, roster, &thread, now)?;
            if text.is_empty() {
                records.remove(&key);
            } else {
                if !records.contains_key(&key)
                    && records
                        .keys()
                        .filter(|k| k.starts_with("crypto-draft:"))
                        .count()
                        >= 128
                {
                    return Err(Error::Limit);
                }
                records.insert(
                    key,
                    serde_json::to_vec(&Draft {
                        scope: self.manager.scope().clone(),
                        group: roster.scope.clone(),
                        admission: self.admission_witness(
                            &read(records, &roster.scope.room)?
                                .ok_or(Error::NotReady)?
                                .active
                                .as_ref()
                                .ok_or(Error::NotReady)?
                                .transition
                                .plan,
                            &grant,
                        )?,
                        grant,
                        thread,
                        text,
                    })
                    .map_err(|_| Error::Changed)?,
                );
            }
            Ok(())
        })
    }
}
