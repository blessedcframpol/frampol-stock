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
import { AdminVendorsPanel } from "@/components/admin-vendors-panel"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  addVendor,
  adminUpdateProductLine,
  deleteProduct,
  fetchAdminProductLinesOverview,
  fetchAdminVendorsOverview,
  mergeProductLines,
  moveProductsToVendor,
  previewVendorProductMove,
  retireProductLine,
  unretireProductLine,
} from "@/lib/settings"
import {
  canHardDeleteProductLine,
  filterProductLineAdminRows,
  productLineStatusLabel,
  type ProductLineAdminRow,
} from "@/lib/product-lines-admin"
import {
  moveProductsConfirmMessage,
  VENDOR_MOVE_COPY,
  type VendorAdminRow,
  type VendorMovePreview,
} from "@/lib/vendors-admin"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { formatCount } from "@/lib/format-display"

export function AdminProductsContent() {
  const { role } = useAuth()
  const allowed = canManageUsers(role)
  const [rows, setRows] = useState<ProductLineAdminRow[]>([])
  const [vendorRows, setVendorRows] = useState<VendorAdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState("products")
  const [search, setSearch] = useState("")
  const [vendor, setVendor] = useState<string>("all")
  const [status, setStatus] = useState<"all" | "active" | "retired">("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [editRow, setEditRow] = useState<ProductLineAdminRow | null>(null)
  const [editName, setEditName] = useState("")
  const [editVendor, setEditVendor] = useState("")
  const [editVendorMode, setEditVendorMode] = useState<"pick" | "new">("pick")
  const [editNewVendor, setEditNewVendor] = useState("")
  const [editSerial, setEditSerial] = useState(true)
  const [editCloud, setEditCloud] = useState(false)
  const [editBusy, setEditBusy] = useState(false)

  const [moveOpen, setMoveOpen] = useState(false)
  const [moveVendor, setMoveVendor] = useState("")
  const [moveVendorMode, setMoveVendorMode] = useState<"pick" | "new">("pick")
  const [moveNewVendor, setMoveNewVendor] = useState("")
  const [moveReason, setMoveReason] = useState("")
  const [movePreview, setMovePreview] = useState<VendorMovePreview | null>(null)
  const [movePreviewBusy, setMovePreviewBusy] = useState(false)
  const [moveBusy, setMoveBusy] = useState(false)

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
      const [next, vendorsNext] = await Promise.all([
        fetchAdminProductLinesOverview(),
        fetchAdminVendorsOverview(),
      ])
      setRows(next)
      setVendorRows(vendorsNext)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load products")
      setRows([])
      setVendorRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!allowed) return
    void reload()
  }, [allowed, reload])

  const vendors = useMemo(() => vendorRows.map((v) => v.name).sort((a, b) => a.localeCompare(b)), [vendorRows])

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
        r.isActive,
    )
  }, [rows, mergeSource])

  const selectedRows = useMemo(
    () => filtered.filter((r) => selectedIds.has(r.id)),
    [filtered, selectedIds],
  )

  function toggleSelected(id: string, on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSelectAllVisible(on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const row of filtered) {
        if (on) next.add(row.id)
        else next.delete(row.id)
      }
      return next
    })
  }

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
    setEditVendorMode("pick")
    setEditNewVendor("")
    setEditSerial(row.requiresSerial)
    setEditCloud(row.requiresCloudKey)
  }

  async function saveEdit() {
    if (!editRow) return
    setEditBusy(true)
    try {
      let vendorName = editVendor
      if (editVendorMode === "new") {
        vendorName = editNewVendor.trim()
        if (!vendorName) {
          toast.error("Enter a vendor name")
          return
        }
        await addVendor(vendorName)
      }
      const result = await adminUpdateProductLine({
        productId: editRow.id,
        productName: editName,
        vendor: vendorName,
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

  const moveTargetName =
    moveVendorMode === "new" ? moveNewVendor.trim() : moveVendor.trim()

  useEffect(() => {
    if (!moveOpen || !moveTargetName || selectedRows.length === 0) {
      setMovePreview(null)
      return
    }
    if (moveVendorMode === "new") {
      // New vendor is never protected; skip server preview until created.
      setMovePreview(null)
      return
    }
    let cancelled = false
    setMovePreviewBusy(true)
    void previewVendorProductMove({
      targetVendor: moveTargetName,
      productIds: selectedRows.map((r) => r.id),
    })
      .then((p) => {
        if (!cancelled) setMovePreview(p)
      })
      .catch((e) => {
        if (!cancelled) {
          setMovePreview(null)
          toastFromCaughtError(e, "Could not preview move")
        }
      })
      .finally(() => {
        if (!cancelled) setMovePreviewBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [moveOpen, moveTargetName, moveVendorMode, selectedRows])

  async function confirmMove() {
    if (selectedRows.length === 0) return
    setMoveBusy(true)
    try {
      let vendorName = moveVendor
      if (moveVendorMode === "new") {
        vendorName = moveNewVendor.trim()
        if (!vendorName) {
          toast.error("Enter a vendor name")
          return
        }
        await addVendor(vendorName)
      }
      if (!vendorName) {
        toast.error("Choose a vendor")
        return
      }
      const result = await moveProductsToVendor({
        productIds: selectedRows.map((r) => r.id),
        vendor: vendorName,
        reason: moveReason.trim() || undefined,
      })
      toast.success(
        `Moved ${formatCount(result.products_moved)} product(s) to ${result.vendor}`,
      )
      setMoveOpen(false)
      setSelectedIds(new Set())
      setMoveVendor("")
      setMoveNewVendor("")
      setMoveVendorMode("pick")
      setMoveReason("")
      setMovePreview(null)
      await reload()
    } catch (e) {
      toastFromCaughtError(e, "Could not move products")
    } finally {
      setMoveBusy(false)
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
            Catalogue admin — products and vendors. History keeps retired names.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings">Settings</Link>
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="min-w-0">
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="vendors">Vendors</TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="mt-4 flex flex-col gap-4 min-w-0">
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
            primary={
              selectedRows.length > 0 ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setMoveVendor("")
                    setMoveNewVendor("")
                    setMoveVendorMode("pick")
                    setMoveOpen(true)
                  }}
                >
                  Move to vendor… ({selectedRows.length})
                </Button>
              ) : null
            }
            count={`${filtered.length} shown`}
          />

          {loadError ? (
            <LoadErrorInline message={loadError} onRetry={() => void reload()} />
          ) : loading ? (
            <TableBodySkeleton rows={8} cols={9} />
          ) : filtered.length === 0 ? (
            <EmptyState message="No products match your filters." />
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={
                          filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id))
                        }
                        onCheckedChange={(v) => toggleSelectAllVisible(v === true)}
                        aria-label="Select all visible products"
                      />
                    </TableHead>
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
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.has(row.id)}
                            onCheckedChange={(v) => toggleSelected(row.id, v === true)}
                            aria-label={`Select ${row.productName}`}
                          />
                        </TableCell>
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
        </TabsContent>

        <TabsContent value="vendors" className="mt-4 min-w-0">
          {loadError ? (
            <LoadErrorInline message={loadError} onRetry={() => void reload()} />
          ) : loading ? (
            <TableBodySkeleton rows={6} cols={4} />
          ) : (
            <AdminVendorsPanel rows={vendorRows} onChanged={reload} />
          )}
        </TabsContent>
      </Tabs>

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
              <Label>Vendor</Label>
              <Select
                value={editVendorMode === "new" ? "__new__" : editVendor || undefined}
                onValueChange={(v) => {
                  if (v === "__new__") {
                    setEditVendorMode("new")
                    setEditNewVendor("")
                  } else {
                    setEditVendorMode("pick")
                    setEditVendor(v)
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose vendor" />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">New vendor…</SelectItem>
                </SelectContent>
              </Select>
              {editVendorMode === "new" ? (
                <Input
                  className="mt-2"
                  placeholder="New vendor name"
                  value={editNewVendor}
                  onChange={(e) => setEditNewVendor(e.target.value)}
                />
              ) : null}
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
            <Button
              onClick={() => void saveEdit()}
              disabled={
                editBusy ||
                !editName.trim() ||
                (editVendorMode === "new" ? !editNewVendor.trim() : !editVendor.trim())
              }
            >
              {editBusy ? <Loader2 className="size-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={moveOpen}
        onOpenChange={(open) => {
          if (!open) {
            setMoveOpen(false)
            setMoveReason("")
            setMovePreview(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to vendor</DialogTitle>
            <DialogDescription>
              {moveProductsConfirmMessage({
                productCount: selectedRows.length,
                kitCount: selectedRows.reduce((sum, r) => sum + r.inStockCount, 0),
                fromVendors: [...new Set(selectedRows.map((r) => r.vendor))],
                toVendor:
                  moveVendorMode === "new" ? moveNewVendor.trim() || "…" : moveVendor || "…",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label>Vendor</Label>
              <Select
                value={moveVendorMode === "new" ? "__new__" : moveVendor || undefined}
                onValueChange={(v) => {
                  if (v === "__new__") {
                    setMoveVendorMode("new")
                    setMoveNewVendor("")
                  } else {
                    setMoveVendorMode("pick")
                    setMoveVendor(v)
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose vendor" />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">New vendor…</SelectItem>
                </SelectContent>
              </Select>
              {moveVendorMode === "new" ? (
                <Input
                  className="mt-2"
                  placeholder="New vendor name"
                  value={moveNewVendor}
                  onChange={(e) => setMoveNewVendor(e.target.value)}
                />
              ) : null}
            </div>
            {movePreviewBusy ? (
              <p className="text-sm text-muted-foreground">Checking consequences…</p>
            ) : null}
            {movePreview?.warnings.map((w) => (
              <p key={w.code} className="text-sm text-muted-foreground">
                {w.message}
              </p>
            ))}
            {movePreview?.sourceProtected.map((p) => (
              <p key={`src-${p.name}`} className="text-sm">
                Locked source {p.name}: {p.protectedReason}
              </p>
            ))}
            {movePreview?.targetProtected ? (
              <p className="text-sm">
                Locked target {movePreview.targetProtected.name}:{" "}
                {movePreview.targetProtected.protectedReason}
              </p>
            ) : null}
            {movePreview?.blocks.map((b) => (
              <p key={b.code} className="text-sm text-destructive">
                {b.message}
              </p>
            ))}
            {movePreview?.requiresReason ? (
              <div className="grid gap-1.5">
                <Label htmlFor="vn-move-reason">{VENDOR_MOVE_COPY.reason_hint}</Label>
                <Textarea
                  id="vn-move-reason"
                  value={moveReason}
                  onChange={(e) => setMoveReason(e.target.value)}
                  rows={3}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)} disabled={moveBusy}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmMove()}
              disabled={
                moveBusy ||
                selectedRows.length === 0 ||
                (moveVendorMode === "new" ? !moveNewVendor.trim() : !moveVendor.trim()) ||
                Boolean(movePreview?.blocked) ||
                (Boolean(movePreview?.requiresReason) && moveReason.trim().length < 15)
              }
            >
              {moveBusy ? <Loader2 className="size-4 animate-spin" /> : "Move"}
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
