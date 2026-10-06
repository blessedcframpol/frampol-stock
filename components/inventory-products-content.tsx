"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Download, MoreHorizontal, Plus } from "lucide-react"
import { toast } from "sonner"
import { pageTitleClass } from "@/components/page-nav"
import { EmptyState } from "@/components/fs/empty-state"
import { clearAllLabel, FilterChip, type FilterChipModel } from "@/components/fs/filter-chip"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { StatusPill } from "@/components/fs/status-pill"
import { tableNumericClass } from "@/components/fs/data-table"
import { MoveItemsDialog } from "@/components/move-items-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { useLowStockProducts } from "@/hooks/use-low-stock-products"
import { useAuth } from "@/lib/auth-context"
import { LOCATIONS, type InventoryItem } from "@/lib/data"
import { downloadCsv } from "@/lib/download-csv"
import { filterOnHandInventory } from "@/lib/inventory-visibility"
import { useInventoryStore } from "@/lib/inventory-store"
import {
  inStockPoolCounts,
  buildInventoryProducts,
  canEditReorderLevel,
  canExportInventory,
  filterInventoryProducts,
  formatPocRental,
  hasProductRowMenu,
  lowStockChipCount,
  parseReorderDraft,
  productRowActions,
  sortInventoryProducts,
  vendorChipSelected,
  vendorChips,
  type InventoryProductRow,
  type ProductSortKey,
} from "@/lib/inventory-products"
import {
  fetchAppSettings,
  fetchProductLineSettings,
  SETTINGS_UPDATED_EVENT,
  updateProductLineSetting,
  type ProductLineSetting,
} from "@/lib/settings"
import { buildStockTakeUrl } from "@/lib/stock-take"
import { buildCsvFilename } from "@/lib/utils"
import { formatCount } from "@/lib/format-display"

const VENDOR_LABELS = ["Starlink", "Fortinet"]

function productHref(productId: string): string {
  return `/inventory/${encodeURIComponent(productId)}`
}

function ReorderEditor({
  row,
  fallback,
  onSave,
}: {
  row: InventoryProductRow
  fallback: number
  onSave: (value: number | null) => Promise<void>
}) {
  const [draft, setDraft] = useState(row.reorderLevel == null ? "" : String(row.reorderLevel))
  const skipBlur = useRef(false)

  async function commit() {
    const parsed = parseReorderDraft(draft)
    if (!parsed.ok) {
      toast.error("Reorder level must be a whole number")
      setDraft(row.reorderLevel == null ? "" : String(row.reorderLevel))
      return
    }
    if (parsed.value === row.reorderLevel) return
    await onSave(parsed.value)
  }

  return (
    <Input
      type="number"
      min={0}
      step={1}
      inputMode="numeric"
      aria-label={`Reorder level for ${row.productName}`}
      placeholder={String(fallback)}
      value={draft}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (skipBlur.current) {
          skipBlur.current = false
          return
        }
        void commit()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          skipBlur.current = true
          setDraft(row.reorderLevel == null ? "" : String(row.reorderLevel))
          event.currentTarget.blur()
        }
        if (event.key === "Enter") {
          event.preventDefault()
          event.stopPropagation()
          skipBlur.current = true
          void commit()
          event.currentTarget.blur()
        }
      }}
      className="h-8 w-20 border-0 bg-transparent px-0 text-right tabular-nums shadow-none focus-visible:bg-card"
    />
  )
}

export function InventoryProductsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { role } = useAuth()
  const { inventory } = useInventoryStore()
  const { products: lowStock, refresh } = useLowStockProducts()
  const [lines, setLines] = useState<ProductLineSetting[]>([])
  const [linesReady, setLinesReady] = useState(false)
  const [defaultReorder, setDefaultReorder] = useState(2)
  const [query, setQuery] = useState("")
  const [vendor, setVendor] = useState("all")
  const [lowOnly, setLowOnly] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [sortKey, setSortKey] = useState<ProductSortKey>("default")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [addOpen, setAddOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveItems, setMoveItems] = useState<InventoryItem[]>([])

  const canEdit = canEditReorderLevel(role)
  const canExport = canExportInventory(role)
  const showMenu = hasProductRowMenu(role)
  const onHand = useMemo(() => filterOnHandInventory(inventory), [inventory])

  const loadLines = useCallback(async () => {
    try {
      const [nextLines, settings] = await Promise.all([fetchProductLineSettings(), fetchAppSettings()])
      setLines(nextLines)
      setDefaultReorder(settings.defaultReorderLevel)
      setLinesReady(true)
    } catch (caught) {
      setLinesReady(true)
      toast.error(caught instanceof Error ? caught.message : "Could not load products")
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([fetchProductLineSettings(), fetchAppSettings()])
      .then(([nextLines, settings]) => {
        if (cancelled) return
        setLines(nextLines)
        setDefaultReorder(settings.defaultReorderLevel)
        setLinesReady(true)
      })
      .catch((caught) => {
        if (cancelled) return
        setLinesReady(true)
        toast.error(caught instanceof Error ? caught.message : "Could not load products")
      })
    const handle = () => void loadLines()
    window.addEventListener(SETTINGS_UPDATED_EVENT, handle)
    return () => {
      cancelled = true
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handle)
    }
  }, [loadLines])

  const rows = useMemo(
    () => (linesReady ? buildInventoryProducts(lowStock, lines, inventory, defaultReorder) : []),
    [linesReady, lowStock, lines, inventory, defaultReorder],
  )
  const chips = useMemo(() => vendorChips(rows), [rows])
  const lowCount = useMemo(() => lowStockChipCount(rows), [rows])
  const activeCount = useMemo(() => rows.filter((row) => row.isActive).length, [rows])
  const pools = useMemo(() => inStockPoolCounts(inventory), [inventory])
  const visible = useMemo(
    () =>
      sortInventoryProducts(
        filterInventoryProducts(rows, { query, vendor, lowOnly, showInactive }),
        sortKey,
        sortDir,
      ),
    [rows, query, vendor, lowOnly, showInactive, sortKey, sortDir],
  )

  const groupParam = searchParams.get("group")?.trim() ?? ""
  const [seededGroup, setSeededGroup] = useState("")
  if (groupParam && groupParam !== seededGroup && rows.length > 0) {
    const matches = rows.filter((row) => row.productName === groupParam)
    if (matches.length !== 1) {
      setSeededGroup(groupParam)
      setQuery(groupParam)
    }
  }

  useEffect(() => {
    const serial = searchParams.get("serial")?.trim()
    if (serial) {
      const match = inventory.find((item) => item.serialNumber === serial && item.productId && !item.deletedAt)
      if (match?.productId) {
        router.replace(`${productHref(match.productId)}?serial=${encodeURIComponent(serial)}`)
      }
      return
    }
    const group = searchParams.get("group")?.trim()
    if (!group || rows.length === 0) return
    const matches = rows.filter((row) => row.productName === group)
    if (matches.length === 1) router.replace(productHref(matches[0].productId))
  }, [inventory, router, rows, searchParams])

  const activeFilters: FilterChipModel[] = []
  if (vendor !== "all") activeFilters.push({ id: vendor, label: vendor })
  if (lowOnly) activeFilters.push({ id: "low", label: "Low stock" })

  function toggleSort(key: Exclude<ProductSortKey, "default">) {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(key)
    setSortDir(key === "product" || key === "vendor" || key === "status" ? "asc" : "desc")
  }

  async function saveReorder(row: InventoryProductRow, reorderLevel: number | null) {
    try {
      await updateProductLineSetting(row.productId, { reorderLevel, isActive: row.isActive })
      await Promise.all([loadLines(), refresh()])
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save reorder level")
    }
  }

  async function toggleActive(row: InventoryProductRow) {
    try {
      await updateProductLineSetting(row.productId, {
        reorderLevel: row.reorderLevel,
        isActive: !row.isActive,
      })
      await Promise.all([loadLines(), refresh()])
      toast.success(row.isActive ? "Product marked inactive" : "Product marked active")
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not update the product")
    }
  }

  function exportRows(list: InventoryProductRow[], filenameParts: string[]) {
    const csv: string[][] = [["Product", "Vendor", "In stock", "POC", "Rental", "Reorder at", "Status"]]
    for (const row of list) {
      const status = !row.isActive ? "Inactive" : row.isLow ? "Low" : ""
      csv.push([
        row.productName,
        row.vendor,
        String(row.inStockCount),
        String(row.pocCount),
        String(row.rentalCount),
        row.reorderLevel == null ? "" : String(row.reorderLevel),
        status,
      ])
    }
    downloadCsv(csv, buildCsvFilename(filenameParts, new Date().toISOString()))
    toast.success("Product CSV downloaded")
  }

  function exportProductSerials(row: InventoryProductRow) {
    const serials = onHand.filter((item) => item.productId === row.productId)
    const csv: string[][] = [["Serial Number", "Name", "Vendor", "Status", "Location", "Date Added"]]
    for (const item of serials) {
      csv.push([item.serialNumber, item.name, row.vendor, item.status, item.location, item.dateAdded])
    }
    downloadCsv(csv, buildCsvFilename([row.vendor, row.productName, "items"], new Date().toISOString()))
    toast.success("Item-level CSV downloaded")
  }

  function openMove(row: InventoryProductRow) {
    const items = onHand.filter((item) => item.productId === row.productId)
    if (items.length === 0) {
      toast.error("No in-stock items to move")
      return
    }
    setMoveItems(items)
    setMoveOpen(true)
  }

  const vendorOptions = useMemo(() => {
    const names = new Set<string>(VENDOR_LABELS)
    for (const row of rows) names.add(row.vendor)
    return [...names].sort()
  }, [rows])

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className={pageTitleClass}>Inventory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {linesReady
              ? `${formatCount(activeCount)} products · ${formatCount(pools.inStock)} items in stock · Available for sale ${formatCount(pools.sale)} · Rental ${formatCount(pools.rental)} · Demo ${formatCount(pools.demo)}`
              : "Loading products"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canExport ? (
            <Button type="button" variant="ghost" onClick={() => exportRows(visible, ["inventory", "products"])}>
              <Download className="size-4" aria-hidden />
              Export
            </Button>
          ) : null}
          {canEdit ? <AddInventoryDialog open={addOpen} onOpenChange={setAddOpen} vendorOptions={vendorOptions} /> : null}
        </div>
      </div>

      <ListToolbar
        search={
          <ListToolbarSearch
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search product or vendor"
            aria-label="Search products"
          />
        }
        count={linesReady ? `${visible.length} of ${showInactive ? rows.length : activeCount}` : "Loading…"}
        secondary={
          <Button type="button" variant="ghost" onClick={() => setShowInactive((current) => !current)} aria-pressed={showInactive}>
            {showInactive ? "Hide inactive" : "Show inactive"}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <FilterChip
            key={chip.id}
            label={chip.label}
            count={chip.count}
            selected={vendorChipSelected(chip.id, vendor, lowOnly)}
            onSelect={() => {
              if (chip.id === "all") {
                setVendor("all")
                setLowOnly(false)
              } else setVendor((current) => (current === chip.id ? "all" : chip.id))
            }}
          />
        ))}
        <FilterChip
          label="Low stock"
          count={lowCount}
          selected={lowOnly}
          onSelect={() => setLowOnly((current) => !current)}
        />
        {activeFilters.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setVendor("all")
              setLowOnly(false)
            }}
            className="text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {clearAllLabel(activeFilters)}
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState message={linesReady ? "No products match these filters." : "Loading products."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label="Product" sortKey="product" activeKey={sortKey} direction={sortDir} onSort={toggleSort} />
              <SortableHead label="Vendor" sortKey="vendor" activeKey={sortKey} direction={sortDir} onSort={toggleSort} />
              <SortableHead label="In stock" sortKey="inStock" activeKey={sortKey} direction={sortDir} onSort={toggleSort} align="right" />
              <SortableHead label="POC/Rental out" sortKey="out" activeKey={sortKey} direction={sortDir} onSort={toggleSort} align="right" />
              <SortableHead label="Reorder at" sortKey="reorder" activeKey={sortKey} direction={sortDir} onSort={toggleSort} align="right" />
              <SortableHead label="Status" sortKey="status" activeKey={sortKey} direction={sortDir} onSort={toggleSort} />
              {showMenu ? <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => {
              const actions = productRowActions(role)
              const href = productHref(row.productId)
              const outLabel = formatPocRental(row.pocCount, row.rentalCount)
              return (
                <TableRow
                  key={row.productId}
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={(event) => {
                    const target = event.target as HTMLElement
                    if (target.closest("a, button, input")) return
                    router.push(href)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.target === event.currentTarget) {
                      router.push(href)
                    }
                  }}
                >
                  <TableCell>
                    <Link href={href} className="font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {row.productName}
                    </Link>
                  </TableCell>
                  <TableCell>{row.vendor}</TableCell>
                  <TableCell className={tableNumericClass}>{row.inStockCount}</TableCell>
                  <TableCell className={tableNumericClass}>{outLabel || "—"}</TableCell>
                  <TableCell className={tableNumericClass}>
                    {canEdit ? (
                      <ReorderEditor
                        key={`${row.productId}:${row.reorderLevel ?? ""}`}
                        row={row}
                        fallback={defaultReorder}
                        onSave={(value) => saveReorder(row, value)}
                      />
                    ) : (
                      row.effectiveReorderLevel
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1">
                      {row.isLow ? <StatusPill value="Low" /> : null}
                      {!row.isActive ? <StatusPill value="Inactive" /> : null}
                    </span>
                  </TableCell>
                  {showMenu ? (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Actions for ${row.productName}`}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <MoreHorizontal className="size-4" aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {actions.move ? <DropdownMenuItem onSelect={() => openMove(row)}>Move group</DropdownMenuItem> : null}
                          {actions.stockTake ? (
                            <DropdownMenuItem asChild>
                              <Link href={buildStockTakeUrl({ vendor: row.vendor, product: row.productName })}>Stock take</Link>
                            </DropdownMenuItem>
                          ) : null}
                          {actions.exportProduct ? (
                            <DropdownMenuItem onSelect={() => exportProductSerials(row)}>Export product</DropdownMenuItem>
                          ) : null}
                          {actions.toggleActive ? (
                            <DropdownMenuItem onSelect={() => void toggleActive(row)}>
                              {row.isActive ? "Mark inactive" : "Mark active"}
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      <MoveItemsDialog
        open={moveOpen}
        onOpenChange={(open) => {
          setMoveOpen(open)
          if (!open) setMoveItems([])
        }}
        items={moveItems}
      />
    </div>
  )
}

function SortableHead({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  align,
}: {
  label: string
  sortKey: Exclude<ProductSortKey, "default">
  activeKey: ProductSortKey
  direction: "asc" | "desc"
  onSort: (key: Exclude<ProductSortKey, "default">) => void
  align?: "right"
}) {
  const active = activeKey === sortKey
  return (
    <TableHead aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-ring ${align === "right" ? "ml-auto block" : ""}`}
      >
        {label}
      </button>
    </TableHead>
  )
}

function AddInventoryDialog({
  open,
  onOpenChange,
  vendorOptions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  vendorOptions: string[]
}) {
  const { addItem } = useInventoryStore()
  const [serial, setSerial] = useState("")
  const [name, setName] = useState("")
  const [vendor, setVendor] = useState("")
  const [newVendor, setNewVendor] = useState("")
  const [location, setLocation] = useState("Warehouse A")
  const [purchaseDate, setPurchaseDate] = useState("")
  const [warrantyEnd, setWarrantyEnd] = useState("")

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setVendor("")
          setNewVendor("")
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <Plus className="size-4" aria-hidden />
          Add inventory
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100vw-2rem)] bg-card text-card-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground">Add New Item</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-4"
          onSubmit={async (event) => {
            event.preventDefault()
            const effectiveVendor = vendor === "__new__" ? newVendor.trim() : vendor
            if (!serial.trim() || !name.trim()) return
            if (!effectiveVendor) {
              toast.error("Please select or enter a vendor")
              return
            }
            try {
              await addItem({
                serialNumber: serial.trim(),
                name: name.trim(),
                vendor: effectiveVendor,
                status: "In Stock",
                dateAdded: new Date().toISOString().slice(0, 10),
                location,
                purchaseDate: purchaseDate.trim() || undefined,
                warrantyEndDate: warrantyEnd.trim() || undefined,
              })
              setSerial("")
              setName("")
              setVendor("")
              setNewVendor("")
              setLocation("Warehouse A")
              setPurchaseDate("")
              setWarrantyEnd("")
              onOpenChange(false)
              toast.success("Item added to inventory")
            } catch {
              toast.error("Could not add item")
            }
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label className="text-foreground">Serial Number</Label>
              <Input required value={serial} onChange={(event) => setSerial(event.target.value)} className="border-border bg-card font-mono text-foreground" placeholder="e.g., SL-2024-00146" />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label className="text-foreground">Item Name</Label>
              <Input required value={name} onChange={(event) => setName(event.target.value)} className="border-border bg-card text-foreground" placeholder="e.g., Starlink Standard Kit v3" />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label className="text-foreground">Vendor</Label>
              <Select value={vendor || ""} onValueChange={setVendor}>
                <SelectTrigger className="border-border bg-card text-foreground">
                  <SelectValue placeholder="Select vendor" />
                </SelectTrigger>
                <SelectContent>
                  {vendorOptions.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                  <SelectItem value="__new__">Add new vendor…</SelectItem>
                </SelectContent>
              </Select>
              {vendor === "__new__" ? (
                <Input value={newVendor} onChange={(event) => setNewVendor(event.target.value)} placeholder="Enter new vendor name" className="border-border bg-card text-foreground" />
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-foreground">Location</Label>
              <Select value={location} onValueChange={setLocation}>
                <SelectTrigger className="border-border bg-card text-foreground">
                  <SelectValue placeholder="Select location" />
                </SelectTrigger>
                <SelectContent>
                  {LOCATIONS.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-foreground">Purchase Date (optional)</Label>
              <Input type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} className="border-border bg-card text-foreground" />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-foreground">Warranty / support end (optional)</Label>
              <Input type="date" value={warrantyEnd} onChange={(event) => setWarrantyEnd(event.target.value)} className="border-border bg-card text-foreground" />
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <Button type="submit">Add Item</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
