"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { clients, LOCATIONS } from "@/lib/data"
import { useInventoryStore } from "@/lib/inventory-store"
import {
  ScanBarcode,
  Camera,
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  RotateCcw,
  FileText,
  Package,
  ArrowLeftRight,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

const transactionTypes = [
  { value: "Inbound", label: "Inbound", icon: ArrowDownLeft, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10", desc: "Receive stock from supplier" },
  { value: "Outbound", label: "Outbound", icon: ArrowUpRight, color: "text-red-500 dark:text-red-400", bg: "bg-red-500/10", desc: "Ship stock to client" },
  { value: "POC Out", label: "POC Out", icon: Send, color: "text-cyan-600 dark:text-cyan-400", bg: "bg-cyan-500/10", desc: "Send for proof of concept" },
  { value: "POC Return", label: "POC Return", icon: RotateCcw, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", desc: "Receive POC return" },
  { value: "Transfer", label: "Transfer", icon: ArrowLeftRight, color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500/10", desc: "Move between locations" },
  { value: "Dispose", label: "Dispose", icon: Trash2, color: "text-slate-600 dark:text-slate-400", bg: "bg-slate-500/10", desc: "Dispose of asset" },
]

export function StockMovementContent() {
  const { applyMovement } = useInventoryStore()
  const [selectedType, setSelectedType] = useState<string>("Inbound")
  const [serialNumbers, setSerialNumbers] = useState("")
  const [clientId, setClientId] = useState<string>("")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [notes, setNotes] = useState("")
  const [fromLocation, setFromLocation] = useState<string>("")
  const [toLocation, setToLocation] = useState<string>("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  const serialsList = serialNumbers
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const scannedCount = serialsList.length
  const clientDisplay = clientId ? clients.find((c) => c.id === clientId)?.company ?? clientId : "Not selected"

  function handleSubmit() {
    if (serialsList.length === 0) {
      toast.error("Scan or enter at least one serial number")
      return
    }
    if ((selectedType === "Outbound" || selectedType === "POC Out") && !clientId) {
      toast.error("Select a client for this transaction type")
      return
    }
    if (selectedType === "Transfer" && (!fromLocation || !toLocation)) {
      toast.error("Select From and To location for transfer")
      return
    }
    if (selectedType === "Transfer" && fromLocation === toLocation) {
      toast.error("From and To locations must be different")
      return
    }
    setIsSubmitting(true)
    const result = applyMovement({
      type: selectedType as "Inbound" | "Outbound" | "POC Out" | "POC Return" | "Transfer" | "Dispose",
      serialNumbers: serialsList,
      clientId: clientId || undefined,
      fromLocation: selectedType === "Transfer" ? fromLocation : undefined,
      toLocation: selectedType === "Transfer" || selectedType === "POC Return" ? toLocation || undefined : undefined,
      assignedTo: clientId ? clients.find((c) => c.id === clientId)?.company : undefined,
      invoiceNumber: invoiceNumber.trim() || undefined,
      notes: notes.trim() || undefined,
    })
    setIsSubmitting(false)
    if (result.success.length > 0) {
      toast.success(`Recorded ${result.success.length} item(s)`)
      setSerialNumbers("")
      setInvoiceNumber("")
      setNotes("")
    }
    if (result.notFound.length > 0) {
      toast.warning(`Serial number(s) not found: ${result.notFound.join(", ")}`)
    }
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      {/* Header */}
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Stock Movement</h1>
        <p className="text-sm text-muted-foreground mt-1">Record inbound and outbound stock transactions.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {/* Left: Form */}
        <div className="lg:col-span-2 flex flex-col gap-4 md:gap-5">
          {/* Transaction Type */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground">Transaction Type</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
                {transactionTypes.map((type) => {
                  const Icon = type.icon
                  const isActive = selectedType === type.value
                  return (
                    <button
                      key={type.value}
                      onClick={() => setSelectedType(type.value)}
                      className={cn(
                        "flex flex-col items-center gap-2 p-3 sm:p-4 rounded-xl border-2 transition-all text-center",
                        isActive
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/30 bg-card"
                      )}
                    >
                      <div className={cn("flex items-center justify-center w-9 sm:w-10 h-9 sm:h-10 rounded-lg", type.bg)}>
                        <Icon className={cn("w-4 sm:w-5 h-4 sm:h-5", type.color)} />
                      </div>
                      <span className={cn("text-xs sm:text-sm font-medium", isActive ? "text-primary" : "text-foreground")}>{type.label}</span>
                      <span className="text-[9px] sm:text-[10px] text-muted-foreground leading-tight hidden sm:block">{type.desc}</span>
                    </button>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Scan Input */}
          <Card className="border-dashed border-primary/30 bg-primary/[0.02]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                <ScanBarcode className="w-4 h-4 text-primary" />
                Scan Items
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Scan barcode or type serial number..."
                  className="flex-1 font-mono text-sm h-10 bg-card text-foreground border-border"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.currentTarget.value.trim()) {
                      setSerialNumbers((prev) => prev ? prev + "\n" + e.currentTarget.value.trim() : e.currentTarget.value.trim())
                      e.currentTarget.value = ""
                    }
                  }}
                />
                <Button size="icon" className="h-10 w-10 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90">
                  <Camera className="w-4 h-4" />
                  <span className="sr-only">Scan with camera</span>
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">
                  Bulk serial numbers (comma or newline separated; paste a list to add commas)
                </Label>
                <Textarea
                  placeholder="SL-001, SL-002, SL-003 or one per line..."
                  value={serialNumbers}
                  onChange={(e) => setSerialNumbers(e.target.value)}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text")
                    if (pasted.includes("\n") && !pasted.includes(",")) {
                      e.preventDefault()
                      setSerialNumbers((prev) => {
                        const normalized = pasted
                          .split(/\n+/)
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .join(", ")
                        return prev ? `${prev}, ${normalized}` : normalized
                      })
                    }
                  }}
                  className="font-mono text-xs min-h-[100px] sm:min-h-[120px] bg-card text-foreground border-border"
                />
              </div>
              {scannedCount > 0 && (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs bg-primary/10 text-primary border-0">
                    {scannedCount} item{scannedCount !== 1 ? "s" : ""} scanned
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setSerialNumbers("")}
                  >
                    Clear all
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Additional Details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
                Transaction Details
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {(selectedType === "Outbound" || selectedType === "POC Out") && (
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Client / Customer (assigned to)</Label>
                  <Select value={clientId} onValueChange={setClientId}>
                    <SelectTrigger className="bg-card text-foreground border-border">
                      <SelectValue placeholder="Select client..." />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map((client) => (
                        <SelectItem key={client.id} value={client.id}>
                          {client.name} - {client.company}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {selectedType === "Transfer" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">From Location</Label>
                    <Select value={fromLocation} onValueChange={setFromLocation}>
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {LOCATIONS.map((loc) => (
                          <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">To Location</Label>
                    <Select value={toLocation} onValueChange={setToLocation}>
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {LOCATIONS.map((loc) => (
                          <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {selectedType === "POC Return" && (
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Return To Location</Label>
                  <Select value={toLocation} onValueChange={setToLocation}>
                    <SelectTrigger className="bg-card text-foreground border-border">
                      <SelectValue placeholder="Select location..." />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCATIONS.map((loc) => (
                        <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Invoice Number</Label>
                  <Input
                    placeholder="e.g., INV-2024-0892"
                    className="font-mono text-sm bg-card text-foreground border-border"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-foreground">Notes / Description</Label>
                <Textarea
                  placeholder="Add any additional notes..."
                  className="min-h-[80px] bg-card text-foreground border-border"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <Button
                className="w-full sm:w-auto sm:self-end bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleSubmit}
                disabled={isSubmitting || scannedCount === 0}
              >
                <Package className="w-4 h-4 mr-1.5" />
                {isSubmitting ? "Submitting..." : "Submit Transaction"}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Right: Summary */}
        <div className="flex flex-col gap-4 md:gap-5">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground">Transaction Summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Type</span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-xs border-0",
                    selectedType === "Inbound" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                    selectedType === "Outbound" && "bg-red-500/10 text-red-500 dark:text-red-400",
                    selectedType === "POC Out" && "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
                    selectedType === "POC Return" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                    selectedType === "Transfer" && "bg-violet-500/10 text-violet-600 dark:text-violet-400",
                    selectedType === "Dispose" && "bg-slate-500/10 text-slate-600 dark:text-slate-400",
                  )}
                >
                  {selectedType}
                </Badge>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Items Scanned</span>
                <span className="text-sm font-semibold text-foreground">{scannedCount}</span>
              </div>
              {(selectedType === "Outbound" || selectedType === "POC Out") && (
                <div className="flex items-center justify-between py-2 border-b border-border">
                  <span className="text-sm text-muted-foreground">Client</span>
                  <span className="text-sm text-foreground">{clientDisplay}</span>
                </div>
              )}
              {selectedType === "Transfer" && (
                <>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">From</span>
                    <span className="text-sm text-foreground">{fromLocation || "—"}</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">To</span>
                    <span className="text-sm text-foreground">{toLocation || "—"}</span>
                  </div>
                </>
              )}
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Invoice</span>
                <span className="text-sm text-foreground">{invoiceNumber || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">Notes</span>
                <span className="text-sm text-foreground truncate max-w-[140px]" title={notes}>{notes || "—"}</span>
              </div>
            </CardContent>
          </Card>

          {/* Scanned Items Preview */}
          {scannedCount > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-foreground">Scanned Items</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {serialNumbers
                  .split("\n")
                  .filter((s) => s.trim())
                  .map((serial, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary"
                    >
                      <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                        <span className="text-[10px] font-bold text-primary">{i + 1}</span>
                      </div>
                      <span className="font-mono text-xs text-foreground truncate">{serial.trim()}</span>
                    </div>
                  ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
