"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Download, MoreHorizontal } from "lucide-react"
import { toast } from "sonner"
import { ChangeGroupDialog } from "@/components/change-group-dialog"
import { ConvertToSaleDialog, ExtendHoldingDialog } from "@/components/holding-actions"
import { InventoryItemActionsMenu } from "@/components/inventory-item-actions"
import { MoveItemsDialog } from "@/components/move-items-dialog"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { pageTitleClass } from "@/components/page-nav"
import { RecordStockMovementDialog } from "@/components/record-stock-movement-dialog"
import { EmptyState } from "@/components/fs/empty-state"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { StatusPill } from "@/components/fs/status-pill"
import { StockPoolChip } from "@/components/stock-pool-chip"
import { KitSerial } from "@/components/kit-serial"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAuth } from "@/lib/auth-context"
import type { InventoryItem } from "@/lib/data"
import { downloadCsv } from "@/lib/download-csv"
import { filterOnHandInventory } from "@/lib/inventory-visibility"
import { useInventoryStore } from "@/lib/inventory-store"
import {
  canExportInventory,
  canLaunchStockTake,
  canMoveProductGroup,
  serialColumnsVisible,
  showSerialCheckboxes,
} from "@/lib/inventory-products"
import { recordReturnHref } from "@/lib/alerts"
import { rentalConversionLabel } from "@/lib/rental-conversion"
import { canChangeStockPool, canRecordStockMovement } from "@/lib/permissions"
import { buildStockTakeUrl } from "@/lib/stock-take"
import { buildCsvFilename, formatDateDDMMYYYY } from "@/lib/utils"
import { formatCount } from "@/lib/format-display"
import { BusinessDateLabel } from "@/components/business-date-label"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function InventorySerialsContent({ productId }: { productId: string }) {
  const timeZone = useOrgTimezone()
  const searchParams = useSearchParams()
  const serialFromUrl = searchParams.get("serial")?.trim() ?? ""
  const { role } = useAuth()
  const { inventory, transactions, refetchLedger } = useInventoryStore()
  const [search, setSearch] = useState(serialFromUrl)
  const [seenSerial, setSeenSerial] = useState(serialFromUrl)
  if (serialFromUrl && serialFromUrl !== seenSerial) {
    setSeenSerial(serialFromUrl)
    setSearch(serialFromUrl)
  } else if (serialFromUrl !== seenSerial) {
    setSeenSerial(serialFromUrl)
  }
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [movementOpen, setMovementOpen] = useState(false)
  const [movementItems, setMovementItems] = useState<InventoryItem[]>([])
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveItems, setMoveItems] = useState<InventoryItem[]>([])
  const [convertOpen, setConvertOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)

  const canMove = canRecordStockMovement(role)
  const canChangeGroup = canChangeStockPool(role)
  const canExport = canExportInventory(role)
  const canStockTake = canLaunchStockTake(role)
  const canMoveGroup = canMoveProductGroup(role)
  const checkboxes = showSerialCheckboxes(role)

  const productItems = useMemo(
    () => inventory.filter((item) => item.productId === productId && !item.deletedAt),
    [inventory, productId],
  )
  const onHand = useMemo(() => filterOnHandInventory(productItems), [productItems])
  const named = productItems[0]
  const productName = named?.name ?? "Product"
  const vendor = named?.vendor?.trim() ? named.vendor : "General"

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return onHand
    return onHand.filter(
      (item) => item.serialNumber.toLowerCase().includes(query) || item.name.toLowerCase().includes(query),
    )
  }, [onHand, search])

  const columns = useMemo(() => serialColumnsVisible(filtered), [filtered])
  const selected = useMemo(() => filtered.filter((item) => selectedIds.has(item.id)), [filtered, selectedIds])
  const allSelected = filtered.length > 0 && filtered.every((item) => selectedIds.has(item.id))

  const kitHistory = useMemo(() => {
    if (!serialFromUrl) return []
    return transactions.filter((txn) => txn.serialNumber === serialFromUrl)
  }, [serialFromUrl, transactions])
  const focusedItem = useMemo(() => {
    if (!serialFromUrl) return undefined
    return productItems.find((item) => item.serialNumber === serialFromUrl)
  }, [productItems, serialFromUrl])
  const focusedHolding = focusedItem?.status === "POC" || focusedItem?.status === "Rented"

  function openMove(items: InventoryItem[]) {
    if (items.length === 0) {
      toast.error("Select at least one item")
      return
    }
    setMoveItems(items)
    setMoveOpen(true)
  }

  function openMovement(items: InventoryItem[]) {
    if (items.length === 0) {
      toast.error("Select at least one item")
      return
    }
    const names = new Set(items.map((item) => item.name))
    if (names.size > 1) {
      toast.error("Selected items must share the same product name")
      return
    }
    setMovementItems(items)
    setMovementOpen(true)
  }

  function exportItems() {
    const rows: string[][] = [["Serial Number", "Name", "Vendor", "Status", "Location", "Assigned To", "Date Added", "Purchase Date", "Warranty End"]]
    for (const item of filtered) {
      rows.push([
        item.serialNumber,
        item.name,
        vendor,
        item.status,
        item.location,
        item.assignedTo ?? "",
        item.dateAdded,
        item.purchaseDate ?? "",
        item.warrantyEndDate ?? "",
      ])
    }
    downloadCsv(rows, buildCsvFilename([vendor, productName, "items"], new Date().toISOString()))
    toast.success("Item-level CSV downloaded")
  }

  const columnCount =
    5 + (checkboxes ? 1 : 0) + (columns.assignedTo ? 1 : 0) + (columns.purchaseWarranty ? 1 : 0)

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <PageBreadcrumbs items={[{ label: "Inventory", href: "/inventory" }, { label: productName }]} />
      {serialFromUrl ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Kit history</CardTitle>
                <p className="text-xs text-muted-foreground">Serial: {serialFromUrl}</p>
              </div>
              {canMove && focusedHolding && focusedItem ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" asChild>
                    <Link href={recordReturnHref(focusedItem.status === "POC" ? "POC" : "Rental", [focusedItem.serialNumber])}>
                      Record return
                    </Link>
                  </Button>
                  {focusedItem.status === "POC" ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setConvertOpen(true)}>
                      Convert to sale
                    </Button>
                  ) : null}
                  <Button type="button" variant="outline" size="sm" onClick={() => setExtendOpen(true)}>
                    Extend
                  </Button>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {kitHistory.length === 0 ? (
              <EmptyState message="No transactions logged for this serial." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Client / Location</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {kitHistory.slice(0, 20).map((txn) => {
                    const period = rentalConversionLabel(txn.metadata, txn.date)
                    return (
                    <TableRow key={txn.id}>
                      <TableCell>
                        <BusinessDateLabel date={txn.date} createdAt={txn.createdAt} timeZone={timeZone} />
                      </TableCell>
                      <TableCell>
                        {txn.type}
                        {period ? <p className="mt-1 text-xs text-muted-foreground">{period}</p> : null}
                      </TableCell>
                      <TableCell>{txn.itemName}</TableCell>
                      <TableCell>
                        {txn.type === "Transfer" && txn.fromLocation && txn.toLocation
                          ? `${txn.fromLocation} → ${txn.toLocation}`
                          : txn.client}
                      </TableCell>
                    </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className={pageTitleClass}>{productName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {vendor} · {formatCount(onHand.length)} in stock
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canMoveGroup && onHand.length > 0 ? (
            <Button type="button" variant="outline" onClick={() => openMove(onHand)}>
              Move group
            </Button>
          ) : null}
          {canStockTake && onHand.length > 0 ? (
            <Button type="button" variant="outline" asChild>
              <Link href={buildStockTakeUrl({ vendor, product: productName })}>Stock take</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <ListToolbar
        search={
          <ListToolbarSearch
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by serial number"
            aria-label="Search serials"
            className="font-mono"
          />
        }
        count={`${formatCount(filtered.length)} of ${formatCount(onHand.length)}`}
        secondary={
          canExport ? (
            <Button type="button" variant="ghost" onClick={exportItems}>
              <Download className="size-4" aria-hidden />
              Export
            </Button>
          ) : null
        }
      />

      {checkboxes && selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-foreground">{selected.length} selected</span>
          {canMove ? (
            <Button type="button" size="sm" onClick={() => openMovement(selected)}>
              Record movement ({selected.length})
            </Button>
          ) : null}
          {canChangeGroup && selected.every((item) => item.status === "In Stock" || item.status === "Rented") ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setGroupOpen(true)}>
              Change group ({selected.length})
            </Button>
          ) : null}
          {canMoveGroup ? (
            <Button type="button" size="sm" variant="outline" onClick={() => openMove(selected)}>
              Move to vendor/group ({selected.length})
            </Button>
          ) : null}
          {canStockTake ? (
            <Button type="button" size="sm" variant="outline" asChild>
              <Link href={buildStockTakeUrl({ serials: selected.map((item) => item.serialNumber) })}>
                Stock take ({selected.length})
              </Link>
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            {checkboxes ? (
              <TableHead className="w-10 px-2">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(value) => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev)
                      const ids = filtered.map((item) => item.id)
                      if (value === true) ids.forEach((id) => next.add(id))
                      else ids.forEach((id) => next.delete(id))
                      return next
                    })
                  }}
                  aria-label="Select all items in this list"
                />
              </TableHead>
            ) : null}
            <TableHead>Serial Number</TableHead>
            <TableHead>Status</TableHead>
            {columns.assignedTo ? <TableHead>Assigned to</TableHead> : null}
            <TableHead>Date Added</TableHead>
            <TableHead>Location</TableHead>
            {columns.purchaseWarranty ? <TableHead>Purchase / Warranty</TableHead> : null}
            <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="h-auto py-8">
                <EmptyState message="No items found in this group." />
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((item) => (
              <TableRow key={item.id}>
                {checkboxes ? (
                  <TableCell className="w-10 px-2">
                    <Checkbox
                      checked={selectedIds.has(item.id)}
                      onCheckedChange={(value) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (value === true) next.add(item.id)
                          else next.delete(item.id)
                          return next
                        })
                      }}
                      aria-label={`Select ${item.serialNumber}`}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="font-mono text-sm">
                  <span className="inline-flex items-center gap-2">
                    <KitSerial serial={item.serialNumber} itemId={item.id} />
                    <StockPoolChip pool={item.stockPool} />
                  </span>
                </TableCell>
                <TableCell>
                  <StatusPill value={item.status} />
                </TableCell>
                {columns.assignedTo ? <TableCell>{item.assignedTo ?? "—"}</TableCell> : null}
                <TableCell>{formatDateDDMMYYYY(item.dateAdded)}</TableCell>
                <TableCell>{item.location}</TableCell>
                {columns.purchaseWarranty ? (
                  <TableCell>
                    {[item.purchaseDate, item.warrantyEndDate].filter(Boolean).map((value) => formatDateDDMMYYYY(value!)).join(" / ") || "—"}
                  </TableCell>
                ) : null}
                <TableCell>
                  <InventoryItemActionsMenu
                    item={item}
                    onRecordMovement={canMove ? (it) => openMovement([it]) : undefined}
                    onMoveToGroup={canMoveGroup ? (it) => openMove([it]) : undefined}
                    menuTrigger={
                      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${item.serialNumber}`}>
                        <MoreHorizontal className="size-4" aria-hidden />
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {focusedItem ? (
        <>
          <ConvertToSaleDialog open={convertOpen} serial={focusedItem.serialNumber} onOpenChange={setConvertOpen} />
          <ExtendHoldingDialog
            open={extendOpen}
            itemId={focusedItem.id}
            serial={focusedItem.serialNumber}
            onOpenChange={setExtendOpen}
          />
        </>
      ) : null}
      <RecordStockMovementDialog
        open={movementOpen}
        onOpenChange={(open) => {
          setMovementOpen(open)
          if (!open) setMovementItems([])
        }}
        items={movementItems}
      />
      <ChangeGroupDialog
        open={groupOpen}
        onOpenChange={setGroupOpen}
        kits={selected}
        onSaved={async () => {
          setSelectedIds(new Set())
          await refetchLedger()
        }}
      />
      <MoveItemsDialog
        open={moveOpen}
        onOpenChange={(open) => {
          setMoveOpen(open)
          if (!open) setMoveItems([])
        }}
        items={moveItems}
        onMoved={() => setSelectedIds(new Set())}
      />
    </div>
  )
}
