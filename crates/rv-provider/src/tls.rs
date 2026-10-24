//! The process-wide rustls provider. Two providers end up compiled in (ring
//! through rv-client's reqwest 0.12, aws-lc-rs through ours), and rustls then
//! refuses to guess: a `wss://` socket opened without one panics its task, so
//! the live connection to a TLS server never comes up. reqwest builds its own
//! config; the websockets rely on this default.

/// Installs aws-lc-rs as the default once; harmless when one is already set.
pub fn ensure_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_provider_is_chosen() {
        super::ensure_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
