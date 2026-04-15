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
| **admin** | Full operational control + user/role management + batch reversal + inventory trash. |
| **sales** | Create/submit stock requests; view clients and inventory appropriate to their job. |
| **technicians** | Create requests; **fulfill** (assign hardware, move request through in_progress → serviced). |
| **accounts** | **Reports**; **billing/invoicing** on stock requests after serviced. |

### Where it is enforced

- **UI:** `lib/permissions.ts` — `canEditInventory`, `canFulfillStockRequests`, `canInvoiceStockRequests`, `canAccessReports`, `canReverseQuickScanBatches`, etc. Components hide or disable actions based on these.
- **Server / DB:** RLS on tables (e.g. `profiles`, `inventory_items`, `transactions`, `stock_requests`). The UI is not sufficient alone for security.

### Edge cases

- **New user after OAuth:** Profile row may exist with `role = null` or `active = false` → user lands on **`/pending-role`** until an admin sets role + active in **Settings → Users**.

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
- **Low stock alerts** — Number of **product groups** (by name/vendor grouping in alert logic) under reorder threshold. Uses `getReorderLevelForProduct` / overrides from **Settings**; values hydrate on client after mount to match `localStorage` reorder settings (avoids SSR/client mismatch).

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

- User authenticates via Supabase (method depends on project config: OAuth providers, magic link, etc.).

### Callback (`/auth/callback`)

- Completes OAuth session creation. Middleware/proxy avoids interfering with PKCE verifier cookies on this path.

### Auth provider (`lib/auth-context.tsx`)

- Subscribes to auth state; loads **`profiles`** row for signed-in user (`id`, `email`, `display_name`, `role`, `active`).
- Exposes `user`, `profile`, `role`, `refetch`, `signOut`.

### Pending role (`/pending-role`)

- **When:** Logged in but `hasAppAccess(profile)` is false (`!active` or `role == null`).
- **UX:** Explains **inactive** vs **no role**; offers refresh/poll so when an admin fixes the profile, the user can continue without re-login.
- **Why:** Self-service signup can create users before an admin assigns a role.

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

- **`getAlerts()`** on inventory store — pure function over current `inventory` + reorder settings.

### Tabs / categories

- **Low stock** — Groups **In Stock** items by product (and vendor where applicable) vs threshold; links or copy suggest going to Inventory / Movement.
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
- **Starlink rule:** Product names containing “starlink” (case-insensitive) require **all requested units** on that line to have assigned serials before **invoiced** is allowed (`lib/stock-request-rules.ts`). Prevents billing kits without traceable serials.

### Billing (`/requests/[id]/billing`)

- Accounts enters invoice metadata (number, dates, document URLs per your schema) and transitions to **invoiced**.

### Notifications

- Unread notifications for request events feed the **header inbox** (`fetchUnreadNotifications` / `markNotificationsRead`).

---

## 16. Reports (`/reports`)

### Purpose

High-level analytics: revenue, sales counts, top clients, charts.

### Current implementation note

- **`reports-content.tsx`** largely consumes **static/demo aggregates** from `lib/data.ts` (`monthlySales`, `clients`, etc.). It is useful for **UI demonstration**; for production you would point charts at Supabase views or API aggregates.

### Export

- **Export CSV** button is present in the UI; verify it exports live data if you extend the module.

---

## 17. Settings (`/settings`)

### Purpose

Per-user profile, local notification preferences, inventory thresholds, and **admin user management**.

### Profile tab

- Update **display name** (stored in `profiles`).

### Notifications tab

- **Low stock email** — Enable/disable and comma-separated recipient list stored in **`localStorage`** via `lib/settings.ts` (browser-only; not a server cron by itself).

### Inventory tab

- **Default reorder level** — Applies to any product without an override.
- **Per-product overrides** — Table of product names (from current inventory name set) with individual thresholds. Drives **low stock** alerts and dashboard stat.

### Users tab (admin)

- Lists **`profiles`**: email, display name, role, active.
- Change **role** (admin/sales/accounts/technicians) and **active** flag via **`/api/admin/profiles`**.
- New OAuth users appear here with **no role** until admin assigns one (see **Pending role** page).

### Theme

- Global theme control lives in the **shell** (not only Settings).

---

## 18. Product catalog (`product_lines`)

### Purpose

Normalize **product name + vendor** so every inventory row points at one catalog row (foreign key `product_id` in Supabase).

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
