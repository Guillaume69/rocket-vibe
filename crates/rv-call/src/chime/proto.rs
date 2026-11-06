//! The few protobuf messages of Chime's signalling this client speaks
//! (`SignalingProtocol.proto` of amazon-chime-sdk-js, Apache-2.0), written and
//! read by hand: field numbers are those of the `.proto`.

/// A message being written.
#[derive(Default)]
pub struct Writer(Vec<u8>);

impl Writer {
    fn key(&mut self, field: u32, wire: u8) {
        varint(&mut self.0, u64::from(field) << 3 | u64::from(wire));
    }

    pub fn uint(mut self, field: u32, value: u64) -> Self {
        self.key(field, 0);
        varint(&mut self.0, value);
        self
    }

    pub fn bool(self, field: u32, value: bool) -> Self {
        self.uint(field, u64::from(value))
    }

    pub fn bytes(mut self, field: u32, value: &[u8]) -> Self {
        self.key(field, 2);
        varint(&mut self.0, value.len() as u64);
        self.0.extend_from_slice(value);
        self
    }

    pub fn string(self, field: u32, value: &str) -> Self {
        self.bytes(field, value.as_bytes())
    }

    pub fn message(self, field: u32, value: Writer) -> Self {
        self.bytes(field, &value.0)
    }

    pub fn finish(self) -> Vec<u8> {
        self.0
    }
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push(value as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// One field read: its number and its value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value<'a> {
    Int(u64),
    Bytes(&'a [u8]),
}

/// The fields of a message, in order; `None` for a malformed one.
pub fn fields(mut b: &[u8]) -> Option<Vec<(u32, Value<'_>)>> {
    let mut out = Vec::new();
    while !b.is_empty() {
        let key = read_varint(&mut b)?;
        let field = u32::try_from(key >> 3).ok()?;
        let value = match key & 7 {
            0 => Value::Int(read_varint(&mut b)?),
            1 => Value::Int(u64::from_le_bytes(take(&mut b, 8)?.try_into().ok()?)),
            2 => {
                let len = usize::try_from(read_varint(&mut b)?).ok()?;
                Value::Bytes(take(&mut b, len)?)
            }
            5 => Value::Int(u64::from(u32::from_le_bytes(take(&mut b, 4)?.try_into().ok()?))),
            _ => return None,
        };
        out.push((field, value));
    }
    Some(out)
}

fn take<'a>(b: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
    if b.len() < n {
        return None;
    }
    let (head, rest) = b.split_at(n);
    *b = rest;
    Some(head)
}

fn read_varint(b: &mut &[u8]) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let (&byte, rest) = b.split_first()?;
        *b = rest;
        value |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some(value);
        }
    }
    None
}

/// A message's fields, looked up by number.
pub struct Message<'a>(Vec<(u32, Value<'a>)>);

impl<'a> Message<'a> {
    pub fn empty() -> Self {
        Message(Vec::new())
    }

    pub fn parse(b: &'a [u8]) -> Option<Self> {
        fields(b).map(Message)
    }

    pub fn int(&self, field: u32) -> Option<u64> {
        self.0.iter().find_map(|(f, v)| match v {
            Value::Int(i) if *f == field => Some(*i),
            _ => None,
        })
    }

    pub fn bytes(&self, field: u32) -> Option<&'a [u8]> {
        self.0.iter().find_map(|(f, v)| match v {
            Value::Bytes(b) if *f == field => Some(*b),
            _ => None,
        })
    }

    pub fn string(&self, field: u32) -> Option<String> {
        self.bytes(field).map(|b| String::from_utf8_lossy(b).into_owned())
    }

    pub fn message(&self, field: u32) -> Option<Message<'a>> {
        self.bytes(field).and_then(Message::parse)
    }

    /// Every embedded message of a repeated field.
    pub fn messages(&self, field: u32) -> Vec<Message<'a>> {
        self.0
            .iter()
            .filter_map(|(f, v)| match v {
                Value::Bytes(b) if *f == field => Message::parse(b),
                _ => None,
            })
            .collect()
    }

    pub fn strings(&self, field: u32) -> Vec<String> {
        self.0
            .iter()
            .filter_map(|(f, v)| match v {
                Value::Bytes(b) if *f == field => Some(String::from_utf8_lossy(b).into_owned()),
                _ => None,
            })
            .collect()
    }
}

/// `SdkSignalFrame.Type`, the frames this client sends or reads.
pub mod kind {
    pub const JOIN: u64 = 1;
    pub const JOIN_ACK: u64 = 2;
    pub const SUBSCRIBE: u64 = 3;
    pub const SUBSCRIBE_ACK: u64 = 4;
    pub const LEAVE: u64 = 9;
    pub const LEAVE_ACK: u64 = 10;
    pub const AUDIO_CONTROL: u64 = 16;
    pub const AUDIO_METADATA: u64 = 17;
    pub const AUDIO_STREAM_ID_INFO: u64 = 18;
    pub const PING_PONG: u64 = 19;
    pub const AUDIO_STATUS: u64 = 20;
}

/// `SdkSignalFrame`'s fields.
pub mod frame {
    pub const TIMESTAMP: u32 = 1;
    pub const TYPE: u32 = 2;
    pub const ERROR: u32 = 3;
    pub const JOIN: u32 = 4;
    pub const JOIN_ACK: u32 = 5;
    pub const SUBSCRIBE: u32 = 6;
    pub const SUBSCRIBE_ACK: u32 = 7;
    pub const LEAVE: u32 = 11;
    pub const AUDIO_CONTROL: u32 = 17;
    pub const AUDIO_METADATA: u32 = 18;
    pub const AUDIO_STREAM_ID_INFO: u32 = 19;
    pub const PING_PONG: u32 = 20;
    pub const AUDIO_STATUS: u32 = 21;
}

/// The type byte before a frame the client sends (`FRAME_TYPE_RTC`); the
/// server's start with `0x02`.
pub const CLIENT_FRAME: u8 = 0x05;

/// A frame as sent: the type byte, then the `SdkSignalFrame`.
pub fn signal(timestamp_ms: u64, kind: u64, body_field: u32, body: Writer) -> Vec<u8> {
    let message = Writer::default()
        .uint(frame::TIMESTAMP, timestamp_ms)
        .uint(frame::TYPE, kind)
        .message(body_field, body)
        .finish();
    let mut out = Vec::with_capacity(message.len() + 1);
    out.push(CLIENT_FRAME);
    out.extend_from_slice(&message);
    out
}

/// A received frame's type and fields, its leading type byte dropped.
pub fn received(b: &[u8]) -> Option<(u64, Message<'_>)> {
    let (_, body) = b.split_first()?;
    let message = Message::parse(body)?;
    Some((message.int(frame::TYPE)?, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_message_reads_back() {
        let inner = Writer::default().string(1, "turn:x").uint(3, 300);
        let b = Writer::default().uint(1, 1_793_586_546_996).bool(7, true).message(5, inner).finish();
        let m = Message::parse(&b).unwrap();
        assert_eq!(m.int(1), Some(1_793_586_546_996));
        assert_eq!(m.int(7), Some(1));
        let inner = m.message(5).unwrap();
        assert_eq!(inner.string(1).as_deref(), Some("turn:x"));
        assert_eq!(inner.int(3), Some(300));
    }

    #[test]
    fn a_truncated_message_is_refused() {
        let b = Writer::default().string(1, "abcdef").finish();
        assert!(Message::parse(&b[..b.len() - 1]).is_none());
        assert!(Message::parse(&[0x80]).is_none());
    }

    #[test]
    fn a_ping_from_the_capture_reads() {
        // The server's first frame of app.slack.com_huddle2.har: PING_PONG {type PING, ping_id 1}.
        let b = [0x02, 0x08, 0x98, 0x92, 0xdb, 0xd0, 0x99, 0x34, 0x10, 0x13, 0xa2, 0x01, 0x04, 0x08, 0x01, 0x10, 0x01];
        let (kind, m) = received(&b).unwrap();
        assert_eq!(kind, kind::PING_PONG);
        let ping = m.message(frame::PING_PONG).unwrap();
        assert_eq!((ping.int(1), ping.int(2)), (Some(1), Some(1)));
    }
}
