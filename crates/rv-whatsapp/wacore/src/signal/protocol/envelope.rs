//! The stored form of a record: the `rv-signal` record, the counter lease
//! and the incarnation of the store that wrote it, as a protobuf whose field
//! numbers (101 and up) a bare `RecordStructure` or `SenderKeyRecordStructure`
//! never uses, so a bare one still reads.

use super::error::{Result, SignalProtocolError};

const RECORD: u64 = 101;
const LEASE: u64 = 102;
const INCARNATION: u64 = 103;

pub(crate) struct Stored<'a> {
    pub record: &'a [u8],
    pub lease: u32,
    pub incarnation: Option<[u8; 16]>,
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn put_bytes(out: &mut Vec<u8>, field: u64, bytes: &[u8]) {
    put_varint(out, (field << 3) | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

pub(crate) fn write(out: &mut Vec<u8>, record: &[u8], lease: u32, incarnation: Option<&[u8; 16]>) {
    put_bytes(out, RECORD, record);
    if lease > 0 {
        put_varint(out, LEASE << 3);
        put_varint(out, u64::from(lease));
    }
    if let Some(incarnation) = incarnation {
        put_bytes(out, INCARNATION, incarnation);
    }
}

fn varint(bytes: &mut &[u8]) -> Result<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let (&b, rest) = bytes
            .split_first()
            .ok_or(SignalProtocolError::InvalidProtobufEncoding)?;
        *bytes = rest;
        v |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            return Ok(v);
        }
    }
    Err(SignalProtocolError::InvalidProtobufEncoding)
}

/// The stored record, or None when `bytes` is a bare record.
pub(crate) fn read(bytes: &[u8]) -> Result<Option<Stored<'_>>> {
    let mut rest = bytes;
    let (mut record, mut lease, mut incarnation) = (None, 0, None);
    while !rest.is_empty() {
        let key = varint(&mut rest)?;
        let (field, wire) = (key >> 3, key & 7);
        let value: Option<&[u8]> = match wire {
            0 => {
                let v = varint(&mut rest)?;
                if field == LEASE {
                    lease = u32::try_from(v)
                        .map_err(|_| SignalProtocolError::InvalidProtobufEncoding)?;
                }
                None
            }
            2 => {
                let len = usize::try_from(varint(&mut rest)?)
                    .map_err(|_| SignalProtocolError::InvalidProtobufEncoding)?;
                if rest.len() < len {
                    return Err(SignalProtocolError::InvalidProtobufEncoding);
                }
                let (value, tail) = rest.split_at(len);
                rest = tail;
                Some(value)
            }
            1 => {
                rest = rest
                    .get(8..)
                    .ok_or(SignalProtocolError::InvalidProtobufEncoding)?;
                None
            }
            5 => {
                rest = rest
                    .get(4..)
                    .ok_or(SignalProtocolError::InvalidProtobufEncoding)?;
                None
            }
            _ => return Err(SignalProtocolError::InvalidProtobufEncoding),
        };
        match (field, value) {
            (RECORD, Some(v)) => record = Some(v),
            (INCARNATION, Some(v)) => {
                incarnation = Some(
                    v.try_into()
                        .map_err(|_| SignalProtocolError::InvalidProtobufEncoding)?,
                )
            }
            _ => {}
        }
    }
    Ok(record.map(|record| Stored {
        record,
        lease,
        incarnation,
    }))
}
