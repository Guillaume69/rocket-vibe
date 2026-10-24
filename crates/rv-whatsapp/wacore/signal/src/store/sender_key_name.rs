/// A sender key's name: the group and the sender address, kept as one
/// `group:sender` string, which is also the key it is stored under.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct SenderKeyName {
    full: String,
    group_len: usize,
}

impl SenderKeyName {
    pub fn new(group_id: String, sender_id: String) -> Self {
        Self::from_parts(&group_id, &sender_id)
    }

    pub fn from_parts(group_id: &str, sender_id: &str) -> Self {
        let mut full = String::with_capacity(group_id.len() + 1 + sender_id.len());
        full.push_str(group_id);
        full.push(':');
        full.push_str(sender_id);
        Self {
            full,
            group_len: group_id.len(),
        }
    }

    /// `buf` already holds `group:sender`, the group being its first `group_len` bytes.
    pub fn from_buf(buf: String, group_len: usize) -> Self {
        debug_assert_eq!(buf.as_bytes().get(group_len), Some(&b':'));
        Self {
            full: buf,
            group_len,
        }
    }

    pub fn group_id(&self) -> &str {
        &self.full[..self.group_len]
    }

    pub fn sender_id(&self) -> &str {
        self.full.get(self.group_len + 1..).unwrap_or_default()
    }

    pub fn cache_key(&self) -> &str {
        &self.full
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parts_and_the_key_agree_however_it_is_built() {
        let a = SenderKeyName::from_parts("g@g.us", "me.0");
        let b = SenderKeyName::from_buf("g@g.us:me.0".to_owned(), 6);
        assert_eq!(a, b);
        assert_eq!(a.group_id(), "g@g.us");
        assert_eq!(a.sender_id(), "me.0");
        assert_eq!(a.cache_key(), "g@g.us:me.0");
    }
}
