/** VN1 / VN1b — vendor admin helpers (plain-language UI). */

export type VendorAdminRow = {
  name: string
  isProtected: boolean
  protectedReason: string | null
  createdAt: string
  productCount: number
  inStockCount: number
}

/** One place for Move/Merge warning and block copy (Josh-facing). */
export const VENDOR_MOVE_COPY = {
  move_into_starlink: "Moving into Starlink makes these kits rentable",
  move_out_of_starlink: "Moving out of Starlink removes rental rules for these kits",
  move_into_fortinet: "Moving into Fortinet lets Accounts issue these",
  move_out_of_fortinet: "Moving out of Fortinet stops Accounts issuing these",
  move_into_general: "Moving into General treats these as the default/unspecified vendor",
  move_out_of_general: "Moving out of General assigns a specific vendor",
  reason_hint: "Explain why you are changing a locked vendor (at least 15 characters)",
  starlink_out_active: (count: number) =>
    count === 1
      ? "1 kit is out on rental — return them first"
      : `${count} kits are out on rental — return them first`,
  fortinet_open_requests: (count: number) =>
    count === 1
      ? "1 open request uses this product"
      : `${count} open requests use this product`,
} as const

export type VendorMoveWarningCode = keyof Pick<
  typeof VENDOR_MOVE_COPY,
  | "move_into_starlink"
  | "move_out_of_starlink"
  | "move_into_fortinet"
  | "move_out_of_fortinet"
  | "move_into_general"
  | "move_out_of_general"
>

export type VendorMoveBlockCode = "starlink_out_active" | "fortinet_open_requests"

export type VendorMovePreview = {
  target: string | null
  fromVendors: string[]
  productCount: number
  kitCount: number
  sourceProtected: { name: string; protectedReason: string | null }[]
  targetProtected: { name: string; protectedReason: string | null } | null
  protectedReasonsText: string
  requiresReason: boolean
  blocked: boolean
  blocks: { code: VendorMoveBlockCode; count: number; message: string }[]
  warnings: { code: VendorMoveWarningCode; message: string }[]
  starlinkOutKitCount: number
  fortinetOpenRequestCount: number
}

export function mapAdminVendorsOverview(raw: unknown): VendorAdminRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((row) => {
    const r = row as Record<string, unknown>
    return {
      name: String(r.name ?? ""),
      isProtected: r.is_protected === true,
      protectedReason: typeof r.protected_reason === "string" ? r.protected_reason : null,
      createdAt: typeof r.created_at === "string" ? r.created_at : "",
      productCount: Number(r.product_count ?? 0),
      inStockCount: Number(r.in_stock_count ?? 0),
    }
  })
}

export function canDeleteVendorRow(row: VendorAdminRow): boolean {
  return !row.isProtected && row.productCount === 0
}

export function deleteVendorDisabledReason(row: VendorAdminRow): string | null {
  if (row.isProtected) return row.protectedReason ?? "This vendor is used by the system"
  if (row.productCount > 0) return "Move its products first"
  return null
}

export function moveProductsConfirmMessage(input: {
  productCount: number
  kitCount: number
  fromVendors: string[]
  toVendor: string
}): string {
  const products = input.productCount === 1 ? "1 product" : `${input.productCount} products`
  const kits = input.kitCount === 1 ? "1 kit" : `${input.kitCount} kits`
  const from =
    input.fromVendors.length === 0
      ? "their current vendor"
      : input.fromVendors.length === 1
        ? input.fromVendors[0]!
        : input.fromVendors.join(", ")
  return `Move ${products} (${kits}) from ${from} to ${input.toVendor}?`
}

export function warningMessageForCode(code: string): string | null {
  if (code in VENDOR_MOVE_COPY) {
    const val = VENDOR_MOVE_COPY[code as VendorMoveWarningCode]
    return typeof val === "string" ? val : null
  }
  return null
}

export function blockMessageForCode(code: string, count: number): string | null {
  if (code === "starlink_out_active") return VENDOR_MOVE_COPY.starlink_out_active(count)
  if (code === "fortinet_open_requests") return VENDOR_MOVE_COPY.fortinet_open_requests(count)
  return null
}

export function mapVendorMovePreview(raw: unknown): VendorMovePreview {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const fromRaw = r.from_vendors
  const fromVendors = Array.isArray(fromRaw)
    ? fromRaw.map((v) => String(v))
    : typeof fromRaw === "string" && fromRaw
      ? fromRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : []

  const sourceProtected = Array.isArray(r.source_protected)
    ? r.source_protected.map((row) => {
        const p = row as Record<string, unknown>
        return {
          name: String(p.name ?? ""),
          protectedReason: typeof p.protected_reason === "string" ? p.protected_reason : null,
        }
      })
    : []

  const tgt = r.target_protected
  const targetProtected =
    tgt && typeof tgt === "object"
      ? {
          name: String((tgt as Record<string, unknown>).name ?? ""),
          protectedReason:
            typeof (tgt as Record<string, unknown>).protected_reason === "string"
              ? String((tgt as Record<string, unknown>).protected_reason)
              : null,
        }
      : null

  const blocks = Array.isArray(r.blocks)
    ? r.blocks.map((b) => {
        const row = b as Record<string, unknown>
        const code = String(row.code ?? "") as VendorMoveBlockCode
        const count = Number(row.count ?? 0)
        return {
          code,
          count,
          message: blockMessageForCode(code, count) ?? `${code} (${count})`,
        }
      })
    : []

  const warnings = Array.isArray(r.warnings)
    ? r.warnings
        .map((w) => {
          const code = String((w as Record<string, unknown>).code ?? "") as VendorMoveWarningCode
          const message = warningMessageForCode(code)
          return message ? { code, message } : null
        })
        .filter((x): x is { code: VendorMoveWarningCode; message: string } => Boolean(x))
    : []

  return {
    target: typeof r.target === "string" ? r.target : null,
    fromVendors,
    productCount: Number(r.product_count ?? 0),
    kitCount: Number(r.kit_count ?? 0),
    sourceProtected,
    targetProtected,
    protectedReasonsText: typeof r.protected_reasons_text === "string" ? r.protected_reasons_text : "",
    requiresReason: r.requires_reason === true,
    blocked: r.blocked === true,
    blocks,
    warnings,
    starlinkOutKitCount: Number(r.starlink_out_kit_count ?? 0),
    fortinetOpenRequestCount: Number(r.fortinet_open_request_count ?? 0),
  }
}

export function filterVendorAdminRows(
  rows: VendorAdminRow[],
  search: string,
): VendorAdminRow[] {
  const q = search.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.protectedReason ?? "").toLowerCase().includes(q),
  )
}
