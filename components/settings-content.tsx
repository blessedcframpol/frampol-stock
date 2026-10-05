"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/fs/empty-state"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  fetchAppSettings,
  fetchProductLineSettings,
  updateAppSettings,
  updateProductLineSetting,
  type AppSettings,
  type ProductLineSetting,
} from "@/lib/settings"
import { useAuth } from "@/lib/auth-context"
import { canAccessSettings, canManageUsers } from "@/lib/permissions"
import { useInventoryStore } from "@/lib/inventory-store"
import { cn } from "@/lib/utils"
import { Mail, Plus, Trash2, Info, UsersRound, ArrowRight } from "lucide-react"
import { PageHeader } from "@/components/page-nav"
import { toast } from "sonner"
import Link from "next/link"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { useLowStockProducts } from "@/hooks/use-low-stock-products"

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
  const { inventory } = useInventoryStore()
  const { products: lowStockProducts, refresh: refreshLowStock } = useLowStockProducts()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [products, setProducts] = useState<ProductLineSetting[]>([])
  const [defaultDraft, setDefaultDraft] = useState("2")
  const [productDrafts, setProductDrafts] = useState<
    Record<string, { reorderLevel: string; isActive: boolean }>
  >({})
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState("")

  const loadSettings = useCallback(async () => {
    try {
      const [nextSettings, nextProducts] = await Promise.all([
        fetchAppSettings(),
        fetchProductLineSettings(),
      ])
      setSettings(nextSettings)
      setDefaultDraft(String(nextSettings.defaultReorderLevel))
      setProducts(nextProducts)
      setProductDrafts(
        Object.fromEntries(
          nextProducts.map((product) => [
            product.productId,
            {
              reorderLevel:
                product.reorderLevel == null ? "" : String(product.reorderLevel),
              isActive: product.isActive,
            },
          ])
        )
      )
    } catch (error) {
      toastFromCaughtError(error, "Could not load settings")
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canAccessSettings(role)) return
    let cancelled = false
    void Promise.all([fetchAppSettings(), fetchProductLineSettings()])
      .then(([nextSettings, nextProducts]) => {
        if (cancelled) return
        setSettings(nextSettings)
        setDefaultDraft(String(nextSettings.defaultReorderLevel))
        setProducts(nextProducts)
        setProductDrafts(
          Object.fromEntries(
            nextProducts.map((product) => [
              product.productId,
              {
                reorderLevel:
                  product.reorderLevel == null ? "" : String(product.reorderLevel),
                isActive: product.isActive,
              },
            ])
          )
        )
      })
      .catch((error) => {
        if (!cancelled) toastFromCaughtError(error, "Could not load settings")
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [role])

  const inStockByProduct = useMemo(() => {
    const counts = new Map<string, number>()
    // View counts win. The ledger only fills catalogue rows the view omits.
    for (const product of lowStockProducts) {
      counts.set(product.productId, product.inStockCount)
    }
    for (const item of inventory) {
      if (!item.productId || counts.has(item.productId)) continue
      if (item.status !== "In Stock" || item.deletedAt || (item.stockPool ?? "sale") !== "sale") continue
      counts.set(item.productId, (counts.get(item.productId) ?? 0) + 1)
    }
    return counts
  }, [inventory, lowStockProducts])

  const displayName = (profile?.display_name ?? "").trim()
  const nameParts = displayName ? displayName.split(/\s+/).filter(Boolean) : []
  const firstName = nameParts[0] ?? ""
  const lastName = nameParts.slice(1).join(" ")

  async function saveAppSettings(
    updates: Parameters<typeof updateAppSettings>[0],
    success: string
  ) {
    if (!isAdmin) return
    setSavingKey("app-settings")
    try {
      setSettings(await updateAppSettings(updates))
      await refreshLowStock()
      toast.success(success)
    } catch (error) {
      toastFromCaughtError(error, "Could not save settings")
    } finally {
      setSavingKey(null)
    }
  }

  async function addEmail() {
    const trimmed = newEmail.trim().toLowerCase()
    if (!trimmed) return
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!re.test(trimmed)) {
      toast.error("Enter a valid email address")
      return
    }
    if (settings?.lowStockRecipients.includes(trimmed)) {
      toast.error("That email is already in the list")
      return
    }
    const next = [...(settings?.lowStockRecipients ?? []), trimmed]
    await saveAppSettings({ lowStockRecipients: next }, "Email added")
    setNewEmail("")
  }

  async function removeEmail(email: string) {
    const next = (settings?.lowStockRecipients ?? []).filter((value) => value !== email)
    await saveAppSettings({ lowStockRecipients: next }, "Email removed")
  }

  async function toggleEmailsEnabled(checked: boolean) {
    await saveAppSettings(
      { lowStockEmailsEnabled: checked },
      checked ? "Low stock emails enabled" : "Low stock emails disabled"
    )
  }

  async function saveReorderDefault() {
    const value = Number(defaultDraft)
    if (!Number.isInteger(value) || value < 0) {
      toast.error("Default reorder level must be a whole number of 0 or more")
      return
    }
    await saveAppSettings(
      { defaultReorderLevel: value },
      "Default reorder level saved"
    )
  }

  async function saveProduct(product: ProductLineSetting) {
    if (!isAdmin) return
    const draft = productDrafts[product.productId]
    if (!draft) return
    const reorderLevel =
      draft.reorderLevel.trim() === "" ? null : Number(draft.reorderLevel)
    if (
      reorderLevel !== null &&
      (!Number.isInteger(reorderLevel) || reorderLevel < 0)
    ) {
      toast.error("Reorder level must be blank or a whole number of 0 or more")
      return
    }
    setSavingKey(product.productId)
    try {
      await updateProductLineSetting(product.productId, {
        reorderLevel,
        isActive: draft.isActive,
      })
      await Promise.all([loadSettings(), refreshLowStock()])
      toast.success(`Settings for "${product.productName}" saved`)
    } catch (error) {
      toastFromCaughtError(error, "Could not save product settings")
    } finally {
      setSavingKey(null)
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

  if (!canAccessSettings(role)) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Settings" description="Workspace settings are not available to viewers." />
        <p className="text-sm text-muted-foreground">Your account has read-only access.</p>
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col">
      <div className="mb-6">
        <PageHeader
          title="Settings"
          description="Fram-Stock preferences, low-stock email, and reorder rules."
        />
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
              <div className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
                Emails are not being sent yet. These settings are stored for a future sender.
              </div>
              <div className="flex flex-col justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row sm:items-center">
                <div>
                  <p className="text-sm font-medium text-foreground">Enable low stock emails</p>
                  <p className="text-xs text-muted-foreground">Recipients below receive alerts when thresholds are hit</p>
                </div>
                <Switch
                  checked={settings?.lowStockEmailsEnabled ?? false}
                  onCheckedChange={(checked) => void toggleEmailsEnabled(checked)}
                  disabled={!isAdmin || settingsLoading || savingKey === "app-settings"}
                />
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
                    onKeyDown={(e) =>
                      e.key === "Enter" && (e.preventDefault(), void addEmail())
                    }
                    disabled={!isAdmin || settingsLoading}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-11 shrink-0 rounded-lg"
                    onClick={() => void addEmail()}
                    disabled={!isAdmin || settingsLoading || savingKey === "app-settings"}
                  >
                    <Plus className="mr-1 size-4" />
                    Add
                  </Button>
                </div>
                {(settings?.lowStockRecipients.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {settings?.lowStockRecipients.map((email) => (
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
                          onClick={() => void removeEmail(email)}
                          disabled={!isAdmin || savingKey === "app-settings"}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState message="No recipients yet." />
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
                    value={defaultDraft}
                    onChange={(e) => setDefaultDraft(e.target.value)}
                    disabled={!isAdmin || settingsLoading}
                  />
                  <span className="text-sm text-muted-foreground">Alert when in stock ≤ this number</span>
                  <Button
                    type="button"
                    size="sm"
                    className="rounded-lg"
                    onClick={() => void saveReorderDefault()}
                    disabled={!isAdmin || settingsLoading || savingKey === "app-settings"}
                  >
                    Save
                  </Button>
                </div>
                {!isAdmin ? (
                  <p className="text-xs text-muted-foreground">
                    Reorder settings are read-only. An administrator can make changes.
                  </p>
                ) : null}
              </div>
              <Separator />
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Products</Label>
                <p className="text-xs text-muted-foreground">
                  Leave Reorder at blank to use the default of {settings?.defaultReorderLevel ?? 2}.
                  Inactive products are excluded from low-stock alerts.
                </p>
                {settingsLoading ? (
                  <p className="text-sm text-muted-foreground">Loading product settings…</p>
                ) : products.length === 0 ? (
                  <EmptyState message="No products found." />
                ) : (
                  <div className="mt-3 overflow-x-auto rounded-xl border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead>Vendor</TableHead>
                          <TableHead className="text-right">In stock</TableHead>
                          <TableHead className="w-36">Reorder at</TableHead>
                          <TableHead className="w-24">Active</TableHead>
                          <TableHead className="w-24" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {products.map((product) => {
                          const draft = productDrafts[product.productId] ?? {
                            reorderLevel: "",
                            isActive: product.isActive,
                          }
                          return (
                            <TableRow key={product.productId}>
                              <TableCell className="font-medium">
                                {product.productName}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {product.vendor}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {inStockByProduct.get(product.productId) ?? 0}
                              </TableCell>
                              <TableCell>
                                <Input
                                  type="number"
                                  min={0}
                                  placeholder={String(settings?.defaultReorderLevel ?? 2)}
                                  value={draft.reorderLevel}
                                  onChange={(event) =>
                                    setProductDrafts((current) => ({
                                      ...current,
                                      [product.productId]: {
                                        ...draft,
                                        reorderLevel: event.target.value,
                                      },
                                    }))
                                  }
                                  disabled={!isAdmin}
                                  className="h-9 w-24"
                                />
                              </TableCell>
                              <TableCell>
                                <Switch
                                  checked={draft.isActive}
                                  onCheckedChange={(checked) =>
                                    setProductDrafts((current) => ({
                                      ...current,
                                      [product.productId]: {
                                        ...draft,
                                        isActive: checked,
                                      },
                                    }))
                                  }
                                  disabled={!isAdmin}
                                />
                              </TableCell>
                              <TableCell>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void saveProduct(product)}
                                  disabled={!isAdmin || savingKey === product.productId}
                                >
                                  Save
                                </Button>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="users" className="mt-0 rounded-2xl border border-border bg-card/30 px-4 py-2 md:px-8">
          {isAdmin ? (
            <SettingsSection
              title="Users"
              description="Assign roles and manage access from the dedicated User management page."
            >
              <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/20 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-3 min-w-0">
                  <UsersRound className="mt-0.5 size-5 shrink-0 text-primary" />
                  <div className="space-y-1 text-sm min-w-0">
                    <p className="font-medium text-foreground">User management</p>
                    <p className="text-muted-foreground">
                      People appear after their first Microsoft sign-in. Search, filter, and edit their access.
                    </p>
                  </div>
                </div>
                <Button asChild className="rounded-lg shrink-0 w-fit">
                  <Link href="/users">
                    Open
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </SettingsSection>
          ) : (
            <SettingsSection
              title="Workspace"
              description="Fram-Stock is an internal inventory app for your organisation."
            >
              <p className="text-sm text-muted-foreground">
                User accounts and roles are managed by an admin under{" "}
                <strong className="font-medium text-foreground">User management</strong>.
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
                    Your profile role controls screens and actions. Admins manage people under{" "}
                    <strong className="font-medium text-foreground">User management</strong>.
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
