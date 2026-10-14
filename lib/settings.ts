import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseClient } from "@/lib/supabase/client"
import type { Database } from "@/lib/supabase/database.types"
import { getLowStockAlerts as mapLowStockAlerts } from "@/lib/low-stock-helper.mjs"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"

export const SETTINGS_UPDATED_EVENT = "fram-stock-settings-updated"

export type AppSettings = {
  defaultReorderLevel: number
  lowStockEmailsEnabled: boolean
  lowStockRecipients: string[]
  stockRequestIssuerRecipientsDefault: string[]
  stockRequestIssuerRecipientsFortinet: string[]
  timezone: string
  updatedAt: string
  updatedBy: string | null
}

export type ProductLineSetting = {
  productId: string
  productName: string
  vendor: string
  reorderLevel: number | null
  isActive: boolean
}

export type LowStockProduct = {
  productId: string
  productName: string
  vendor: string
  inStockCount: number
  effectiveReorderLevel: number
  isLow: boolean
}

export type LowStockAlert = {
  productId: string
  groupName: string
  vendor: string
  inStock: number
  threshold: number
}

type SettingsClient = SupabaseClient<Database>

function client(provided?: SettingsClient): SettingsClient {
  return provided ?? getSupabaseClient()
}

function announceSettingsUpdate(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT))
  }
}

export async function fetchAppSettings(provided?: SettingsClient): Promise<AppSettings> {
  const { data, error } = await client(provided)
    .from("app_settings")
    .select(
      "default_reorder_level, low_stock_emails_enabled, low_stock_recipients, stock_request_issuer_recipients_default, stock_request_issuer_recipients_fortinet, timezone, updated_at, updated_by"
    )
    .eq("id", true)
    .single()
  if (error) throw error
  return {
    defaultReorderLevel: data.default_reorder_level,
    lowStockEmailsEnabled: data.low_stock_emails_enabled,
    lowStockRecipients: data.low_stock_recipients,
    stockRequestIssuerRecipientsDefault: data.stock_request_issuer_recipients_default,
    stockRequestIssuerRecipientsFortinet: data.stock_request_issuer_recipients_fortinet,
    timezone: data.timezone,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by,
  }
}

export async function updateAppSettings(
  updates: Partial<
    Pick<
      AppSettings,
      | "defaultReorderLevel"
      | "lowStockEmailsEnabled"
      | "lowStockRecipients"
      | "stockRequestIssuerRecipientsDefault"
      | "stockRequestIssuerRecipientsFortinet"
      | "timezone"
    >
  >,
  provided?: SettingsClient
): Promise<AppSettings> {
  const row: Database["public"]["Tables"]["app_settings"]["Update"] = {}
  if (updates.defaultReorderLevel !== undefined) {
    row.default_reorder_level = updates.defaultReorderLevel
  }
  if (updates.lowStockEmailsEnabled !== undefined) {
    row.low_stock_emails_enabled = updates.lowStockEmailsEnabled
  }
  if (updates.lowStockRecipients !== undefined) {
    row.low_stock_recipients = updates.lowStockRecipients
  }
  if (updates.stockRequestIssuerRecipientsDefault !== undefined) {
    row.stock_request_issuer_recipients_default = updates.stockRequestIssuerRecipientsDefault
  }
  if (updates.stockRequestIssuerRecipientsFortinet !== undefined) {
    row.stock_request_issuer_recipients_fortinet = updates.stockRequestIssuerRecipientsFortinet
  }
  if (updates.timezone !== undefined) row.timezone = updates.timezone

  const { data, error } = await client(provided)
    .from("app_settings")
    .update(row)
    .eq("id", true)
    .select(
      "default_reorder_level, low_stock_emails_enabled, low_stock_recipients, stock_request_issuer_recipients_default, stock_request_issuer_recipients_fortinet, timezone, updated_at, updated_by"
    )
    .single()
  if (error) throw error
  announceSettingsUpdate()
  return {
    defaultReorderLevel: data.default_reorder_level,
    lowStockEmailsEnabled: data.low_stock_emails_enabled,
    lowStockRecipients: data.low_stock_recipients,
    stockRequestIssuerRecipientsDefault: data.stock_request_issuer_recipients_default,
    stockRequestIssuerRecipientsFortinet: data.stock_request_issuer_recipients_fortinet,
    timezone: data.timezone,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by,
  }
}

export async function fetchProductLineSettings(
  provided?: SettingsClient
): Promise<ProductLineSetting[]> {
  const supabase = client(provided)
  const rows = await fetchAllPages((from, to) =>
    supabase
      .from("product_lines")
      .select("id, product_name, vendor, reorder_level, is_active")
      .order("product_name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  )
  return rows.map((row) => ({
    productId: row.id,
    productName: row.product_name,
    vendor: row.vendor,
    reorderLevel: row.reorder_level,
    isActive: row.is_active,
  }))
}

export async function updateProductLineSetting(
  productId: string,
  updates: Pick<ProductLineSetting, "reorderLevel" | "isActive">,
  provided?: SettingsClient
): Promise<void> {
  const { error } = await client(provided)
    .from("product_lines")
    .update({
      reorder_level: updates.reorderLevel,
      is_active: updates.isActive,
    })
    .eq("id", productId)
  if (error) throw error
  announceSettingsUpdate()
}

/** Admin archive (is_active=false). Blocked while kits are In Stock. Reason audited. */
export async function archiveProduct(
  productId: string,
  reason: string,
  provided?: SettingsClient
): Promise<void> {
  const { error } = await client(provided).rpc("archive_product", {
    p_product_id: productId,
    p_reason: reason,
  })
  if (error) throw error
  announceSettingsUpdate()
}

/** Admin restore archived product. Reason audited. */
export async function restoreProduct(
  productId: string,
  reason: string,
  provided?: SettingsClient
): Promise<void> {
  const { error } = await client(provided).rpc("restore_product", {
    p_product_id: productId,
    p_reason: reason,
  })
  if (error) throw error
  announceSettingsUpdate()
}

/** Admin delete only when nothing references the product. Reason audited. */
export async function deleteProduct(
  productId: string,
  reason: string,
  provided?: SettingsClient
): Promise<void> {
  const { error } = await client(provided).rpc("delete_product", {
    p_product_id: productId,
    p_reason: reason,
  })
  if (error) throw error
  announceSettingsUpdate()
}

export async function fetchLowStockProducts(
  provided?: SettingsClient
): Promise<LowStockProduct[]> {
  const supabase = client(provided)
  const rows = await fetchAllPages((from, to) =>
    supabase
      .from("low_stock_products")
      .select(
        "product_id, product_name, vendor, in_stock_count, effective_reorder_level, is_low"
      )
      .order("product_id", { ascending: true })
      .range(from, to)
  )
  return rows.map((row) => ({
    productId: row.product_id,
    productName: row.product_name,
    vendor: row.vendor,
    inStockCount: row.in_stock_count,
    effectiveReorderLevel: row.effective_reorder_level,
    isLow: row.is_low,
  }))
}

export function getLowStockAlerts(products: LowStockProduct[]): LowStockAlert[] {
  return mapLowStockAlerts(products)
}
