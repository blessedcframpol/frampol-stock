"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Plus,
  Search,
  UsersRound,
} from "lucide-react"
import { useAuth } from "@/lib/auth-context"
import { canManageUsers, isValidRole, ROLES, type AppRole } from "@/lib/permissions"
import { PageBackLink, pageTitleClass } from "@/components/page-nav"
import { toast } from "sonner"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { buildCsvFilename, cn, formatDateDDMMYYYY } from "@/lib/utils"

type ProfileRow = {
  id: string
  email: string
  display_name: string | null
  role: string | null
  active: boolean
  created_at?: string
}

const ROLE_PLACEHOLDER = "__role_pending__"
const PAGE_SIZE_OPTIONS = [10, 15, 25, 50] as const

const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Admin",
  sales: "Sales",
  accounts: "Accounts",
  technicians: "Technicians",
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

function formatJoined(iso: string | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return formatDateDDMMYYYY(iso)
  const date = formatDateDDMMYYYY(iso)
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return `${date}, ${time}`
}

function roleLabel(role: string | null): string {
  if (role && isValidRole(role)) return ROLE_LABELS[role]
  return "Unassigned"
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")
}

function downloadUsersCsv(profiles: ProfileRow[]) {
  const header = ["ID", "Full name", "Email", "Role", "Status", "Joined date"]
  const rows: string[][] = [
    header,
    ...profiles.map((p) => [
      p.id,
      p.display_name?.trim() || "",
      p.email,
      roleLabel(p.role),
      p.active ? "Active" : "Inactive",
      p.created_at ? formatJoined(p.created_at) : "",
    ]),
  ]
  const csv = `\uFEFF${toCsv(rows)}`
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = buildCsvFilename(["users"], new Date().toISOString())
  a.click()
  URL.revokeObjectURL(url)
}

export function UsersContent() {
  const { role } = useAuth()
  const allowed = canManageUsers(role)

  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [pageSize, setPageSize] = useState<number>(15)
  const [page, setPage] = useState(1)

  const [createOpen, setCreateOpen] = useState(false)
  const [createEmail, setCreateEmail] = useState("")
  const [createPassword, setCreatePassword] = useState("")
  const [createDisplayName, setCreateDisplayName] = useState("")
  const [createRole, setCreateRole] = useState<string>("technicians")
  const [creating, setCreating] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  const [editProfile, setEditProfile] = useState<ProfileRow | null>(null)
  const [editDisplayName, setEditDisplayName] = useState("")
  const [editRole, setEditRole] = useState<string>(ROLE_PLACEHOLDER)
  const [editActive, setEditActive] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchProfiles = useCallback(async () => {
    if (!allowed) return
    setLoading(true)
    try {
      const res = await fetch("/api/admin/profiles")
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Could not load users")
        setProfiles([])
        return
      }
      setProfiles(Array.isArray(data) ? data : [])
    } catch (e) {
      toastFromCaughtError(e, "Could not load users")
      setProfiles([])
    } finally {
      setLoading(false)
    }
  }, [allowed])

  useEffect(() => {
    if (!allowed) {
      setLoading(false)
      return
    }
    void fetchProfiles()
  }, [allowed, fetchProfiles])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return profiles.filter((p) => {
      if (roleFilter !== "all") {
        if (roleFilter === "unassigned") {
          if (p.role) return false
        } else if (p.role !== roleFilter) {
          return false
        }
      }
      if (statusFilter === "active" && !p.active) return false
      if (statusFilter === "inactive" && p.active) return false
      if (!q) return true
      const name = (p.display_name || "").toLowerCase()
      return name.includes(q) || p.email.toLowerCase().includes(q)
    })
  }, [profiles, search, roleFilter, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * pageSize
  const pageRows = filtered.slice(pageStart, pageStart + pageSize)

  useEffect(() => {
    setPage(1)
  }, [search, roleFilter, statusFilter, pageSize])

  function openEdit(p: ProfileRow) {
    setEditProfile(p)
    setEditDisplayName(p.display_name || "")
    setEditRole(p.role && isValidRole(p.role) ? p.role : ROLE_PLACEHOLDER)
    setEditActive(p.active)
    setEditOpen(true)
  }

  function resetCreateForm() {
    setCreateEmail("")
    setCreatePassword("")
    setCreateDisplayName("")
    setCreateRole("technicians")
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
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Failed to create user")
        return
      }
      const name = createDisplayName.trim() || createEmail.trim()
      toast.success(`‘${name}’ created`, {
        description: "User account has been created successfully.",
      })
      resetCreateForm()
      setCreateOpen(false)
      await fetchProfiles()
    } catch (err) {
      toastFromCaughtError(err, "Failed to create user")
    } finally {
      setCreating(false)
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editProfile) return
    if (editRole === ROLE_PLACEHOLDER) {
      toast.error("Assign a role before saving")
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/profiles/${editProfile.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: editDisplayName.trim(),
          role: editRole,
          active: editActive,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Update failed")
        return
      }
      const name = editDisplayName.trim() || editProfile.email
      toast.success(`‘${name}’ details updated`, {
        description: "Details have been successfully updated.",
      })
      setEditOpen(false)
      setEditProfile(null)
      await fetchProfiles()
    } catch (err) {
      toastFromCaughtError(err, "Update failed")
    } finally {
      setSaving(false)
    }
  }

  if (!allowed) {
    return (
      <div className="flex flex-col gap-4 min-w-0 items-start">
        <PageBackLink href="/" label="Dashboard" />
        <p className="text-sm text-muted-foreground">You do not have access to user management.</p>
      </div>
    )
  }

  const rangeLabel =
    filtered.length === 0
      ? "0 of 0"
      : `${pageStart + 1}–${Math.min(pageStart + pageSize, filtered.length)} of ${filtered.length}`

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <UsersRound className="size-6 shrink-0 text-foreground" aria-hidden />
          <h1 className={pageTitleClass}>User management</h1>
          <Badge variant="secondary" className="rounded-full px-2.5 tabular-nums">
            {profiles.length}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your team members and their account permissions here.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center min-w-0 flex-1">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or email…"
              className="h-9 pl-9 rounded-lg bg-background"
            />
          </div>
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="h-9 w-full sm:w-[9.5rem] rounded-lg bg-background">
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
              <SelectItem value="unassigned">Unassigned</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-full sm:w-[9.5rem] rounded-lg bg-background">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            type="button"
            variant="outline"
            className="rounded-lg"
            disabled={loading || profiles.length === 0}
            onClick={() => {
              downloadUsersCsv(profiles)
              toast.success("Users CSV downloaded")
            }}
          >
            <Download className="size-4" />
            Export
          </Button>
          <Button type="button" className="rounded-lg" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add user
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card/30">
        {loading ? (
          <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading users…
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-8 text-sm text-muted-foreground">
            {profiles.length === 0 ? "No users found." : "No users match your filters."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent bg-muted/40">
                  <TableHead className="min-w-[12rem]">Full name</TableHead>
                  <TableHead className="min-w-[12rem]">Email</TableHead>
                  <TableHead className="min-w-[8rem]">Role</TableHead>
                  <TableHead className="min-w-[7rem]">Status</TableHead>
                  <TableHead className="min-w-[10rem]">Joined date</TableHead>
                  <TableHead className="w-[5rem] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar className="size-8 shrink-0 border border-border">
                          <AvatarFallback className="bg-muted text-foreground text-xs font-semibold">
                            {profileInitials(p.display_name, p.email)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium text-foreground truncate">
                          {p.display_name?.trim() || "—"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.email}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm",
                          p.role ? "text-foreground" : "text-muted-foreground italic"
                        )}
                      >
                        {roleLabel(p.role)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 text-sm">
                        <span
                          className={cn(
                            "size-2 rounded-full shrink-0",
                            p.active ? "bg-emerald-500" : "bg-red-500"
                          )}
                          aria-hidden
                        />
                        {p.active ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {formatJoined(p.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => openEdit(p)}
                        aria-label={`Edit ${p.display_name || p.email}`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!loading && filtered.length > 0 ? (
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <span>Rows per page</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => setPageSize(Number(v))}
                >
                  <SelectTrigger className="h-8 w-[4.5rem] rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="tabular-nums">{rangeLabel}</span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8 rounded-lg"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-muted-foreground">
                {safePage} / {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8 rounded-lg"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) resetCreateForm()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Create a sign-in and assign a role. The user can log in immediately.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="flex flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="create-email">Email</Label>
              <Input
                id="create-email"
                type="email"
                placeholder="user@example.com"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                className="h-11 rounded-lg"
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-password">Password</Label>
              <Input
                id="create-password"
                type="password"
                placeholder="••••••••"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                className="h-11 rounded-lg"
                autoComplete="new-password"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-name">Display name</Label>
              <Input
                id="create-name"
                placeholder="Optional"
                value={createDisplayName}
                onChange={(e) => setCreateDisplayName(e.target.value)}
                className="h-11 rounded-lg"
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={createRole} onValueChange={setCreateRole}>
                <SelectTrigger className="h-11 rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {creating ? "Creating…" : "Create user"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open)
          if (!open) setEditProfile(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>
              Update display name, role, or active status for{" "}
              <span className="font-medium text-foreground">{editProfile?.email}</span>.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveEdit} className="flex flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Display name</Label>
              <Input
                id="edit-name"
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                className="h-11 rounded-lg"
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger className="h-11 rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROLE_PLACEHOLDER}>Assign role…</SelectItem>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">Active</p>
                <p className="text-xs text-muted-foreground">Inactive users cannot sign in</p>
              </div>
              <Switch checked={editActive} onCheckedChange={setEditActive} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
