# Production migration alias map

Maps **repo** `supabase/migrations/*.sql` files to rows in production
`supabase_migrations.schema_migrations` when the **version** strings differ
(dashboard apply timestamps, renames, or split applies).

Last reconciled: MIG2b (2026-11-13) on project `iysjspjsuuunpjhpwlei`.

## Coverage check

| Metric | Count |
|---|---|
| Repo migration files (non-`.DRAFT`) | **125** |
| Exact version match in prod | **97** |
| Aliased (name / rename / split) | **28** |
| Repo gaps (unexplained) | **0** |
| Prod rows | **131** |

`97 + 28 = 125` — every repo file is recorded or aliased. Prod has more rows than
the repo because of duplicate dashboard applies and split applies (one repo file
→ multiple prod versions).

## How versions are matched

1. **Exact:** `schema_migrations.version` equals the filename prefix  
   (`014`, `055b`, `20261113100000`, …).
2. **Aliased:** same logical name after stripping a leading `NNN_` / `NNNb_` from
   the recorded `name`, or via the rename/split table below.
3. Bookkeeping-only inserts (MIG1 / MIG2b) use the **repo** version string and do
   not re-run SQL.

## Alias table (prod timestamp ↔ repo file)

| Repo file | Repo version | Prod version(s) | Prod name(s) |
|---|---|---|---|
| `040_dedupe_and_unique_serial.sql` | `040` | `20260602081610` | `dedupe_and_unique_serial` |
| `041_apply_stock_movement_serial_guard.sql` | `041` | `20260602081654` | `apply_stock_movement_serial_guard` |
| `048_transactions_date_integrity.sql` | `048` | `20260727092212` | `transactions_date_integrity` |
| `054_request_hygiene_and_profile_access_audit.sql` | `054` | `20260917000054` | `054_request_hygiene_and_profile_access_audit` |
| `055_lock_down_uploads_storage.sql` | `055` | `20260917000055`, `20260917102200` | `055_lock_down_uploads_storage` (applied twice) |
| `055b_fix_uploads_storage_policies.sql` | `055b` | `20260917000155`, `20260917104054` | `055b_fix_uploads_storage_policies` (twice) |
| `056_grant_get_my_role_to_storage_admin.sql` | `056` | `20260917000056`, `20260917102732` | `056_grant_get_my_role_to_storage_admin` (twice) |
| `057_profile_and_auth_lockdown.sql` | `057` | `20260917000057` | `057_profile_and_auth_lockdown` |
| `058_add_viewer_role.sql` | `058` | `20260917000058` | `058_add_viewer_role` |
| `059_viewer_role_policies.sql` | `059` | `20260917000059` | `059_viewer_role_policies` |
| `060_settings_db.sql` | `060` | `20260917000060` | `060_settings_db` |
| `060b_scope_low_stock_and_requires_serial.sql` | `060b` | `20260917000160` | `060b_scope_low_stock_and_requires_serial` |
| `061_transaction_business_dates.sql` | `061` | `20260929000061` | `061_transaction_business_dates` |
| `062_product_lines_update_denied.sql` | `062` | `20261001045444` | `product_lines_update_denied` |
| `063_transaction_batch_page.sql` | `063` | `20261001065018` | `transaction_batch_page` |
| `064_ledger_page_filters.sql` | `064` | `20261001071612` | `ledger_page_filters` |
| `20261001074347_dispatched_batch_groups.sql` | `20261001074347` | `20261001074721` | `dispatched_batch_groups` |
| `20261001080910_drawer_recorded_by.sql` | `20261001080910` | `20261001081154` | `drawer_recorded_by` |
| `20261011083518_rq2b_request_numbers_reminder.sql` | `20261011083518` | `20261011083951` | `rq2b_request_numbers_reminder` |
| `20261011102829_rq2c_yearly_request_numbers.sql` | `20261011102829` | `20261011103118` | `rq2c_yearly_request_numbers` |
| `20261011183846_lg1_set_user_access.sql` | `20261011183846` | `20261011185533` | `lg1_set_user_access` |
| `20261011184602_lg1_pending_role_notify.sql` | `20261011184602` | `20261011185207` | `lg1_pending_role_notify` |
| `20261012123409_rh1_stock_availability.sql` | `20261012123409` | `20261012123916` | `rh1_stock_availability` |
| `20261012140354_hf1_requester_atlas_catalogue.sql` | `20261012140354` | `20261012142042` | `hf1_requester_atlas_catalogue` |
| `20261012175928_mv1_archive_products_movement.sql` | `20261012175928` | `20261012181559`, `20261012181757` | `mv1_archive_products_movement`, `mv1_archive_restore_delete_rpcs` (split) |
| `20261013071253_mv1b_archive_poc_rental_delete.sql` | `20261013071253` | `20261013071814` | `mv1b_archive_poc_rental_delete` |
| `20261013072919_rq7_batch_request_context.sql` | `20261013072919` | `20261013073835`, `20261013073948` | `rq7_batch_request_context`, `rq7_batch_request_page_fns` (split) |
| `20261013081238_rq7b_batch_drawer_timeline.sql` | `20261013081238` | `20261013081744` | `rq7b_batch_drawer_timeline_v3` (rename) |

## Rename / split name aliases

When matching by name, treat these prod `name` values as the same logical migration
as the repo stem:

| Prod recorded name | Repo logical name |
|---|---|
| `rq7b_batch_drawer_timeline_v3` | `rq7b_batch_drawer_timeline` |
| `mv1_archive_restore_delete_rpcs` | `mv1_archive_products_movement` |
| `rq7_batch_request_page_fns` | `rq7_batch_request_context` |

## Duplicate prod rows (same logical migration, extra version)

These are **not** repo gaps. Prod was applied more than once (or under two stamps):

| Logical name | Prod versions |
|---|---|
| `055_lock_down_uploads_storage` | `20260917000055`, `20260917102200` |
| `056_grant_get_my_role_to_storage_admin` | `20260917000056`, `20260917102732` |
| `055b_fix_uploads_storage_policies` | `20260917000155`, `20260917104054` |
| `poc_sale_and_movement_transitions` | `20261001092134` (matches repo file), `20261001092850` (extra) |

## MIG2b bookkeeping (repo version rows inserted without re-running SQL)

These thirteen were proven applied/superseded in MIG2 and recorded under the
**repo** version string:

`017`, `019`, `020`, `029`, `030`, `031`, `032`, `046`, `049`, `051`, `052`,
`20261009140000` (RQ1), `20261011122815` (AU1).
