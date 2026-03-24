"use client"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { LucideIcon } from "lucide-react"

interface StatCardProps {
  title: string
  value: string | number
  change?: string
  changeType?: "positive" | "negative" | "neutral"
  icon: LucideIcon
  iconBg: string
  iconColor: string
}

export function StatCard({ title, value, change, changeType = "neutral", icon: Icon, iconBg, iconColor }: StatCardProps) {
  return (
    <Card className="py-5 gap-0">
      <CardContent className="flex items-center gap-4">
        <div className={cn("flex items-center justify-center w-11 h-11 rounded-xl shrink-0", iconBg)}>
          <Icon className={cn("w-5 h-5", iconColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
          <p className="text-xl sm:text-2xl font-bold text-foreground mt-0.5 tracking-tight">{value}</p>
        </div>
        {change && (
          <span
            className={cn(
              "text-[10px] sm:text-xs font-medium px-2 py-1 rounded-md hidden sm:inline-block",
              changeType === "positive" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              changeType === "negative" && "bg-red-500/10 text-red-600 dark:text-red-400",
              changeType === "neutral" && "bg-secondary text-secondary-foreground"
            )}
          >
            {change}
          </span>
        )}
      </CardContent>
    </Card>
  )
}
