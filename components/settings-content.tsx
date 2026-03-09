"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  getLowStockEmailsEnabled,
  setLowStockEmailsEnabled,
  getLowStockEmailRecipients,
  setLowStockEmailRecipients,
  getReorderLevelDefault,
  setReorderLevelDefault,
  getReorderLevelOverrides,
  setReorderLevelOverrides,
} from "@/lib/settings"
import { useInventoryStore } from "@/lib/inventory-store"
import { Mail, Package, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

function useProductNames(): string[] {
  const { inventory } = useInventoryStore()
  const names = Array.from(new Set(inventory.map((i) => i.name))).sort()
  return names
}

export function SettingsContent() {
  const productNames = useProductNames()
  const [emailsEnabled, setEmailsEnabledState] = useState(true)
  const [emailRecipients, setEmailRecipientsState] = useState<string[]>([])
  const [newEmail, setNewEmail] = useState("")
  const [reorderDefault, setReorderDefaultState] = useState(2)
  const [overrides, setOverridesState] = useState<Record<string, number>>({})

  useEffect(() => {
    setEmailsEnabledState(getLowStockEmailsEnabled())
    setEmailRecipientsState(getLowStockEmailRecipients())
    setReorderDefaultState(getReorderLevelDefault())
    setOverridesState(getReorderLevelOverrides())
  }, [])

  function addEmail() {
    const trimmed = newEmail.trim().toLowerCase()
    if (!trimmed) return
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!re.test(trimmed)) {
      toast.error("Enter a valid email address")
      return
    }
    if (emailRecipients.includes(trimmed)) {
      toast.error("That email is already in the list")
      return
    }
    const next = [...emailRecipients, trimmed]
    setEmailRecipientsState(next)
    setLowStockEmailRecipients(next)
    setNewEmail("")
    toast.success("Email added")
  }

  function removeEmail(email: string) {
    const next = emailRecipients.filter((e) => e !== email)
    setEmailRecipientsState(next)
    setLowStockEmailRecipients(next)
    toast.success("Email removed")
  }

  function toggleEmailsEnabled(checked: boolean) {
    setEmailsEnabledState(checked)
    setLowStockEmailsEnabled(checked)
    toast.success(checked ? "Low stock emails enabled" : "Low stock emails disabled")
  }

  function saveReorderDefault() {
    const n = Math.max(0, Math.floor(Number(reorderDefault)) || 0)
    setReorderDefaultState(n)
    setReorderLevelDefault(n)
    toast.success("Default reorder level saved")
  }

  function setOverride(productName: string, value: number) {
    const n = Math.max(0, Math.floor(Number(value)) || 0)
    setOverridesState((prev) => {
      const next = { ...prev, [productName]: n }
      setReorderLevelOverrides(next)
      return next
    })
    toast.success(`Reorder level for "${productName}" saved`)
  }

  function clearOverride(productName: string) {
    setOverridesState((prev) => {
      const next = { ...prev }
      delete next[productName]
      setReorderLevelOverrides(next)
      return next
    })
    toast.success("Using default reorder level for this product")
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-full">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account and application preferences.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {/* Left column: Email, Profile, Other */}
        <div className="flex flex-col gap-6 min-h-0">
      {/* Low stock email notifications */}
      <Card className="flex-1 flex flex-col min-h-[280px] border-border">
        <CardHeader className="pb-3 shrink-0">
          <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
            <Mail className="w-4 h-4" />
            Low stock email notifications
          </CardTitle>
          <p className="text-sm text-muted-foreground font-normal mt-1">
            Send emails to the following addresses when stock for any product falls at or below its reorder level.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
          <div className="flex items-center justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Enable low stock emails</p>
              <p className="text-xs text-muted-foreground">Recipients below will be notified when reorder level is reached</p>
            </div>
            <Switch checked={emailsEnabled} onCheckedChange={toggleEmailsEnabled} />
          </div>
          <Separator />
<div className="flex flex-col gap-2 min-w-0 shrink-0">
              <Label className="text-foreground">Recipients</Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                type="email"
                placeholder="email@example.com"
                className="flex-1 bg-card text-foreground border-border"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addEmail())}
              />
              <Button type="button" size="sm" variant="secondary" onClick={addEmail} className="shrink-0">
                <Plus className="w-4 h-4 mr-1" />
                Add
              </Button>
            </div>
            {emailRecipients.length > 0 ? (
              <ul className="space-y-2 mt-2">
                {emailRecipients.map((email) => (
                  <li
                    key={email}
                    className="flex items-center justify-between gap-2 py-2 px-3 rounded-lg bg-muted/50 text-sm text-foreground"
                  >
                    <span>{email}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeEmail(email)}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">No recipients yet. Add emails to receive low stock alerts.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Profile */}
      <Card className="flex-1 flex flex-col min-h-[280px] border-border">
        <CardHeader className="pb-3 shrink-0">
          <CardTitle className="text-base font-semibold text-foreground">Profile</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 flex-1 min-h-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label className="text-foreground">First Name</Label>
              <Input defaultValue="Eric" className="bg-card text-foreground border-border" />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-foreground">Last Name</Label>
              <Input defaultValue="Mugabo" className="bg-card text-foreground border-border" />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Email</Label>
            <Input defaultValue="eric.mugabo@stockflow.rw" className="bg-card text-foreground border-border" />
          </div>
          <Button className="w-full sm:w-fit bg-primary text-primary-foreground hover:bg-primary/90">Save Changes</Button>
        </CardContent>
      </Card>

      {/* Other notifications */}
      <Card className="flex-1 flex flex-col min-h-[280px] border-border">
        <CardHeader className="pb-3 shrink-0">
          <CardTitle className="text-base font-semibold text-foreground">Other notifications</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 flex-1 min-h-0">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">POC reminders</p>
              <p className="text-xs text-muted-foreground">Reminder when POC items are nearing return date</p>
            </div>
            <Switch defaultChecked />
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Transaction receipts</p>
              <p className="text-xs text-muted-foreground">Email confirmation for every stock movement</p>
            </div>
            <Switch />
          </div>
        </CardContent>
      </Card>
        </div>

        {/* Right column: Reorder levels - same height as left column */}
        <div className="flex flex-col gap-6 min-h-0">
      <Card className="h-full min-h-[280px] flex flex-col border-border">
        <CardHeader className="pb-3 shrink-0">
          <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
            <Package className="w-4 h-4" />
            Reorder levels
          </CardTitle>
          <p className="text-sm text-muted-foreground font-normal mt-1">
            When in-stock count for a product is at or below this number, it is considered low stock and can trigger alerts and emails.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Default reorder level (all products)</Label>
            <div className="flex flex-wrap gap-2 items-center">
              <Input
                type="number"
                min={0}
                className="w-24 bg-card text-foreground border-border"
                value={reorderDefault}
                onChange={(e) => setReorderDefaultState(e.target.valueAsNumber ?? 0)}
              />
              <span className="text-sm text-muted-foreground">Alert when in stock ≤ this number</span>
              <Button size="sm" onClick={saveReorderDefault}>
                Save default
              </Button>
            </div>
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Per-product overrides (optional)</Label>
            <p className="text-xs text-muted-foreground">
              Set a specific reorder level for a product. Leave blank or clear to use the default.
            </p>
            {productNames.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No products in inventory yet.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 mt-2">
                {productNames.map((name) => {
                  const value = overrides[name] ?? ""
                  return (
                    <div
                      key={name}
                      className="flex items-center gap-2 py-2 px-3 rounded-lg bg-muted/30 border border-border/50 shrink-0"
                    >
                      <span className="flex-1 text-sm font-medium text-foreground truncate min-w-0" title={name}>{name}</span>
                      <Input
                        type="number"
                        min={0}
                        className="w-16 h-8 bg-card text-foreground border-border text-sm shrink-0"
                        placeholder={String(reorderDefault)}
                        value={value === "" ? "" : value}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === "") {
                            setOverridesState((prev) => {
                              const next = { ...prev }
                              delete next[name]
                              return next
                            })
                            return
                          }
                          const n = parseInt(v, 10)
                          if (Number.isFinite(n) && n >= 0) setOverridesState((prev) => ({ ...prev, [name]: n }))
                        }}
                        onBlur={(e) => {
                          const v = e.target.value
                          if (v !== "") {
                            const n = Math.max(0, Math.floor(Number(v)) || 0)
                            setOverride(name, n)
                          }
                        }}
                      />
                      {name in overrides ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground shrink-0"
                          onClick={() => clearOverride(name)}
                        >
                          Default
                        </Button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
        </div>
      </div>
    </div>
  )
}
