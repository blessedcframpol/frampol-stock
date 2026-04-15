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
  { value: "Inbound", label: "Inbound", icon: ArrowDownLeft, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10", desc: "Receive stock from supplier" },
  { value: "Sale", label: "Sale", icon: ArrowUpRight, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10", desc: "Sell stock to client" },
  { value: "POC Out", label: "POC Out", icon: Send, color: "text-cyan-600 dark:text-cyan-400", bg: "bg-cyan-500/10", desc: "Send for proof of concept" },
  { value: "POC Return", label: "POC Return", icon: RotateCcw, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", desc: "Receive POC return" },
  { value: "Rentals", label: "Rentals", icon: Calendar, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10", desc: "Rent out to client" },
  { value: "Rental Return", label: "Rental Return", icon: RotateCcw, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10", desc: "Receive rental return" },
  {
    value: "Sale Return",
    label: "Sale Return",
    icon: PackageX,
    color: "text-orange-600 dark:text-orange-400",
    bg: "bg-orange-500/10",
    desc: "Faulty sold unit returned — RMA hold",
  },
  {
    value: "Decommissioned",
    label: "Decommissioned",
    icon: Unplug,
    color: "text-teal-600 dark:text-teal-400",
    bg: "bg-teal-500/10",
    desc: "Kit returned from site — pending inspection",
  },
  {
    value: "Remediation Loaner Issue",
    label: "Rem. loaner",
    icon: PackageOpen,
    color: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-500/10",
    desc: "Issue working unit from stock for remediation case",
  },
  { value: "Transfer", label: "Transfer", icon: ArrowLeftRight, color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500/10", desc: "Move between locations" },
  { value: "Dispose", label: "Dispose", icon: Trash2, color: "text-slate-600 dark:text-slate-400", bg: "bg-slate-500/10", desc: "Dispose of asset" },
]
