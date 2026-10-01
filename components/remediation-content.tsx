"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/fs/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchRemediationProviders,
  fetchRemediationCases,
  createRemediationCase,
  updateRemediationCase,
  type RemediationCaseRow,
  type RemediationProviderRow,
} from "@/lib/supabase/remediation-db"
import { useInventoryStore } from "@/lib/inventory-store"
import { useAuth } from "@/lib/auth-context"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { PageHeader } from "@/components/page-nav"
import { canManageRemediation } from "@/lib/permissions"

function normalizeVendor(v: string | undefined): string {
  return (v ?? "").trim() || "General"
}

export function RemediationContent() {
  const supabase = useMemo(() => {
    try {
      return getSupabaseClient()
    } catch {
      return null
    }
  }, [])
  const { inventory, refetchLedger } = useInventoryStore()
  const { user, role } = useAuth()
  const canManage = canManageRemediation(role)

  const [providers, setProviders] = useState<RemediationProviderRow[]>([])
  const [cases, setCases] = useState<RemediationCaseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [providerId, setProviderId] = useState("")
  const [faultySerial, setFaultySerial] = useState("")
  const [caseNotes, setCaseNotes] = useState("")

  const eligibleFaulty = useMemo(
    () =>
      inventory.filter(
        (i) =>
          i.status === "RMA Hold" && normalizeVendor(i.vendor).toLowerCase() === "starlink"
      ),
    [inventory]
  )

  const fetchRemediationData = useCallback(async () => {
    if (!supabase) return null
    const [p, c] = await Promise.all([fetchRemediationProviders(supabase), fetchRemediationCases(supabase)])
    return { providers: p, cases: c }
  }, [supabase])

  const load = useCallback(async () => {
    try {
      const data = await fetchRemediationData()
      if (!data) return
      setProviders(data.providers)
      setCases(data.cases)
      setProviderId((prev) => (data.providers.length && !prev ? data.providers[0]!.id : prev))
    } catch (e) {
      console.error(e)
      toast.error("Could not load remediation data")
    } finally {
      setLoading(false)
    }
  }, [fetchRemediationData])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await fetchRemediationData()
        if (cancelled || !data) return
        setProviders(data.providers)
        setCases(data.cases)
        setProviderId((prev) => (data.providers.length && !prev ? data.providers[0]!.id : prev))
      } catch (e) {
        if (!cancelled) {
          console.error(e)
          toast.error("Could not load remediation data")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchRemediationData])

  async function handleCreateCase(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase || !canManage) return
    const serial = faultySerial.trim()
    if (!serial) {
      toast.error("Enter faulty kit serial")
      return
    }
    if (!providerId) {
      toast.error("Select provider")
      return
    }
    const item = inventory.find((i) => i.serialNumber === serial)
    if (!item) {
      toast.error("Serial not found in inventory")
      return
    }
    if (item.status !== "RMA Hold") {
      toast.error("Faulty unit must be in RMA Hold status")
      return
    }
    setSaving(true)
    try {
      await createRemediationCase(supabase, {
        providerId,
        faultyInventoryItemId: item.id,
        faultySerial: item.serialNumber,
        notes: caseNotes.trim() || undefined,
        createdBy: user?.id ?? null,
      })
      toast.success("Remediation case created")
      setFaultySerial("")
      setCaseNotes("")
      await load()
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Failed to create case")
    } finally {
      setSaving(false)
    }
  }

  async function patchCase(id: string, field: string, value: string) {
    if (!supabase || !canManage) return
    setSaving(true)
    try {
      const patch: Record<string, string | null> = {}
      if (field === "status") patch.status = value
      if (field === "tracking_reference") patch.tracking_reference = value || null
      if (field === "date_sent_to_provider") patch.date_sent_to_provider = value || null
      if (field === "date_replacement_received") patch.date_replacement_received = value || null
      if (field === "notes") patch.notes = value || null
      if (field === "provider_replacement_serial") patch.provider_replacement_serial = value || null
      await updateRemediationCase(supabase, id, patch)
      toast.success("Updated")
      await load()
      void refetchLedger()
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error ? err.message : "Update failed")
    } finally {
      setSaving(false)
    }
  }

  if (!supabase) {
    return (
      <p className="text-sm text-muted-foreground">Supabase is not configured.</p>
    )
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <PageHeader
        title="Remediation"
        description="Provider RMA chain (Starlink first). Create a case for a faulty unit on RMA Hold, then issue a loaner from Inventory movement → Rem. loaner using the case ID."
      />

      {canManage ? <Card>
        <CardHeader>
          <CardTitle className="text-base">New case</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateCase} className="grid gap-4 max-w-lg">
            <div className="flex flex-col gap-2">
              <Label>Provider</Label>
              <Select value={providerId} onValueChange={setProviderId}>
                <SelectTrigger>
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Faulty serial / Kit ID (must be RMA Hold, Starlink)</Label>
              <Input
                className="font-mono"
                value={faultySerial}
                onChange={(e) => setFaultySerial(e.target.value)}
                placeholder="Scan or type serial"
                list="remediation-faulty-serials"
              />
              <datalist id="remediation-faulty-serials">
                {eligibleFaulty.map((i) => (
                  <option key={i.id} value={i.serialNumber}>
                    {i.name}
                  </option>
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Notes (optional)</Label>
              <Textarea value={caseNotes} onChange={(e) => setCaseNotes(e.target.value)} rows={2} />
            </div>
            <Button type="submit" disabled={saving || loading}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create case"}
            </Button>
          </form>
        </CardContent>
      </Card> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cases</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading ? (
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          ) : cases.length === 0 ? (
            <EmptyState message="No remediation cases yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Case ID</TableHead>
                  <TableHead>Faulty serial</TableHead>
                  <TableHead>Loaner</TableHead>
                  <TableHead>Provider repl.</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tracking</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-[10px] max-w-[100px] truncate" title={c.id}>
                      {c.id}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.faulty_serial}</TableCell>
                    <TableCell className="font-mono text-xs">{c.loaner_serial ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{c.provider_replacement_serial ?? "—"}</TableCell>
                    <TableCell>
                      {canManage ? (
                        <Select
                          value={c.status}
                          onValueChange={(v) => void patchCase(c.id, "status", v)}
                          disabled={saving}
                        >
                          <SelectTrigger className="h-8 w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pending">pending</SelectItem>
                            <SelectItem value="sent">sent</SelectItem>
                            <SelectItem value="replacement_received">replacement_received</SelectItem>
                            <SelectItem value="closed">closed</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        c.status
                      )}
                    </TableCell>
                    <TableCell>
                      {canManage ? (
                        <Input
                          className="h-8 font-mono text-xs min-w-[100px]"
                          defaultValue={c.tracking_reference ?? ""}
                          onBlur={(e) => {
                            if (e.target.value !== (c.tracking_reference ?? ""))
                              void patchCase(c.id, "tracking_reference", e.target.value)
                          }}
                        />
                      ) : (
                        c.tracking_reference ?? "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {canManage ? (
                        <Input
                          type="date"
                          className="h-8 w-[130px]"
                          defaultValue={c.date_sent_to_provider ?? ""}
                          onBlur={(e) => {
                            if (e.target.value !== (c.date_sent_to_provider ?? ""))
                              void patchCase(c.id, "date_sent_to_provider", e.target.value)
                          }}
                        />
                      ) : (
                        c.date_sent_to_provider ?? "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {canManage ? (
                        <Input
                          type="date"
                          className="h-8 w-[130px]"
                          defaultValue={c.date_replacement_received ?? ""}
                          onBlur={(e) => {
                            if (e.target.value !== (c.date_replacement_received ?? ""))
                              void patchCase(c.id, "date_replacement_received", e.target.value)
                          }}
                        />
                      ) : (
                        c.date_replacement_received ?? "—"
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      {canManage ? (
                        <Input
                          className="h-8 text-xs"
                          defaultValue={c.notes ?? ""}
                          onBlur={(e) => {
                            if (e.target.value !== (c.notes ?? ""))
                              void patchCase(c.id, "notes", e.target.value)
                          }}
                        />
                      ) : (
                        c.notes ?? "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
