/** Starlink-related products need serials assigned before accounts can mark invoiced. */
export function lineRequiresSerialsBeforeInvoice(productName: string): boolean {
  return productName.trim().toLowerCase().includes("starlink")
}

export function canMarkRequestInvoiced(args: {
  lines: { id: string; product_name: string; quantity_requested: number }[]
  assignedCountByLineId: Record<string, number>
}): { ok: boolean; message?: string } {
  for (const line of args.lines) {
    if (!lineRequiresSerialsBeforeInvoice(line.product_name)) continue
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
