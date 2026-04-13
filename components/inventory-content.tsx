"use client"

import { useState, useMemo, useEffect } from "react"
import { useSearchParams } from "next/navigation"
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
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { LOCATIONS, type InventoryItem, type ItemStatus, type DeviceTypeName } from "@/lib/data"
import { useInventoryStore } from "@/lib/inventory-store"
import { filterOnHandInventory } from "@/lib/inventory-visibility"
import { useAuth } from "@/lib/auth-context"
import { canEditInventory } from "@/lib/permissions"
import {
  Search,
  Plus,
  Filter,
  ChevronRight,
  MoreHorizontal,
  Download,
  ArrowLeft,
  LayoutList,
  LayoutGrid,
  Layers,
  List,
} from "lucide-react"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { InventoryItemActionsMenu } from "@/components/inventory-item-actions"
import { Checkbox } from "@/components/ui/checkbox"
import { RecordStockMovementDialog } from "@/components/record-stock-movement-dialog"

const statusStyles: Record<ItemStatus, string> = {
  "In Stock": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sold: "bg-red-500/10 text-red-500 dark:text-red-400",
  POC: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  Rented: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Maintenance: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Disposed: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

type ItemGroup = {
  name: string
  deviceType: DeviceTypeName
  items: InventoryItem[]
  count: number
}

function groupInventoryItems(items: InventoryItem[]): ItemGroup[] {
  const byName = new Map<string, InventoryItem[]>()
  for (const item of items) {
    const list = byName.get(item.name) ?? []
    list.push(item)
    byName.set(item.name, list)
  }
  return Array.from(byName.entries()).map(([name, items]) => ({
    name,
    deviceType: items[0].deviceType,
    items,
    count: items.length,
  }))
}

const VENDOR_LABELS: Record<string, string> = {
  Starlink: "Starlink",
  Fortinet: "Fortinet",
}

export function InventoryContent() {
  const searchParams = useSearchParams()
  const { inventory, transactions, addItem, deviceTypes, addDeviceType, archiveDeviceType, reassignInventoryGroup } = useInventoryStore()
  const onHandInventory = useMemo(() => filterOnHandInventory(inventory), [inventory])
  const { role } = useAuth()
  const isAdmin = canEditInventory(role)
  const [search, setSearch] = useState("")

  const serialFromUrl = searchParams.get("serial")
  const groupFromUrl = searchParams.get("group")
  useEffect(() => {
    if (serialFromUrl) setSearch(serialFromUrl)
  }, [serialFromUrl])
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null)
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null)
  const [itemView, setItemView] = useState<"list" | "card">("list")
  const [groupSearch, setGroupSearch] = useState("")
  const [addSerial, setAddSerial] = useState("")
  const [addName, setAddName] = useState("")
  const [addType, setAddType] = useState<DeviceTypeName>("Starlink Kit")
  const [addVendor, setAddVendor] = useState<string>("")
  const [addNewVendorName, setAddNewVendorName] = useState("")
  const [addLocation, setAddLocation] = useState("Warehouse A")
  const [addPurchaseDate, setAddPurchaseDate] = useState("")
  const [addWarrantyEnd, setAddWarrantyEnd] = useState("")
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [manageTypesOpen, setManageTypesOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [movementDialogOpen, setMovementDialogOpen] = useState(false)
  const [movementItems, setMovementItems] = useState<InventoryItem[]>([])
  const [newDeviceTypeName, setNewDeviceTypeName] = useState("")
  const [moveGroupOpen, setMoveGroupOpen] = useState(false)
  const [moveTargetGroupName, setMoveTargetGroupName] = useState("")
  const [moveTargetTypeId, setMoveTargetTypeId] = useState("")
  const [moveTargetVendor, setMoveTargetVendor] = useState("General")

  useEffect(() => {
    if (groupFromUrl?.trim()) setSelectedGroupName(groupFromUrl.trim())
  }, [groupFromUrl])
  useEffect(() => {
    setSelectedIds(new Set())
  }, [selectedGroupName])

  const vendorsFromInventory = useMemo(
    () => [...new Set(onHandInventory.map((i) => (i.vendor?.trim() ? i.vendor : "General")))].sort() as string[],
    [onHandInventory]
  )
  const vendors = useMemo(
    () => [...new Set([...Object.keys(VENDOR_LABELS), ...vendorsFromInventory])].sort(),
    [vendorsFromInventory]
  )
  const groups = useMemo(() => groupInventoryItems(onHandInventory), [onHandInventory])
  const groupsInVendor = useMemo(
    () =>
      selectedVendor
        ? groupInventoryItems(
            onHandInventory.filter((i) => (i.vendor?.trim() ? i.vendor : "General") === selectedVendor)
          )
        : [],
    [onHandInventory, selectedVendor]
  )

  const addVendorOptions = useMemo(
    () => [...new Set([...Object.keys(VENDOR_LABELS), ...vendorsFromInventory])].sort(),
    [vendorsFromInventory]
  )

  const filteredGroups = useMemo(() => {
    const list = selectedVendor && selectedVendor !== "__flat__" ? groupsInVendor : groups
    return list.filter((g) => {
      const matchesSearch =
        g.name.toLowerCase().includes(groupSearch.toLowerCase()) ||
        g.deviceType.toLowerCase().includes(groupSearch.toLowerCase())
      const matchesType = typeFilter === "all" || g.deviceType === typeFilter
      return matchesSearch && matchesType
    })
  }, [selectedVendor, groupsInVendor, groups, groupSearch, typeFilter])

  const itemsInViewCount = useMemo(
    () => filteredGroups.reduce((sum, g) => sum + g.count, 0),
    [filteredGroups]
  )

  const selectedGroup = selectedGroupName
    ? (selectedVendor && selectedVendor !== "__flat__"
        ? groupsInVendor.find((g) => g.name === selectedGroupName)
        : groups.find((g) => g.name === selectedGroupName))
    : null

  const itemsInGroup = useMemo(() => {
    if (!selectedGroup) return []
    return selectedGroup.items.filter(
      (i) => !selectedVendor || (i.vendor?.trim() ? i.vendor : "General") === selectedVendor
    )
  }, [selectedGroup, selectedVendor])

  const filteredItems = useMemo(() => {
    return itemsInGroup.filter((item) => {
      const matchesSearch =
        item.serialNumber.toLowerCase().includes(search.toLowerCase()) ||
        item.name.toLowerCase().includes(search.toLowerCase())
      return matchesSearch
    })
  }, [itemsInGroup, search])

  const selectedInFiltered = useMemo(
    () => filteredItems.filter((i) => selectedIds.has(i.id)),
    [filteredItems, selectedIds]
  )

  const allFilteredSelected =
    filteredItems.length > 0 && filteredItems.every((i) => selectedIds.has(i.id))

  function openRecordMovement(items: InventoryItem[]) {
    if (items.length === 0) {
      toast.error("Select at least one item")
      return
    }
    const names = new Set(items.map((i) => i.name))
    if (names.size > 1) {
      toast.error("Selected items must share the same product name")
      return
    }
    setMovementItems(items)
    setMovementDialogOpen(true)
  }

  function toggleSelectAllVisible(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      const ids = filteredItems.map((i) => i.id)
      if (checked) ids.forEach((id) => next.add(id))
      else ids.forEach((id) => next.delete(id))
      return next
    })
  }

  const deviceTypeNames: DeviceTypeName[] = useMemo(() => {
    const activeTypes = deviceTypes.filter((pt) => pt.active).map((pt) => pt.name)
    const fromInventory = onHandInventory.map((i) => i.deviceType).filter(Boolean)
    const combined = [...new Set(["General", ...activeTypes, ...fromInventory])]
    return combined.sort()
  }, [onHandInventory, deviceTypes])

  const showVendorsView = vendors.length > 0 && selectedVendor === null && selectedGroupName === null
  const showProductsView = (vendors.length === 0 || selectedVendor !== null) && selectedGroupName === null
  const showItemsView = selectedGroupName !== null

  const serialFromUrlForHistory = searchParams.get("serial")
  const kitHistoryForSerial = useMemo(() => {
    if (!serialFromUrlForHistory?.trim()) return []
    return transactions.filter((t) => t.serialNumber === serialFromUrlForHistory.trim())
  }, [transactions, serialFromUrlForHistory])

  const kitHistoryCard = serialFromUrlForHistory && kitHistoryForSerial.length >= 0 && (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">Kit history</CardTitle>
        <p className="text-xs text-muted-foreground">Serial: {serialFromUrlForHistory}</p>
      </CardHeader>
      <CardContent>
        {kitHistoryForSerial.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions recorded for this serial yet.</p>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-b border-border">
                  <TableHead className="text-xs text-muted-foreground font-medium">Date</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Type</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Item</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Client / Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kitHistoryForSerial.slice(0, 20).map((txn) => (
                  <TableRow key={txn.id} className="border-b border-border/50">
                    <TableCell className="text-sm text-muted-foreground">{formatDateDDMMYYYY(txn.date)}</TableCell>
                    <TableCell className="text-sm font-medium">{txn.type}</TableCell>
                    <TableCell className="text-sm">{txn.itemName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {txn.type === "Transfer" && txn.fromLocation && txn.toLocation ? `${txn.fromLocation} → ${txn.toLocation}` : txn.client}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {kitHistoryForSerial.length > 20 && (
              <p className="text-xs text-muted-foreground mt-2">Showing latest 20 of {kitHistoryForSerial.length} transactions.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )

  async function handleAddDeviceType() {
    const result = await addDeviceType(newDeviceTypeName)
    if (!result.ok) {
      toast.error(result.error ?? "Failed to add device type")
      return
    }
    toast.success("Device type added")
    setNewDeviceTypeName("")
  }

  async function handleArchiveDeviceType(id: string) {
    const result = await archiveDeviceType(id)
    if (!result.ok) {
      toast.error(result.error ?? "Failed to archive device type")
      return
    }
    toast.success("Device type archived")
  }

  async function handleMoveGroup() {
    if (!selectedGroup?.name) return
    const result = await reassignInventoryGroup({
      sourceGroupName: selectedGroup.name,
      targetGroupName: moveTargetGroupName.trim() || selectedGroup.name,
      targetDeviceTypeId: moveTargetTypeId || undefined,
      targetVendor: moveTargetVendor.trim() || "General",
    })
    if (!result.ok) {
      toast.error(result.error ?? "Failed to move group")
      return
    }
    toast.success(`Moved ${result.updated} item(s)`)
    setMoveGroupOpen(false)
    setMoveTargetGroupName("")
  }

  // —— Level 1: Vendors (Starlink, Fortinet, …)
  if (showVendorsView) {
    return (
      <div className="flex flex-col gap-4 md:gap-6">
        {kitHistoryCard}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Inventory</h1>
            <p className="text-sm text-muted-foreground mt-1">Select a vendor to view products and items.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-md border border-border overflow-hidden">
              <Button
                variant="secondary"
                size="sm"
                className="rounded-none h-9 px-3 text-foreground gap-1.5"
                onClick={() => {}}
              >
                <Layers className="w-4 h-4" />
                <span className="text-xs font-medium hidden sm:inline">By vendor</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-none h-9 px-3 text-foreground gap-1.5"
                onClick={() => setSelectedVendor("__flat__")}
              >
                <List className="w-4 h-4" />
                <span className="text-xs font-medium hidden sm:inline">All types</span>
              </Button>
            </div>
            <Dialog open={addDialogOpen} onOpenChange={(open) => { setAddDialogOpen(open); if (!open) { setAddNewVendorName(""); setAddVendor(""); } }}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90">
                  <Plus className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">Add Inventory</span>
                  <span className="sm:hidden">Add</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-2rem)] sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle className="text-foreground">Add New Item</DialogTitle>
                </DialogHeader>
                <form
                  className="flex flex-col gap-4 py-4"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const effectiveVendor = addVendor === "__new__" ? addNewVendorName.trim() : addVendor
                    if (!addSerial.trim() || !addName.trim()) return
                    if (!effectiveVendor) {
                      toast.error("Please select or enter a vendor")
                      return
                    }
                    const dateAdded = new Date().toISOString().slice(0, 10)
                    addItem({
                      serialNumber: addSerial.trim(),
                      name: addName.trim(),
                      deviceType: addType,
                      vendor: effectiveVendor,
                      status: "In Stock",
                      dateAdded,
                      location: addLocation,
                      purchaseDate: addPurchaseDate.trim() || undefined,
                      warrantyEndDate: addWarrantyEnd.trim() || undefined,
                    })
                    setAddSerial("")
                    setAddName("")
                    setAddType("Starlink Kit")
                    setAddVendor("")
                    setAddNewVendorName("")
                    setAddLocation("Warehouse A")
                    setAddPurchaseDate("")
                    setAddWarrantyEnd("")
                    setAddDialogOpen(false)
                    toast.success("Item added to inventory")
                  }}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2 sm:col-span-2">
                      <Label className="text-foreground">Serial Number</Label>
                      <Input placeholder="e.g., SL-2024-00146" className="font-mono bg-card text-foreground border-border" value={addSerial} onChange={(e) => setAddSerial(e.target.value)} required />
                    </div>
                    <div className="flex flex-col gap-2 sm:col-span-2">
                      <Label className="text-foreground">Item Name</Label>
                      <Input placeholder="e.g., Starlink Standard Kit v3" className="bg-card text-foreground border-border" value={addName} onChange={(e) => setAddName(e.target.value)} required />
                    </div>
                    <div className="flex flex-col gap-2 sm:col-span-2">
                      <Label className="text-foreground">Vendor</Label>
                      <Select value={addVendor || ""} onValueChange={(v) => setAddVendor(v)}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="Select vendor" />
                        </SelectTrigger>
                        <SelectContent>
                          {addVendorOptions.map((cat) => (
                            <SelectItem key={cat} value={cat}>{VENDOR_LABELS[cat] ?? cat}</SelectItem>
                          ))}
                          <SelectItem value="__new__">Add new vendor…</SelectItem>
                        </SelectContent>
                      </Select>
                      {addVendor === "__new__" && (
                        <Input
                          placeholder="Enter new vendor name"
                          className="bg-card text-foreground border-border"
                          value={addNewVendorName}
                          onChange={(e) => setAddNewVendorName(e.target.value)}
                        />
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Item Type</Label>
                      <Select value={addType} onValueChange={(v) => setAddType(v as DeviceTypeName)}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          {deviceTypeNames.map((type) => (
                            <SelectItem key={type} value={type}>{type}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Location</Label>
                      <Select value={addLocation} onValueChange={setAddLocation}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="Select location" />
                        </SelectTrigger>
                        <SelectContent>
                          {LOCATIONS.map((loc) => (
                            <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Purchase Date (optional)</Label>
                      <Input type="date" className="bg-card text-foreground border-border" value={addPurchaseDate} onChange={(e) => setAddPurchaseDate(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Warranty / support end (optional)</Label>
                      <Input type="date" className="bg-card text-foreground border-border" value={addWarrantyEnd} onChange={(e) => setAddWarrantyEnd(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex justify-end pt-2">
                    <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90">Add Item</Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          {vendors.map((cat) => {
            const count = onHandInventory.filter((i) => (i.vendor?.trim() ? i.vendor : "General") === cat).length
            return (
              <Card
                key={cat}
                className="cursor-pointer border-border hover:border-primary/50 hover:bg-muted/30 transition-colors"
                onClick={() => setSelectedVendor(cat)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      {VENDOR_LABELS[cat] ?? cat}
                    </CardTitle>
                    <ChevronRight className="w-5 h-5 shrink-0 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-2xl font-bold text-foreground">{count}</p>
                  <p className="text-xs text-muted-foreground">items</p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    )
  }

  // —— Level 2: Products (grouped by name) – or flat when no vendors
  if (showProductsView) {
    const isFlatView = selectedVendor === "__flat__"
    return (
      <div className="flex flex-col gap-4 md:gap-6">
        {kitHistoryCard}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {selectedVendor && selectedVendor !== "__flat__" && (
              <Button
                variant="ghost"
                size="sm"
                className="w-fit -ml-2 text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedVendor(null)}
              >
                <ArrowLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
            )}
            <div>
              <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">
                {selectedVendor && selectedVendor !== "__flat__"
                  ? `${VENDOR_LABELS[selectedVendor] ?? selectedVendor} – products`
                  : "Inventory"}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {filteredGroups.length} product{filteredGroups.length !== 1 ? "s" : ""} · {itemsInViewCount} items in view
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-md border border-border overflow-hidden">
              <Button
                variant={!isFlatView ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none h-9 px-3 text-foreground gap-1.5"
                onClick={() => setSelectedVendor(null)}
              >
                <Layers className="w-4 h-4" />
                <span className="text-xs font-medium hidden sm:inline">By vendor</span>
              </Button>
              <Button
                variant={isFlatView ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none h-9 px-3 text-foreground gap-1.5"
                onClick={() => setSelectedVendor("__flat__")}
              >
                <List className="w-4 h-4" />
                <span className="text-xs font-medium hidden sm:inline">All types</span>
              </Button>
            </div>
            <Button variant="outline" size="sm" className="text-foreground">
              <Download className="w-4 h-4 mr-1.5" />
              <span className="hidden sm:inline">Export</span>
            </Button>
            {isAdmin && (
              <Dialog open={manageTypesOpen} onOpenChange={setManageTypesOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-foreground">
                    Manage device types
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-2rem)] sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle className="text-foreground">Device types (Admin)</DialogTitle>
                  </DialogHeader>
                  <div className="flex flex-col gap-3 py-2">
                    <div className="flex gap-2">
                      <Input
                        placeholder="Add device type..."
                        value={newDeviceTypeName}
                        onChange={(e) => setNewDeviceTypeName(e.target.value)}
                      />
                      <Button onClick={handleAddDeviceType}>Add</Button>
                    </div>
                    <div className="max-h-72 overflow-y-auto border border-border rounded-md divide-y divide-border">
                      {deviceTypes
                        .filter((pt) => pt.active)
                        .map((pt) => (
                          <div key={pt.id} className="flex items-center justify-between px-3 py-2">
                            <span className="text-sm">{pt.name}</span>
                            {pt.name !== "General" && (
                              <Button variant="ghost" size="sm" onClick={() => void handleArchiveDeviceType(pt.id)}>
                                Archive
                              </Button>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}
            <Dialog open={addDialogOpen} onOpenChange={(open) => { setAddDialogOpen(open); if (!open) { setAddNewVendorName(""); setAddVendor(""); } }}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90">
                  <Plus className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">Add Inventory</span>
                  <span className="sm:hidden">Add</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-2rem)] sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle className="text-foreground">Add New Item</DialogTitle>
                </DialogHeader>
                <form
                  className="flex flex-col gap-4 py-4"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const effectiveVendor = addVendor === "__new__" ? addNewVendorName.trim() : addVendor
                    if (!addSerial.trim() || !addName.trim()) return
                    if (!effectiveVendor) {
                      toast.error("Please select or enter a vendor")
                      return
                    }
                    const dateAdded = new Date().toISOString().slice(0, 10)
                    addItem({
                      serialNumber: addSerial.trim(),
                      name: addName.trim(),
                      deviceType: addType,
                      vendor: effectiveVendor,
                      status: "In Stock",
                      dateAdded,
                      location: addLocation,
                      purchaseDate: addPurchaseDate.trim() || undefined,
                      warrantyEndDate: addWarrantyEnd.trim() || undefined,
                    })
                    setAddSerial("")
                    setAddName("")
                    setAddType("Starlink Kit")
                    setAddVendor("")
                    setAddNewVendorName("")
                    setAddLocation("Warehouse A")
                    setAddPurchaseDate("")
                    setAddWarrantyEnd("")
                    setAddDialogOpen(false)
                    toast.success("Item added to inventory")
                  }}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2 sm:col-span-2">
                      <Label className="text-foreground">Serial Number</Label>
                      <Input placeholder="e.g., SL-2024-00146" className="font-mono bg-card text-foreground border-border" value={addSerial} onChange={(e) => setAddSerial(e.target.value)} required />
                    </div>
                    <div className="flex flex-col gap-2 sm:col-span-2">
                      <Label className="text-foreground">Item Name</Label>
                      <Input placeholder="e.g., Starlink Standard Kit v3" className="bg-card text-foreground border-border" value={addName} onChange={(e) => setAddName(e.target.value)} required />
                    </div>
                    <div className="flex flex-col gap-2 sm:col-span-2">
                      <Label className="text-foreground">Vendor</Label>
                      <Select value={addVendor || ""} onValueChange={(v) => setAddVendor(v)}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="Select vendor" />
                        </SelectTrigger>
                        <SelectContent>
                          {addVendorOptions.map((cat) => (
                            <SelectItem key={cat} value={cat}>{VENDOR_LABELS[cat] ?? cat}</SelectItem>
                          ))}
                          <SelectItem value="__new__">Add new vendor…</SelectItem>
                        </SelectContent>
                      </Select>
                      {addVendor === "__new__" && (
                        <Input
                          placeholder="Enter new vendor name"
                          className="bg-card text-foreground border-border"
                          value={addNewVendorName}
                          onChange={(e) => setAddNewVendorName(e.target.value)}
                        />
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Item Type</Label>
                      <Select value={addType} onValueChange={(v) => setAddType(v as DeviceTypeName)}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          {deviceTypeNames.map((type) => (
                            <SelectItem key={type} value={type}>{type}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Location</Label>
                      <Select value={addLocation} onValueChange={setAddLocation}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="Select location" />
                        </SelectTrigger>
                        <SelectContent>
                          {LOCATIONS.map((loc) => (
                            <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Purchase Date (optional)</Label>
                      <Input type="date" className="bg-card text-foreground border-border" value={addPurchaseDate} onChange={(e) => setAddPurchaseDate(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Warranty / support end (optional)</Label>
                      <Input type="date" className="bg-card text-foreground border-border" value={addWarrantyEnd} onChange={(e) => setAddWarrantyEnd(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex justify-end pt-2">
                    <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90">Add Item</Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <Card className="py-4 gap-0">
          <CardContent>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search products by name or device type..."
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                  className="pl-9 font-mono text-sm h-9 bg-card text-foreground border-border"
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full sm:w-44 h-9 bg-card text-foreground border-border">
                  <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                  <SelectValue placeholder="Device type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All device types</SelectItem>
                  {deviceTypeNames.map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          {filteredGroups.map((group) => (
            <Card
              key={group.name}
              className="cursor-pointer border-border hover:border-primary/50 hover:bg-muted/30 transition-colors"
              onClick={() => setSelectedGroupName(group.name)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base font-semibold text-foreground line-clamp-2">
                    {group.name}
                  </CardTitle>
                  <ChevronRight className="w-5 h-5 shrink-0 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">{group.deviceType}</p>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-2xl font-bold text-foreground">{group.count}</p>
                <p className="text-xs text-muted-foreground">
                  {group.count === 1 ? "item" : "items"}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        {filteredGroups.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No product groups match your filters.
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  // —— Level 3: Group detail view (items in selected group, with list/card view)
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {kitHistoryCard}
      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit -ml-2 text-muted-foreground hover:text-foreground"
          onClick={() => setSelectedGroupName(null)}
        >
          <ArrowLeft className="w-4 h-4 mr-1.5" />
          {selectedVendor && selectedVendor !== "__flat__" ? "Back to products" : "Back to groups"}
        </Button>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">
              {selectedGroup?.name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {selectedGroup?.deviceType} · {itemsInGroup.length} in stock
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && selectedGroup && (
              <Dialog
                open={moveGroupOpen}
                onOpenChange={(open) => {
                  setMoveGroupOpen(open)
                  if (open) {
                    setMoveTargetGroupName(selectedGroup.name)
                    setMoveTargetTypeId(
                      deviceTypes.find((pt) => pt.name.toLowerCase() === selectedGroup.deviceType.toLowerCase())?.id ??
                        deviceTypes.find((pt) => pt.name === "General")?.id ??
                        ""
                    )
                    setMoveTargetVendor(selectedVendor && selectedVendor !== "__flat__" ? selectedVendor : "General")
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-foreground">
                    Move group
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-2rem)] sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle className="text-foreground">Move Group (Admin)</DialogTitle>
                  </DialogHeader>
                  <div className="flex flex-col gap-3 py-2">
                    <div className="text-xs text-muted-foreground">
                      Moving all items in <strong>{selectedGroup.name}</strong>.
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Group name</Label>
                      <Input value={moveTargetGroupName} onChange={(e) => setMoveTargetGroupName(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Device type</Label>
                      <Select value={moveTargetTypeId} onValueChange={setMoveTargetTypeId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          {deviceTypes
                            .filter((pt) => pt.active)
                            .map((pt) => (
                              <SelectItem key={pt.id} value={pt.id}>
                                {pt.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Vendor</Label>
                      <Input value={moveTargetVendor} onChange={(e) => setMoveTargetVendor(e.target.value)} />
                    </div>
                    <div className="flex justify-end">
                      <Button onClick={() => void handleMoveGroup()}>Apply move</Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}
            <div className="flex rounded-md border border-border overflow-hidden">
              <Button
                variant={itemView === "list" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none h-9 px-3 text-foreground"
                onClick={() => setItemView("list")}
              >
                <LayoutList className="w-4 h-4" />
                <span className="sr-only">List view</span>
              </Button>
              <Button
                variant={itemView === "card" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none h-9 px-3 text-foreground"
                onClick={() => setItemView("card")}
              >
                <LayoutGrid className="w-4 h-4" />
                <span className="sr-only">Card view</span>
              </Button>
            </div>
            <Button variant="outline" size="sm" className="text-foreground">
              <Download className="w-4 h-4 mr-1.5" />
              <span className="hidden sm:inline">Export</span>
            </Button>
          </div>
        </div>
      </div>

      <Card className="py-4 gap-0">
        <CardContent>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by serial number..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 font-mono text-sm h-9 bg-card text-foreground border-border max-w-sm"
            />
          </div>
        </CardContent>
      </Card>

      {selectedInFiltered.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span className="text-sm text-foreground">{selectedInFiltered.length} selected</span>
          <Button size="sm" type="button" onClick={() => openRecordMovement(selectedInFiltered)}>
            Record movement ({selectedInFiltered.length})
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {itemView === "list" && (
        <Card className="py-0 gap-0 overflow-hidden">
          <CardContent className="px-0 py-0 overflow-x-auto min-w-0">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent border-b border-border">
                  <TableHead className="w-10 px-2 text-muted-foreground">
                    <Checkbox
                      checked={allFilteredSelected}
                      onCheckedChange={(v) => toggleSelectAllVisible(v === true)}
                      aria-label="Select all items in this list"
                    />
                  </TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Serial Number</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Status</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium hidden md:table-cell">Assigned to</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium hidden md:table-cell">Date Added</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">Location</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">Purchase / Warranty</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium w-10">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={item.id} className="cursor-default">
                    <TableCell className="w-10 px-2 align-middle">
                      <Checkbox
                        checked={selectedIds.has(item.id)}
                        onCheckedChange={(v) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev)
                            if (v === true) next.add(item.id)
                            else next.delete(item.id)
                            return next
                          })
                        }}
                        aria-label={`Select ${item.serialNumber}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm text-foreground">{item.serialNumber}</TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn("text-[10px] font-medium border-0", statusStyles[item.status])}
                      >
                        {item.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground hidden md:table-cell">{item.assignedTo ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground hidden md:table-cell">{formatDateDDMMYYYY(item.dateAdded)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">{item.location}</TableCell>
                    <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">
                      {[item.purchaseDate, item.warrantyEndDate].filter(Boolean).map(formatDateDDMMYYYY).join(" / ") || "—"}
                    </TableCell>
                    <TableCell>
                      <InventoryItemActionsMenu
                        item={item}
                        onRecordMovement={(it) => openRecordMovement([it])}
                        menuTrigger={
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                            <MoreHorizontal className="w-4 h-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {filteredItems.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                      No items found in this group.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {itemView === "card" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
          {filteredItems.map((item) => (
            <Card key={item.id} className="border-border relative">
              <div className="absolute right-3 top-3 z-10">
                <Checkbox
                  checked={selectedIds.has(item.id)}
                  onCheckedChange={(v) => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev)
                      if (v === true) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }}
                  aria-label={`Select ${item.serialNumber}`}
                />
              </div>
              <CardHeader className="pb-2 pr-10">
                <CardTitle className="text-sm font-mono text-foreground truncate" title={item.serialNumber}>
                  {item.serialNumber}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <Badge
                    variant="secondary"
                    className={cn("text-[10px] font-medium border-0", statusStyles[item.status])}
                  >
                    {item.status}
                  </Badge>
                </div>
                {item.assignedTo && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Assigned to</span>
                    <span className="text-xs text-foreground truncate">{item.assignedTo}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Location</span>
                  <span className="text-xs text-foreground truncate">{item.location}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Date added</span>
                  <span className="text-xs text-foreground">{formatDateDDMMYYYY(item.dateAdded)}</span>
                </div>
                {(item.purchaseDate || item.warrantyEndDate) && (
                  <div className="flex flex-col gap-0.5">
                    {item.purchaseDate && <p className="text-[10px] text-muted-foreground">Purchase: {formatDateDDMMYYYY(item.purchaseDate)}</p>}
                    {item.warrantyEndDate && <p className="text-[10px] text-muted-foreground">Warranty end: {formatDateDDMMYYYY(item.warrantyEndDate)}</p>}
                  </div>
                )}
                <InventoryItemActionsMenu
                  item={item}
                  onRecordMovement={(it) => openRecordMovement([it])}
                  menuTrigger={
                    <Button variant="outline" size="sm" className="w-full mt-2 text-foreground">
                      <MoreHorizontal className="w-4 h-4 mr-1.5" />
                      Actions
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ))}
          {filteredItems.length === 0 && (
            <Card className="col-span-full">
              <CardContent className="py-12 text-center text-muted-foreground">
                No items found in this group.
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <RecordStockMovementDialog
        open={movementDialogOpen}
        onOpenChange={(open) => {
          setMovementDialogOpen(open)
          if (!open) setMovementItems([])
        }}
        items={movementItems}
      />
    </div>
  )
}
