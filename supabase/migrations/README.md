# Database migrations

Run these in **Supabase → SQL Editor → New query**, then Run.

- **`000_apply_all_optional_columns.sql`** – Use this on an **existing** database to add any missing columns (e.g. `inventory_items.vendor`, `quick_scans.movement_type`). Safe to run more than once.
- **`001_add_quick_scan_movement_type.sql`** – Adds only `quick_scans.movement_type` if missing. Use if you only need the Quick Scan movement type change.

If you are creating the database from scratch, use the main **`schema.sql`** in the parent folder instead; it already includes these columns.
