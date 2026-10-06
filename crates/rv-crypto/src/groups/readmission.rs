//! Replace an old accepted admission only after preview and explicit consent.
//! Temporary MLS deletion during preview lives in the disposable snapshot;
//! replacement, cache retirement and cursor reset share the final transaction.
use super::*;

fn intent(admission: &Admission) -> Result<(Transition, Fingerprint)> {
    let (transition, _) = check_admission(admission)?;
    Ok((
        transition,
        fingerprint("rocketvibe-local-group-readmission-v1", admission)?,
    ))
}
impl Coordinator {
    fn readmission_source(
        &self,
        provider: &OpenMlsRustCrypto,
        records: &Records,
        state: &State,
        admission: &Admission,
        transition: &Transition,
        now: u64,
    ) -> Result<()> {
        self.scope(&state.scope)?;
        check_clock(Some(state), now)?;
        self.ensure_group_settled(records, &state.scope.room, now)?;
        if state.pending.is_some() || self.pending_messages(records, &state.scope)? {
            return Err(Error::Pending);
        }
        let active = state.active.as_ref().ok_or(Error::NotReady)?;
        if admission.receipt == active.receipt && transition == &active.transition {
            return Err(Error::Exists);
        }
        if state.scope.room != admission.receipt.scope.room
            || state.seen_packages.contains(&admission.welcome.key_package)
            || state.scope == transition.plan.scope
                && (admission.receipt.revision <= active.receipt.revision
                    || admission.receipt.epoch <= active.receipt.epoch)
        {
            return Err(Error::Changed);
        }
        let mut old = MlsGroup::load(
            provider.storage(),
            &GroupId::from_slice(&state.scope.group_id()?),
        )
        .map_err(|_| Error::Mls)?
        .ok_or(Error::Changed)?;
        if old.pending_commit().is_some() || old.pending_proposals().next().is_some() {
            return Err(Error::Pending);
        }
        check_actual(old.public_group(), &active.transition.plan)?;
        old.delete(provider.storage()).map_err(|_| Error::Mls)?;
        Ok(())
    }
    pub fn preview_readmission(
        &self,
        admission: &Admission,
        now: u64,
    ) -> Result<(Preview, Consent)> {
        let (transition, intent) = intent(admission)?;
        self.scope(&transition.plan.scope)?;
        self.inspect(|provider, records| {
            let state = read(records, &transition.plan.scope.room)?.ok_or(Error::NotReady)?;
            self.readmission_source(provider, records, &state, admission, &transition, now)?;
            let context = self.context(records, now)?;
            let expires = self
                .validate_admission(provider, &context, admission, &transition, now)?
                .min(context.certificate.device.expires_at)
                .min(transition.certificate.device.expires_at)
                .min(now.saturating_add(300));
            let own = context.certificate.fingerprint()?;
            let state = consent_state(Some(&state))?;
            let fingerprint = fingerprint(
                "rocketvibe-local-group-confirmation-v1",
                &(intent, state, context.pins_fingerprint, own, expires),
            )?;
            Ok((
                Preview {
                    fingerprint,
                    scope: transition.plan.scope,
                    recipients: transition.plan.participants,
                },
                Consent {
                    fingerprint,
                    intent,
                    state,
                    pins: context.pins_fingerprint,
                    own,
                    expires,
                },
            ))
        })
    }
    pub fn accept_readmission(
        &self,
        admission: &Admission,
        consent: &Consent,
        confirmed: Fingerprint,
        now: u64,
    ) -> Result<()> {
        let (transition, intent) = intent(admission)?;
        self.scope(&transition.plan.scope)?;
        if consent.fingerprint != confirmed || consent.intent != intent {
            return Err(Error::Changed);
        }
        self.transact(|provider, records| {
            let old = read(records, &transition.plan.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&old), now)?;
            if let Some(active) = &old.active
                && active.receipt == admission.receipt
                && active.transition == transition
            {
                let group = MlsGroup::load(
                    provider.storage(),
                    &GroupId::from_slice(&old.scope.group_id()?),
                )
                .map_err(|_| Error::Mls)?
                .ok_or(Error::Changed)?;
                return check_actual(group.public_group(), &active.transition.plan);
            }
            if now >= consent.expires || consent_state(Some(&old))? != consent.state {
                return Err(Error::Changed);
            }
            let context = self.context(records, now)?;
            if context.pins_fingerprint != consent.pins
                || context.certificate.fingerprint()? != consent.own
            {
                return Err(Error::Changed);
            }
            self.readmission_source(provider, records, &old, admission, &transition, now)?;
            self.validate_admission(provider, &context, admission, &transition, now)?;
            self.retire_message_admission(records, &old.scope.room, now)?;
            journal::reset_admission(records, &old.scope)?;
            let mut seen_packages = old.seen_packages;
            seen_packages.extend(
                transition
                    .plan
                    .participants
                    .iter()
                    .filter_map(|p| p.key_package),
            );
            save(
                records,
                &State {
                    version: 1,
                    scope: transition.plan.scope.clone(),
                    clock: now,
                    active: Some(Active {
                        created: now,
                        historical: false,
                        transition,
                        receipt: admission.receipt.clone(),
                    }),
                    pending: None,
                    seen_packages,
                },
            )
        })
    }
}
