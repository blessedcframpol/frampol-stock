"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { FileText } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-nav"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAuth } from "@/lib/auth-context"
import { realInvoiceNumberProblem } from "@/lib/invoices"
import { canManageInvoices, ADMIN } from "@/lib/permissions"
import { loadProfileLabels } from "@/lib/profile-labels"
import { getSupabaseClient } from "@/lib/supabase/client"
import { KitSerialList } from "@/components/kit-serial"
import type { Database } from "@/lib/supabase/database.types"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"

type InvoiceListRow = Database["public"]["Views"]["batch_invoice_list"]["Row"]

function downloadCsv(filename: string, rows: string[][]) {
  const body = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n")
  const blob = new Blob([`\uFEFF${body}`], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function InvoicesContent() {
  const { role, user } = useAuth()
  const [rows, setRows] = useState<InvoiceListRow[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const allowed = canManageInvoices(role)
  const isAdmin = role === ADMIN

  const load = useCallback(async () => {
    const supabase = getSupabaseClient()
    if (!supabase || !allowed) return
    try {
      const data = await fetchAllPages((from, to) =>
        supabase
          .from("batch_invoice_list")
          .select("*")
          .order("entered_at", { ascending: true })
          .range(from, to),
      )
      setRows(data)
      const labels = await loadProfileLabels(supabase, [
        ...data.map((row) => row.entered_by),
        ...data.map((row) => row.approved_by),
      ])
      setNames(labels)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load invoices")
    } finally {
      setLoading(false)
    }
  }, [allowed])

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    const supabase = getSupabaseClient()
    if (!supabase) return
    void fetchAllPages((from, to) =>
      supabase
        .from("batch_invoice_list")
        .select("*")
        .order("entered_at", { ascending: true })
        .range(from, to),
    )
      .then(async (data) => {
        if (cancelled) return
        setRows(data)
        const labels = await loadProfileLabels(supabase, [
          ...data.map((row) => row.entered_by),
          ...data.map((row) => row.approved_by),
        ])
        if (!cancelled) {
          setNames(labels)
          setError(null)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load invoices")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [allowed])

  const pending = useMemo(() => rows.filter((row) => row.status === "pending"), [rows])
  const awaiting = useMemo(
    () => rows.filter((row) => row.status === "not_invoiced" && row.approval === "awaiting"),
    [rows],
  )
  const notInvoiced = useMemo(
    () => rows.filter((row) => row.status === "not_invoiced" && row.approval === "approved"),
    [rows],
  )
  const legacy = useMemo(() => rows.filter((row) => row.status === "legacy_unreviewed"), [rows])

  if (!allowed) {
    return (
      <PageHeader
        title="Invoices"
        description="Invoice records are for admin and accounts."
        icon={FileText}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Invoices"
        description="Pending numbers, 00000 approvals, and the legacy 00000 sales still to classify."
        icon={FileText}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading invoices…</p> : null}
      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
          {isAdmin ? <TabsTrigger value="awaiting">Awaiting approval ({awaiting.length})</TabsTrigger> : null}
          <TabsTrigger value="not-invoiced">Not invoiced ({notInvoiced.length})</TabsTrigger>
          <TabsTrigger value="legacy">Legacy 00000 ({legacy.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="pt-3">
          <InvoiceTable
            rows={pending}
            empty="No invoices are waiting for a number."
            extraHead={<TableHead>Waiting</TableHead>}
            extraCell={(row) => (
              <TableCell className="tabular-nums">
                {row.days_waiting ?? "—"} days
                {row.legacy ? <span className="ml-2 text-muted-foreground">Legacy</span> : null}
              </TableCell>
            )}
            action={(row) => <EnterNumber batchId={row.batch_id} onDone={load} />}
          />
        </TabsContent>
        {isAdmin ? (
          <TabsContent value="awaiting" className="pt-3">
            <InvoiceTable
              rows={awaiting}
              empty="Nothing is waiting for approval."
              extraHead={<TableHead>Reason</TableHead>}
              extraCell={(row) => <TableCell>{row.not_invoiced_reason || "—"}</TableCell>}
              action={(row) => (
                <ApprovalActions
                  batchId={row.batch_id}
                  own={Boolean(user?.id && row.entered_by === user.id)}
                  onDone={load}
                />
              )}
            />
          </TabsContent>
        ) : null}
        <TabsContent value="not-invoiced" className="pt-3">
          <div className="mb-3">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                downloadCsv("not-invoiced.csv", [
                  ["Batch", "Kit", "Client", "Quantity", "Reason", "Approver"],
                  ...notInvoiced.map((row) => [
                    row.batch_id,
                    row.serials ?? "",
                    row.client_name ?? "",
                    String(row.quantity),
                    row.not_invoiced_reason ?? "",
                    row.approved_by ? names.get(row.approved_by) || row.approved_by : "",
                  ]),
                ])
              }
            >
              Export
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kit</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Approver</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notInvoiced.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">No approved 00000 sales.</TableCell>
                </TableRow>
              ) : (
                notInvoiced.map((row) => (
                  <TableRow key={row.batch_id}>
                    <TableCell className="font-mono text-xs">
                      {row.serials ? <KitSerialList serials={row.serials} /> : row.product_name || "—"}
                    </TableCell>
                    <TableCell>{row.client_name || "—"}</TableCell>
                    <TableCell className="tabular-nums">{row.quantity}</TableCell>
                    <TableCell>{row.not_invoiced_reason || "—"}</TableCell>
                    <TableCell>{row.approved_by ? names.get(row.approved_by) || "User" : "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="legacy" className="pt-3">
          <InvoiceTable
            rows={legacy}
            empty="No unreviewed 00000 sales."
            action={(row) => <ClassifyLegacy batchId={row.batch_id} onDone={load} />}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function InvoiceTable({
  rows,
  empty,
  extraHead,
  extraCell,
  action,
}: {
  rows: InvoiceListRow[]
  empty: string
  extraHead?: ReactNode
  extraCell?: (row: InvoiceListRow) => ReactNode
  action: (row: InvoiceListRow) => ReactNode
}) {
  const columns = extraHead ? 5 : 4
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Client</TableHead>
          <TableHead>Product</TableHead>
          <TableHead>Qty</TableHead>
          {extraHead}
          <TableHead>Invoice</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns} className="text-muted-foreground">{empty}</TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.batch_id}>
              <TableCell>{row.client_name || "—"}</TableCell>
              <TableCell>
                <div>{row.product_name || "—"}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  <KitSerialList serials={row.serials} />
                </div>
              </TableCell>
              <TableCell className="tabular-nums">{row.quantity}</TableCell>
              {extraCell ? extraCell(row) : null}
              <TableCell className="min-w-56">{action(row)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

function EnterNumber({ batchId, onDone }: { batchId: string; onDone: () => Promise<void> }) {
  const [number, setNumber] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  async function save() {
    const problem = realInvoiceNumberProblem(number)
    if (problem) {
      toast.error(problem)
      return
    }
    const supabase = getSupabaseClient()
    if (!supabase) return
    setSaving(true)
    try {
      const { error } = await supabase.rpc("set_batch_invoice", {
        p_batch_id: batchId,
        p_choice: "number",
        p_invoice_number: number.trim(),
        p_reason: reason.trim(),
      })
      if (error) throw new Error(error.message)
      toast.success("Invoice number saved")
      await onDone()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save the invoice")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Input className="font-mono" value={number} placeholder="Invoice number" onChange={(event) => setNumber(event.target.value)} />
      <Input value={reason} placeholder="Reason, optional on the first number" onChange={(event) => setReason(event.target.value)} />
      <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>Save number</Button>
    </div>
  )
}

function ApprovalActions({
  batchId,
  own,
  onDone,
}: {
  batchId: string
  own: boolean
  onDone: () => Promise<void>
}) {
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  async function decide(kind: "approve" | "reject") {
    const supabase = getSupabaseClient()
    if (!supabase) return
    setSaving(true)
    try {
      const result = kind === "approve"
        ? await supabase.rpc("approve_batch_invoice", { p_batch_id: batchId })
        : await supabase.rpc("reject_batch_invoice", { p_batch_id: batchId, p_reason: reason.trim() })
      if (result.error) throw new Error(result.error.message)
      toast.success(kind === "approve" ? "Approved" : "Returned to pending")
      await onDone()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not update the approval")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {own ? <p className="text-xs text-muted-foreground">You entered this. Another admin has to approve it.</p> : null}
      <Button type="button" size="sm" disabled={saving || own} onClick={() => void decide("approve")}>Approve</Button>
      <Textarea value={reason} placeholder="Rejection reason, at least 15 characters" onChange={(event) => setReason(event.target.value)} />
      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void decide("reject")}>Reject</Button>
    </div>
  )
}

function ClassifyLegacy({ batchId, onDone }: { batchId: string; onDone: () => Promise<void> }) {
  const [number, setNumber] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  async function run(choice: "number" | "pending" | "not_invoiced") {
    if (choice === "number") {
      const problem = realInvoiceNumberProblem(number)
      if (problem) {
        toast.error(problem)
        return
      }
    }
    const supabase = getSupabaseClient()
    if (!supabase) return
    setSaving(true)
    try {
      const { error } = await supabase.rpc("set_batch_invoice", {
        p_batch_id: batchId,
        p_choice: choice,
        p_invoice_number: choice === "number" ? number.trim() : "",
        p_reason: reason.trim(),
      })
      if (error) throw new Error(error.message)
      toast.success("Classified")
      await onDone()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not classify this invoice")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Input className="font-mono" value={number} placeholder="Real invoice number" onChange={(event) => setNumber(event.target.value)} />
      <Button type="button" size="sm" disabled={saving} onClick={() => void run("number")}>Enter number</Button>
      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void run("pending")}>Mark pending</Button>
      <Textarea value={reason} placeholder="Not invoiced reason, at least 15 characters" onChange={(event) => setReason(event.target.value)} />
      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void run("not_invoiced")}>Mark not invoiced</Button>
    </div>
  )
}
