//! Disposable CLI fixture. Run only inside the isolated keyring smoke script.
use rv_crypto::{
    protected::{Manager, Storage, system::Keyring},
    vault::{Error, Scope},
};
use std::{io::Write, path::PathBuf, sync::Arc};
use zeroize::Zeroizing;

struct HeldWrite(bool);
impl Storage for HeldWrite {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        Keyring.read(name)
    }
    fn write(&self, name: &str, value: &[u8]) -> Result<(), Error> {
        if self.0 {
            println!("protected-write-at-boundary");
            std::io::stdout().flush().map_err(|_| Error::Storage)?;
            loop {
                std::thread::park();
            }
        }
        Keyring.write(name, value)
    }
}
fn run() -> Result<(), Error> {
    let phase = std::env::args().nth(1).ok_or(Error::Scope)?;
    let path = PathBuf::from(std::env::var_os("RV_CRYPTO_SMOKE_DIRECTORY").ok_or(Error::Scope)?);
    let scope = Scope {
        instance: "disposable-crypto-smoke".into(),
        data_epoch: "fixture-epoch".into(),
        user: "fixture-alice".into(),
        device: "fixture-desktop".into(),
        incarnation: "fixture-incarnation".into(),
    };
    let manager = Manager::new(path, scope, Arc::new(HeldWrite(phase == "hold-checkpoint")))?;
    match phase.as_str() {
        "initialize" => manager.initialize()?,
        "hold-checkpoint" => manager.transact(|_, records| {
            records.insert(
                "original-outbox".into(),
                b"Public encrypted-operation fixture".to_vec(),
            );
            Ok(())
        })?,
        "busy" => {
            if manager.inspect(|_, _| Ok(())) != Err(Error::Busy) {
                return Err(Error::Rejected);
            }
        }
        "recover" => {
            let original = manager.inspect(|_, records| {
                records
                    .get("original-outbox")
                    .cloned()
                    .ok_or(Error::Rejected)
            })?;
            if original != b"Public encrypted-operation fixture" {
                return Err(Error::Rejected);
            }
        }
        "retire" => {
            manager.retire()?;
            if manager.inspect(|_, _| Ok(())) != Err(Error::Retired)
                || manager.initialize() != Err(Error::Retired)
            {
                return Err(Error::Rejected);
            }
        }
        _ => return Err(Error::Scope),
    }
    println!("Protected crypto fixture: {phase} passed");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
