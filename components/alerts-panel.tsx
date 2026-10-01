"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/fs/empty-state"
import { useInventoryStore } from "@/lib/inventory-store"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { AlertTriangle, Package, ShieldAlert, Clock } from "lucide-react"
import { useLowStockProducts } from "@/hooks/use-low-stock-products"

export function AlertsPanel() {
  const { getAlerts } = useInventoryStore()
  const { lowStock } = useLowStockProducts()
  const alerts = { ...getAlerts(), lowStock }
  const total =
    alerts.lowStock.length +
    alerts.warrantyExpiring.length +
    alerts.pocOverdue.length +
    alerts.pocApproaching.length +
    alerts.rentalOverdue.length +
    alerts.rentalApproaching.length
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
          <EmptyState message="No alerts at the moment." />
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="border-warning/40 bg-warning-soft">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-warning" />
          Alerts
          <Badge variant="secondary" className="ml-auto text-xs bg-warning-soft text-warning border-0">
            {total}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {alerts.lowStock.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1.5">
              <Package className="w-3.5 h-3.5" />
              Low stock
            </p>
            <ul className="space-y-1">
              {alerts.lowStock.map((a) => (
                <li key={a.productId} className="text-sm text-foreground flex justify-between gap-2">
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
        {((alerts.pocOverdue.length + alerts.pocApproaching.length + alerts.rentalOverdue.length + alerts.rentalApproaching.length) > 0) && (
          <div>
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1.5">
              <Clock className="w-3.5 h-3.5" />
              POC / Rental return due
            </p>
            <ul className="space-y-1">
              {[...alerts.pocOverdue, ...alerts.pocApproaching, ...alerts.rentalOverdue, ...alerts.rentalApproaching].slice(0, 5).map((item) => (
                <li key={item.id} className="text-sm text-foreground flex justify-between gap-2">
                  <span className="truncate font-mono">{item.serialNumber}</span>
                  <span className="text-muted-foreground shrink-0">{item.assignedTo ?? "—"}</span>
                </li>
              ))}
              {(alerts.pocOverdue.length + alerts.pocApproaching.length + alerts.rentalOverdue.length + alerts.rentalApproaching.length) > 5 && (
                <li className="text-xs text-muted-foreground">+{(alerts.pocOverdue.length + alerts.pocApproaching.length + alerts.rentalOverdue.length + alerts.rentalApproaching.length) - 5} more</li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
