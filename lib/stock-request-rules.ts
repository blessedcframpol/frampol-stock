/** Starlink kits need serials assigned before accounts can mark invoiced. */
const STARLINK_NAMES = new Set(["Starlink Kit"])

export function lineRequiresSerialsBeforeInvoice(productName: string, itemType?: string | null): boolean {
  const n = productName.trim()
  if (STARLINK_NAMES.has(n)) return true
  if (itemType && STARLINK_NAMES.has(itemType.trim())) return true
  return false
}

export function canMarkRequestInvoiced(args: {
  lines: { id: string; product_name: string; item_type: string | null; quantity_requested: number }[]
  assignedCountByLineId: Record<string, number>
}): { ok: boolean; message?: string } {
  for (const line of args.lines) {
    if (!lineRequiresSerialsBeforeInvoice(line.product_name, line.item_type)) continue
    const got = args.assignedCountByLineId[line.id] ?? 0
    if (got < line.quantity_requested) {
      return {
        ok: false,
        message: `Starlink line "${line.product_name}" needs all kit serials assigned (${got}/${line.quantity_requested}) before invoicing.`,
      }
    }
  }
  return { ok: true }
}
