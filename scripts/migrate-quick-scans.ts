/**
 * One-time backfill: replay public.quick_scans into inventory_items + transactions.
 *
 * Prerequisites:
 *   - Migration 025_batch_reversals.sql applied (quick_scans still exists).
 *   - Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 *
 * Run: npm run migrate:quick-scans (loads .env.local via --env-file)
 * Or: tsx --env-file=.env.local scripts/migrate-quick-scans.ts
 *
 * Then apply 026_drop_quick_scans.sql when satisfied.
 *
 * Idempotency: skips rows whose transaction TXN-MIG-{quick_scan.id} already exists.
 */

import { createHash } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const supabase: SupabaseClient = createClient(url, serviceKey)

interface QScan {
  id: string
  serial_number: string
  scan_type: string
  scanned_at: string
  movement_type: string | null
  batch_id: string | null
  client_id: string | null
  client_name: string | null
  client_company: string | null
  client_email: string | null
  client_phone: string | null
  reversed_at: string | null
}

type InvRow = Record<string, unknown>

const DEFAULT_LOC = "Warehouse A"
const PTYPE_GENERAL = "ptype-general"

function itemTypeLabel(scanType: string): string {
  const t = scanType.trim()
  if (!t) return "General"
  return t.length > 120 ? t.slice(0, 120) : t
}

function clientLabel(row: QScan): string {
  const n = row.client_name?.trim()
  const c = row.client_company?.trim()
  if (n && c) return `${n} - ${c}`
  return c || n || "Internal"
}

function assignedLabel(row: QScan): string {
  return row.client_company?.trim() || row.client_name?.trim() || clientLabel(row)
}

function defaultRentalReturnDate(isoDate: string): string {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + 30)
  return d.toISOString().slice(0, 10)
}

async function main() {
  const { data: scans, error: scanErr } = await supabase.from("quick_scans").select("*").order("scanned_at", { ascending: true }).order("id", { ascending: true })

  if (scanErr) {
    console.error("Failed to read quick_scans:", scanErr.message)
    process.exit(1)
  }

  const list = (scans ?? []) as QScan[]
  console.log(`Found ${list.length} quick_scans rows`)

  const { data: invRows } = await supabase.from("inventory_items").select("*")
  const bySerial = new Map<string, InvRow>()
  for (const r of invRows ?? []) {
    const row = r as InvRow
    bySerial.set(String(row.serial_number).trim(), row)
  }

  let applied = 0
  let skippedReversed = 0
  let skippedIdempotent = 0

  for (const row of list) {
    if (row.reversed_at) {
      skippedReversed++
      continue
    }

    const serial = row.serial_number.trim()
    if (!serial) continue

    const txnId = `TXN-MIG-${row.id}`
    const { data: existingTxn } = await supabase.from("transactions").select("id").eq("id", txnId).maybeSingle()
    if (existingTxn) {
      skippedIdempotent++
      continue
    }

    const movement = row.movement_type?.trim() || "Inbound"
    const dateIso = new Date(row.scanned_at).toISOString()
    const dateOnly = dateIso.slice(0, 10)
    const batchId = row.batch_id?.trim() || row.id
    const scanName = row.scan_type.trim() || "Unknown"
    const itemType = itemTypeLabel(row.scan_type)

    let inv = bySerial.get(serial)
    const client = clientLabel(row)
    const assign = assignedLabel(row)

    const persistInv = async (patch: Record<string, unknown>) => {
      if (!inv) {
        const id = `INV-MIG-` + createHash("sha256").update(serial).digest("hex").slice(0, 28)
        const insert = {
          id,
          serial_number: serial,
          name: scanName,
          item_type: itemType,
          product_type_id: PTYPE_GENERAL,
          category: "General",
          status: patch.status ?? "In Stock",
          date_added: (patch.date_added as string) ?? dateOnly,
          location: patch.location ?? DEFAULT_LOC,
          client: patch.client ?? null,
          notes: null,
          assigned_to: patch.assigned_to ?? null,
          purchase_date: null,
          warranty_end_date: null,
          poc_out_date: patch.poc_out_date ?? null,
          return_date: patch.return_date ?? null,
          assignment_history: null,
          reserved_for_request_line_id: null,
          cloud_key: null,
        }
        const { error } = await supabase.from("inventory_items").insert(insert)
        if (error) throw new Error(`insert inventory ${serial}: ${error.message}`)
        inv = insert
        bySerial.set(serial, inv)
      } else {
        const next = { ...inv, ...patch }
        const { error } = await supabase
          .from("inventory_items")
          .update({
            serial_number: next.serial_number,
            item_type: next.item_type,
            product_type_id: next.product_type_id ?? PTYPE_GENERAL,
            name: next.name,
            category: next.category,
            status: next.status,
            date_added: next.date_added,
            location: next.location,
            client: next.client,
            notes: next.notes,
            assigned_to: next.assigned_to,
            purchase_date: next.purchase_date,
            warranty_end_date: next.warranty_end_date,
            poc_out_date: next.poc_out_date,
            return_date: next.return_date,
            assignment_history: next.assignment_history,
            reserved_for_request_line_id: next.reserved_for_request_line_id,
            cloud_key: next.cloud_key ?? null,
          })
          .eq("id", next.id as string)
        if (error) throw new Error(`update inventory ${serial}: ${error.message}`)
        inv = next
        bySerial.set(serial, inv)
      }
    }

    let txn: Record<string, unknown>

    switch (movement) {
      case "Inbound":
        await persistInv({
          status: "In Stock",
          location: DEFAULT_LOC,
          client: null,
          assigned_to: null,
          name: scanName,
          item_type: itemType,
          date_added: inv?.date_added ?? dateOnly,
          poc_out_date: null,
        })
        txn = {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: scanName,
          client: "Internal",
          date: dateIso,
          batch_id: batchId,
          client_id: null,
          invoice_number: null,
          notes: null,
          from_location: null,
          to_location: null,
          assigned_to: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      case "Sale":
        await persistInv({
          status: "Sold",
          location: "Delivered",
          client,
          assigned_to: assign,
          name: scanName,
          item_type: itemType,
          date_added: inv?.date_added ?? dateOnly,
        })
        txn = {
          id: txnId,
          type: "Sale",
          serial_number: serial,
          item_name: scanName,
          client,
          date: dateIso,
          client_id: row.client_id,
          batch_id: batchId,
          assigned_to: assign,
          invoice_number: null,
          notes: null,
          from_location: null,
          to_location: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      case "POC Out":
        await persistInv({
          status: "POC",
          location: "Client Site",
          client,
          assigned_to: assign,
          poc_out_date: dateOnly,
          name: scanName,
          item_type: itemType,
          date_added: inv?.date_added ?? dateOnly,
        })
        txn = {
          id: txnId,
          type: "POC Out",
          serial_number: serial,
          item_name: scanName,
          client,
          date: dateIso,
          client_id: row.client_id,
          batch_id: batchId,
          assigned_to: assign,
          invoice_number: null,
          notes: null,
          from_location: null,
          to_location: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      case "POC Return":
        await persistInv({
          status: "In Stock",
          location: DEFAULT_LOC,
          client: null,
          assigned_to: null,
          poc_out_date: null,
          return_date: null,
          name: scanName,
          item_type: itemType,
        })
        txn = {
          id: txnId,
          type: "POC Return",
          serial_number: serial,
          item_name: scanName,
          client: "Internal",
          date: dateIso,
          client_id: null,
          batch_id: batchId,
          invoice_number: null,
          notes: null,
          from_location: null,
          to_location: DEFAULT_LOC,
          assigned_to: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      case "Rental Return":
        await persistInv({
          status: "In Stock",
          location: DEFAULT_LOC,
          client: null,
          assigned_to: null,
          poc_out_date: null,
          return_date: null,
          name: scanName,
          item_type: itemType,
        })
        txn = {
          id: txnId,
          type: "Rental Return",
          serial_number: serial,
          item_name: scanName,
          client: "Internal",
          date: dateIso,
          client_id: null,
          batch_id: batchId,
          invoice_number: null,
          notes: null,
          from_location: null,
          to_location: DEFAULT_LOC,
          assigned_to: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      case "Rentals":
        await persistInv({
          status: "Rented",
          location: "Client Site",
          client,
          assigned_to: assign,
          poc_out_date: dateOnly,
          return_date: defaultRentalReturnDate(dateIso),
          name: scanName,
          item_type: itemType,
          date_added: inv?.date_added ?? dateOnly,
        })
        txn = {
          id: txnId,
          type: "Rentals",
          serial_number: serial,
          item_name: scanName,
          client,
          date: dateIso,
          client_id: row.client_id,
          batch_id: batchId,
          assigned_to: assign,
          invoice_number: null,
          notes: null,
          from_location: null,
          to_location: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      case "Transfer":
        await persistInv({
          location: DEFAULT_LOC,
          name: scanName,
          item_type: itemType,
        })
        txn = {
          id: txnId,
          type: "Transfer",
          serial_number: serial,
          item_name: scanName,
          client: "Internal",
          date: dateIso,
          client_id: null,
          batch_id: batchId,
          invoice_number: null,
          notes: null,
          from_location: DEFAULT_LOC,
          to_location: DEFAULT_LOC,
          assigned_to: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      case "Dispose":
        await persistInv({
          status: "Disposed",
          client: null,
          assigned_to: null,
          name: scanName,
          item_type: itemType,
        })
        txn = {
          id: txnId,
          type: "Dispose",
          serial_number: serial,
          item_name: scanName,
          client: "Internal",
          date: dateIso,
          client_id: null,
          batch_id: batchId,
          invoice_number: null,
          notes: "Migrated from quick_scans",
          from_location: null,
          to_location: null,
          assigned_to: null,
          disposal_reason: "Historical import",
          authorised_by: null,
          delivery_note_url: null,
        }
        break

      default:
        console.warn(`Unknown movement_type "${movement}" for ${row.id} — treating as Inbound`)
        await persistInv({
          status: "In Stock",
          location: DEFAULT_LOC,
          client: null,
          assigned_to: null,
          name: scanName,
          item_type: itemType,
          date_added: inv?.date_added ?? dateOnly,
          poc_out_date: null,
        })
        txn = {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: scanName,
          client: "Internal",
          date: dateIso,
          batch_id: batchId,
          client_id: null,
          invoice_number: null,
          notes: `Imported (was: ${movement})`,
          from_location: null,
          to_location: null,
          assigned_to: null,
          disposal_reason: null,
          authorised_by: null,
          delivery_note_url: null,
        }
    }

    const { error: txnErr } = await supabase.from("transactions").insert(txn)
    if (txnErr) throw new Error(`insert transaction ${txnId}: ${txnErr.message}`)

    applied++
    if (applied % 50 === 0) console.log(`… applied ${applied}`)
  }

  console.log("Done.", { applied, skippedReversed, skippedIdempotent })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
