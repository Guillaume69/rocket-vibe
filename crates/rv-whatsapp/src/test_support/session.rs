use std::sync::Arc;

use crate::Client;
use wacore::libsignal::protocol::{
    KeyPair, PreKeyBundle, SignalProtocolError, UsePQRatchet, process_prekey_bundle,
};
use wacore::types::jid::JidExt;
use wacore_binary::Jid;

pub(crate) async fn seed_peer_session(client: &Arc<Client>, peer: &Jid) -> anyhow::Result<()> {
    let bundle = tokio::task::spawn_blocking(|| -> Result<PreKeyBundle, SignalProtocolError> {
        let mut rng = rand::make_rng::<rand::rngs::StdRng>();
        let receiver = KeyPair::generate(&mut rng);
        let spk = KeyPair::generate(&mut rng);
        let opk = KeyPair::generate(&mut rng);
        let signature = receiver.private.sign(&spk.public.serialize(), &mut rng);
        wacore::libsignal::protocol::prekey_bundle(
            1,
            Some((1u32.into(), opk.public)),
            1u32.into(),
            spk.public,
            signature,
            receiver.public,
        )
    })
    .await??;
    let mut adapter = client.signal_adapter();
    let mut rng = rand::make_rng::<rand::rngs::StdRng>();
    process_prekey_bundle(
        &peer.to_protocol_address(),
        &mut adapter.session_store,
        &mut adapter.identity_store,
        &bundle,
        &mut rng,
        UsePQRatchet::No,
    )
    .await?;
    Ok(())
}
