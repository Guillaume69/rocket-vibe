use std::fmt;

/// A device number within a Signal address.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Default)]
pub struct DeviceId(u32);

impl DeviceId {
    pub const fn new(id: u32) -> Self {
        Self(id)
    }
}

impl From<u32> for DeviceId {
    fn from(id: u32) -> Self {
        Self(id)
    }
}

impl From<DeviceId> for u32 {
    fn from(id: DeviceId) -> Self {
        id.0
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// The buffer an address name is written into in place.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AddressBuf(String);

impl AddressBuf {
    pub fn empty() -> Self {
        Self(String::new())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
    pub fn push(&mut self, c: char) {
        self.0.push(c);
    }
    pub fn push_str(&mut self, s: &str) {
        self.0.push_str(s);
    }
}

/// A peer's device: a name and a device number, written `name.device`, the
/// string every store keys on.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ProtocolAddress {
    full: String,
    name_len: usize,
    device_id: DeviceId,
}

impl ProtocolAddress {
    pub fn new(name: &str, device_id: DeviceId) -> Self {
        Self {
            full: format!("{name}.{device_id}"),
            name_len: name.len(),
            device_id,
        }
    }

    pub fn empty(device_id: DeviceId) -> Self {
        Self::new("", device_id)
    }

    pub fn name(&self) -> &str {
        &self.full[..self.name_len]
    }

    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    pub fn as_str(&self) -> &str {
        &self.full
    }

    /// Rewrites the name in place, keeping the device.
    pub fn reset_with(&mut self, write_name: impl FnOnce(&mut AddressBuf)) {
        let mut buf = AddressBuf(std::mem::take(&mut self.full));
        buf.clear();
        write_name(&mut buf);
        self.name_len = buf.0.len();
        use std::fmt::Write;
        let _ = write!(buf.0, ".{}", self.device_id);
        self.full = buf.0;
    }
}

impl fmt::Display for ProtocolAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.full)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_string_is_name_dot_device_and_survives_a_rename() {
        let mut address = ProtocolAddress::new("15550001001", 1.into());
        assert_eq!(address.as_str(), "15550001001.1");
        assert_eq!(address.name(), "15550001001");
        address.reset_with(|b| b.push_str("1@lid"));
        assert_eq!(address.as_str(), "1@lid.1");
        assert_eq!(address.name(), "1@lid");
        assert_eq!(address.device_id(), DeviceId::new(1));
    }
}
