"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useInventoryStore } from "@/lib/inventory-store"
import { ArrowDownLeft, ArrowUpRight, RotateCcw, Send, ArrowLeftRight, Trash2, Calendar } from "lucide-react"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"

const typeConfig: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string; bg: string; label: string }> = {
  Inbound: { icon: ArrowDownLeft, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10", label: "Inbound" },
  Sale: { icon: ArrowUpRight, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10", label: "Sale" },
  "POC Out": { icon: Send, color: "text-cyan-600 dark:text-cyan-400", bg: "bg-cyan-500/10", label: "POC Out" },
  "POC Return": { icon: RotateCcw, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", label: "POC Return" },
  Rentals: { icon: Calendar, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10", label: "Rentals" },
  Transfer: { icon: ArrowLeftRight, color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500/10", label: "Transfer" },
  Dispose: { icon: Trash2, color: "text-slate-600 dark:text-slate-400", bg: "bg-slate-500/10", label: "Dispose" },
}

export function RecentActivity() {
  const { transactions } = useInventoryStore()
  const recent = transactions.slice(0, 6)
  return (
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold text-foreground">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-0 flex-1 min-h-0 overflow-auto">
        {recent.map((txn, i) => {
          const config = typeConfig[txn.type] ?? typeConfig.Inbound
          const Icon = config.icon
          return (
            <div
              key={txn.id}
              className={cn(
                "flex items-center gap-3 py-3",
                i !== Math.min(5, recent.length - 1) && "border-b border-border"
              )}
            >
              <div className={cn("flex items-center justify-center w-8 h-8 rounded-lg shrink-0", config.bg)}>
                <Icon className={cn("w-4 h-4", config.color)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{txn.itemName}</p>
                <p className="text-xs text-muted-foreground">
                {txn.type === "Transfer" && txn.fromLocation && txn.toLocation
                  ? `${txn.fromLocation} → ${txn.toLocation}`
                  : txn.client}
              </p>
              </div>
              <div className="text-right shrink-0">
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-[10px] font-medium border-0",
                    txn.type === "Inbound" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                    txn.type === "Sale" && "bg-red-500/10 text-red-500 dark:text-red-400",
                    txn.type === "POC Out" && "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
                    txn.type === "POC Return" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                    txn.type === "Rentals" && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                    txn.type === "Transfer" && "bg-violet-500/10 text-violet-600 dark:text-violet-400",
                    txn.type === "Dispose" && "bg-slate-500/10 text-slate-600 dark:text-slate-400",
                  )}
                >
                  {config.label}
                </Badge>
                <p className="text-[10px] text-muted-foreground mt-1">{formatDateDDMMYYYY(txn.date)}</p>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
