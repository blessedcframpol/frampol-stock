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
import { LOCATIONS, type InventoryItem, type ItemStatus, type ItemType } from "@/lib/data"
import { useInventoryStore } from "@/lib/inventory-store"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const statusStyles: Record<ItemStatus, string> = {
  "In Stock": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sold: "bg-red-500/10 text-red-500 dark:text-red-400",
  POC: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  Maintenance: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Disposed: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

type ItemGroup = {
  name: string
  itemType: ItemType
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
    itemType: items[0].itemType,
    items,
    count: items.length,
  }))
}

const CATEGORY_LABELS: Record<string, string> = {
  Starlink: "Starlink",
  Fortinet: "Fortinet",
}

export function InventoryContent() {
  const searchParams = useSearchParams()
  const { inventory, addItem } = useInventoryStore()
  const [search, setSearch] = useState("")

  const serialFromUrl = searchParams.get("serial")
  useEffect(() => {
    if (serialFromUrl) setSearch(serialFromUrl)
  }, [serialFromUrl])
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null)
  const [itemView, setItemView] = useState<"list" | "card">("list")
  const [groupSearch, setGroupSearch] = useState("")
  const [addSerial, setAddSerial] = useState("")
  const [addName, setAddName] = useState("")
  const [addType, setAddType] = useState<ItemType>("Starlink Kit")
  const [addCategory, setAddCategory] = useState<string>("")
  const [addLocation, setAddLocation] = useState("Warehouse A")
  const [addPurchaseDate, setAddPurchaseDate] = useState("")
  const [addWarrantyEnd, setAddWarrantyEnd] = useState("")
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  const categories = useMemo(
    () => [...new Set(inventory.map((i) => i.category).filter(Boolean))].sort() as string[],
    [inventory]
  )
  const groups = useMemo(() => groupInventoryItems(inventory), [inventory])
  const groupsInCategory = useMemo(
    () => (selectedCategory ? groupInventoryItems(inventory.filter((i) => i.category === selectedCategory)) : []),
    [inventory, selectedCategory]
  )

  const filteredGroups = useMemo(() => {
    const list = selectedCategory && selectedCategory !== "__flat__" ? groupsInCategory : groups
    return list.filter((g) => {
      const matchesSearch =
        g.name.toLowerCase().includes(groupSearch.toLowerCase()) ||
        g.itemType.toLowerCase().includes(groupSearch.toLowerCase())
      const matchesType = typeFilter === "all" || g.itemType === typeFilter
      return matchesSearch && matchesType
    })
  }, [selectedCategory, groupsInCategory, groups, groupSearch, typeFilter])

  const selectedGroup = selectedGroupName
    ? (selectedCategory && selectedCategory !== "__flat__"
        ? groupsInCategory.find((g) => g.name === selectedGroupName)
        : groups.find((g) => g.name === selectedGroupName))
    : null

  const itemsInGroup = useMemo(() => {
    if (!selectedGroup) return []
    return selectedGroup.items.filter((i) => !selectedCategory || i.category === selectedCategory)
  }, [selectedGroup, selectedCategory])

  const filteredItems = useMemo(() => {
    return itemsInGroup.filter((item) => {
      const matchesSearch =
        item.serialNumber.toLowerCase().includes(search.toLowerCase()) ||
        item.name.toLowerCase().includes(search.toLowerCase())
      return matchesSearch
    })
  }, [itemsInGroup, search])

  const itemTypes: ItemType[] = ["Starlink Kit", "Laptop", "Desktop", "Router", "Switch", "Access Point", "UPS", "Monitor"]

  const showCategoriesView = categories.length > 0 && selectedCategory === null && selectedGroupName === null
  const showProductTypesView = (categories.length === 0 || selectedCategory !== null) && selectedGroupName === null
  const showItemsView = selectedGroupName !== null

  // —— Level 1: Categories (Starlink, Fortinet)
  if (showCategoriesView) {
    return (
      <div className="flex flex-col gap-4 md:gap-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Inventory</h1>
            <p className="text-sm text-muted-foreground mt-1">Select a category to view product types and items.</p>
          </div>
          <div className="flex rounded-md border border-border overflow-hidden shrink-0">
            <Button
              variant="secondary"
              size="sm"
              className="rounded-none h-9 px-3 text-foreground gap-1.5"
              onClick={() => {}}
            >
              <Layers className="w-4 h-4" />
              <span className="text-xs font-medium hidden sm:inline">By category</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-none h-9 px-3 text-foreground gap-1.5"
              onClick={() => setSelectedCategory("__flat__")}
            >
              <List className="w-4 h-4" />
              <span className="text-xs font-medium hidden sm:inline">All types</span>
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          {categories.map((cat) => {
            const count = inventory.filter((i) => i.category === cat).length
            return (
              <Card
                key={cat}
                className="cursor-pointer border-border hover:border-primary/50 hover:bg-muted/30 transition-colors"
                onClick={() => setSelectedCategory(cat)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      {CATEGORY_LABELS[cat] ?? cat}
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

  // —— Level 2: Product types (groups) – or flat groups when no categories
  if (showProductTypesView) {
    const isFlatView = selectedCategory === "__flat__"
    return (
      <div className="flex flex-col gap-4 md:gap-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {selectedCategory && selectedCategory !== "__flat__" && (
              <Button
                variant="ghost"
                size="sm"
                className="w-fit -ml-2 text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedCategory(null)}
              >
                <ArrowLeft className="w-4 h-4 mr-1.5" />
                Back to categories
              </Button>
            )}
            <div>
              <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">
                {selectedCategory && selectedCategory !== "__flat__"
                  ? `${CATEGORY_LABELS[selectedCategory] ?? selectedCategory} – product types`
                  : "Inventory"}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {filteredGroups.length} product type{filteredGroups.length !== 1 ? "s" : ""} · {inventory.length} items total
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-md border border-border overflow-hidden">
              <Button
                variant={!isFlatView ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none h-9 px-3 text-foreground gap-1.5"
                onClick={() => setSelectedCategory(null)}
              >
                <Layers className="w-4 h-4" />
                <span className="text-xs font-medium hidden sm:inline">By category</span>
              </Button>
              <Button
                variant={isFlatView ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none h-9 px-3 text-foreground gap-1.5"
                onClick={() => setSelectedCategory("__flat__")}
              >
                <List className="w-4 h-4" />
                <span className="text-xs font-medium hidden sm:inline">All types</span>
              </Button>
            </div>
            <Button variant="outline" size="sm" className="text-foreground">
              <Download className="w-4 h-4 mr-1.5" />
              <span className="hidden sm:inline">Export</span>
            </Button>
            <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
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
                    if (!addSerial.trim() || !addName.trim()) return
                    const dateAdded = new Date().toISOString().slice(0, 10)
                    addItem({
                      serialNumber: addSerial.trim(),
                      name: addName.trim(),
                      itemType: addType,
                      category: addCategory || undefined,
                      status: "In Stock",
                      dateAdded,
                      location: addLocation,
                      purchaseDate: addPurchaseDate.trim() || undefined,
                      warrantyEndDate: addWarrantyEnd.trim() || undefined,
                    })
                    setAddSerial("")
                    setAddName("")
                    setAddType("Starlink Kit")
                    setAddCategory("")
                    setAddLocation("Warehouse A")
                    setAddPurchaseDate("")
                    setAddWarrantyEnd("")
                    setAddDialogOpen(false)
                    toast.success("Item added to inventory")
                  }}
                >
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">Serial Number</Label>
                    <Input placeholder="e.g., SL-2024-00146" className="font-mono bg-card text-foreground border-border" value={addSerial} onChange={(e) => setAddSerial(e.target.value)} required />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">Item Name</Label>
                    <Input placeholder="e.g., Starlink Standard Kit v3" className="bg-card text-foreground border-border" value={addName} onChange={(e) => setAddName(e.target.value)} required />
                  </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Category (optional)</Label>
                      <Select value={addCategory || "none"} onValueChange={(v) => setAddCategory(v === "none" ? "" : v)}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="Starlink">Starlink</SelectItem>
                          <SelectItem value="Fortinet">Fortinet</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Item Type</Label>
                      <Select value={addType} onValueChange={(v) => setAddType(v as ItemType)}>
                        <SelectTrigger className="bg-card text-foreground border-border">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          {itemTypes.map((type) => (
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
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Purchase Date (optional)</Label>
                      <Input type="date" className="bg-card text-foreground border-border" value={addPurchaseDate} onChange={(e) => setAddPurchaseDate(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground">Warranty / support end (optional)</Label>
                      <Input type="date" className="bg-card text-foreground border-border" value={addWarrantyEnd} onChange={(e) => setAddWarrantyEnd(e.target.value)} />
                    </div>
                  </div>
                  <Button type="submit" className="mt-2 bg-primary text-primary-foreground hover:bg-primary/90">Add Item</Button>
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
                  placeholder="Search groups by name or type..."
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                  className="pl-9 font-mono text-sm h-9 bg-card text-foreground border-border"
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full sm:w-44 h-9 bg-card text-foreground border-border">
                  <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                  <SelectValue placeholder="Item Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {itemTypes.map((type) => (
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
                <p className="text-xs text-muted-foreground">{group.itemType}</p>
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
      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit -ml-2 text-muted-foreground hover:text-foreground"
          onClick={() => setSelectedGroupName(null)}
        >
          <ArrowLeft className="w-4 h-4 mr-1.5" />
          {selectedCategory && selectedCategory !== "__flat__" ? "Back to product types" : "Back to groups"}
        </Button>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">
              {selectedGroup?.name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {selectedGroup?.itemType} · {itemsInGroup.length} items
            </p>
          </div>
          <div className="flex items-center gap-2">
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

      {itemView === "list" && (
        <Card className="py-0 gap-0 overflow-hidden">
          <CardContent className="px-0 py-0 overflow-x-auto min-w-0">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent border-b border-border">
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
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                            <MoreHorizontal className="w-4 h-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem>View Details</DropdownMenuItem>
                          <DropdownMenuItem>Edit</DropdownMenuItem>
                          <DropdownMenuItem>Move Stock</DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredItems.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
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
            <Card key={item.id} className="border-border">
              <CardHeader className="pb-2">
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full mt-2 text-foreground">
                      <MoreHorizontal className="w-4 h-4 mr-1.5" />
                      Actions
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem>View Details</DropdownMenuItem>
                    <DropdownMenuItem>Edit</DropdownMenuItem>
                    <DropdownMenuItem>Move Stock</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
    </div>
  )
}
