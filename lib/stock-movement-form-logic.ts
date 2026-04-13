import type { DeviceTypeName, TransactionType } from "@/lib/data"
import type { LucideIcon } from "lucide-react"
import {
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  RotateCcw,
  Calendar,
  ArrowLeftRight,
  Trash2,
} from "lucide-react"

/** Movement types that use the outbound-style client / cloud-key form. */
export const OUTBOUND_LIKE_MOVEMENTS: TransactionType[] = ["Sale", "POC Out", "Transfer", "Dispose", "Rentals"]

export const NEW_CLIENT_SELECT = "__new__"

export const DEVICE_TYPE_OPTIONS: { value: DeviceTypeName; label: string }[] = [
  { value: "Starlink Kit", label: "Starlink Kit" },
  { value: "Laptop", label: "Laptop" },
  { value: "Desktop", label: "Desktop" },
  { value: "Router", label: "Router" },
  { value: "Switch", label: "Switch" },
  { value: "Access Point", label: "Access Point" },
  { value: "UPS", label: "UPS" },
  { value: "Monitor", label: "Monitor" },
]

export type TransactionTypeChoice = {
  value: string
  label: string
  icon: LucideIcon
  color: string
  bg: string
  desc: string
}

export const TRANSACTION_TYPE_CHOICES: TransactionTypeChoice[] = [
  { value: "Inbound", label: "Inbound", icon: ArrowDownLeft, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10", desc: "Receive stock from supplier" },
  { value: "Sale", label: "Sale", icon: ArrowUpRight, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10", desc: "Sell stock to client" },
  { value: "POC Out", label: "POC Out", icon: Send, color: "text-cyan-600 dark:text-cyan-400", bg: "bg-cyan-500/10", desc: "Send for proof of concept" },
  { value: "POC Return", label: "POC Return", icon: RotateCcw, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", desc: "Receive POC return" },
  { value: "Rentals", label: "Rentals", icon: Calendar, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10", desc: "Rent out to client" },
  { value: "Rental Return", label: "Rental Return", icon: RotateCcw, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10", desc: "Receive rental return" },
  { value: "Transfer", label: "Transfer", icon: ArrowLeftRight, color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500/10", desc: "Move between locations" },
  { value: "Dispose", label: "Dispose", icon: Trash2, color: "text-slate-600 dark:text-slate-400", bg: "bg-slate-500/10", desc: "Dispose of asset" },
]
