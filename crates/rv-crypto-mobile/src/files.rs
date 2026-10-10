//! Encrypted files of private rooms (E2EE_FILES.md): stateless sealing and
//! opening between private files of the app, streamed in Rust. The key leaves
//! only inside the descriptor the encrypted document carries.
use super::*;
use rv_crypto::files;
use serde_json::json;
use std::path::Path;

fn local(path: &str) -> Result<&Path> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(CryptoBridgeError::Integrity);
    }
    Ok(path)
}
fn failed(error: files::Error) -> CryptoBridgeError {
    match error {
        files::Error::Io(_) | files::Error::Unavailable => CryptoBridgeError::Storage,
        files::Error::Invalid | files::Error::TooLarge => CryptoBridgeError::Integrity,
    }
}

/// Seals `source` into a new private `object`. Returns the descriptor's
/// secret and checks, and the object's size and SHA-256 for its reservation.
#[cfg_attr(feature = "native-bindings", uniffi::export)]
pub fn seal_file(source: String, object: String) -> Result<String> {
    let sealed = files::seal_path(local(&source)?, local(&object)?).map_err(failed)?;
    Ok(json!({"key":sealed.key_text(),"bytes":sealed.bytes.to_string(),"sha256":sealed.sha256_text(),
        "object_bytes":sealed.object_bytes.to_string(),"object_sha256":sealed.object_sha256_text()})
    .to_string())
}
/// Opens a downloaded `object` into `target` with its descriptor; nothing is
/// published at `target` unless every chunk, the size and the digest match.
#[cfg_attr(feature = "native-bindings", uniffi::export)]
pub fn open_file(
    key: String,
    bytes: String,
    sha256: String,
    object: String,
    target: String,
) -> Result<()> {
    let key = files::decode_key(&key).map_err(failed)?;
    let digest = files::decode_sha256(&sha256).map_err(failed)?;
    let bytes = bytes
        .parse::<u64>()
        .ok()
        .filter(|n| n.to_string() == bytes)
        .ok_or(CryptoBridgeError::Integrity)?;
    files::open_path(&key, bytes, &digest, local(&object)?, local(&target)?).map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_seal_and_open_between_absolute_paths_only() {
        let directory = tempfile::tempdir().unwrap();
        let path = |name: &str| directory.path().join(name).to_string_lossy().into_owned();
        std::fs::write(path("source"), b"private bytes of the file").unwrap();
        let sealed: serde_json::Value =
            serde_json::from_str(&seal_file(path("source"), path("object")).unwrap()).unwrap();
        assert_eq!(sealed["bytes"], "25");
        let field = |name: &str| sealed[name].as_str().unwrap().to_owned();
        open_file(
            field("key"),
            field("bytes"),
            field("sha256"),
            path("object"),
            path("target"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(path("target")).unwrap(),
            b"private bytes of the file"
        );
        assert!(
            open_file(
                field("key"),
                "24".into(),
                field("sha256"),
                path("object"),
                path("other")
            )
            .is_err()
        );
        assert!(!std::path::Path::new(&path("other")).exists());
        assert!(seal_file("relative".into(), path("object2")).is_err());
    }
}
