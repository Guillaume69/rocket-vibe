//! Encrypted files of private rooms (E2EE_FILES.md, `rv-file-v1`): a fresh key
//! per file, 64 KiB chunks under XChaCha20-Poly1305 with a STREAM nonce, and
//! the plaintext size and SHA-256 checked again on opening. Streaming, so a
//! 100 MiB file never sits in memory.
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 4] = b"RVF1";
pub const CHUNK: usize = 65_536;
const PREFIX: usize = 19;
const TAG: usize = 16;
const AAD: &[u8] = b"rocketvibe-file-v1";
/// The largest object the server stores (FILES.md).
pub const MAX_OBJECT: u64 = 100 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("crypto_file_io")]
    Io(#[from] std::io::Error),
    #[error("crypto_file_invalid")]
    Invalid,
    #[error("crypto_file_too_large")]
    TooLarge,
    #[error("crypto_unavailable")]
    Unavailable,
}
pub type Result<T> = std::result::Result<T, Error>;

/// Chunks of a plaintext of `bytes`: an empty file is one empty chunk.
pub fn chunks(bytes: u64) -> u64 {
    bytes.div_ceil(CHUNK as u64).max(1)
}
/// Exact object size for a plaintext of `bytes`.
pub fn object_size(bytes: u64) -> u64 {
    (MAGIC.len() + PREFIX) as u64 + bytes + TAG as u64 * chunks(bytes)
}

/// A sealed file: the descriptor's secret and checks, and the object's own
/// size and SHA-256 for the upload reservation.
pub struct Sealed {
    pub key: Zeroizing<[u8; 32]>,
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub object_bytes: u64,
    pub object_sha256: [u8; 32],
}
impl Sealed {
    pub fn key_text(&self) -> String {
        encode_key(&self.key)
    }
    pub fn sha256_text(&self) -> String {
        HEXLOWER.encode(&self.sha256)
    }
    pub fn object_sha256_text(&self) -> String {
        HEXLOWER.encode(&self.object_sha256)
    }
}
pub fn encode_key(key: &[u8; 32]) -> String {
    BASE64URL_NOPAD.encode(key)
}
pub fn decode_key(text: &str) -> Result<Zeroizing<[u8; 32]>> {
    let bytes = Zeroizing::new(
        BASE64URL_NOPAD
            .decode(text.as_bytes())
            .map_err(|_| Error::Invalid)?,
    );
    let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| Error::Invalid)?;
    Ok(Zeroizing::new(key))
}
pub fn decode_sha256(text: &str) -> Result<[u8; 32]> {
    if text.len() != 64 || text.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err(Error::Invalid);
    }
    HEXLOWER
        .decode(text.as_bytes())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(Error::Invalid)
}

fn nonce(prefix: &[u8; PREFIX], index: u64, last: bool) -> Result<XNonce> {
    let index = u32::try_from(index).map_err(|_| Error::TooLarge)?;
    let mut nonce = [0u8; 24];
    nonce[..PREFIX].copy_from_slice(prefix);
    nonce[PREFIX..PREFIX + 4].copy_from_slice(&index.to_be_bytes());
    nonce[23] = u8::from(last);
    Ok(nonce.into())
}
/// Reads until `buffer` is full or the input ends; the count read.
fn fill(reader: &mut impl Read, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(filled)
}
/// Writes and hashes the object as it goes.
struct Hashed<W> {
    inner: W,
    digest: Sha256,
    bytes: u64,
}
impl<W: Write> Hashed<W> {
    fn put(&mut self, data: &[u8]) -> Result<()> {
        self.inner.write_all(data)?;
        self.digest.update(data);
        self.bytes += data.len() as u64;
        Ok(())
    }
}

/// Seals `reader` into `writer` under a fresh key.
pub fn seal(reader: impl Read, writer: impl Write) -> Result<Sealed> {
    let mut key = Zeroizing::new([0u8; 32]);
    getrandom::fill(key.as_mut()).map_err(|_| Error::Unavailable)?;
    let mut prefix = [0u8; PREFIX];
    getrandom::fill(&mut prefix).map_err(|_| Error::Unavailable)?;
    seal_with(key, prefix, reader, writer)
}
/// Seals with a given key and prefix: only for public vectors and tests.
pub fn seal_with(
    key: Zeroizing<[u8; 32]>,
    prefix: [u8; PREFIX],
    mut reader: impl Read,
    writer: impl Write,
) -> Result<Sealed> {
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let mut out = Hashed {
        inner: writer,
        digest: Sha256::new(),
        bytes: 0,
    };
    out.put(MAGIC)?;
    out.put(&prefix)?;
    let mut plain = Sha256::new();
    let mut bytes = 0u64;
    let mut current = Zeroizing::new(vec![0u8; CHUNK]);
    let mut next = Zeroizing::new(vec![0u8; CHUNK]);
    let mut length = fill(&mut reader, &mut current)?;
    let mut index = 0u64;
    loop {
        // A full chunk is the last only if nothing follows it.
        let following = if length == CHUNK {
            fill(&mut reader, &mut next)?
        } else {
            0
        };
        let last = following == 0;
        let chunk = &current[..length];
        plain.update(chunk);
        bytes += length as u64;
        if object_size(bytes) > MAX_OBJECT {
            return Err(Error::TooLarge);
        }
        let sealed = cipher
            .encrypt(
                &nonce(&prefix, index, last)?,
                Payload {
                    msg: chunk,
                    aad: AAD,
                },
            )
            .map_err(|_| Error::Invalid)?;
        out.put(&sealed)?;
        if last {
            break;
        }
        std::mem::swap(&mut current, &mut next);
        length = following;
        index += 1;
    }
    out.inner.flush()?;
    Ok(Sealed {
        key,
        bytes,
        sha256: plain.finalize().into(),
        object_bytes: out.bytes,
        object_sha256: out.digest.finalize().into(),
    })
}

/// Opens an object into `writer`, checking every chunk, the chunk count and
/// flags, the end of input, then the plaintext size and SHA-256. On error the
/// writer may hold a prefix: callers write to a private partial file.
pub fn open(
    key: &[u8; 32],
    bytes: u64,
    sha256: &[u8; 32],
    mut reader: impl Read,
    mut writer: impl Write,
) -> Result<()> {
    if object_size(bytes) > MAX_OBJECT {
        return Err(Error::TooLarge);
    }
    let mut head = [0u8; 4 + PREFIX];
    if fill(&mut reader, &mut head)? != head.len() || &head[..4] != MAGIC {
        return Err(Error::Invalid);
    }
    let prefix: [u8; PREFIX] = head[4..].try_into().expect("fixed prefix length");
    let cipher = XChaCha20Poly1305::new(key.into());
    let count = chunks(bytes);
    let mut remaining = bytes;
    let mut digest = Sha256::new();
    let mut sealed = vec![0u8; CHUNK + TAG];
    for index in 0..count {
        let length = remaining.min(CHUNK as u64) as usize;
        let part = &mut sealed[..length + TAG];
        if fill(&mut reader, part)? != part.len() {
            return Err(Error::Invalid);
        }
        let chunk = Zeroizing::new(
            cipher
                .decrypt(
                    &nonce(&prefix, index, index + 1 == count)?,
                    Payload {
                        msg: part,
                        aad: AAD,
                    },
                )
                .map_err(|_| Error::Invalid)?,
        );
        digest.update(chunk.as_slice());
        writer.write_all(&chunk)?;
        remaining -= length as u64;
    }
    if fill(&mut reader, &mut [0u8; 1])? != 0 || digest.finalize().as_slice() != sha256 {
        return Err(Error::Invalid);
    }
    writer.flush()?;
    Ok(())
}

/// Seals the file at `source` into a new private file at `object`.
pub fn seal_path(source: &Path, object: &Path) -> Result<Sealed> {
    let input = std::fs::File::open(source)?;
    let output = private_file(object)?;
    let mut writer = std::io::BufWriter::new(output);
    let sealed = seal(std::io::BufReader::new(input), &mut writer)?;
    writer
        .into_inner()
        .map_err(|e| e.into_error())?
        .sync_all()?;
    Ok(sealed)
}
/// Opens the object at `object` into `target` through a private partial file,
/// published only once every check passed.
pub fn open_path(
    key: &[u8; 32],
    bytes: u64,
    sha256: &[u8; 32],
    object: &Path,
    target: &Path,
) -> Result<()> {
    let partial = target.with_extension("part");
    let result = (|| {
        let input = std::fs::File::open(object)?;
        let mut writer = std::io::BufWriter::new(private_file(&partial)?);
        open(
            key,
            bytes,
            sha256,
            std::io::BufReader::new(input),
            &mut writer,
        )?;
        writer
            .into_inner()
            .map_err(|e| e.into_error())?
            .sync_all()?;
        std::fs::rename(&partial, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}
fn private_file(path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

#[cfg(test)]
mod tests;
