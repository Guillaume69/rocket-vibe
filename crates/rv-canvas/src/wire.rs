//! The protobuf wire format, by hand: the canvas service speaks a handful of
//! Quip messages and only their few fields this crate reads or writes.

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Int(u64),
    Bytes(Vec<u8>),
    Fixed64([u8; 8]),
    Fixed32([u8; 4]),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Message {
    pub fields: Vec<(u32, Value)>,
}

#[derive(Debug, PartialEq)]
pub struct Malformed;

fn varint(bytes: &[u8], at: &mut usize) -> Result<u64, Malformed> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*at).ok_or(Malformed)?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Ok(value);
        }
    }
    Err(Malformed)
}

impl Message {
    pub fn parse(bytes: &[u8]) -> Result<Self, Malformed> {
        let mut fields = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let key = varint(bytes, &mut at)?;
            let number = u32::try_from(key >> 3).map_err(|_| Malformed)?;
            if number == 0 {
                return Err(Malformed);
            }
            let value = match key & 7 {
                0 => Value::Int(varint(bytes, &mut at)?),
                1 => Value::Fixed64(bytes.get(at..at + 8).ok_or(Malformed)?.try_into().map_err(|_| Malformed)?),
                2 => {
                    let len = usize::try_from(varint(bytes, &mut at)?).map_err(|_| Malformed)?;
                    Value::Bytes(bytes.get(at..at + len).ok_or(Malformed)?.to_vec())
                }
                5 => Value::Fixed32(bytes.get(at..at + 4).ok_or(Malformed)?.try_into().map_err(|_| Malformed)?),
                _ => return Err(Malformed),
            };
            at += match &value {
                Value::Fixed64(_) => 8,
                Value::Fixed32(_) => 4,
                Value::Bytes(b) => b.len(),
                Value::Int(_) => 0,
            };
            fields.push((number, value));
        }
        Ok(Message { fields })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (number, value) in &self.fields {
            let wire = match value {
                Value::Int(_) => 0,
                Value::Fixed64(_) => 1,
                Value::Bytes(_) => 2,
                Value::Fixed32(_) => 5,
            };
            put_varint(&mut out, u64::from(*number) << 3 | wire);
            match value {
                Value::Int(v) => put_varint(&mut out, *v),
                Value::Fixed64(b) => out.extend_from_slice(b),
                Value::Fixed32(b) => out.extend_from_slice(b),
                Value::Bytes(b) => {
                    put_varint(&mut out, b.len() as u64);
                    out.extend_from_slice(b);
                }
            }
        }
        out
    }

    pub fn int(&self, number: u32) -> Option<u64> {
        self.fields.iter().find_map(|(n, v)| match v {
            Value::Int(i) if *n == number => Some(*i),
            _ => None,
        })
    }

    pub fn bytes(&self, number: u32) -> Option<&[u8]> {
        self.all_bytes(number).next()
    }

    pub fn all_bytes(&self, number: u32) -> impl Iterator<Item = &[u8]> {
        self.fields.iter().filter_map(move |(n, v)| match v {
            Value::Bytes(b) if *n == number => Some(b.as_slice()),
            _ => None,
        })
    }

    pub fn string(&self, number: u32) -> Option<String> {
        self.bytes(number).and_then(|b| String::from_utf8(b.to_vec()).ok())
    }

    pub fn message(&self, number: u32) -> Option<Message> {
        self.bytes(number).and_then(|b| Message::parse(b).ok())
    }

    pub fn messages(&self, number: u32) -> Vec<Message> {
        self.all_bytes(number).filter_map(|b| Message::parse(b).ok()).collect()
    }

    pub fn with_int(mut self, number: u32, value: u64) -> Self {
        self.fields.push((number, Value::Int(value)));
        self
    }

    pub fn with_bytes(mut self, number: u32, value: impl Into<Vec<u8>>) -> Self {
        self.fields.push((number, Value::Bytes(value.into())));
        self
    }

    pub fn with_str(self, number: u32, value: &str) -> Self {
        self.with_bytes(number, value.as_bytes())
    }

    pub fn with_message(self, number: u32, value: &Message) -> Self {
        self.with_bytes(number, value.encode())
    }
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_round_trips() {
        let inner = Message::default().with_str(1, "eTd9AAR4bTh").with_int(3, 13000);
        let outer = Message::default().with_message(1, &inner).with_int(6, 300);
        let parsed = Message::parse(&outer.encode()).unwrap();
        assert_eq!(parsed, outer);
        assert_eq!(parsed.message(1).unwrap().int(3), Some(13000));
        assert_eq!(parsed.message(1).unwrap().string(1).as_deref(), Some("eTd9AAR4bTh"));
        assert_eq!(Message::parse(&[0x0a, 0x05, 1]), Err(Malformed));
    }
}
