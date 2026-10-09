import type { InventoryItem, TransactionType } from "@/lib/data"
import { INTERNAL_LOCATIONS, isInternalLocation } from "@/lib/data"
import { invoiceChoiceProblem, type InvoiceChoice } from "@/lib/invoices"
import { validateMovementForItem } from "@/lib/supabase/movement-utils"
import type { LucideIcon } from "lucide-react"
import {
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  RotateCcw,
  Calendar,
  ArrowLeftRight,
  Trash2,
  PackageX,
  Unplug,
} from "lucide-react"

/** Outbound-style movements that need a client (and often cloud keys). */
export const OUTBOUND_LIKE_MOVEMENTS: TransactionType[] = [
  "Sale",
  "POC Out",
  "Transfer",
  "Dispose",
  "Rentals",
]

export const NEW_CLIENT_SELECT = "__new__"

export type MovementSource = "movement_page" | "quick_scan"

export type MovementTypeGroup = "out" | "in" | "move"

export type TransactionTypeChoice = {
  value: TransactionType
  label: string
  icon: LucideIcon
  color: string
  bg: string
  desc: string
  group: MovementTypeGroup
}

/** User-selectable movement types for P3.6 (no Remediation Loaner; inspections stay on Inspections). */
export const TRANSACTION_TYPE_CHOICES: TransactionTypeChoice[] = [
  { value: "Sale", label: "Sale", icon: ArrowUpRight, color: "text-success", bg: "bg-success-soft", desc: "Sell stock to client", group: "out" },
  { value: "POC Out", label: "POC Out", icon: Send, color: "text-info", bg: "bg-info-soft", desc: "Send for proof of concept", group: "out" },
  { value: "Rentals", label: "Rentals", icon: Calendar, color: "text-brand", bg: "bg-brand/15", desc: "Rent out to client", group: "out" },
  { value: "Dispose", label: "Dispose", icon: Trash2, color: "text-muted-foreground", bg: "bg-muted", desc: "Dispose of asset", group: "out" },
  { value: "Inbound", label: "Inbound", icon: ArrowDownLeft, color: "text-success", bg: "bg-success-soft", desc: "Receive stock from supplier", group: "in" },
  { value: "POC Return", label: "POC Return", icon: RotateCcw, color: "text-info", bg: "bg-info-soft", desc: "Receive POC return", group: "in" },
  { value: "Rental Return", label: "Rental Return", icon: RotateCcw, color: "text-brand", bg: "bg-brand/15", desc: "Receive a rental return for inspection", group: "in" },
  {
    value: "Sale Return",
    label: "Sale Return",
    icon: PackageX,
    color: "text-warning",
    bg: "bg-warning-soft",
    desc: "Faulty sold unit returned — RMA hold",
    group: "in",
  },
  {
    value: "Decommissioned",
    label: "Decommissioned",
    icon: Unplug,
    color: "text-info",
    bg: "bg-info-soft",
    desc: "Kit returned from site — pending inspection",
    group: "in",
  },
  { value: "Transfer", label: "Transfer", icon: ArrowLeftRight, color: "text-muted-foreground", bg: "bg-muted", desc: "Move between locations", group: "move" },
]

export const MOVEMENT_GROUP_LABELS: Record<MovementTypeGroup, string> = {
  out: "Out",
  in: "In",
  move: "Move",
}

export const MOVEMENT_GROUP_ORDER: MovementTypeGroup[] = ["out", "in", "move"]

export function choicesForGroup(group: MovementTypeGroup): TransactionTypeChoice[] {
  return TRANSACTION_TYPE_CHOICES.filter((c) => c.group === group)
}

export function groupForType(type: string): MovementTypeGroup | null {
  return TRANSACTION_TYPE_CHOICES.find((c) => c.value === type)?.group ?? null
}

export function isSelectableMovementType(type: string): type is TransactionType {
  return TRANSACTION_TYPE_CHOICES.some((c) => c.value === type)
}

/** In movements must use warehouse / service locations only. */
export const IN_MOVEMENT_TYPES: ReadonlySet<string> = new Set([
  "Inbound",
  "POC Return",
  "Rental Return",
  "Sale Return",
  "Decommissioned",
])

export function requiresClient(type: string): boolean {
  return (
    type === "Sale" ||
    type === "POC Out" ||
    type === "Rentals" ||
    type === "Dispose" ||
    type === "Decommissioned"
  )
}

export function requiresInvoice(type: string): boolean {
  return type === "Sale" || type === "Rentals"
}

export function requiresReturnDate(type: string): boolean {
  return type === "POC Out" || type === "Rentals"
}

export function requiresReturnPool(type: string): boolean {
  return type === "POC Return"
}

export function requiresIntakeReason(type: string): boolean {
  return type === "Rental Return" || type === "Decommissioned"
}

export function requiresWarehouseLocation(type: string): boolean {
  return IN_MOVEMENT_TYPES.has(type)
}

export function locationOptionsForType(type: string): readonly string[] {
  if (requiresWarehouseLocation(type) || type === "Transfer") return INTERNAL_LOCATIONS
  return INTERNAL_LOCATIONS
}

export type MovementFormFields = {
  type: string
  productName: string
  vendor: string
  serialText: string
  clientId: string
  invoiceChoice: InvoiceChoice | ""
  invoiceNumber: string
  invoiceReason: string
  returnDate: string
  returnPool: "" | "sale" | "demo"
  intakeCategory: string
  intakeReason: string
  toLocation: string
  disposalReason: string
  authorisedBy: string
  businessDate: string
  /** Transfer: destinations only; origin comes from serial locations. */
  notes: string
}

export type SerialFeedbackLine = {
  summary: string
  marks: Array<{ serial: string; mark: "ok" | "duplicate" | "in_stock" | "not_found" | "blocked"; detail?: string }>
  validSerials: string[]
  blockedCount: number
  notFoundCount: number
  duplicateCount: number
}

/**
 * Live serial line using inventory already loaded from the server and the
 * shared validateMovementForItem twin (same rules as apply_stock_movement).
 */
export function buildSerialFeedback(
  type: TransactionType,
  serialText: string,
  inventory: InventoryItem[],
  opts: {
    expectedProductName?: string
    expectedVendor?: string
    fromLocation?: string
  } = {},
): SerialFeedbackLine {
  const raw = serialText
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Map<string, number>()
  for (const s of raw) seen.set(s, (seen.get(s) ?? 0) + 1)

  const unique = [...seen.keys()]
  const bySerial = new Map(inventory.map((item) => [item.serialNumber, item]))
  const marks: SerialFeedbackLine["marks"] = []
  let duplicateCount = 0
  let notFoundCount = 0
  let blockedCount = 0
  let inStockCount = 0
  const validSerials: string[] = []

  for (const serial of unique) {
    const copies = seen.get(serial) ?? 1
    if (copies > 1) {
      duplicateCount += copies - 1
      marks.push({ serial, mark: "duplicate", detail: `listed ${copies} times` })
    }
    const item = bySerial.get(serial)
    if (!item) {
      if (type === "Inbound" || type === "Decommissioned") {
        if (copies === 1) marks.push({ serial, mark: "ok", detail: "will create" })
        validSerials.push(serial)
      } else {
        notFoundCount += 1
        if (copies === 1) marks.push({ serial, mark: "not_found", detail: "not found" })
        else marks[marks.length - 1] = { serial, mark: "not_found", detail: "not found · duplicate in list" }
      }
      continue
    }
    if (item.status === "In Stock") inStockCount += 1
    const reason = validateMovementForItem(type, item, {
      expectedProductName: opts.expectedProductName,
      expectedVendor: opts.expectedVendor,
      fromLocation: opts.fromLocation,
    })
    if (reason) {
      blockedCount += 1
      marks.push({ serial, mark: "blocked", detail: reason })
    } else {
      if (copies === 1) marks.push({ serial, mark: "ok" })
      validSerials.push(serial)
    }
  }

  const parts = [`${raw.length} serial${raw.length === 1 ? "" : "s"}`]
  if (duplicateCount) parts.push(`${duplicateCount} duplicate`)
  if (inStockCount && type === "Inbound") parts.push(`${inStockCount} already in stock`)
  if (notFoundCount) parts.push(`${notFoundCount} not found`)
  if (blockedCount) {
    parts.push(type === "Sale" ? `${blockedCount} can't be sold` : `${blockedCount} blocked`)
  }

  return {
    summary: parts.join(" · "),
    marks,
    validSerials,
    blockedCount,
    notFoundCount,
    duplicateCount,
  }
}

/** Derive a single Transfer origin from selected serials; null if mixed or unknown. */
export function transferOriginFromSerials(
  serials: string[],
  inventory: InventoryItem[],
): { location: string | null; mixed: boolean } {
  const bySerial = new Map(inventory.map((item) => [item.serialNumber, item]))
  const locations = new Set<string>()
  for (const serial of serials) {
    const item = bySerial.get(serial)
    if (!item?.location) continue
    locations.add(item.location)
  }
  if (locations.size === 0) return { location: null, mixed: false }
  if (locations.size > 1) return { location: null, mixed: true }
  return { location: [...locations][0]!, mixed: false }
}

export function disposalReasonProblem(reason: string): string | null {
  if (reason.trim().length < 15) return "Disposal reason must be at least 15 characters"
  return null
}

export function authorisedByProblem(adminId: string): string | null {
  if (!adminId.trim()) return "Pick the authorising admin"
  return null
}

export function businessDateProblem(ymd: string, todayYmd: string): string | null {
  const day = ymd.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Pick a business date"
  if (day > todayYmd.slice(0, 10)) return "Business date can't be in the future"
  return null
}

export function warehouseLocationProblem(type: string, location: string): string | null {
  if (!requiresWarehouseLocation(type)) return null
  if (!location.trim()) return "Pick a warehouse location"
  if (!isInternalLocation(location.trim())) return "In movements must use a warehouse location"
  return null
}

export function transferDestinationProblem(destination: string, origin: string | null): string | null {
  if (!destination.trim()) return "Pick a destination"
  if (origin && destination.trim() === origin.trim()) {
    return "Destination must differ from the current location"
  }
  return null
}

/**
 * What the Record button should say when the form is incomplete.
 * Returns null when the form is ready to submit (serial feedback may still block).
 */
export function submitBlockMessage(
  fields: MovementFormFields,
  serialFeedback: SerialFeedbackLine,
  opts: { todayYmd: string; originLocation?: string | null; hasUnknownSerial?: boolean } = {
    todayYmd: "",
  },
): string | null {
  if (!isSelectableMovementType(fields.type)) return "Select a movement type"
  if (!fields.productName.trim()) return "Select a product"

  const dateProblem = businessDateProblem(fields.businessDate, opts.todayYmd)
  if (dateProblem) return dateProblem

  if (serialFeedback.duplicateCount > 0) return "Remove duplicate serials"
  if (serialFeedback.blockedCount > 0) {
    if (fields.type === "Sale") return `${serialFeedback.blockedCount} serials can't be sold`
    return `${serialFeedback.blockedCount} serials can't move`
  }
  if (serialFeedback.notFoundCount > 0 && fields.type !== "Inbound" && fields.type !== "Decommissioned") {
    return `${serialFeedback.notFoundCount} serials not found`
  }
  if (serialFeedback.validSerials.length === 0) return "Enter at least one serial"

  if (requiresClient(fields.type)) {
    if (!fields.clientId.trim() || fields.clientId === NEW_CLIENT_SELECT) {
      return "Select a client"
    }
  }

  if (requiresInvoice(fields.type)) {
    const inv = invoiceChoiceProblem(fields.invoiceChoice, fields.invoiceNumber, fields.invoiceReason)
    if (inv) return inv
  }

  if (requiresReturnPool(fields.type) && fields.returnPool !== "sale" && fields.returnPool !== "demo") {
    return "Choose Back in sellable stock or Demo unit"
  }

  if (requiresIntakeReason(fields.type)) {
    if (!fields.intakeCategory.trim()) return "Pick a return category"
    if (!fields.intakeReason.trim()) return "Enter a return reason"
  }

  if (requiresWarehouseLocation(fields.type)) {
    const loc = warehouseLocationProblem(fields.type, fields.toLocation)
    if (loc) return loc
  }

  if (fields.type === "Transfer") {
    const dest = transferDestinationProblem(fields.toLocation, opts.originLocation ?? null)
    if (dest) return dest
  }

  if (fields.type === "Dispose") {
    const reason = disposalReasonProblem(fields.disposalReason)
    if (reason) return reason
    const admin = authorisedByProblem(fields.authorisedBy)
    if (admin) return admin
  }

  return null
}
