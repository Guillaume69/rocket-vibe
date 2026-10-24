/// The five keys one app-state sync key expands to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandedAppStateKeys {
    pub index: [u8; 32],
    pub value_encryption: [u8; 32],
    pub value_mac: [u8; 32],
    pub snapshot_mac: [u8; 32],
    pub patch_mac: [u8; 32],
}

/// HKDF-SHA256 of the sync key, no salt, labelled "WhatsApp Mutation Keys",
/// 160 bytes cut into five keys in this order.
pub fn expand_app_state_keys(key_data: &[u8]) -> ExpandedAppStateKeys {
    let mut okm = [0u8; 160];
    crate::crypto::hkdf(key_data, b"WhatsApp Mutation Keys", &mut okm);
    let key = |n: usize| -> [u8; 32] { okm[n * 32..(n + 1) * 32].try_into().expect("32 bytes") };
    ExpandedAppStateKeys {
        index: key(0),
        value_encryption: key(1),
        value_mac: key(2),
        snapshot_mac: key(3),
        patch_mac: key(4),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_five_keys_are_distinct_and_deterministic() {
        let a = expand_app_state_keys(&[7; 32]);
        assert_eq!(a, expand_app_state_keys(&[7; 32]));
        let all = [
            a.index,
            a.value_encryption,
            a.value_mac,
            a.snapshot_mac,
            a.patch_mac,
        ];
        for i in 0..all.len() {
            for j in i + 1..all.len() {
                assert_ne!(all[i], all[j]);
            }
        }
        assert_ne!(a, expand_app_state_keys(&[8; 32]));
    }
}
