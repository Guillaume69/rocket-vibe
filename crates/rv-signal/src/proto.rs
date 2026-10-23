//! Just enough protobuf for the wire messages and records of `WAProto.proto`
//! (whatspec): varints and length-delimited fields. Fixed-width and unknown
//! fields are skipped.

use crate::{Error, Result};

#[derive(Default)]
pub(crate) struct Writer(pub Vec<u8>);

impl Writer {
    fn varint(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.0.push(v as u8 | 0x80);
            v >>= 7;
        }
        self.0.push(v as u8);
    }

    fn key(&mut self, field: u32, wire: u8) {
        self.varint((u64::from(field) << 3) | u64::from(wire));
    }

    pub fn uint(&mut self, field: u32, v: u64) {
        self.key(field, 0);
        self.varint(v);
    }

    pub fn opt_uint(&mut self, field: u32, v: Option<u64>) {
        if let Some(v) = v {
            self.uint(field, v);
        }
    }

    pub fn bytes(&mut self, field: u32, v: &[u8]) {
        self.key(field, 2);
        self.varint(v.len() as u64);
        self.0.extend_from_slice(v);
    }

    pub fn message(&mut self, field: u32, build: impl FnOnce(&mut Writer)) {
        let mut inner = Writer::default();
        build(&mut inner);
        self.bytes(field, &inner.0);
    }
}

pub(crate) enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed,
}

impl<'a> Value<'a> {
    pub fn uint(&self) -> Result<u64> {
        match self {
            Value::Varint(v) => Ok(*v),
            _ => Err(Error::InvalidProtobuf("expected a varint")),
        }
    }

    pub fn u32(&self) -> Result<u32> {
        u32::try_from(self.uint()?).map_err(|_| Error::InvalidProtobuf("varint over 32 bits"))
    }

    /// An `int32` field: negative values are sign-extended to 64 bits on the wire.
    pub fn i32(&self) -> Result<i32> {
        Ok(self.uint()? as i64 as i32)
    }

    pub fn bytes(&self) -> Result<&'a [u8]> {
        match self {
            Value::Bytes(v) => Ok(v),
            _ => Err(Error::InvalidProtobuf("expected bytes")),
        }
    }
}

pub(crate) struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self(bytes)
    }

    fn varint(&mut self) -> Result<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let (&b, rest) = self
                .0
                .split_first()
                .ok_or(Error::InvalidProtobuf("truncated varint"))?;
            self.0 = rest;
            v |= u64::from(b & 0x7f) << shift;
            if b < 0x80 {
                return Ok(v);
            }
        }
        Err(Error::InvalidProtobuf("varint too long"))
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.0.len() < n {
            return Err(Error::InvalidProtobuf("truncated field"));
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    /// The next field, or None at the end.
    pub fn next_field(&mut self) -> Result<Option<(u32, Value<'a>)>> {
        if self.0.is_empty() {
            return Ok(None);
        }
        let key = self.varint()?;
        let field = u32::try_from(key >> 3).map_err(|_| Error::InvalidProtobuf("field number"))?;
        let value = match key & 7 {
            0 => Value::Varint(self.varint()?),
            1 => {
                self.take(8)?;
                Value::Fixed
            }
            2 => {
                let len = usize::try_from(self.varint()?)
                    .map_err(|_| Error::InvalidProtobuf("length"))?;
                Value::Bytes(self.take(len)?)
            }
            5 => {
                self.take(4)?;
                Value::Fixed
            }
            _ => return Err(Error::InvalidProtobuf("unsupported wire type")),
        };
        Ok(Some((field, value)))
    }
}

/// Calls `each` for every field of `bytes`.
pub(crate) fn fields<'a>(
    bytes: &'a [u8],
    mut each: impl FnMut(u32, Value<'a>) -> Result<()>,
) -> Result<()> {
    let mut reader = Reader::new(bytes);
    while let Some((field, value)) = reader.next_field()? {
        each(field, value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_fields_and_skips_unknown_ones() {
        let mut w = Writer::default();
        w.uint(1, 300);
        w.bytes(4, b"abc");
        w.key(5, 1);
        w.0.extend_from_slice(&[0; 8]);
        w.uint(99, 1);
        w.message(6, |m| m.uint(1, 7));
        let mut seen = Vec::new();
        fields(&w.0, |field, value| {
            match field {
                1 => seen.push(format!("1={}", value.uint()?)),
                4 => seen.push(format!("4={:?}", value.bytes()?)),
                5 => seen.push(format!("5={}", matches!(value, Value::Fixed))),
                6 => fields(value.bytes()?, |f, v| {
                    seen.push(format!("6.{f}={}", v.uint()?));
                    Ok(())
                })?,
                _ => {}
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, ["1=300", "4=[97, 98, 99]", "5=true", "6.1=7"]);
    }

    #[test]
    fn negative_int32_is_sign_extended() {
        let mut w = Writer::default();
        w.uint(3, -1i64 as u64);
        let mut got = 0;
        fields(&w.0, |_, v| {
            got = v.i32()?;
            Ok(())
        })
        .unwrap();
        assert_eq!(got, -1);
    }

    #[test]
    fn truncated_input_is_an_error() {
        assert!(fields(&[0x22, 0x05, 1, 2], |_, _| Ok(())).is_err());
    }
}
