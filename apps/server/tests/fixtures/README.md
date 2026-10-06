# Synthetic SMTP test certificates

`mail-cert.pem` / `.der` and `mail-key.der` form a self-signed localhost identity,
generated solely for in-process tests. The private key is public test data and
must never identify a real service. Certificate SANs: localhost / 127.0.0.1;
validity: ten years from fixture generation (2026-10-01).

The production sender still checks trust and hostname. A configured private
CA can extend its trust roots; there is no bypass of verification. The tests
explicitly trust this synthetic certificate, then also test refusal without it.
