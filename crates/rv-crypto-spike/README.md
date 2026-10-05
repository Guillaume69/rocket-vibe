# J4 MLS prototype

The feasibility tests of [RFC 0002](../../docs/rfcs/0002-e2ee-native.md).
No server or client depends on this crate; its workspace and its lock
are independent to avoid modifying the production dependencies.

```sh
cargo test --locked --manifest-path crates/rv-crypto-spike/Cargo.toml --target-dir target
```

Three scenarios use OpenMLS 0.9.0 / RustCrypto 0.6.0 with suite 0x0001:

- Welcome, ciphertext and identity / AAD, alteration, state restoration then
  replay refused. An altered reception consumes a key: the future engine must
  cancel the writes and reload the group before retrying.
- Three devices, two of them belonging to the same test user; withdrawal of a leaf
  and impossibility of opening the new epoch with its previous state.
- New leaf without automatic access to the history; prepared commit
  kept after reload. The library still allows sending in the
  old epoch: the application policy must block these sends.

The test identities are uncertified BasicCredentials. The storage is
in memory, the test copies contain secrets and the reload is not
a disk restart. The delivery server and its confirmation are
simulated. These proofs validate neither recovery / archive, nor the mobile bridge,
nor the authentication of accounts, nor the security of the storage or of the application.
The native E2EE capabilities stay disabled.
