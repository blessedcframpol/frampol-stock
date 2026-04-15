# Inventory movements and RMA (faulty sold returns)

> **See also:** [App features overview](./app-features.md) for the full product map.

This document describes how **stock statuses**, **transaction types**, and the **customer return / vendor replacement** flow work in Fram Stock. It complements the code in `lib/supabase/movement-utils.ts` (validation and state updates) and Supabase constraints in `supabase/migrations/028_inventory_status_transition_guard.sql` plus `033_sale_return_rma_hold.sql`.

## Statuses (`ItemStatus`)

| Status | Meaning |
|--------|--------|
| **In Stock** | Available in warehouse (normal sellable/transferable stock). |
| **Sold** | Sold to a customer; typically at **Delivered** with client/assignee set. |
| **POC** | Out on proof-of-concept at client site. |
| **Rented** | Out on rental at client site. |
| **Maintenance** | Internal repair/service; not treated as sellable without a further movement. |
| **RMA Hold** | Faulty unit returned after a **sale**; held while waiting on vendor (e.g. Starlink) replacement or disposal. Not sellable. |
| **Pending Inspection** | Kit received via **Decommissioned** (or unknown-serial intake); not sellable until **Inspection Pass** or **Inspection Fail**. |
| **Disposed** | Written off; end of life for that serial in normal operations. |

**Dispatched** (conceptually): items that are **not** available as normal warehouse stock include Sold, POC, Rented, Maintenance, and Disposed. **RMA Hold** is *not* grouped as “dispatched to client”; it appears on the main inventory list with an orange **RMA Hold** badge so you can see kits physically on hand but not for sale.

## Transaction types (`TransactionType`)

Each successful movement appends one **transaction** row per serial (audit trail). Main types:

- **Inbound** — New or existing serial received; creates rows or sets **In Stock** (see movement rules for existing statuses).
- **Sale**, **POC Out**, **Rentals** — Move **In Stock** → outbound statuses.
- **POC Return** / **Rental Return** — Bring serials back from POC / Rented to **In Stock** at a chosen location.
- **Sale Return** — **Sold** → **RMA Hold** at a chosen **hold location** (warehouse/service). Use for faulty kits the customer brings back while you arrange a vendor replacement.
- **Transfer** — Change location; allowed for **In Stock**, **Maintenance**, and **RMA Hold** (status unchanged).
- **Dispose** — Allowed from **In Stock**, **Maintenance**, **RMA Hold**, or **Pending Inspection** → **Disposed**.
- **Decommissioned** — **POC**, **Rented**, or **Sold** (or unknown serial with product defaults) → **Pending Inspection** at a hold/receive location. Use when equipment returns from site for inspection (not the same as **Dispose**). Optional **metadata** on the transaction stores reason, dates, document URL.
- **Inspection Pass** / **Inspection Fail** — From **Pending Inspection** only. Pass → **In Stock**; fail → **RMA Hold**. Optionally creates a **`kit_inspections`** row (inspector, outcome, notes).
- **Remediation Loaner Issue** — **In Stock** → **Sold** at **Delivered** (like a sale) with **metadata** linking a **remediation case**; updates the case with the loaner serial.

Validation and transitions are implemented in `validateMovementForItem` and `computeMovementResult` in `lib/supabase/movement-utils.ts`.

### Decommissioned vs Sale Return vs Dispose

| | **Decommissioned** | **Sale Return** | **Dispose** |
|---|-------------------|-----------------|-------------|
| **Use for** | Kits returning from POC/rental/sale for inspection | Faulty **sold** unit into RMA hold | Write-off / scrap |
| **Resulting status** | **Pending Inspection** | **RMA Hold** | **Disposed** |
| **Undo** | Not supported from UI | Supported (with caveats) | Not supported |

### Remediation (provider RMA)

- **Remediation** page (`/inventory/remediation`): create a case for a **Starlink** faulty unit on **RMA Hold**, then use **Inventory movement → Rem. loaner** with the **case UUID** to issue a working unit from stock (`Remediation Loaner Issue`). The case tracks status, tracking ref, dates, and provider replacement serial when recorded.
- Migrations: **`034_decommissioned_pending_inspection.sql`**, **`035_kit_inspections.sql`**, **`036_remediation.sql`**.

### Reporting / export

- Filter **`transactions`** by **`type`** (e.g. `Decommissioned`, `Inspection Pass`) and/or **`metadata`** JSON in Supabase SQL or the dashboard.
- **`created_by`** on **`transactions`** records the authenticated user when available.

## RMA / Starlink-style replacement workflow (recommended)

1. **Customer returns a faulty sold kit**  
   Record **Sale Return** (Inventory Movement page or Quick Scan).  
   - Serial must still be **Sold**.  
   - Pick **hold location** (where the faulty unit is stored).  
   - Optional: put vendor case / RMA ID in **Notes**.

2. **Status becomes RMA Hold**  
   Client/assignee fields on the item are cleared on the row (the **transaction** still records who/what was used at submit time for audit).

3. **Vendor sends a replacement (new serial)**  
   Record **Inbound** for the **new** serial as usual (same product/vendor as appropriate). That unit is **In Stock** and can be **Sale** (or other outbound) to the customer.

4. **Faulty serial when you are done with it**  
   When the unit is scrapped, returned to vendor with no further tracking, or otherwise closed out: record **Dispose** on that serial (from **RMA Hold**). Use disposal reason/notes as needed.

5. **Optional: same serial “repaired” back to stock**  
   If you ever bring the **same** serial back to sellable condition without a new inbound row, **Inbound** is allowed from **RMA Hold** (same as **Maintenance**) and sets the row to **In Stock**. This is uncommon for true RMA swaps; prefer a new serial + Dispose on the old one when possible.

## Undo

- Undoing a **Sale Return** transaction (where supported in the UI) attempts to restore **Sold** at **Delivered** and re-apply **client** / **assignedTo** from the **Sale Return** transaction row (not from the earlier Sale row). If you need a perfect reinstatement of the original sale metadata, prefer careful notes or avoid undo and correct with a follow-up movement after discussing with your team.

- **Dispose** cannot be undone from the standard undo action.

- **Decommissioned**, **Inspection Pass**, **Inspection Fail**, and **Remediation Loaner Issue** cannot be undone from the standard undo action (use a corrective movement after team agreement).

## Database

- `inventory_items.status` and `transactions.type` are constrained with `CHECK` constraints; see `supabase/schema.sql` and migrations **033**, **034**, **035**, **036**.
- Trigger `inventory_items_guard_status_transition` allows only defined status edges, including:
  - `Sold` → `RMA Hold` (Sale Return)
  - `RMA Hold` → `In Stock` | `Disposed` | `Sold` (the last is for undo of Sale Return)
  - `POC` / `Rented` / `Sold` → `Pending Inspection` (Decommissioned)
  - `Pending Inspection` → `In Stock` | `RMA Hold` | `Disposed`

Apply migrations in order on production (including **033** after **028**, then **034**–**036**).

## UI surfaces

- **Inventory Movement** — Full form; **Sale Return** is a transaction type tile with hold-location field and short inline help.
- **Quick Scan** — **Sale Return** in the movement dropdown; same rules as other return types (return/hold location, serials must exist and be **Sold**).
- **Badges** — **RMA Hold** styling is consistent across inventory, search, stock take views, and the vendor chart (**RMA hold** segment).

For product-specific rules (e.g. Starlink), see `lib/stock-request-rules.ts` and any future RMA-specific helpers; the movement layer is vendor-agnostic.
