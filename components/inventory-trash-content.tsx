"use client"

import { useEffect, useMemo, useState } from "react"
import { useInventoryStore, INVENTORY_TRASH_RETENTION_DAYS } from "@/lib/inventory-store"
import { useAuth } from "@/lib/auth-context"
import { canEditInventory } from "@/lib/permissions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { Loader2, Trash2, RotateCcw, Eraser } from "lucide-react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

function daysUntilPurge(deletedAtIso: string): number {
  const deleted = new Date(deletedAtIso).getTime()
  const purgeAt = deleted + INVENTORY_TRASH_RETENTION_DAYS * 86400000
  const left = Math.ceil((purgeAt - Date.now()) / 86400000)
  return Math.max(0, left)
}

export function InventoryTrashContent() {
  const { role } = useAuth()
  const isAdmin = canEditInventory(role)
  const { trashedInventory, refetchTrashed, restoreItem, permanentlyDeleteItem, purgeTrashExpired } = useInventoryStore()
  const [loading, setLoading] = useState(true)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purging, setPurging] = useState(false)
  const [permId, setPermId] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      await refetchTrashed()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [isAdmin, refetchTrashed])

  const expiredCount = useMemo(() => {
    const cutoff = Date.now() - INVENTORY_TRASH_RETENTION_DAYS * 86400000
    return trashedInventory.filter((i) => i.deletedAt && new Date(i.deletedAt).getTime() < cutoff).length
  }, [trashedInventory])

  async function handlePurgeExpired() {
    setPurging(true)
    try {
      const res = await purgeTrashExpired()
      if (!res.ok) {
        toast.error(res.error ?? "Purge failed")
        return
      }
      toast.success(res.removed ? `Removed ${res.removed} expired item(s)` : "No expired items to remove")
      await refetchTrashed()
    } finally {
      setPurging(false)
      setPurgeOpen(false)
    }
  }

  async function handleRestore(id: string) {
    const res = await restoreItem(id)
    if (!res.ok) {
      toast.error(res.error ?? "Restore failed")
      return
    }
    toast.success("Item restored to inventory")
    await refetchTrashed()
  }

  async function handlePermanentDelete(id: string) {
    const res = await permanentlyDeleteItem(id)
    if (!res.ok) {
      toast.error(res.error ?? "Delete failed")
      return
    }
    toast.success("Item permanently deleted")
    setPermId(null)
    await refetchTrashed()
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">You don&apos;t have access to Trash. Administrators only.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Trash</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Deleted items stay here for {INVENTORY_TRASH_RETENTION_DAYS} days, then they can be purged permanently.
          </p>
        </div>
        <Button variant="outline" disabled={expiredCount === 0 || purging} onClick={() => setPurgeOpen(true)}>
          {purging ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Eraser className="h-4 w-4 mr-2" />}
          Purge expired ({expiredCount})
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Trashed items</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : trashedInventory.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Trash is empty.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Serial</TableHead>
                  <TableHead className="text-xs">Product</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Deleted</TableHead>
                  <TableHead className="text-xs">Days left</TableHead>
                  <TableHead className="text-xs w-[200px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trashedInventory.map((item) => {
                  const left = item.deletedAt ? daysUntilPurge(item.deletedAt) : 0
                  const canPurgeNow = item.deletedAt && new Date(item.deletedAt).getTime() < Date.now() - INVENTORY_TRASH_RETENTION_DAYS * 86400000
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-xs">{item.serialNumber}</TableCell>
                      <TableCell className="text-sm max-w-[180px] truncate" title={item.name}>
                        {item.name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">
                          {item.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.deletedAt ? formatDateDDMMYYYY(item.deletedAt.slice(0, 10)) : "—"}
                      </TableCell>
                      <TableCell className="text-xs">{canPurgeNow ? "Eligible for purge" : `${left}d`}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => void handleRestore(item.id)}>
                            <RotateCcw className="h-3.5 w-3.5 mr-1" />
                            Restore
                          </Button>
                          <Button type="button" variant="destructive" size="sm" className="h-8" onClick={() => setPermId(item.id)}>
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Purge expired items?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete {expiredCount} item(s) that have been in Trash for more than {INVENTORY_TRASH_RETENTION_DAYS}{" "}
              days. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-card">Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={purging} onClick={() => void handlePurgeExpired()}>
              {purging ? "Purging…" : "Purge"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={permId !== null} onOpenChange={(o) => !o && setPermId(null)}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the inventory row forever. Ledger entries for the serial may still exist.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-card">Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => permId && void handlePermanentDelete(permId)}>
              Delete forever
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
