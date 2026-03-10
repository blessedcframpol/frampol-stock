"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useInventoryStore } from "@/lib/inventory-store"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { AlertTriangle, Package, ShieldAlert, Clock } from "lucide-react"

export function AlertsPanel() {
  const { getAlerts } = useInventoryStore()
  const alerts = getAlerts()
  const total =
    alerts.lowStock.length + alerts.warrantyExpiring.length + alerts.rentalOverdue.length
  if (total === 0) {
    return (
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-muted-foreground" />
            Alerts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No alerts at the moment.</p>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          Alerts
          <Badge variant="secondary" className="ml-auto text-xs bg-amber-500/20 text-amber-700 dark:text-amber-300 border-0">
            {total}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {alerts.lowStock.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1.5">
              <Package className="w-3.5 h-3.5" />
              Low stock (≤2 in stock)
            </p>
            <ul className="space-y-1">
              {alerts.lowStock.map((a) => (
                <li key={a.groupName} className="text-sm text-foreground flex justify-between gap-2">
                  <span className="truncate">{a.groupName}</span>
                  <span className="text-muted-foreground shrink-0">{a.inStock} left</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {alerts.warrantyExpiring.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1.5">
              <ShieldAlert className="w-3.5 h-3.5" />
              Warranty expiring within 30 days
            </p>
            <ul className="space-y-1">
              {alerts.warrantyExpiring.slice(0, 5).map((item) => (
                <li key={item.id} className="text-sm text-foreground flex justify-between gap-2">
                  <span className="truncate font-mono">{item.serialNumber}</span>
                  <span className="text-muted-foreground shrink-0">{formatDateDDMMYYYY(item.warrantyEndDate)}</span>
                </li>
              ))}
              {alerts.warrantyExpiring.length > 5 && (
                <li className="text-xs text-muted-foreground">+{alerts.warrantyExpiring.length - 5} more</li>
              )}
            </ul>
          </div>
        )}
        {alerts.rentalOverdue.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1.5">
              <Clock className="w-3.5 h-3.5" />
              Rental past return date
            </p>
            <ul className="space-y-1">
              {alerts.rentalOverdue.map((item) => (
                <li key={item.id} className="text-sm text-foreground flex justify-between gap-2">
                  <span className="truncate font-mono">{item.serialNumber}</span>
                  <span className="text-muted-foreground shrink-0">{item.assignedTo ?? "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
