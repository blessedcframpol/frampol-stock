import type { TransactionType } from "@/lib/data"
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
  PackageOpen,
} from "lucide-react"

/** Movement types that use the outbound-style client / cloud-key form. */
export const OUTBOUND_LIKE_MOVEMENTS: TransactionType[] = [
  "Sale",
  "POC Out",
  "Transfer",
  "Dispose",
  "Rentals",
  "Remediation Loaner Issue",
]

export const NEW_CLIENT_SELECT = "__new__"

export type TransactionTypeChoice = {
  value: string
  label: string
  icon: LucideIcon
  color: string
  bg: string
  desc: string
}

export const TRANSACTION_TYPE_CHOICES: TransactionTypeChoice[] = [
  { value: "Inbound", label: "Inbound", icon: ArrowDownLeft, color: "text-success", bg: "bg-success-soft", desc: "Receive stock from supplier" },
  { value: "Sale", label: "Sale", icon: ArrowUpRight, color: "text-success", bg: "bg-success-soft", desc: "Sell stock to client" },
  { value: "POC Out", label: "POC Out", icon: Send, color: "text-info", bg: "bg-info-soft", desc: "Send for proof of concept" },
  { value: "POC Return", label: "POC Return", icon: RotateCcw, color: "text-info", bg: "bg-info-soft", desc: "Receive POC return" },
  { value: "Rentals", label: "Rentals", icon: Calendar, color: "text-brand", bg: "bg-brand/15", desc: "Rent out to client" },
  { value: "Rental Return", label: "Rental Return", icon: RotateCcw, color: "text-brand", bg: "bg-brand/15", desc: "Receive rental return" },
  {
    value: "Sale Return",
    label: "Sale Return",
    icon: PackageX,
    color: "text-warning",
    bg: "bg-warning-soft",
    desc: "Faulty sold unit returned — RMA hold",
  },
  {
    value: "Decommissioned",
    label: "Decommissioned",
    icon: Unplug,
    color: "text-info",
    bg: "bg-info-soft",
    desc: "Kit returned from site — pending inspection",
  },
  {
    value: "Remediation Loaner Issue",
    label: "Rem. loaner",
    icon: PackageOpen,
    color: "text-warning",
    bg: "bg-warning-soft",
    desc: "Issue working unit from stock for remediation case",
  },
  { value: "Transfer", label: "Transfer", icon: ArrowLeftRight, color: "text-muted-foreground", bg: "bg-muted", desc: "Move between locations" },
  { value: "Dispose", label: "Dispose", icon: Trash2, color: "text-muted-foreground", bg: "bg-muted", desc: "Dispose of asset" },
]
