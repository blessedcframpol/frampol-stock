# Fram Stock — detailed app features

This document describes **what each feature is for**, **how to use it**, **what the UI does**, and **how it ties to data and permissions**. For movement types and RMA mechanics, see [inventory-movements-and-rma.md](./inventory-movements-and-rma.md).

---

## 1. Architecture at a glance

### Purpose

Give developers a single mental model: where state lives, how writes happen, and how auth gates the app.

### How it works

- **Next.js App Router** (`app/`): each `page.tsx` wraps feature UI (often inside `DashboardShell`).
- **UI layer** (`components/*-content.tsx`, `components/quick-scan.tsx`, etc.): forms, tables, charts; they call hooks and the inventory store rather than embedding SQL.
- **Domain logic**
  - **`lib/supabase/movement-utils.ts`** — Pure function `computeMovementResult`: given current inventory + movement params, returns updated rows, new transaction rows, rejections. All stock **movement rules** should stay here (and in DB triggers for defense in depth).
  - **`lib/inventory-store.tsx`** — Holds `inventory` and `transactions` in React state; `applyMovement` runs `computeMovementResult` then persists to Supabase when a client exists; exposes undo, trash, refetch, alerts.
- **Supabase** (optional at build time): Postgres tables per `supabase/schema.sql` + migrations. **RLS** and policies control who can insert/update; UI permissions in `lib/permissions.ts` should align with those policies.
- **Seed / offline:** If Supabase is not used, initial data can come from `lib/data.ts` so the UI still runs for demos.

### Auth boundary

- **`proxy.ts`**: For most routes, unauthenticated users are redirected to `/login` with `redirectTo`. `/login` and `/auth/callback` stay reachable; callback is handled lightly so PKCE cookies are not stripped before token exchange.

---

## 2. Roles and permissions

### Purpose

Separate **who can change stock**, **who can fulfill requests**, **who can invoice**, and **who can administer users**.

### Roles

| Role | Typical use |
|------|-------------|
| **admin** | Full operational control + user/role management + batch reversal + inventory trash + stock movements. |
| **sales** | Create/submit stock requests; view clients and inventory (read). Create clients. No stock writes. |
| **technicians** | Create requests; **fulfill** (assign hardware); **record stock movements**; undo/reassign own ledger rows. |
| **accounts** | **Reports**; **billing/invoicing** on stock requests after serviced. Inventory/ledger read only. |

### Stock write matrix (UI + RLS, migration 047)

| Action | Who |
|--------|-----|
| **Stock movements** (Quick Scan, Inventory Movement) | admin + technicians (`canRecordStockMovement`) |
| **Per-transaction undo / reassign** | creator (technician who recorded it) or any admin (`canAmendTransaction`) |
| **Batch reversal** | admin only — enforced in the DB function body (`reverse_quick_scan_batch`), not only at the API route (`canReverseQuickScanBatches`) |
| **Inventory add / edit / trash** | admin only (`canEditInventory`) — deliberately stricter than RLS write policies on `inventory_items` |

`requireAdmin()` (`lib/require-admin.ts`) is **application-only** — no schema change. It provides the shared admin-auth preamble for GET `/api/admin/profiles` and PATCH `/api/admin/profiles/[id]`, including the `profiles.active` check. The former admin POST user-creation handler was removed when authentication became Microsoft-only. Covered by `scripts/verify-050-admin-auth.mjs`.

Migration **050 does not exist**. The later sequence is 047, 048, 049, 051, 052, 053. Numbers are ordered, not contiguous. The verify-050 script name is the admin-auth gate, not a missing SQL file.

### Serial-tracked products (`requires_serial`, migration 051)

`product_lines.requires_serial` is the DB gate for full serial assignment before a request can be marked **serviced**. There is **no UI** yet. Flag a new serial-tracked product with:

```sql
UPDATE public.product_lines SET requires_serial = true WHERE id = '<product_line_id>';
```

until a product-lines admin screen exists. 20 Starlink catalog rows were backfilled so this matches the previous `%starlink%` predicate (mechanism change, not gating). App gates (`lib/stock-request-rules.ts`) read `requires_serial` from the catalog join on the request fetch.

### Where it is enforced

- **UI:** `lib/permissions.ts` — `canRecordStockMovement`, `canAmendTransaction`, `canEditInventory`, `canFulfillStockRequests`, `canInvoiceStockRequests`, `canAccessReports`, `canReverseQuickScanBatches`, etc. Components hide or disable actions based on these.
- **Server / DB:** RLS on tables (e.g. `profiles`, `inventory_items`, `transactions`, `stock_requests`) and the admin guard inside `reverse_quick_scan_batch`. The UI is not sufficient alone for security.

### Edge cases

- **New user after OAuth:** Profile row may exist with `role = null` or `active = false` → user lands on **`/pending-role`** until an admin sets role + active in **User management**.
- **Orphan ledger rows** (`transactions.created_by` IS NULL): only admins can undo/reassign after 047.
---

## 3. Application shell and navigation

### Purpose

Consistent layout: sidebar, header, mobile drawer, global search, notifications, theme.

### Sidebar (`components/dashboard-shell.tsx`)

- **Main menu** items are filtered by role (e.g. **Reports** only for admin/accounts; **Requests** for all four roles).
- **Inventory** is expandable: sub-links to **Dispatched**, **Inventory movement**, **Stock take**, **Trash** (Trash sub-link only if `canEditInventory`).
- Active route highlighting uses `usePathname()`.

### Header

- **Global search input** — Delegates to `runSearch` + `SearchSuggestions` (inventory + clients; users from seed when present). Choosing a result navigates (e.g. `/inventory?serial=…`).
- **Theme** — Light / dark / system via `next-themes`.
- **Inbox** — `useInboxNotifications`: unread rows from Supabase stock-request notifications; mark read updates DB. Refetches on route change.
- **User menu** — Sign out, link to settings, avatar/initials.

### Mobile

- Sheet/drawer duplicates nav so small screens do not rely on the desktop sidebar.

---

## 4. Dashboard (`/`)

### Purpose

Operational snapshot: how much is sellable, what is out, whether reorder is needed, quick scanning, and recent activity.

### Stat cards (top row)

- **Total inventory** — Count of items with status **In Stock** (sellable pool). Not the same as “every row in DB.”
- **Items sold** — Count of **Sold** rows (historical footprint still in inventory table).
- **POC active** — Count **POC** (trial units at client site).
- **Low stock alerts** — Active product lines that have at least one non-deleted inventory row and whose live **In Stock** count is at or below the effective reorder threshold. Never-stocked catalogue lines are omitted; sold-out lines still alert. Dashboard, Alerts, navigation, and the header bell all read `low_stock_products`, the only low-stock definition.

### Quick Scan panel

- Full detail in **§6**; it is embedded here for speed of entry without leaving the dashboard.

### Stock by vendor (stacked bar)

- One bar per vendor key (`vendor` on item, or **General** if blank).
- Segments: In Stock, Sold, POC, Rented, Maintenance, **RMA hold** (see movement doc). Useful to see concentration (e.g. Starlink) and how much is tied up outside **In Stock**.

### Latest requests

- Pulls recent stock requests from the same source as the requests module; each row links to `/requests/[id]` for detail.

### Recent transactions

- Short ledger preview (types, serials, dates) so users see latest movements without opening **Transaction history**.

### Lower charts

- **Vendor distribution** — Another view of mix by vendor/category.
- **Monthly sales** — Trend chart; data source depends on wiring (may use demo/aggregated data).

---

## 5. Authentication and access gating

### Login (`/login`)

- The only sign-in method is Microsoft via the Supabase Azure provider. Email/password sign-in, self-service email sign-up, and password recovery are not exposed by the app.
- Supabase Auth sign-ups stay enabled so a first-time Microsoft user can create an auth identity and profile.

### Callback (`/auth/callback`)

- Completes OAuth session creation. Middleware/proxy avoids interfering with PKCE verifier cookies on this path.

### Auth provider (`lib/auth-context.tsx`)

- Subscribes to auth state; loads **`profiles`** row for signed-in user (`id`, `email`, `display_name`, `role`, `active`).
- Exposes `user`, `profile`, `role`, `refetch`, `signOut`.

### Session cookies (HTTP 431) — closed

Measured on production (`frampol-stock.vercel.app`, signed in): two `sb-<ref>-auth-token` chunks, 3216 B and 2442 B, ~5.7 KB total including `_vercel_*` cookies, against a 16 KB per-header cap. No orphan `.N` chunks, no duplicate scopes; `Secure` unset on both and no second scoped copy.

Chunking in `@supabase/ssr` **0.5.2** works; that version already emits leftover-chunk deletes. The JWT is small: **role** and **active** come from `profiles` via `get_my_role()`, not token claims. Azure `user_metadata` is under 700 B, no group claims.

431 never appears in `app_event_logs` because the platform rejects it before any app code runs, so there is no record of when it last occurred. Most likely a localhost artifact from repeated login cycles across dev-server restarts.

**Known, not fixed:** `lib/supabase/browser.ts` passes `secure` from `window.location.protocol` while `proxy.ts` and `lib/supabase/server.ts` pass no `cookieOptions`. Inconsistent, but not producing duplicate cookies in production. Do not change cookie attributes on a working auth flow. Revisit only if a 431 recurs in production.

### Pending role (`/pending-role`)

- **When:** Logged in but `hasAppAccess(profile)` is false (`!active` or `role == null`).
- **UX:** Explains **inactive** vs **no role**; offers refresh/poll so when an admin fixes the profile, the user can continue without re-login.
- **Why:** A first-time Microsoft sign-in creates a profile before an admin assigns a role.

---

## 6. Quick Scan (dashboard widget)

### Purpose

Record stock movements from the home page with minimal navigation: choose type, vendor, product, serials, submit.

### Movement type dropdown

- Every **`TransactionType`** the app supports for scanning: Inbound, Sale, POC Out/Return, Rentals/Rental Return, **Sale Return**, Transfer, Dispose.
- Changing type shows/hides **Receive location**, **Return location**, FortiGate cloud key block, and footer help text.

### Vendor and product

- **Vendor** is always visible; **product** options are **filtered to names that appear in inventory under that vendor** (normalized: empty vendor → General). This reduces wrong picks (e.g. Starlink vs Dell).
- Changing vendor clears the product if the current name does not exist for the new vendor (custom “new” names not yet in inventory are kept).

### Serials

- Comma- or newline-separated; duplicates in the list are deduplicated for submit; UI may warn about duplicates in list.

### Inbound

- Requires receive location; creates or updates rows per movement rules; passes **expected product and vendor** so mismatched serials are rejected.

### Return-like (POC Return, Rental Return, Sale Return)

- Requires **return / hold location** (internal locations in quick scan where applicable).
- **Sale Return** only accepts serials whose status is **Sold**; result is **RMA Hold** (see RMA doc).

### Outbound (Sale, POC Out, Rentals, Transfer, Dispose)

- Serials must exist in inventory first (unless you use the **missing serials** path to add stubs then continue).
- **FortiGate** product names require cloud keys count = unique serial count, same order.
- **Client modal** collects client (existing or new) and optional sites, return dates for POC/Rentals, optional admin sale date for Sale.
- **Vendor** at scan time is stored on **pending outbound** so the modal submit uses the same **expectedVendor** as the initial scan.

### Footer hints

- Short text per movement category (inbound vs returns vs outbound) so operators know prerequisites (e.g. serials already in stock for outbound).

---

## 7. Inventory (`/inventory`)

### Purpose

Browse and manage **sellable** stock (default), drill into product groups, add items, open movements, trash rows.

### Default dataset

- **`filterOnHandInventory`**: status **In Stock**, not soft-deleted. This is the pool for **sales**, **transfers**, **request fulfillment**, etc.

### Views and grouping

- Items grouped by **product name** (with representative vendor shown for the group).
- **List vs grid** toggles density.
- **Filters** (status, location, vendor, etc. as implemented on the page) narrow groups.
- **Search** on the page filters within loaded data.

### Selection and bulk actions

- Checkbox selection on rows enables **Record movement** for many serials at once with shared product context (dialog embed mode).

### Add inventory

- Admin (or role with `canEditInventory`) can add rows: serial, name, vendor, location, etc., creating **In Stock** lines (and product line linkage in Supabase when configured).

### Row actions (`inventory-item-actions.tsx`)

- **Record movement** — Opens dialog with that item (or selection).
- **Edit** — Update fields allowed by permissions.
- **Move to trash** — Soft delete (`deletedAt`); row leaves main lists and appears under **Trash**.

### Deep link

- **`?serial=`** query scrolls/highlights matching serial (used from search, dispatched, etc.).

### Inventory Trash (`/inventory/trash`)

- Lists soft-deleted items.
- **Restore** clears `deletedAt`.
- **Permanent delete** removes row (subject to DB constraints).
- **`INVENTORY_TRASH_RETENTION_DAYS`** documents suggested purge policy for automated cleanup (if you implement cron later).

---

## 8. Dispatched (`/inventory/dispatched`)

### Purpose

Answer: “What is **not** sitting in warehouse as sellable?” — sold, at client on POC/rental, disposed, or in maintenance.

### Inclusion rule

- **`isDispatchedStatus`** in `lib/inventory-visibility.ts`: Sold, POC, Rented, Disposed, Maintenance.
- **RMA Hold** is **intentionally excluded** — those units are often physically in warehouse pending vendor replacement; they appear on main inventory with an orange badge instead.

### Columns / behaviour

- Tries to show **last outbound-style movement** (Sale, POC Out, Rentals, Dispose) from transaction history for context and date.
- **Maintenance** may not have a single “outbound” type; movement type may show as empty or inferred.
- Links to **inventory** by serial for drill-down.

---

## 9. Inventory Movement (`/inventory/movement`)

### Purpose

Full-page counterpart to Quick Scan: same movement types with richer **transaction details** (invoice, notes, delivery note file, disposal authority, multiple client fields, transfer from/to).

### Transaction type grid

- Tiles from `TRANSACTION_TYPE_CHOICES` in `lib/stock-movement-form-logic.ts` — short label, icon, color, description tooltip.

### Scan items column

- **Vendor → Product name picker → Serial textarea** (same vendor-scoped options as Quick Scan).
- Duplicate/scan count feedback; clear serials.

### Transaction details card (context-sensitive)

- **Inbound** — Optional **delivery note** file upload (stored to Supabase storage, URL on transaction when saved); **receive location** (vendor moved to scan column; receive location remains here).
- **Sale / POC Out / Rentals / Transfer / Dispose** — **Client** select (existing, or “Add new client” with inline form: name, company, email, phone, sites). Invoice number required where business rules say so (e.g. Sale, Rentals). POC/Rentals optional return dates. **Sale** optional admin **ledger date**.
- **Transfer** — From and To location (must differ).
- **POC Return / Rental Return / Sale Return** — **Return to** or **hold** location; Sale Return shows helper text for RMA workflow.
- **Dispose** — Reason dropdown + **Authorised by** (required); cannot be undone via normal undo.

### Submit flow

- Validates required fields per type.
- May **insert client** first if “new client” was chosen.
- **Outbound with client modal:** If the flow requires second step (same as Quick Scan), opens modal; otherwise **`doSubmit`** calls **`applyMovement`** once.
- On success, clears form fields (non-embed); refetches ledger.

### Embed mode (Record movement dialog)

- **Fixed serials and product** from selected inventory rows; movement types **exclude Inbound**.
- **`expectedVendor`** from first selected row helps reject wrong-vendor serials if mixed selection slips through.

---

## 10. Stock take (`/inventory/stock-take`)

### Purpose

Reconcile **physical** serials scanned on the floor against the system for **In Stock** items: find unknown serials, missing units, and export evidence.

### Session persistence

- Typed/pasted serial list saved in **`sessionStorage`** (`fram-stock-take-scans`) so a refresh does not wipe work.

### Compare

- Builds sets: **matched** (in DB and in list), **not in system** (in list only), **not scanned** (In Stock in DB but not in list — potential shrinkage or mis-file).

### Export

- **CSV** with columns: result type, serial, name, status, location.

### Save snapshot (Supabase)

- When API is configured, completed take can POST to **`/api/stock-takes`** so auditors retain a point-in-time snapshot (`result_snapshot`).

### History

- **`/inventory/stock-take/history`** — List of saved takes with date/id.
- **`/inventory/stock-take/history/[id]`** — Read-only breakdown of that snapshot with status badges.

---

## 11. Transaction history (`/transaction-history`)

### Purpose

Audit **bulk operations** (batch_id) and individual lines; support **correction** via undo or admin batch reversal.

### Batch view

- Groups transactions sharing **`batch_id`** (generated per submit in `applyMovement` when not provided).
- Clicking a row opens a **batch detail** dialog with a summary built from **all lines** in the batch: client (with a link to the client record when every line shares the same `client_id`), **invoice** numbers for roles that can view financials, **delivery note** link, transfer **from/to** locations when uniform across the batch, **assignee**, **disposal** reason and authoriser for Dispose batches, and **notes** (distinct values combined when they differ). Below that, search serials within the batch and **copy all serials** to clipboard for spreadsheets.

### Per-transaction undo

- **`undoTransaction`** in store: looks up transaction type, applies **inverse patch** to inventory (`getRevertUpdatesForTransaction`), deletes transaction row. **Dispose** blocked.
- Limitation: inverse is **best-effort** from the transaction row (e.g. Sale Return undo restores Sold using Sale Return txn’s client fields, not necessarily the original Sale).

### Admin: reverse entire batch

- Only **`canReverseQuickScanBatches`** (admin).
- Only movement types listed in **`quick-scan-reversal-inventory.ts`** (e.g. Sale, POC Out, Rentals, Dispose, Transfer — not every type).
- Requires **reason** (minimum length) and **return location** for stock coming back.
- Writes **`batch_reversals`** audit row and calls API to delete matching transactions and revert inventory in one coordinated step.

---

## 12. Alerts (`/alerts`)

### Purpose

Proactive operations list: reorder, warranty, return discipline.

### Data source

- **Low stock** — `low_stock_products`. The app helper only maps rows the view already classified; it does not recount stock or reapply a threshold.
- **Other alerts** — `getAlerts()` on the inventory store, for warranty and return dates only.

### Tabs / categories

- **Low stock** — One row per product from `low_stock_products` where `is_low` is true.
- **Warranty** — Items with **warranty end** in upcoming window; excludes statuses that should not alert (per store logic).
- **Returns** — **POC** and **Rented** items: **overdue** (past `returnDate`) and **approaching** (within N days). Uses `pocOutDate` / `returnDate` fields.

### Sidebar badge

- Total alert count (or subset — should match what users see as “action needed”) on **Alerts** nav item.

---

## 13. Search (`/search`)

### Purpose

One place to type a string and see **inventory hits**, **client hits**, and **directory users** (when seed users exist).

### Inventory scope

- **`searchInventory`** only searches **`filterOnHandInventory`** — **In Stock** only. Sold/POC/etc. are not in global search results by design (use Dispatched or transaction history for those).

### Client scope

- Name, company, email, phone substring match.

### Header search vs page

- Header uses same **`runSearch`** with suggestions; `/search` page may show fuller grouped results and deep links.

---

## 14. Clients (`/clients`, `/clients/[id]`)

### Purpose

CRM-light directory: who you sell/rent/POC to; sites for delivery documentation.

### List page

- Table/cards of clients from **`useClients`** / Supabase `clients` table.
- Add client with sites (addresses, optional site names).

### Detail page (`/clients/[id]`)

- Edit fields, manage multiple sites.
- May show related context (inventory assigned to client where wired).

### Integration

- **Inventory Movement** and **Quick Scan** client modals use the same client list and **`insertClient`** for on-the-fly creation.

---

## 15. Stock requests (`/requests`)

### Purpose

Sales-driven workflow: quote → submit → technician fulfills with real serials → accounts invoices. Bridges **inventory reservations** and **billing**.

### List (`/requests`)

- Filter/sort by status; create new from **`/requests/new`**.

### Detail (`/requests/[id]`)

- Shows header status badge, lines (product name, qty), availability hints, assigned serial counts.
- Actions depend on **status** and **role**:
  - **Draft** — Owner can edit (**`/edit`**), submit, cancel.
  - **Submitted** — Fulfillers can **start work** (→ in_progress), assign stock.
  - **In progress** — Continue fulfillment until all lines satisfied → **serviced**.
  - **Serviced** — Accounts opens **billing** to invoice → **invoiced**.
  - **Cancelled** — Read-only terminal state.

### Quotation

- Upload quotation document (URL stored on request); used for sales traceability.

### Fulfill (`/requests/[id]/fulfill`)

- Map **In Stock** inventory items to **request lines**; may set **`reservedForRequestLineId`** on items in DB.
- **Serial rule:** Catalog rows with `product_lines.requires_serial` require **all requested units** on that line to have assigned serials before **serviced** (051/052 trigger) and before **invoiced** (`lib/stock-request-rules.ts`). There is no UI to toggle `requires_serial` yet — see the stock-write matrix note.

### Billing (`/requests/[id]/billing`)

- Accounts enters invoice metadata (number, dates, document URLs per your schema) and transitions to **invoiced**.

### Notifications

- Unread notifications for request events feed the **header inbox** (`fetchUnreadNotifications` / `markNotificationsRead`).

---

## 16. Reports (`/reports`)

### Purpose

Placeholder until live reporting ships (stock cover, POC pipeline, overdue rentals). Admin and accounts can open `/reports`; there are no charts, numbers, or export.

### Current implementation note

- **`reports-content.tsx`** is a static “in development” card. It does not read mock aggregates or live queries.

---

## 17. Settings (`/settings`)

### Purpose

Per-user profile, database-backed low-stock settings, inventory thresholds, and **admin user management**.

### Profile tab

- Update **display name** (stored in `profiles`).

### Email alerts tab

- **Low stock email** — Database-backed enable flag and recipient list in the singleton `app_settings` row. No sender exists yet, so the UI states that emails are not being sent.

### Reorder levels tab

- **Default reorder level** — Applies to any product without an override.
- **Per-product settings** — Admin-editable `product_lines.reorder_level` and `is_active`, with current in-stock count. Blank thresholds use the default; inactive products are excluded from alerts.
- Sales, accounts, and technicians retain Settings access but see reorder and email settings read-only. Viewer access remains blocked, matching existing Settings rules.

### User management (`/users`, admin)

- Lists **`profiles`**: name, email, role, active status, joined date.
- Search and filter by role / status; edit name, role, and active flag via **`PATCH /api/admin/profiles/[id]`**.
- People appear after their first Microsoft sign-in. New users have **no role** until an admin assigns one (see **Pending role** page).
- Settings → Users links admins to this page.

### Theme

- Global theme control lives in the **shell** (not only Settings).

---

## 18. Product catalog (`product_lines`)

### Purpose

Normalize **product name + vendor** so every inventory row and stock-request line points at one catalog row (foreign key `product_id` in Supabase). `stock_request_lines.product_name` is deprecated display text.

### Behaviour

- **`ensureProductLine`** RPC or client helper creates or resolves a line when names are added (movements, reassign, etc.).
- Migrations (e.g. **032**) define uniqueness (e.g. normalized name per vendor) and helper functions.

### Operator impact

- Users still pick **display names** in UI; catalog stays consistent under the hood.

---

## 19. HTTP API routes (server)

### Purpose

Server-side operations that need service role, batching, or audit tables the browser should not write directly.

| Area | Routes | Typical use |
|------|--------|----------------|
| Quick scan persistence | `/api/quick-scan`, `/api/quick-scan/[id]`, `/api/quick-scan/reverse` | Legacy/alternate persistence paths for scan batches; reversal helpers. |
| Transaction batches | `/api/transaction-batches` | List batches; support **admin reversal** workflow. |
| Stock takes | `/api/stock-takes`, `/api/stock-takes/[id]` | Save and retrieve take snapshots. |
| Admin | `/api/admin/profiles`, `/api/admin/profiles/[id]` | Role/active updates for profiles. |

**Source of truth for request/response shapes:** each `app/api/**/route.ts` file.

---

## 20. FortiGate cloud keys

### Purpose

Certain Fortinet/FortiGate products require a **cloud key** per unit when moving out on Sale, POC Out, Rentals, Transfer, or Dispose — aligned **in order** with the serial list.

### Detection

- **`lib/fortigate.ts`** — `isFortigateProductName`, parsing serial lists vs key lists.

### UX

- **Quick Scan** and **Inventory Movement** show a textarea for keys when product is FortiGate and movement is outbound-like; submit blocked until counts match.

---

## 21. Related documentation

- **[inventory-movements-and-rma.md](./inventory-movements-and-rma.md)** — Status and transaction type reference, **Sale Return** / **RMA Hold**, DB transition trigger, undo nuances.
- **[README.md](./README.md)** — Index of docs in this folder.

---

## 22. Contributor checklist (new status or movement)

When adding a **new movement type** or **status**, update in lockstep:

1. `lib/data.ts` types  
2. `lib/supabase/movement-utils.ts` (`validateMovementForItem`, `computeMovementResult`)  
3. New Supabase migration: `inventory_items` status CHECK, `transactions` type CHECK, **`inventory_items_guard_status_transition`**  
4. UI: Quick Scan options, `TRANSACTION_TYPE_CHOICES`, badges/charts `Record<ItemStatus, …>`, any filters (Dispatched, search, stock take)  
5. `getRevertUpdatesForTransaction` if **undo** should work  
6. **inventory-movements-and-rma.md** and this file  
