export type SerialGatedLine = {
  id: string
  product_name: string
  quantity_requested: number
  requires_serial: boolean
}

export function lineRequiresSerialAssignment(line: { requires_serial: boolean }): boolean {
  return line.requires_serial === true
}

export type SerialBlockingLine = {
  lineId: string
  productName: string
  assigned: number
  required: number
}

/** Lines that would fail the 051/052 serviced serial check (`product_lines.requires_serial`). */
export function linesBlockingServiced(
  lines: SerialGatedLine[],
  assignedCounts: Record<string, number>
): SerialBlockingLine[] {
  const blocking: SerialBlockingLine[] = []
  for (const line of lines) {
    if (!lineRequiresSerialAssignment(line)) continue
    const assigned = assignedCounts[line.id] ?? 0
    if (assigned < line.quantity_requested) {
      blocking.push({
        lineId: line.id,
        productName: line.product_name,
        assigned,
        required: line.quantity_requested,
      })
    }
  }
  return blocking
}

export function servicedBlockedReason(blocking: SerialBlockingLine[]): string {
  if (blocking.length === 0) return ""
  if (blocking.length === 1) {
    const b = blocking[0]
    return `${b.required} of ${b.required} serials must be assigned first`
  }
  const required = blocking.reduce((sum, b) => sum + b.required, 0)
  return `${required} serials across ${blocking.length} lines must be assigned first`
}

export function canMarkRequestInvoiced(args: {
  lines: SerialGatedLine[]
  assignedCountByLineId: Record<string, number>
}): { ok: boolean; message?: string } {
  for (const line of args.lines) {
    if (!lineRequiresSerialAssignment(line)) continue
    const got = args.assignedCountByLineId[line.id] ?? 0
    if (got < line.quantity_requested) {
      return {
        ok: false,
        message: `Serial-tracked line "${line.product_name}" needs all kit serials assigned (${got}/${line.quantity_requested}) before invoicing.`,
      }
    }
  }
  return { ok: true }
}
