//! The integrity hash of a collection: a sum, word by word, of a 128-byte
//! derivation of every live record's value MAC, so that adding and removing
//! records commute and the hash depends only on the set of records.

/// An LTHash: each item is expanded with HKDF-SHA256 (no salt, `hkdf_info`)
/// to `hkdf_size` bytes, read as little-endian 16-bit words, and added to or
/// subtracted from the base with wrap-around.
#[derive(Clone, Debug)]
pub struct LTHash {
    pub hkdf_info: &'static [u8],
    pub hkdf_size: u8,
}

pub const WAPATCH_INTEGRITY_INFO: &str = "WhatsApp Patch Integrity";

pub const WAPATCH_INTEGRITY: LTHash = LTHash {
    hkdf_info: WAPATCH_INTEGRITY_INFO.as_bytes(),
    hkdf_size: 128,
};

impl LTHash {
    pub fn subtract_then_add<S: AsRef<[u8]>, A: AsRef<[u8]>>(
        &self,
        base: &[u8],
        subtract: &[S],
        add: &[A],
    ) -> Vec<u8> {
        let mut out = base.to_vec();
        self.subtract_then_add_in_place(&mut out, subtract, add);
        out
    }

    pub fn subtract_then_add_in_place<S: AsRef<[u8]>, A: AsRef<[u8]>>(
        &self,
        base: &mut [u8],
        subtract: &[S],
        add: &[A],
    ) {
        assert_eq!(
            base.len(),
            usize::from(self.hkdf_size),
            "LTHash base length"
        );
        for item in subtract {
            self.fold(base, item.as_ref(), u16::wrapping_sub);
        }
        for item in add {
            self.fold(base, item.as_ref(), u16::wrapping_add);
        }
    }

    fn fold(&self, base: &mut [u8], item: &[u8], op: fn(u16, u16) -> u16) {
        let mut derived = vec![0u8; usize::from(self.hkdf_size)];
        crate::crypto::hkdf(item, self.hkdf_info, &mut derived);
        for (b, d) in base.chunks_exact_mut(2).zip(derived.chunks_exact(2)) {
            let r = op(
                u16::from_le_bytes([b[0], b[1]]),
                u16::from_le_bytes([d[0], d[1]]),
            );
            b.copy_from_slice(&r.to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adding_then_subtracting_returns_to_the_base() {
        let base = [3u8; 128];
        let added = WAPATCH_INTEGRITY.subtract_then_add(&base, &[] as &[&[u8]], &[b"a", b"b"]);
        assert_ne!(added, base);
        let back = WAPATCH_INTEGRITY.subtract_then_add(&added, &[b"b", b"a"], &[] as &[&[u8]]);
        assert_eq!(back, base);
    }

    #[test]
    fn the_order_of_items_does_not_matter() {
        let zero = [0u8; 128];
        let ab = WAPATCH_INTEGRITY.subtract_then_add(&zero, &[] as &[&[u8]], &[b"a", b"b"]);
        let ba = WAPATCH_INTEGRITY.subtract_then_add(&zero, &[] as &[&[u8]], &[b"b", b"a"]);
        assert_eq!(ab, ba);
    }
}
