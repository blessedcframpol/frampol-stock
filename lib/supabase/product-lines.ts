import type { AppSupabaseClient } from "./app-client"

type SB = AppSupabaseClient

const VENDOR_CONFLICT_RE =
  /ensure_product_line:\s*product "([^"]+)" already exists under vendor "([^"]+)"/i

/** User-facing copy when ensure_product_line raises a vendor conflict. */
export function productLineVendorConflictMessage(error: unknown): string | null {
  const raw =
    error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string"
      ? (error as { message: string }).message
      : typeof error === "string"
        ? error
        : ""
  const m = raw.match(VENDOR_CONFLICT_RE)
  if (!m) return null
  return `Product "${m[1]}" already exists in the catalog (${m[2]}). Choose it from the list instead of adding it as new.`
}

/** Resolves or creates a product_lines row; matches migration normalization (empty vendor → General). */
export async function ensureProductLine(sb: SB, productName: string, vendor?: string | null): Promise<string> {
  const { data, error } = await sb.rpc("ensure_product_line", {
    p_product_name: productName,
    p_vendor: vendor ?? "",
  })
  if (error) {
    const friendly = productLineVendorConflictMessage(error)
    if (friendly) throw new Error(friendly)
    throw error
  }
  if (!data || typeof data !== "string") throw new Error("ensure_product_line returned no id")
  return data
}
