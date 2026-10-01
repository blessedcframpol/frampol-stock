import { fetchAllPages } from "@/lib/supabase/postgrest-page"
import { getSupabaseClient } from "@/lib/supabase/client"
import type { HeldUnit } from "@/lib/clients-directory"

type HoldingRow = {
  id: string
  serial_number: string
  status: string
  assigned_to: string | null
  client: string | null
  poc_out_date: string | null
  return_date: string | null
  product_lines: { product_name: string } | { product_name: string }[] | null
}

function productOf(row: HoldingRow): string {
  const embedded = row.product_lines
  if (Array.isArray(embedded)) return embedded[0]?.product_name ?? "—"
  return embedded?.product_name ?? "—"
}

function holderOf(row: HoldingRow): string {
  const assigned = (row.assigned_to ?? "").trim()
  if (assigned) return assigned
  return (row.client ?? "").trim()
}

/** Live POC and rental units. Same holder rule as Alerts. */
export async function fetchHeldUnits(): Promise<HeldUnit[]> {
  const supabase = getSupabaseClient()
  const rows = await fetchAllPages<HoldingRow>((from, to) =>
    supabase
      .from("inventory_items")
      .select("id, serial_number, status, assigned_to, client, poc_out_date, return_date, product_lines(product_name)")
      .is("deleted_at", null)
      .in("status", ["POC", "Rented"])
      .order("id", { ascending: true })
      .range(from, to),
  )
  return rows.map((row) => ({
    id: row.id,
    serialNumber: row.serial_number,
    product: productOf(row),
    kind: row.status === "POC" ? "POC" : "Rental",
    holder: holderOf(row),
    dateOut: row.poc_out_date,
    returnDate: row.return_date,
  }))
}
