# Archived verify scripts

These scripts were retired by **T3c**. Their invariants are covered by:

- `scripts/verify-schema-rules.mjs` — catalog / constraint / RLS / trigger / DEFINER / bucket checks (harness, read-only)
- `scripts/probe-production-http.mjs` — refusal-only HTTP/Storage/RPC probes (no writes)
- Harness behavioral scripts (`verify-065`…`079`, movement, parity) for runtime flows

Do not run archived scripts against production. They still contain commit-and-cleanup patterns blocked by A1 / `prepareVerifyEnv`.

| Archived script | Replaced by |
|-----------------|-------------|
| `verify-047-stock-write-grants.mjs` | schema-rules: `rls_enabled_all_tables`, viewer SELECT policies; write-grant behavior remains in harness movement/parity scripts |
| `verify-051-product-fk.mjs` | schema-rules: `uniq_inventory_items_serial_live`, `anon_execute_none`; `product_id` NOT NULL covered by harness `verify-transition-parity` |
| `verify-054-request-hygiene.mjs` | schema-rules: audit triggers / RLS; request hygiene behavior not re-probed (catalog) |
| `verify-055-uploads-storage.mjs` | schema-rules: `storage_bucket_private`, `storage_no_anon_policies`; probe: `public_storage_rejected` |
| `verify-057-profile-lockdown.mjs` | schema-rules: RLS + audit triggers |
| `verify-059-viewer-role.mjs` | schema-rules: viewer SELECT / no write policies; probe: unauthenticated admin/write API 401/403 |
| `verify-061-transaction-dates.mjs` | schema-rules: `transactions_date_iso_utc`, `midnight_enforced` |
| `verify-066-revoke-anon-execute.mjs` | schema-rules: `anon_execute_none`; probe: `anon_rpc_denied`, `anon_csdc_denied` |

Truncation guard: these are **git mv** renames into this folder (content preserved), so the >80% line-loss check stays quiet.
