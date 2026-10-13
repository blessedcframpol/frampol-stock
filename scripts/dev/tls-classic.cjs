/**
 * Dev / verify preload only — never load from the production build.
 *
 * Node 25+ enables post-quantum X25519MLKEM768 in the TLS handshake. On this
 * network that triggers ERR_SSL_TLSV1_ALERT_DECODE_ERROR (and related
 * ERR_SSL_TLSV1_ALERT_DECRYPT_ERROR) against Supabase and other hosts.
 * Prefer classic ECDH curves for local `npm run dev` and `npm run verify:all`.
 */
require("tls").DEFAULT_ECDH_CURVE = "X25519:P-256:P-384"
