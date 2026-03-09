"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useInventoryStore } from "@/lib/inventory-store"
import { Package, ShieldAlert, Clock, AlertTriangle, ChevronRight } from "lucide-react"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"

function daysUntil(dateStr: string): number {
  const end = new Date(dateStr)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  return Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function daysOverdue(dateStr: string): number {
  const out = new Date(dateStr)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  out.setHours(0, 0, 0, 0)
  return Math.ceil((now.getTime() - out.getTime()) / (1000 * 60 * 60 * 24))
}

export function AlertsContent() {
  const { getAlerts } = useInventoryStore()
  const alerts = getAlerts()
  const total =
    alerts.lowStock.length + alerts.warrantyExpiring.length + alerts.pocOverdue.length

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">
          Alerts
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Low stock, warranty expiring, and POC overdue. Take action from here or in Inventory / Stock Movement.
        </p>
      </div>

      {total === 0 ? (
        <Card className="border-border">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <AlertTriangle className="w-12 h-12 text-muted-foreground/50 mb-3" />
            <p className="text-sm font-medium text-foreground">No alerts</p>
            <p className="text-sm text-muted-foreground mt-1">
              You're all set. New alerts will appear here when stock is low, warranty is expiring, or POC is overdue.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border">
          <Tabs defaultValue="all" className="w-full">
            <TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent p-0 h-auto gap-0 shrink-0 min-w-0 overflow-x-auto flex-nowrap [&::-webkit-scrollbar]:h-1">
              <TabsTrigger
                value="all"
                className={cn(
                  "rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-3 gap-1.5 shrink-0"
                )}
              >
                All
                <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                  {total}
                </Badge>
              </TabsTrigger>
              <TabsTrigger
                value="lowStock"
                className={cn(
                  "rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-3 gap-1.5 shrink-0"
                )}
              >
                Low stock
                {alerts.lowStock.length > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                    {alerts.lowStock.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="warranty"
                className={cn(
                  "rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-3 gap-1.5 shrink-0"
                )}
              >
                Warranty
                {alerts.warrantyExpiring.length > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                    {alerts.warrantyExpiring.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="poc"
                className={cn(
                  "rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-3 gap-1.5 shrink-0"
                )}
              >
                POC
                {alerts.pocOverdue.length > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                    {alerts.pocOverdue.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {/* All: show all three sections */}
            <TabsContent value="all" className="mt-0">
              <div className="flex flex-col gap-6 p-4">
                {alerts.lowStock.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-3">
                      <Package className="w-3.5 h-3.5" />
                      Low stock
                    </p>
                    <div className="overflow-x-auto -mx-1">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent border-b border-border">
                            <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">Type</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">In stock</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium w-20" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {alerts.lowStock.map((a) => (
                            <TableRow key={a.groupName} className="border-b border-border/50">
                              <TableCell className="font-medium text-foreground">{a.groupName}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{a.itemType}</TableCell>
                              <TableCell className="text-sm">{a.inStock}</TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                                  <Link href="/inventory">
                                    View in Inventory <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                                  </Link>
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
                {alerts.warrantyExpiring.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-3">
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Warranty expiring
                    </p>
                    <div className="overflow-x-auto -mx-1">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent border-b border-border">
                            <TableHead className="text-xs text-muted-foreground font-medium">Serial</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">Warranty end</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">Days left</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium w-20" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {alerts.warrantyExpiring.map((item) => {
                            const days = daysUntil(item.warrantyEndDate!)
                            return (
                              <TableRow key={item.id} className="border-b border-border/50">
                                <TableCell className="font-mono text-sm text-foreground">{item.serialNumber}</TableCell>
                                <TableCell className="text-sm text-foreground">{item.name}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">{formatDateDDMMYYYY(item.warrantyEndDate)}</TableCell>
                                <TableCell className="text-sm">{days} days</TableCell>
                                <TableCell>
                                  <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                                    <Link href="/inventory">View in Inventory <ChevronRight className="w-3.5 h-3.5 ml-0.5" /></Link>
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
                {alerts.pocOverdue.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-3">
                      <Clock className="w-3.5 h-3.5" />
                      POC overdue
                    </p>
                    <div className="overflow-x-auto -mx-1">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent border-b border-border">
                            <TableHead className="text-xs text-muted-foreground font-medium">Serial</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">Assigned to</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium">Days overdue</TableHead>
                            <TableHead className="text-xs text-muted-foreground font-medium w-20" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {alerts.pocOverdue.map((item) => {
                            const days = item.pocOutDate ? daysOverdue(item.pocOutDate) : 0
                            return (
                              <TableRow key={item.id} className="border-b border-border/50">
                                <TableCell className="font-mono text-sm text-foreground">{item.serialNumber}</TableCell>
                                <TableCell className="text-sm text-foreground">{item.name}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">{item.assignedTo ?? "—"}</TableCell>
                                <TableCell className="text-sm">{days} days</TableCell>
                                <TableCell>
                                  <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                                    <Link href="/stock-movement">Record return <ChevronRight className="w-3.5 h-3.5 ml-0.5" /></Link>
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Low stock only */}
            <TabsContent value="lowStock" className="mt-0">
              <div className="pt-4 px-4 pb-4">
                {alerts.lowStock.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No low stock alerts.</p>
                ) : (
                  <div className="overflow-x-auto -mx-1">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent border-b border-border">
                          <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">Type</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">In stock</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium w-20" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {alerts.lowStock.map((a) => (
                          <TableRow key={a.groupName} className="border-b border-border/50">
                            <TableCell className="font-medium text-foreground">{a.groupName}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{a.itemType}</TableCell>
                            <TableCell className="text-sm">{a.inStock}</TableCell>
                            <TableCell>
                              <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                                <Link href="/inventory">
                                  View in Inventory <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                                </Link>
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Warranty only */}
            <TabsContent value="warranty" className="mt-0">
              <div className="pt-4 px-4 pb-4">
                {alerts.warrantyExpiring.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No warranty alerts.</p>
                ) : (
                  <div className="overflow-x-auto -mx-1">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent border-b border-border">
                          <TableHead className="text-xs text-muted-foreground font-medium">Serial</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">Warranty end</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">Days left</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium w-20" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {alerts.warrantyExpiring.map((item) => {
                          const days = daysUntil(item.warrantyEndDate!)
                          return (
                            <TableRow key={item.id} className="border-b border-border/50">
                              <TableCell className="font-mono text-sm text-foreground">{item.serialNumber}</TableCell>
                              <TableCell className="text-sm text-foreground">{item.name}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{formatDateDDMMYYYY(item.warrantyEndDate)}</TableCell>
                              <TableCell className="text-sm">{days} days</TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                                  <Link href="/inventory">View in Inventory <ChevronRight className="w-3.5 h-3.5 ml-0.5" /></Link>
                                </Button>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* POC only */}
            <TabsContent value="poc" className="mt-0">
              <div className="pt-4 px-4 pb-4">
                {alerts.pocOverdue.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No POC overdue alerts.</p>
                ) : (
                  <div className="overflow-x-auto -mx-1">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent border-b border-border">
                          <TableHead className="text-xs text-muted-foreground font-medium">Serial</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">Assigned to</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium">Days overdue</TableHead>
                          <TableHead className="text-xs text-muted-foreground font-medium w-20" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {alerts.pocOverdue.map((item) => {
                          const days = item.pocOutDate ? daysOverdue(item.pocOutDate) : 0
                          return (
                            <TableRow key={item.id} className="border-b border-border/50">
                              <TableCell className="font-mono text-sm text-foreground">{item.serialNumber}</TableCell>
                              <TableCell className="text-sm text-foreground">{item.name}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{item.assignedTo ?? "—"}</TableCell>
                              <TableCell className="text-sm">{days} days</TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                                  <Link href="/stock-movement">Record return <ChevronRight className="w-3.5 h-3.5 ml-0.5" /></Link>
                                </Button>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </Card>
      )}
    </div>
  )
}
