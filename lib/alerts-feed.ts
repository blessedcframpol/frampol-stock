import { DEFAULT_ORG_TIMEZONE, todayBusinessDate } from "@/lib/business-date.mjs"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  INTERNAL_HOLDERS,
  addCalendarDays,
  alertChipCounts,
  isDueSoon,
  isOverdue,
  sortReturnRows,
  type AlertCounts,
  type LowStockAlertRow,
  type ReturnAlertRow,
  type ReturnKind,
} from "@/lib/alerts"

export type AlertFeed = {
  today: string
  counts: AlertCounts
  overdue: ReturnAlertRow[]
  dueSoon: ReturnAlertRow[]
  lowStock: LowStockAlertRow[]
}

type FeedClient = ReturnType<typeof getSupabaseClient>

type ReturnDbRow = {
  id: string
  serial_number: string
  status: string
  assigned_to: string | null
  client: string | null
  return_date: string | null
  product_id: string
  product_lines: { product_name: string } | { product_name: string }[] | null
}

function holderOf(row: { assigned_to: string | null; client: string | null }): string {
  const assigned = (row.assigned_to ?? "").trim()
  if (assigned) return assigned
  const client = (row.client ?? "").trim()
  return client || "—"
}

function productOf(row: ReturnDbRow): string {
  const embedded = row.product_lines
  if (Array.isArray(embedded)) return embedded[0]?.product_name ?? "—"
  return embedded?.product_name ?? "—"
}

function kindOf(status: string): ReturnKind {
  return status === "POC" ? "POC" : "Rental"
}

async function exactCount(
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>
): Promise<number> {
  const { count, error } = await query
  if (error) throw new Error(error.message)
  return count ?? 0
}

function returnCount(
  supabase: FeedClient,
  status: "POC" | "Rented",
  today: string,
  windowEnd: string,
  bucket: "overdue" | "dueSoon"
) {
  let query = supabase
    .from("inventory_items")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null)
    .eq("status", status)
    .not("return_date", "is", null)
    .neq("return_date", "")
  query =
    bucket === "overdue"
      ? query.lt("return_date", today)
      : query.gte("return_date", today).lte("return_date", windowEnd)
  return exactCount(query)
}

function internalFilter(): string {
  return INTERNAL_HOLDERS.flatMap((name) => [
    `assigned_to.eq."${name}"`,
    `client.eq."${name}"`,
  ]).join(",")
}

export async function fetchAlertFeed(supabase: FeedClient = getSupabaseClient()): Promise<AlertFeed> {
  const settings = await supabase.from("app_settings").select("timezone").limit(1).maybeSingle()
  const timezone = settings.data?.timezone?.trim() || DEFAULT_ORG_TIMEZONE
  const today = todayBusinessDate(timezone)
  const windowEnd = addCalendarDays(today, 14)

  const [overduePoc, overdueRental, dueSoonPoc, dueSoonRental, lowStockCount, internal, returnRows, lowRows] =
    await Promise.all([
      returnCount(supabase, "POC", today, windowEnd, "overdue"),
      returnCount(supabase, "Rented", today, windowEnd, "overdue"),
      returnCount(supabase, "POC", today, windowEnd, "dueSoon"),
      returnCount(supabase, "Rented", today, windowEnd, "dueSoon"),
      exactCount(
        supabase
          .from("low_stock_products")
          .select("product_id", { count: "exact", head: true })
          .eq("is_low", true)
      ),
      exactCount(
        supabase
          .from("inventory_items")
          .select("id", { count: "exact", head: true })
          .is("deleted_at", null)
          .in("status", ["POC", "Rented"])
          .or(internalFilter())
      ),
      fetchAllPages((from, to) =>
        supabase
          .from("inventory_items")
          .select(
            "id, serial_number, status, assigned_to, client, return_date, product_id, product_lines(product_name)"
          )
          .is("deleted_at", null)
          .in("status", ["POC", "Rented"])
          .not("return_date", "is", null)
          .neq("return_date", "")
          .lte("return_date", windowEnd)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      fetchAllPages((from, to) =>
        supabase
          .from("low_stock_products")
          .select("product_id, product_name, vendor, in_stock_count, effective_reorder_level, is_low")
          .eq("is_low", true)
          .order("product_id", { ascending: true })
          .range(from, to)
      ),
    ])

  const mapped: ReturnAlertRow[] = (returnRows as ReturnDbRow[])
    .filter((row) => row.return_date && (isOverdue(row.return_date, today) || isDueSoon(row.return_date, today)))
    .map((row) => ({
      id: row.id,
      serialNumber: row.serial_number,
      productId: row.product_id,
      product: productOf(row),
      kind: kindOf(row.status),
      holder: holderOf(row),
      returnDate: row.return_date!.slice(0, 10),
    }))

  const overdue = sortReturnRows(
    mapped.filter((row) => isOverdue(row.returnDate, today)),
    today
  )
  const dueSoon = sortReturnRows(
    mapped.filter((row) => isDueSoon(row.returnDate, today)),
    today
  )
  const lowStock: LowStockAlertRow[] = lowRows
    .filter((row) => row.is_low)
    .map((row) => ({
      productId: row.product_id,
      product: row.product_name,
      vendor: row.vendor,
      inStock: row.in_stock_count,
      reorderAt: row.effective_reorder_level,
    }))
    .sort((a, b) => a.product.localeCompare(b.product))

  return {
    today,
    counts: alertChipCounts({
      overduePoc,
      overdueRental,
      dueSoonPoc,
      dueSoonRental,
      lowStock: lowStockCount,
      internal,
    }),
    overdue,
    dueSoon,
    lowStock,
  }
}
