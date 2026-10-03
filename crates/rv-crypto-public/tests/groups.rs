use rv_crypto_public::{Error, groups::Transition};
use serde_json::Value;
fn vector() -> Value {
    serde_json::from_str(include_str!("../fixtures/group-transition-v1.json")).unwrap()
}
fn transition() -> Transition {
    serde_json::from_value(vector()["transition"].clone()).unwrap()
}
#[test]
fn public_vector_binds_group_context_recipients_and_parent() {
    let transition = transition();
    transition.verify(1_900_000_100).unwrap();
    assert_eq!(
        serde_json::to_value(transition.fingerprint().unwrap()).unwrap(),
        vector()["fingerprint"]
    );
    assert_eq!(
        serde_json::to_value(transition.plan.scope.group_id().unwrap()).unwrap(),
        vector()["group_id"]
    );
    assert_eq!(
        Transition::from_bytes(&transition.to_bytes().unwrap()).unwrap(),
        transition
    );
    for path in [
        "/plan/operation",
        "/plan/authority_version",
        "/plan/scope/room",
        "/plan/scope/data_epoch",
        "/plan/members/1/access_version",
        "/plan/members/1/activation_version",
    ] {
        let mut altered = vector()["transition"].clone();
        *altered.pointer_mut(path).unwrap() = Value::String("substituted-value".into());
        assert!(
            serde_json::from_value::<Transition>(altered)
                .unwrap()
                .verify(1_900_000_100)
                .is_err(),
            "{path}"
        );
    }
    for path in [
        "/plan/previous/0",
        "/plan/context/0",
        "/plan/tree/0",
        "/plan/commit/0",
        "/plan/scope/incarnation/0",
        "/plan/participants/1/root/0",
        "/plan/participants/1/certificate/0",
        "/plan/participants/1/leaf",
        "/plan/participants/1/key_package/0",
        "/plan/welcomes/0/digest/0",
        "/plan/expected_revision",
        "/plan/epoch",
        "/signature/0",
    ] {
        let mut altered = vector()["transition"].clone();
        let field = altered.pointer_mut(path).unwrap();
        *field = Value::from(field.as_u64().unwrap() ^ 1);
        assert!(
            serde_json::from_value::<Transition>(altered)
                .unwrap()
                .verify(1_900_000_100)
                .is_err(),
            "{path}"
        );
    }
}
#[test]
fn canonical_recipient_and_member_shape_rejects_ambiguous_lists() {
    let plan = transition().plan;
    let mut changed = plan.clone();
    changed.members.reverse();
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.participants.reverse();
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.participants[1].leaf = changed.participants[0].leaf;
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.participants[1].device = changed.participants[0].device.clone();
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.members.pop();
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.participants[1].key_package = Some([0; 32]);
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.welcomes.push(changed.welcomes[0].clone());
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.expected_epoch = Some(u64::MAX);
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.expected_revision = i64::MAX as u64;
    assert!(changed.validate().is_err());
    let mut changed = plan;
    changed.participants[1].leaf = 4096;
    assert!(changed.validate().is_err());
}
#[test]
fn expired_certificates_scope_substitution_and_oversized_frame_are_refused() {
    let transition = transition();
    assert_eq!(
        transition.verify(transition.certificate.device.expires_at),
        Err(Error::Expired)
    );
    let mut changed = transition.clone();
    changed.plan.scope.instance = "another-instance".into();
    assert_eq!(changed.verify(1_900_000_100), Err(Error::Scope));
    let mut changed = transition.clone();
    changed.plan.participants[0].certificate[0] ^= 1;
    assert_eq!(changed.verify(1_900_000_100), Err(Error::Scope));
    assert_eq!(
        Transition::from_bytes(&vec![0; rv_crypto_public::groups::WIRE_LIMIT + 1]),
        Err(Error::Limit)
    );
}
