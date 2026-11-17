"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  archiveClientContact,
  createClientContact,
  fetchClientContacts,
  setPrimaryClientContact,
  updateClientContact,
  type ClientContact,
} from "@/lib/supabase/client-contacts-db"
import {
  CLIENT_CONTACT_ROLE_LABELS,
  CLIENT_CONTACT_ROLES,
  clientContactFieldErrors,
  type ClientContactInput,
  type ClientContactRole,
} from "@/lib/client-contacts"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { Mail, Phone, Pencil, Plus, Star, Archive } from "lucide-react"

const emptyForm = (): ClientContactInput => ({
  name: "",
  role: "buyer",
  email: "",
  phone: "",
  notes: "",
  isPrimary: false,
})

type Props = {
  clientId: string
  canEdit: boolean
  canAdd: boolean
}

export function ClientContactsCard({ clientId, canEdit, canAdd }: Props) {
  const [contacts, setContacts] = useState<ClientContact[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ClientContact | null>(null)
  const [form, setForm] = useState<ClientContactInput>(emptyForm)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const sb = getSupabaseClient()
    const rows = await fetchClientContacts(sb, clientId)
    setContacts(rows)
  }, [clientId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    reload()
      .catch(() => {
        if (!cancelled) setContacts([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reload])

  function openAdd() {
    setEditing(null)
    setForm(emptyForm())
    setFieldErrors(null)
    setDialogOpen(true)
  }

  function openEdit(c: ClientContact) {
    setEditing(c)
    setForm({
      name: c.name,
      role: c.role,
      email: c.email ?? "",
      phone: c.phone ?? "",
      notes: c.notes ?? "",
      isPrimary: c.isPrimary,
    })
    setFieldErrors(null)
    setDialogOpen(true)
  }

  async function handleSave() {
    const errors = clientContactFieldErrors(form)
    setFieldErrors(errors)
    if (errors) return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      if (editing) {
        await updateClientContact(sb, editing.id, form)
        toast.success("Contact updated.")
      } else {
        await createClientContact(sb, clientId, form)
        toast.success("Contact added.")
      }
      setDialogOpen(false)
      await reload()
    } catch (e) {
      toastFromCaughtError(e, editing ? "Could not update contact" : "Could not add contact")
    } finally {
      setBusy(false)
    }
  }

  async function handleArchive(c: ClientContact) {
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await archiveClientContact(sb, c.id)
      toast.success("Contact archived.")
      await reload()
    } catch (e) {
      toastFromCaughtError(e, "Could not archive contact")
    } finally {
      setBusy(false)
    }
  }

  async function handleSetPrimary(c: ClientContact) {
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await setPrimaryClientContact(sb, c.id)
      toast.success("Primary contact set.")
      await reload()
    } catch (e) {
      toastFromCaughtError(e, "Could not set primary")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card className="w-full">
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Contacts</CardTitle>
          {canAdd ? (
            <Button type="button" variant="outline" size="sm" onClick={openAdd} disabled={busy}>
              <Plus className="size-3.5 mr-1" />
              Add
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {loading ? (
            <p className="text-muted-foreground">Loading contacts…</p>
          ) : contacts.length === 0 ? (
            <p className="text-muted-foreground">No contacts yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {contacts.map((c) => (
                <li key={c.id} className="flex flex-col gap-1.5 border-b border-border pb-3 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {c.active === false ? `${c.name} (archived)` : c.name}
                    </span>
                    {c.role !== "buyer" ? (
                      <Badge variant="secondary" className="font-normal">
                        {CLIENT_CONTACT_ROLE_LABELS[c.role]}
                      </Badge>
                    ) : null}
                    {c.isPrimary ? (
                      <Badge variant="outline" className="gap-1 font-normal">
                        <Star className="size-3" />
                        Primary
                      </Badge>
                    ) : null}
                  </div>
                  {c.email ? (
                    <a
                      href={`mailto:${c.email}`}
                      className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground break-all"
                    >
                      <Mail className="size-3.5 shrink-0" />
                      {c.email}
                    </a>
                  ) : null}
                  {c.phone ? (
                    <a
                      href={`tel:${c.phone.replace(/\s/g, "")}`}
                      className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
                    >
                      <Phone className="size-3.5 shrink-0" />
                      {c.phone}
                    </a>
                  ) : null}
                  {c.notes ? <p className="text-xs text-muted-foreground whitespace-pre-wrap">{c.notes}</p> : null}
                  {canEdit ? (
                    <div className="flex flex-wrap gap-1 pt-1">
                      <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => openEdit(c)} disabled={busy}>
                        <Pencil className="size-3.5 mr-1" />
                        Edit
                      </Button>
                      {!c.isPrimary ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => void handleSetPrimary(c)}
                          disabled={busy}
                        >
                          <Star className="size-3.5 mr-1" />
                          Set primary
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground"
                        onClick={() => void handleArchive(c)}
                        disabled={busy}
                      >
                        <Archive className="size-3.5 mr-1" />
                        Archive
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit contact" : "Add contact"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-1">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cc-name">Name</Label>
              <Input
                id="cc-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                disabled={busy}
                aria-invalid={fieldErrors?.name ? true : undefined}
              />
              {fieldErrors?.name ? <p className="text-sm text-destructive">{fieldErrors.name}</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cc-role">Role</Label>
              <Select
                value={form.role || "buyer"}
                onValueChange={(v) => setForm((f) => ({ ...f, role: v as ClientContactRole }))}
                disabled={busy}
              >
                <SelectTrigger id="cc-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_CONTACT_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {CLIENT_CONTACT_ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldErrors?.role ? <p className="text-sm text-destructive">{fieldErrors.role}</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cc-email">Email</Label>
              <Input
                id="cc-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                disabled={busy}
                aria-invalid={fieldErrors?.email ? true : undefined}
              />
              {fieldErrors?.email ? <p className="text-sm text-destructive">{fieldErrors.email}</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cc-phone">Phone</Label>
              <Input
                id="cc-phone"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                disabled={busy}
                aria-invalid={fieldErrors?.phone ? true : undefined}
              />
              {fieldErrors?.phone ? <p className="text-sm text-destructive">{fieldErrors.phone}</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cc-notes">Notes</Label>
              <Textarea
                id="cc-notes"
                value={form.notes ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                disabled={busy}
                rows={2}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={Boolean(form.isPrimary)}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isPrimary: v === true }))}
                disabled={busy}
              />
              Primary contact
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={busy}>
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
