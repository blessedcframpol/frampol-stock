"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { StatusPill } from "@/components/fs/status-pill"
import { IntakeReasonFields } from "@/components/intake-reason-fields"
import { InvoiceChoiceFields } from "@/components/invoice-choice-fields"
import { ReturnPoolChoice } from "@/components/return-pool-choice"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { formatBusinessDate, todayBusinessDate } from "@/lib/business-date.mjs"
import {
  resolveDraftFromItem,
  resolveHoldingRow,
  resolveRowProblems,
  resolveSummaryText,
  readBulkResolveResult,
  type ResolveAction,
  type ResolveDraft,
} from "@/lib/bulk-resolve"
import { INTERNAL_LOCATIONS, type InventoryItem } from "@/lib/data"
import type { InvoiceChoice } from "@/lib/invoices"
import { useInventoryStore } from "@/lib/inventory-store"
import { getSupabaseClient } from "@/lib/supabase/client"

export function ResolveHoldingsDialog({
  open,
  kits,
  onOpenChange,
  onCompleted,
}: {
  open: boolean
  kits: InventoryItem[]
  onOpenChange: (open: boolean) => void
  onCompleted: () => Promise<void> | void
}) {
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const { transactions } = useInventoryStore()
  const signature = kits.map((kit) => kit.id).join("|")
  const [builtFor, setBuiltFor] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<ResolveDraft[]>([])
  const [summary, setSummary] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!open && builtFor != null) {
    setBuiltFor(null)
    setDrafts([])
    setSummary(null)
    setFormError(null)
  } else if (open && builtFor !== signature && summary == null && !submitting) {
    setBuiltFor(signature)
    setDrafts(
      kits.flatMap((kit) => {
        const draft = resolveDraftFromItem(kit, transactions, today)
        return draft ? [draft] : []
      }),
    )
    setFormError(null)
  }

  function patchDraft(serial: string, patch: Partial<ResolveDraft>) {
    setDrafts((prev) =>
      prev.map((draft) => {
        if (draft.serialNumber !== serial) return draft
        const next: ResolveDraft = { ...draft, ...patch, serverErrors: [] }
        if (patch.actionDate && draft.kind === "Rental" && !draft.rentalEndTouched && patch.rentalEnd == null) {
          next.rentalEnd = patch.actionDate
        }
        if (patch.action === "sold" && next.kind === "Rental" && !next.rentalEndTouched) {
          next.rentalEnd = next.actionDate
        }
        return next
      }),
    )
  }

  const problems = drafts.map((draft) => [
    ...new Set([...resolveRowProblems(draft, today), ...draft.serverErrors]),
  ])
  const ready =
    drafts.some((draft) => draft.action !== "leave") && problems.every((row) => row.length === 0)

  async function submit() {
    const checked = drafts.map((draft) => ({ ...draft, serverErrors: resolveRowProblems(draft, today) }))
    if (checked.some((draft) => draft.serverErrors.length > 0) || checked.every((draft) => draft.action === "leave")) {
      setDrafts(checked)
      return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const supabase = getSupabaseClient()
      if (!supabase) {
        setFormError("Could not resolve these kits")
        return
      }
      const { data, error } = await supabase.rpc("bulk_resolve_holdings", {
        p_rows: drafts.map(resolveHoldingRow),
      })
      if (error) {
        setFormError(error.message)
        return
      }
      const result = readBulkResolveResult(data)
      if (!result) {
        setFormError("Could not resolve these kits")
        return
      }
      if (!result.ok) {
        setDrafts((prev) =>
          prev.map((draft) => ({
            ...draft,
            serverErrors: result.errors.find((entry) => entry.serial === draft.serialNumber)?.messages ?? [],
          })),
        )
        const loose = result.errors.find((entry) => entry.serial === "")
        setFormError(loose ? loose.messages.join(" ") : null)
        return
      }
      setSummary(resolveSummaryText(result))
      await onCompleted()
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not resolve these kits")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent className="bg-card text-card-foreground sm:max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Resolve selected</DialogTitle>
        </DialogHeader>
        {summary ? (
          <p className="text-sm text-foreground">{summary}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Returned and Sold are written together. Leave keeps that kit as it is.
            </p>
            {formError ? <p className="text-sm text-danger">{formError}</p> : null}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Serial</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Due date</TableHead>
                    <TableHead className="text-right">Days overdue</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drafts.map((draft, index) => (
                    <ResolveRow
                      key={draft.serialNumber}
                      draft={draft}
                      today={today}
                      problems={problems[index] ?? []}
                      onPatch={(patch) => patchDraft(draft.serialNumber, patch)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        <DialogFooter>
          {summary ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={submitting || !ready}>
                Resolve selected
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResolveRow({
  draft,
  today,
  problems,
  onPatch,
}: {
  draft: ResolveDraft
  today: string
  problems: string[]
  onPatch: (patch: Partial<ResolveDraft>) => void
}) {
  const lower = draft.dispatchDate > draft.lastMovementDate ? draft.dispatchDate : draft.lastMovementDate
  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell className="font-mono text-sm text-foreground">{draft.serialNumber}</TableCell>
        <TableCell>
          <StatusPill value={draft.kind === "Rental" ? "Rented" : "POC"}>{draft.kind}</StatusPill>
        </TableCell>
        <TableCell className="max-w-[180px] truncate text-sm text-muted-foreground" title={draft.client}>
          {draft.client}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{formatBusinessDate(draft.dueDate)}</TableCell>
        <TableCell className="text-right text-sm tabular-nums text-foreground">{draft.daysOverdue}</TableCell>
        <TableCell>
          <Select value={draft.action} onValueChange={(value) => onPatch({ action: value as ResolveAction })}>
            <SelectTrigger className="bg-card text-foreground border-border w-[140px]" aria-label={`Action for ${draft.serialNumber}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="returned">Returned</SelectItem>
              <SelectItem value="sold">Sold</SelectItem>
              <SelectItem value="leave">Leave</SelectItem>
            </SelectContent>
          </Select>
        </TableCell>
      </TableRow>
      {draft.action === "leave" ? null : (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="bg-muted/30">
            <div className="grid gap-3 py-1 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${draft.serialNumber}-date`}>
                  {draft.action === "returned" ? "Date returned" : "Sale date"}
                </Label>
                <Input
                  id={`${draft.serialNumber}-date`}
                  type="date"
                  min={lower || undefined}
                  max={today}
                  value={draft.actionDate}
                  onChange={(event) => onPatch({ actionDate: event.target.value })}
                  className="bg-card text-foreground border-border"
                />
              </div>
              {draft.action === "returned" ? (
                <div className="flex flex-col gap-1.5">
                  <Label>Warehouse</Label>
                  <Select value={draft.location || undefined} onValueChange={(value) => onPatch({ location: value })}>
                    <SelectTrigger className="bg-card text-foreground border-border">
                      <SelectValue placeholder="Choose a warehouse" />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERNAL_LOCATIONS.map((location) => (
                        <SelectItem key={location} value={location}>
                          {location}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {draft.action === "returned" && draft.kind === "POC" ? (
                <div className="sm:col-span-2">
                  <ReturnPoolChoice
                    value={draft.returnPool}
                    onChange={(value) => onPatch({ returnPool: value })}
                  />
                </div>
              ) : null}
              {draft.action === "returned" && draft.kind === "Rental" ? (
                <div className="sm:col-span-2 flex flex-col gap-3">
                  <IntakeReasonFields
                    category={draft.reasonCategory}
                    reason={draft.reasonText}
                    onCategory={(value) => onPatch({ reasonCategory: value })}
                    onReason={(value) => onPatch({ reasonText: value })}
                  />
                </div>
              ) : null}
              {draft.action === "sold" && draft.kind === "Rental" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${draft.serialNumber}-end`}>Rental end date</Label>
                  <Input
                    id={`${draft.serialNumber}-end`}
                    type="date"
                    min={draft.rentalStart || undefined}
                    max={today}
                    value={draft.rentalEnd}
                    onChange={(event) => onPatch({ rentalEnd: event.target.value, rentalEndTouched: true })}
                    className="bg-card text-foreground border-border"
                  />
                </div>
              ) : null}
              {draft.action === "sold" ? (
                <div className="sm:col-span-2">
                  <InvoiceChoiceFields
                    idPrefix={draft.serialNumber}
                    choice={draft.invoiceChoice}
                    invoiceNumber={draft.invoiceNumber}
                    reason={draft.invoiceReason}
                    onChoice={(choice: InvoiceChoice) => onPatch({ invoiceChoice: choice })}
                    onInvoiceNumber={(value) => onPatch({ invoiceNumber: value })}
                    onReason={(value) => onPatch({ invoiceReason: value })}
                  />
                </div>
              ) : null}
              {problems.length > 0 ? (
                <ul className="sm:col-span-2 text-sm text-danger">
                  {problems.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
