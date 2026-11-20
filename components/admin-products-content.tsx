"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Loader2, MoreHorizontal, Pencil, GitMerge, Archive, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { pageTitleClass } from "@/components/page-nav"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { EmptyState } from "@/components/fs/empty-state"
import { TableBodySkeleton } from "@/components/fs/content-skeletons"
import { LoadErrorInline } from "@/components/fs/load-error-inline"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { StatusPill } from "@/components/fs/status-pill"
import { tableNumericClass } from "@/components/fs/data-table"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
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
import { useAuth } from "@/lib/auth-context"
import { canManageUsers } from "@/lib/permissions"
import {
  adminUpdateProductLine,
  deleteProduct,
  fetchAdminProductLinesOverview,
  mergeProductLines,
  retireProductLine,
  unretireProductLine,
} from "@/lib/settings"
import {
  canHardDeleteProductLine,
  filterProductLineAdminRows,
  productLineStatusLabel,
  type ProductLineAdminRow,
} from "@/lib/product-lines-admin"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { formatCount } from "@/lib/format-display"

export function AdminProductsContent() {
  const { role } = useAuth()
  const allowed = canManageUsers(role)
  const [rows, setRows] = useState<ProductLineAdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [vendor, setVendor] = useState<string>("all")
  const [status, setStatus] = useState<"all" | "active" | "retired">("all")

  const [editRow, setEditRow] = useState<ProductLineAdminRow | null>(null)
  const [editName, setEditName] = useState("")
  const [editVendor, setEditVendor] = useState("")
  const [editSerial, setEditSerial] = useState(true)
  const [editCloud, setEditCloud] = useState(false)
  const [editBusy, setEditBusy] = useState(false)

  const [retireRow, setRetireRow] = useState<ProductLineAdminRow | null>(null)
  const [retireReason, setRetireReason] = useState("")
  const [retireBusy, setRetireBusy] = useState(false)
  const [retireMode, setRetireMode] = useState<"retire" | "unretire">("retire")

  const [mergeSource, setMergeSource] = useState<ProductLineAdminRow | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState("")
  const [mergeReason, setMergeReason] = useState("")
  const [mergeCrossVendor, setMergeCrossVendor] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)

  const [deleteRow, setDeleteRow] = useState<ProductLineAdminRow | null>(null)
  const [deleteReason, setDeleteReason] = useState("")
  const [deleteBusy, setDeleteBusy] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await fetchAdminProductLinesOverview()
      setRows(next)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load products")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!allowed) return
    void reload()
  }, [allowed, reload])

  const vendors = useMemo(() => {
    const set = new Set(rows.map((r) => r.vendor).filter(Boolean))
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [rows])

  const filtered = useMemo(
    () =>
      filterProductLineAdminRows(rows, {
        search,
        vendor: vendor === "all" ? null : vendor,
        status,
      }),
    [rows, search, vendor, status],
  )

  const mergeTargets = useMemo(() => {
    if (!mergeSource) return []
    return rows.filter(
      (r) =>
        r.id !== mergeSource.id &&
        !r.mergedIntoId &&
        !r.retiredAt &&
        r.isActive,
    )
  }, [rows, mergeSource])

  if (!allowed) {
    return (
      <div className="flex flex-col gap-4 min-w-0">
        <PageBreadcrumbs items={[{ label: "Settings", href: "/settings" }, { label: "Products" }]} />
        <EmptyState message="Product catalogue admin is limited to administrators." />
      </div>
    )
  }

  function openEdit(row: ProductLineAdminRow) {
    setEditRow(row)
    setEditName(row.productName)
    setEditVendor(row.vendor)
    setEditSerial(row.requiresSerial)
    setEditCloud(row.requiresCloudKey)
  }

  async function saveEdit() {
    if (!editRow) return
    setEditBusy(true)
    try {
      const result = await adminUpdateProductLine({
        productId: editRow.id,
        productName: editName,
        vendor: editVendor,
        requiresSerial: editSerial,
        requiresCloudKey: editCloud,
      })
      if (result.warn_missing_serial) {
        toast.warning(
          `Saved. ${formatCount(result.in_stock_missing_serial ?? 0)} in-stock kit(s) still have no serial — requires serial is on but not blocking.`,
        )
      } else {
        toast.success("Product updated")
      }
      setEditRow(null)
      await reload()
    } catch (e) {
      toastFromCaughtError(e, "Could not update product")
    } finally {
      setEditBusy(false)
    }
  }

  async function confirmRetire() {
    if (!retireRow) return
    setRetireBusy(true)
    try {
      if (retireMode === "retire") {
        await retireProductLine(retireRow.id, retireReason)
        toast.success("Product retired")
      } else {
        await unretireProductLine(retireRow.id, retireReason)
        toast.success("Product restored")
      }
      setRetireRow(null)
      setRetireReason("")
      await reload()
    } catch (e) {
      toastFromCaughtError(e, "Could not update retirement")
    } finally {
      setRetireBusy(false)
    }
  }

  async function confirmMerge() {
    if (!mergeSource || !mergeTargetId) return
    setMergeBusy(true)
    try {
      const result = await mergeProductLines({
        sourceId: mergeSource.id,
        targetId: mergeTargetId,
        reason: mergeReason,
        allowCrossVendor: mergeCrossVendor,
      })
      toast.success(
        `Merged: moved ${formatCount(result.inventory_moved)} inventory and ${formatCount(result.request_lines_moved)} request line(s)`,
      )
      setMergeSource(null)
      setMergeTargetId("")
      setMergeReason("")
      setMergeCrossVendor(false)
      await reload()
    } catch (e) {
      toastFromCaughtError(e, "Could not merge products")
    } finally {
      setMergeBusy(false)
    }
  }

  async function confirmDelete() {
    if (!deleteRow) return
    setDeleteBusy(true)
    try {
      await deleteProduct(deleteRow.id, deleteReason)
      toast.success("Product deleted")
      setDeleteRow(null)
      setDeleteReason("")
      await reload()
    } catch (e) {
      toastFromCaughtError(e, "Could not delete product")
    } finally {
      setDeleteBusy(false)
    }
  }

  const mergeTarget = mergeTargets.find((r) => r.id === mergeTargetId) ?? null
  const crossVendorNeeded =
    Boolean(mergeSource && mergeTarget && mergeSource.vendor.toLowerCase() !== mergeTarget.vendor.toLowerCase())

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <PageBreadcrumbs items={[{ label: "Settings", href: "/settings" }, { label: "Products" }]} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitleClass}>Products</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Catalogue admin — rename, flags, retire, merge. History keeps retired names.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings">Settings</Link>
        </Button>
      </div>

      <ListToolbar
        search={
          <>
            <ListToolbarSearch
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or vendor…"
              aria-label="Search products"
            />
            <Select value={vendor} onValueChange={setVendor}>
              <SelectTrigger className="h-9 w-full sm:w-[10rem] rounded-lg bg-background">
                <SelectValue placeholder="Vendor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All vendors</SelectItem>
                {vendors.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="h-9 w-full sm:w-[9rem] rounded-lg bg-background">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="retired">Retired</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
        count={`${filtered.length} shown`}
      />

      {loadError ? (
        <LoadErrorInline message={loadError} onRetry={() => void reload()} />
      ) : loading ? (
        <TableBodySkeleton rows={8} cols={8} />
      ) : filtered.length === 0 ? (
        <EmptyState message="No products match your filters." />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className={tableNumericClass}>In stock</TableHead>
                <TableHead className={tableNumericClass}>Total</TableHead>
                <TableHead className={tableNumericClass}>Requests</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>Cloud key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const status = productLineStatusLabel(row)
                const retired = status.label !== "Active"
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.productName}</TableCell>
                    <TableCell>{row.vendor}</TableCell>
                    <TableCell className={tableNumericClass}>{formatCount(row.inStockCount)}</TableCell>
                    <TableCell className={tableNumericClass}>{formatCount(row.totalItems)}</TableCell>
                    <TableCell className={tableNumericClass}>{formatCount(row.requestLinesCount)}</TableCell>
                    <TableCell>{row.requiresSerial ? "Yes" : "No"}</TableCell>
                    <TableCell>{row.requiresCloudKey ? "Yes" : "No"}</TableCell>
                    <TableCell>
                      <span className="inline-flex flex-col gap-0.5">
                        <StatusPill value={status.label} />
                        {status.detail ? (
                          <span className="text-[11px] text-muted-foreground">{status.detail}</span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Product actions">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={Boolean(row.mergedIntoId)}
                            onClick={() => openEdit(row)}
                          >
                            <Pencil className="size-4 mr-2" />
                            Edit
                          </DropdownMenuItem>
                          {!retired ? (
                            <DropdownMenuItem
                              onClick={() => {
                                setRetireMode("retire")
                                setRetireRow(row)
                                setRetireReason("")
                              }}
                            >
                              <Archive className="size-4 mr-2" />
                              Retire
                            </DropdownMenuItem>
                          ) : !row.mergedIntoId ? (
                            <DropdownMenuItem
                              onClick={() => {
                                setRetireMode("unretire")
                                setRetireRow(row)
                                setRetireReason("")
                              }}
                            >
                              <RotateCcw className="size-4 mr-2" />
                              Unretire
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            disabled={Boolean(row.mergedIntoId)}
                            onClick={() => {
                              setMergeSource(row)
                              setMergeTargetId("")
                              setMergeReason("")
                              setMergeCrossVendor(false)
                            }}
                          >
                            <GitMerge className="size-4 mr-2" />
                            Merge into…
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canHardDeleteProductLine(row)}
                            onClick={() => {
                              setDeleteRow(row)
                              setDeleteReason("")
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

      <Dialog open={Boolean(editRow)} onOpenChange={(open) => !open && setEditRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit product</DialogTitle>
            <DialogDescription>Rename, vendor, and catalogue flags. Collision names are rejected.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="pl-name">Name</Label>
              <Input id="pl-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pl-vendor">Vendor</Label>
              <Input id="pl-vendor" value={editVendor} onChange={(e) => setEditVendor(e.target.value)} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="pl-serial">Requires serial</Label>
              <Switch id="pl-serial" checked={editSerial} onCheckedChange={setEditSerial} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="pl-cloud">Requires cloud key</Label>
              <Switch id="pl-cloud" checked={editCloud} onCheckedChange={setEditCloud} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)} disabled={editBusy}>
              Cancel
            </Button>
            <Button onClick={() => void saveEdit()} disabled={editBusy || !editName.trim()}>
              {editBusy ? <Loader2 className="size-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(retireRow)} onOpenChange={(open) => !open && setRetireRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{retireMode === "retire" ? "Retire product" : "Unretire product"}</DialogTitle>
            <DialogDescription>
              {retireMode === "retire"
                ? "Hidden from new requests and movement pickers. History still shows the name."
                : "Restores the product to the active catalogue."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label htmlFor="pl-retire-reason">Reason</Label>
            <Textarea
              id="pl-retire-reason"
              value={retireReason}
              onChange={(e) => setRetireReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRetireRow(null)} disabled={retireBusy}>
              Cancel
            </Button>
            <Button onClick={() => void confirmRetire()} disabled={retireBusy || retireReason.trim().length < 3}>
              {retireBusy ? <Loader2 className="size-4 animate-spin" /> : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(mergeSource)} onOpenChange={(open) => !open && setMergeSource(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge product</DialogTitle>
            <DialogDescription>
              Moves inventory and request lines onto the target, then retires{" "}
              <span className="font-medium">{mergeSource?.productName}</span> as an alias.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="rounded-md border px-3 py-2 text-sm">
              <div>
                Moving <strong>{formatCount(mergeSource?.totalItems ?? 0)}</strong> inventory item(s) and{" "}
                <strong>{formatCount(mergeSource?.requestLinesCount ?? 0)}</strong> request line(s).
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Merge into</Label>
              <Select value={mergeTargetId || undefined} onValueChange={setMergeTargetId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose surviving product" />
                </SelectTrigger>
                <SelectContent>
                  {mergeTargets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.productName} · {t.vendor}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {crossVendorNeeded ? (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={mergeCrossVendor}
                  onCheckedChange={(v) => setMergeCrossVendor(v === true)}
                />
                <span>
                  Allow merge across vendors ({mergeSource?.vendor} → {mergeTarget?.vendor})
                </span>
              </label>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="pl-merge-reason">Reason (min 15 characters)</Label>
              <Textarea
                id="pl-merge-reason"
                value={mergeReason}
                onChange={(e) => setMergeReason(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeSource(null)} disabled={mergeBusy}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmMerge()}
              disabled={
                mergeBusy ||
                !mergeTargetId ||
                mergeReason.trim().length < 15 ||
                (crossVendorNeeded && !mergeCrossVendor)
              }
            >
              {mergeBusy ? <Loader2 className="size-4 animate-spin" /> : "Merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteRow)} onOpenChange={(open) => !open && setDeleteRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete product</DialogTitle>
            <DialogDescription>
              Only allowed when there is no inventory and no request lines (typo cleanup).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label htmlFor="pl-delete-reason">Reason</Label>
            <Textarea
              id="pl-delete-reason"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRow(null)} disabled={deleteBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy || deleteReason.trim().length < 3}
            >
              {deleteBusy ? <Loader2 className="size-4 animate-spin" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
