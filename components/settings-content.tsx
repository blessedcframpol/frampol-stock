"use client"

import { useState, useEffect, useCallback } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { useAuth } from "@/lib/auth-context"
import { canManageUsers, isValidRole } from "@/lib/permissions"
import { useInventoryStore } from "@/lib/inventory-store"
import { cn } from "@/lib/utils"
import { Mail, Plus, Trash2, Loader2, HelpCircle, Info } from "lucide-react"
import { toast } from "sonner"

type ProfileRow = {
  id: string
  email: string
  display_name: string | null
  role: string | null
  active: boolean
  created_at?: string
}

/** Radix Select needs a dedicated value for rows with no role yet */
const ADMIN_ROLE_PLACEHOLDER = "__role_pending__"

const tabPill = cn(
  "rounded-full border border-border/70 bg-muted/50 px-5 py-2.5 text-sm font-medium text-muted-foreground shadow-none transition-all",
  "hover:text-foreground",
  "data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
)

function SettingsSection({
  title,
  description,
  children,
  aside,
  layout = "default",
}: {
  title: string
  description: string
  children: React.ReactNode
  aside?: React.ReactNode
  /** `stacked` = title row then full-width content (for dense grids like reorder levels). */
  layout?: "default" | "stacked"
}) {
  if (layout === "stacked") {
    return (
      <div className="flex flex-col gap-6 border-b border-border py-8 last:border-b-0 last:pb-0 lg:gap-8 lg:py-10">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div className="w-full min-w-0">{children}</div>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-8 border-b border-border py-8 last:border-b-0 last:pb-0 lg:grid-cols-12 lg:gap-10 lg:py-10">
      <div className="lg:col-span-3">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className={cn(aside ? "lg:col-span-5" : "lg:col-span-9")}>{children}</div>
      {aside ? <div className="flex flex-col items-start gap-3 lg:col-span-4">{aside}</div> : null}
    </div>
  )
}

function useProductNames(): string[] {
  const { inventory } = useInventoryStore()
  const names = Array.from(new Set(inventory.map((i) => i.name))).sort()
  return names
}

function profileInitials(display: string | null | undefined, email: string | null | undefined): string {
  const s = (display || "").trim()
  if (s) {
    const parts = s.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase().slice(0, 2)
    return s.slice(0, 2).toUpperCase()
  }
  const e = (email || "").split("@")[0]
  return e.slice(0, 2).toUpperCase() || "?"
}

export function SettingsContent() {
  const { role, profile, user } = useAuth()
  const isAdmin = canManageUsers(role)
  const productNames = useProductNames()

  const [emailsEnabled, setEmailsEnabledState] = useState(true)
  const [emailRecipients, setEmailRecipientsState] = useState<string[]>([])
  const [newEmail, setNewEmail] = useState("")
  const [reorderDefault, setReorderDefaultState] = useState(2)
  const [overrides, setOverridesState] = useState<Record<string, number>>({})
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [createEmail, setCreateEmail] = useState("")
  const [createPassword, setCreatePassword] = useState("")
  const [createDisplayName, setCreateDisplayName] = useState("")
  const [createRole, setCreateRole] = useState<string>("technicians")
  const [creating, setCreating] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const displayName = (profile?.display_name ?? "").trim()
  const nameParts = displayName ? displayName.split(/\s+/).filter(Boolean) : []
  const firstName = nameParts[0] ?? ""
  const lastName = nameParts.slice(1).join(" ")

  const fetchProfiles = useCallback(async () => {
    if (!isAdmin) return
    setProfilesLoading(true)
    try {
      const res = await fetch("/api/admin/profiles")
      if (!res.ok) throw new Error(res.status === 403 ? "Forbidden" : "Failed to load")
      const data = await res.json()
      setProfiles(Array.isArray(data) ? data : [])
    } catch {
      toast.error("Could not load users")
      setProfiles([])
    } finally {
      setProfilesLoading(false)
    }
  }, [isAdmin])

  useEffect(() => {
    fetchProfiles()
  }, [fetchProfiles])

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

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault()
    if (!createEmail.trim() || !createPassword) {
      toast.error("Email and password required")
      return
    }
    setCreating(true)
    try {
      const res = await fetch("/api/admin/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: createEmail.trim(),
          password: createPassword,
          display_name: createDisplayName.trim() || undefined,
          role: createRole,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create user")
      toast.success("User created")
      setCreateEmail("")
      setCreatePassword("")
      setCreateDisplayName("")
      setCreateRole("technicians")
      fetchProfiles()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create user")
    } finally {
      setCreating(false)
    }
  }

  async function handleUpdateProfile(id: string, updates: { role?: string; active?: boolean }) {
    setUpdatingId(id)
    try {
      const res = await fetch(`/api/admin/profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Update failed")
      toast.success("Updated")
      fetchProfiles()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed")
    } finally {
      setUpdatingId(null)
    }
  }

  const profileAside = (
    <>
      <Avatar className="size-28 border-2 border-border">
        <AvatarFallback className="text-2xl font-semibold bg-muted text-foreground">
          {profileInitials(profile?.display_name, profile?.email ?? user?.email)}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled className="rounded-lg" title="Coming soon">
          Edit photo
        </Button>
        <Button type="button" variant="outline" size="icon" disabled className="rounded-lg shrink-0" title="Coming soon">
          <Trash2 className="size-4" />
        </Button>
      </div>
    </>
  )

  return (
    <div className="flex w-full min-w-0 flex-col">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">Settings</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Fram-Stock preferences, low-stock email, reorder rules, and user management.
        </p>
      </div>

      <Tabs defaultValue="account" className="w-full gap-6">
        <TabsList
          className={cn(
            "mb-4 h-auto w-full flex flex-wrap items-center justify-start gap-2 rounded-none bg-transparent p-0"
          )}
        >
          <TabsTrigger value="account" className={tabPill}>
            Account
          </TabsTrigger>
          <TabsTrigger value="email-alerts" className={tabPill}>
            Email alerts
          </TabsTrigger>
          <TabsTrigger value="reorder-levels" className={tabPill}>
            Reorder levels
          </TabsTrigger>
          <TabsTrigger value="alert-options" className={tabPill}>
            Alert options
          </TabsTrigger>
          <TabsTrigger value="users" className={tabPill}>
            {isAdmin ? "Users" : "Workspace"}
          </TabsTrigger>
          <TabsTrigger value="help" className={tabPill}>
            Help
          </TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="mt-0 rounded-2xl border border-border bg-card/30 px-4 py-2 md:px-8">
          <SettingsSection
            title="Profile"
            description="Set your account details. Name changes are managed by an administrator."
            aside={profileAside}
          >
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-muted-foreground">Name</Label>
                  <Input readOnly value={firstName} placeholder="—" className="h-11 rounded-lg border-input bg-background" />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-muted-foreground">Surname</Label>
                  <Input readOnly value={lastName} placeholder="—" className="h-11 rounded-lg border-input bg-background" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Email</Label>
                <Input
                  readOnly
                  value={profile?.email ?? user?.email ?? ""}
                  className="h-11 rounded-lg border-input bg-background"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Role</Label>
                <Input
                  readOnly
                  value={role ? role.charAt(0).toUpperCase() + role.slice(1) : "—"}
                  className="h-11 rounded-lg border-input bg-background"
                />
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Locale & display"
            description="Optional display preferences for this device. (Saving these is planned for a later release.)"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label className="text-sm font-medium text-muted-foreground">City</Label>
                <Input disabled placeholder="Not configured" className="h-11 rounded-lg border-input bg-muted/30" />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Timezone</Label>
                <Select disabled value="utc">
                  <SelectTrigger className="h-11 w-full rounded-lg border-input bg-muted/30">
                    <SelectValue placeholder="Use system default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="utc">System default</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Date &amp; time format</Label>
                <Select disabled value="locale">
                  <SelectTrigger className="h-11 w-full rounded-lg border-input bg-muted/30">
                    <SelectValue placeholder="Browser locale" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="locale">Browser locale</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Your access"
            description="Summary of how you appear in Fram-Stock."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Function</Label>
                <Input readOnly value="Inventory operations" className="h-11 rounded-lg border-input bg-background" />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Job title</Label>
                <Input
                  readOnly
                  value={role ? `${role.charAt(0).toUpperCase() + role.slice(1)} access` : "—"}
                  className="h-11 rounded-lg border-input bg-background"
                />
              </div>
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="email-alerts" className="mt-0 rounded-2xl border border-border bg-card/30 px-4 py-2 md:px-8">
          <SettingsSection
            title="Low-stock email"
            description="When count in stock for a product is at or below its reorder level, notify these addresses."
          >
            <div className="flex flex-col gap-6">
              <div className="flex flex-col justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row sm:items-center">
                <div>
                  <p className="text-sm font-medium text-foreground">Enable low stock emails</p>
                  <p className="text-xs text-muted-foreground">Recipients below receive alerts when thresholds are hit</p>
                </div>
                <Switch checked={emailsEnabled} onCheckedChange={toggleEmailsEnabled} />
              </div>
              <Separator />
              <div className="space-y-3">
                <Label className="text-sm font-medium text-muted-foreground">Recipients</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="email"
                    placeholder="email@example.com"
                    className="h-11 flex-1 rounded-lg border-input bg-background"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addEmail())}
                  />
                  <Button type="button" size="sm" variant="secondary" className="h-11 shrink-0 rounded-lg" onClick={addEmail}>
                    <Plus className="mr-1 size-4" />
                    Add
                  </Button>
                </div>
                {emailRecipients.length > 0 ? (
                  <ul className="space-y-2">
                    {emailRecipients.map((email) => (
                      <li
                        key={email}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm"
                      >
                        <span className="text-foreground">{email}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => removeEmail(email)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No recipients yet.</p>
                )}
              </div>
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent
          value="reorder-levels"
          className="mt-0 w-full min-w-0 max-w-none rounded-2xl border border-border bg-card/30 px-3 py-2 sm:px-4 md:px-6"
        >
          <SettingsSection
            layout="stacked"
            title="Reorder thresholds"
            description="Used for low-stock alerts and dashboard counts. If in-stock quantity is at or below the threshold, the SKU group is treated as low stock."
          >
            <div className="flex flex-col gap-6">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Default reorder level</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    type="number"
                    min={0}
                    className="h-11 w-28 rounded-lg border-input bg-background"
                    value={reorderDefault}
                    onChange={(e) => setReorderDefaultState(e.target.valueAsNumber ?? 0)}
                  />
                  <span className="text-sm text-muted-foreground">Alert when in stock ≤ this number</span>
                  <Button type="button" size="sm" className="rounded-lg" onClick={saveReorderDefault}>
                    Save
                  </Button>
                </div>
              </div>
              <Separator />
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Per-product overrides</Label>
                <p className="text-xs text-muted-foreground">
                  Optional. Clear or use &quot;Default&quot; to fall back to the global level.
                </p>
                {productNames.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No products in inventory yet.</p>
                ) : (
                  <div className="mt-2 grid w-full grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                    {productNames.map((name) => {
                      const value = overrides[name] ?? ""
                      return (
                        <div
                          key={name}
                          className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
                            {name}
                          </span>
                          <Input
                            type="number"
                            min={0}
                            className="h-9 w-16 rounded-md border-input bg-background text-sm"
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
                              className="shrink-0 text-xs"
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
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="alert-options" className="mt-0 rounded-2xl border border-border bg-card/30 px-4 py-2 md:px-8">
          <SettingsSection
            title="Extra alert toggles"
            description="Optional behaviours for the dashboard and (later) outbound email. Not all options are wired to the backend yet."
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row sm:items-center">
                <div>
                  <p className="text-sm font-medium text-foreground">POC reminders</p>
                  <p className="text-xs text-muted-foreground">Surface kits nearing return date (UI alerts)</p>
                </div>
                <Switch defaultChecked />
              </div>
              <Separator />
              <div className="flex flex-col justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row sm:items-center">
                <div>
                  <p className="text-sm font-medium text-foreground">Transaction receipts</p>
                  <p className="text-xs text-muted-foreground">Email confirmation for every stock movement</p>
                </div>
                <Switch />
              </div>
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="users" className="mt-0 rounded-2xl border border-border bg-card/30 px-4 py-2 md:px-8">
          {isAdmin ? (
            <SettingsSection
              title="Users"
              description="Create sign-ins and assign roles (admin, sales, accounts, technicians). Only admins can change this list."
            >
              <div className="flex flex-col gap-6">
                <form onSubmit={handleCreateUser} className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/10 p-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Email</Label>
                      <Input
                        type="email"
                        placeholder="user@example.com"
                        value={createEmail}
                        onChange={(e) => setCreateEmail(e.target.value)}
                        className="h-11 rounded-lg bg-background"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Password</Label>
                      <Input
                        type="password"
                        placeholder="••••••••"
                        value={createPassword}
                        onChange={(e) => setCreatePassword(e.target.value)}
                        className="h-11 rounded-lg bg-background"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Display name</Label>
                      <Input
                        placeholder="Optional"
                        value={createDisplayName}
                        onChange={(e) => setCreateDisplayName(e.target.value)}
                        className="h-11 rounded-lg bg-background"
                      />
                    </div>
                    <div className="space-y-2 sm:col-span-2 lg:col-span-1">
                      <Label className="text-xs text-muted-foreground">Role</Label>
                      <Select value={createRole} onValueChange={setCreateRole}>
                        <SelectTrigger className="h-11 rounded-lg bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="sales">Sales</SelectItem>
                          <SelectItem value="accounts">Accounts</SelectItem>
                          <SelectItem value="technicians">Technicians</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button type="submit" disabled={creating} className="w-fit rounded-lg">
                    {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                    <span className="ml-2">{creating ? "Creating…" : "Create user"}</span>
                  </Button>
                </form>
                <div>
                  <Label className="text-sm font-medium text-muted-foreground">Users</Label>
                  {profilesLoading ? (
                    <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" /> Loading…
                    </p>
                  ) : profiles.length === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">No users loaded.</p>
                  ) : (
                    <div className="mt-3 overflow-hidden rounded-xl border border-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/40">
                            <th className="p-3 text-left font-medium">Email</th>
                            <th className="p-3 text-left font-medium">Name</th>
                            <th className="p-3 text-left font-medium">Role</th>
                            <th className="p-3 text-left font-medium">Active</th>
                            <th className="p-3 text-right font-medium" />
                          </tr>
                        </thead>
                        <tbody>
                          {profiles.map((p) => (
                            <tr key={p.id} className="border-b border-border/60 last:border-0">
                              <td className="p-3">{p.email}</td>
                              <td className="p-3 text-muted-foreground">{p.display_name || "—"}</td>
                              <td className="p-3">
                                <Select
                                  value={p.role && isValidRole(p.role) ? p.role : ADMIN_ROLE_PLACEHOLDER}
                                  onValueChange={(value) => {
                                    if (value === ADMIN_ROLE_PLACEHOLDER) return
                                    handleUpdateProfile(p.id, { role: value })
                                  }}
                                  disabled={updatingId === p.id}
                                >
                                  <SelectTrigger className="h-9 min-w-[10.5rem] rounded-lg bg-background">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={ADMIN_ROLE_PLACEHOLDER}>Assign role…</SelectItem>
                                    <SelectItem value="admin">Admin</SelectItem>
                                    <SelectItem value="sales">Sales</SelectItem>
                                    <SelectItem value="accounts">Accounts</SelectItem>
                                    <SelectItem value="technicians">Technicians</SelectItem>
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="p-3">
                                <Switch
                                  checked={p.active}
                                  onCheckedChange={(checked) => handleUpdateProfile(p.id, { active: checked })}
                                  disabled={updatingId === p.id}
                                />
                              </td>
                              <td className="p-3 text-right">
                                {updatingId === p.id && <Loader2 className="inline size-4 animate-spin" />}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </SettingsSection>
          ) : (
            <SettingsSection
              title="Workspace"
              description="Fram-Stock is an internal inventory app for your organisation."
            >
              <p className="text-sm text-muted-foreground">
                User accounts and roles are managed by an admin under the <strong className="font-medium text-foreground">Users</strong> tab.
                If you need access changes, ask your Fram-Stock administrator.
              </p>
            </SettingsSection>
          )}
        </TabsContent>

        <TabsContent value="help" className="mt-0 rounded-2xl border border-border bg-card/30 px-4 py-2 md:px-8">
          <SettingsSection
            title="Help"
            description="Short notes on how Fram-Stock settings work."
          >
            <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/20 p-5">
              <div className="flex gap-3">
                <Info className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-foreground">Roles & access</p>
                  <p className="text-muted-foreground">
                    Your profile role controls screens and actions. Admins manage people under the <strong className="font-medium text-foreground">Users</strong> tab.
                  </p>
                </div>
              </div>
              <Separator />
              <div className="flex gap-3">
                <HelpCircle className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-foreground">Low-stock rules</p>
                  <p className="text-muted-foreground">
                    Defaults and per-product overrides are under <strong className="font-medium text-foreground">Reorder levels</strong>. Values are stored in this browser until you move them to the database.
                  </p>
                </div>
              </div>
              <Separator />
              <div className="flex gap-3">
                <Mail className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-foreground">Still stuck?</p>
                  <p className="text-muted-foreground">Ask your Fram-Stock administrator to verify your profile and Supabase access.</p>
                </div>
              </div>
            </div>
          </SettingsSection>
        </TabsContent>
      </Tabs>
    </div>
  )
}
