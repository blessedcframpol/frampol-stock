"use client"

import { useEffect, useMemo, useState } from "react"
import { Loader2, Lock, MoreHorizontal, Pencil, GitMerge, Trash2, Plus } from "lucide-react"
import { toast } from "sonner"
import { EmptyState } from "@/components/fs/empty-state"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { tableNumericClass } from "@/components/fs/data-table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  addVendor,
  deleteVendor,
  mergeVendors,
  previewVendorProductMove,
  renameVendor,
} from "@/lib/settings"
import {
  canDeleteVendorRow,
  deleteVendorDisabledReason,
  filterVendorAdminRows,
  VENDOR_MOVE_COPY,
  type VendorAdminRow,
  type VendorMovePreview,
} from "@/lib/vendors-admin"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { formatCount } from "@/lib/format-display"

export function AdminVendorsPanel({
  rows,
  onChanged,
}: {
  rows: VendorAdminRow[]
  onChanged: () => Promise<void>
}) {
  const [search, setSearch] = useState("")
  const filtered = useMemo(() => filterVendorAdminRows(rows, search), [rows, search])

  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState("")
  const [addBusy, setAddBusy] = useState(false)

  const [renameRow, setRenameRow] = useState<VendorAdminRow | null>(null)
  const [renameTo, setRenameTo] = useState("")
  const [renameBusy, setRenameBusy] = useState(false)

  const [mergeRow, setMergeRow] = useState<VendorAdminRow | null>(null)
  const [mergeTarget, setMergeTarget] = useState("")
  const [mergeReason, setMergeReason] = useState("")
  const [mergePreview, setMergePreview] = useState<VendorMovePreview | null>(null)
  const [mergePreviewBusy, setMergePreviewBusy] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)

  const [deleteRow, setDeleteRow] = useState<VendorAdminRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const mergeTargets = useMemo(() => {
    if (!mergeRow) return []
    return rows.filter((r) => r.name !== mergeRow.name)
  }, [rows, mergeRow])

  useEffect(() => {
    if (!mergeRow || !mergeTarget) {
      setMergePreview(null)
      return
    }
    let cancelled = false
    setMergePreviewBusy(true)
    void previewVendorProductMove({
      targetVendor: mergeTarget,
      sourceVendor: mergeRow.name,
    })
      .then((p) => {
        if (!cancelled) setMergePreview(p)
      })
      .catch((e) => {
        if (!cancelled) {
          setMergePreview(null)
          toastFromCaughtError(e, "Could not preview merge")
        }
      })
      .finally(() => {
        if (!cancelled) setMergePreviewBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [mergeRow, mergeTarget])

  async function confirmAdd() {
    setAddBusy(true)
    try {
      await addVendor(addName)
      toast.success(`Added vendor ${addName.trim()}`)
      setAddOpen(false)
      setAddName("")
      await onChanged()
    } catch (e) {
      toastFromCaughtError(e, "Could not add vendor")
    } finally {
      setAddBusy(false)
    }
  }

  async function confirmRename() {
    if (!renameRow) return
    setRenameBusy(true)
    try {
      const result = await renameVendor(renameRow.name, renameTo)
      toast.success(
        result.products_updated > 0
          ? `Renamed to ${renameTo.trim()}. ${formatCount(result.products_updated)} product(s) updated.`
          : `Renamed to ${renameTo.trim()}.`,
      )
      setRenameRow(null)
      await onChanged()
    } catch (e) {
      toastFromCaughtError(e, "Could not rename vendor")
    } finally {
      setRenameBusy(false)
    }
  }

  async function confirmMerge() {
    if (!mergeRow || !mergeTarget) return
    setMergeBusy(true)
    try {
      const result = await mergeVendors(mergeRow.name, mergeTarget, mergeReason.trim() || undefined)
      toast.success(
        `Merged ${mergeRow.name} into ${mergeTarget}. Moved ${formatCount(result.products_moved)} product(s).`,
      )
      setMergeRow(null)
      setMergeTarget("")
      setMergeReason("")
      setMergePreview(null)
      await onChanged()
    } catch (e) {
      toastFromCaughtError(e, "Could not merge vendors")
    } finally {
      setMergeBusy(false)
    }
  }

  async function confirmDelete() {
    if (!deleteRow) return
    setDeleteBusy(true)
    try {
      await deleteVendor(deleteRow.name)
      toast.success(`Deleted vendor ${deleteRow.name}`)
      setDeleteRow(null)
      await onChanged()
    } catch (e) {
      toastFromCaughtError(e, "Could not delete vendor")
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <ListToolbar
        search={
          <ListToolbarSearch
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendors…"
            aria-label="Search vendors"
          />
        }
        count={`${filtered.length} vendor${filtered.length === 1 ? "" : "s"}`}
        primary={
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4 mr-1" />
            Add vendor
          </Button>
        }
      />

      {filtered.length === 0 ? (
        <EmptyState message="No vendors match your search." />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Vendor</TableHead>
                <TableHead className={tableNumericClass}>Products</TableHead>
                <TableHead className={tableNumericClass}>In stock</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const deleteBlocked = deleteVendorDisabledReason(row)
                return (
                  <TableRow key={row.name}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        {row.name}
                        {row.isProtected ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex text-muted-foreground" aria-label="Protected vendor">
                                  <Lock className="size-3.5" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                {row.protectedReason ?? "Used by the system"}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className={tableNumericClass}>{formatCount(row.productCount)}</TableCell>
                    <TableCell className={tableNumericClass}>{formatCount(row.inStockCount)}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${row.name}`}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={row.isProtected}
                            onClick={() => {
                              if (row.isProtected) {
                                toast.error(row.protectedReason ?? "This vendor cannot be renamed")
                                return
                              }
                              setRenameRow(row)
                              setRenameTo(row.name)
                            }}
                          >
                            <Pencil className="size-4 mr-2" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={row.isProtected}
                            onClick={() => {
                              if (row.isProtected) {
                                toast.error(row.protectedReason ?? "This vendor cannot be merged away")
                                return
                              }
                              setMergeRow(row)
                              setMergeTarget("")
                            }}
                          >
                            <GitMerge className="size-4 mr-2" />
                            Merge into…
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canDeleteVendorRow(row)}
                            title={deleteBlocked ?? undefined}
                            onClick={() => {
                              if (deleteBlocked) {
                                toast.error(deleteBlocked)
                                return
                              }
                              setDeleteRow(row)
                            }}
                          >
                            <Trash2 className="size-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add vendor</DialogTitle>
            <DialogDescription>Creates a new vendor name for the product catalogue.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label htmlFor="vn-add">Name</Label>
            <Input id="vn-add" value={addName} onChange={(e) => setAddName(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={addBusy}>
              Cancel
            </Button>
            <Button onClick={() => void confirmAdd()} disabled={addBusy || !addName.trim()}>
              {addBusy ? <Loader2 className="size-4 animate-spin" /> : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renameRow)} onOpenChange={(o) => !o && setRenameRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename vendor</DialogTitle>
            <DialogDescription>
              All products under {renameRow?.name} will show the new name. Rules that hard-code protected
              names are not affected here — those vendors cannot be renamed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label htmlFor="vn-rename">New name</Label>
            <Input id="vn-rename" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameRow(null)} disabled={renameBusy}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmRename()}
              disabled={renameBusy || !renameTo.trim() || renameTo.trim() === renameRow?.name}
            >
              {renameBusy ? <Loader2 className="size-4 animate-spin" /> : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(mergeRow)}
        onOpenChange={(o) => {
          if (!o) {
            setMergeRow(null)
            setMergeTarget("")
            setMergeReason("")
            setMergePreview(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge vendors</DialogTitle>
            <DialogDescription>
              Move every product from {mergeRow?.name} into another vendor, then remove{" "}
              {mergeRow?.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border px-3 py-2 text-sm">
            About to move <strong>{formatCount(mergeRow?.productCount ?? 0)}</strong> product(s) and{" "}
            <strong>{formatCount(mergeRow?.inStockCount ?? 0)}</strong> in-stock kit(s).
          </div>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label>Merge into</Label>
              <Select value={mergeTarget || undefined} onValueChange={setMergeTarget}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose surviving vendor" />
                </SelectTrigger>
                <SelectContent>
                  {mergeTargets.map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mergePreviewBusy ? (
              <p className="text-sm text-muted-foreground">Checking consequences…</p>
            ) : null}
            {mergePreview?.warnings.map((w) => (
              <p key={w.code} className="text-sm text-muted-foreground">
                {w.message}
              </p>
            ))}
            {mergePreview?.targetProtected ? (
              <p className="text-sm">
                Locked target {mergePreview.targetProtected.name}:{" "}
                {mergePreview.targetProtected.protectedReason}
              </p>
            ) : null}
            {mergePreview?.blocks.map((b) => (
              <p key={b.code} className="text-sm text-destructive">
                {b.message}
              </p>
            ))}
            {mergePreview?.requiresReason ||
            (mergeTarget && rows.find((r) => r.name === mergeTarget)?.isProtected) ? (
              <div className="grid gap-1.5">
                <Label htmlFor="vn-merge-reason">{VENDOR_MOVE_COPY.reason_hint}</Label>
                <Textarea
                  id="vn-merge-reason"
                  value={mergeReason}
                  onChange={(e) => setMergeReason(e.target.value)}
                  rows={3}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeRow(null)} disabled={mergeBusy}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmMerge()}
              disabled={
                mergeBusy ||
                !mergeTarget ||
                Boolean(mergePreview?.blocked) ||
                ((Boolean(mergePreview?.requiresReason) ||
                  Boolean(rows.find((r) => r.name === mergeTarget)?.isProtected)) &&
                  mergeReason.trim().length < 15)
              }
            >
              {mergeBusy ? <Loader2 className="size-4 animate-spin" /> : "Merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteRow)} onOpenChange={(o) => !o && setDeleteRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete vendor</DialogTitle>
            <DialogDescription>
              Remove {deleteRow?.name} permanently. Only empty vendors can be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRow(null)} disabled={deleteBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleteBusy}>
              {deleteBusy ? <Loader2 className="size-4 animate-spin" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
