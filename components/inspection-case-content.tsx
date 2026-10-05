"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-nav"
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
import { StockPoolChip } from "@/components/stock-pool-chip"
import { useAuth } from "@/lib/auth-context"
import { canCompleteInspection } from "@/lib/permissions"
import { INTERNAL_LOCATIONS } from "@/lib/data"
import { INTAKE_REASON_CATEGORIES } from "@/components/intake-reason-fields"
import {
  clientLabel,
  completeInspection,
  daysWaiting,
  gradeSuggestion,
  inspectionOutcomes,
  loadKitCase,
  type KitCaseRow,
} from "@/lib/kit-cases"

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-3 border-b border-border py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground break-words">{value}</span>
    </div>
  )
}

export function InspectionCaseContent({ caseId }: { caseId: string }) {
  const router = useRouter()
  const { role } = useAuth()
  const isAdmin = canCompleteInspection(role)
  const [row, setRow] = useState<KitCaseRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState("")
  const [grade, setGrade] = useState("")
  const [outcome, setOutcome] = useState("")
  const [comments, setComments] = useState("")
  const [location, setLocation] = useState("")
  const [category, setCategory] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadKitCase(caseId)
      .then((next) => {
        if (cancelled) return
        setRow(next)
        setCategory(next?.reason_category ?? "")
        setError(next ? null : "Case not found")
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the case")
      })
    return () => {
      cancelled = true
    }
  }, [caseId])

  const outcomes = inspectionOutcomes(result, row?.vendor ?? null)
  const suggestion = gradeSuggestion(grade, row?.vendor ?? null)
  const needsWarehouse = outcome === "Resell" || outcome === "Rent out"
  const open = row?.stage === "open"

  async function save() {
    if (!row || !isAdmin || !open) return
    if (result !== "Pass" && result !== "Fail") {
      toast.error("Choose Pass or Fail")
      return
    }
    if (grade !== "A" && grade !== "B" && grade !== "C") {
      toast.error("Choose a grade")
      return
    }
    if (!comments.trim()) {
      toast.error("Comments are required")
      return
    }
    if (!outcome) {
      toast.error("Choose an outcome")
      return
    }
    if (needsWarehouse && !location) {
      toast.error("Pick a warehouse")
      return
    }
    setSaving(true)
    try {
      await completeInspection({
        caseId: row.id,
        result,
        comments: comments.trim(),
        grade,
        outcome,
        location: needsWarehouse ? location : null,
        reasonCategory: category && category !== row.reason_category ? category : null,
      })
      toast.success("Inspection recorded")
      router.push("/inventory/inspections")
      router.refresh()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not record the inspection")
    } finally {
      setSaving(false)
    }
  }

  if (error) return <p className="text-sm text-danger">{error}</p>
  if (!row) return <p className="text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHeader
        title={row.serial_number}
        description={`${row.product_name ?? "Kit"} · ${row.source_label}`}
        back={{ href: "/inventory/inspections", label: "Inspections" }}
      />
      <section className="rounded-md border border-border p-4">
        <h2 className="text-sm font-medium text-foreground mb-2">Kit</h2>
        <Detail label="Product" value={row.product_name ?? "—"} />
        <Detail label="Vendor" value={row.vendor ?? "—"} />
        <Detail label="Status" value={row.kit_status} />
        <div className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-3 border-b border-border py-2 text-sm">
          <span className="text-muted-foreground">Group</span>
          <span className="inline-flex items-center gap-2">
            {row.stock_pool === "rental" ? "Rental" : row.stock_pool === "demo" ? "Demo" : "Sale"}
            <StockPoolChip pool={row.stock_pool === "rental" || row.stock_pool === "demo" ? row.stock_pool : "sale"} />
          </span>
        </div>
        <Detail label="Holder" value={row.holder || "—"} />
        <Detail label="Location" value={row.location || "—"} />
        <Detail label="Client" value={clientLabel(row)} />
        <Detail label="Days waiting" value={String(daysWaiting(row.opened_at))} />
      </section>
      <section className="rounded-md border border-border p-4">
        <h2 className="text-sm font-medium text-foreground mb-2">Intake</h2>
        <Detail label="Type" value={row.source_label} />
        <Detail label="Category" value={row.reason_category} />
        <Detail label="Reason" value={row.reason_text} />
      </section>
      {open ? (
        <section className="rounded-md border border-border p-4 flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">Inspection</h2>
          {!isAdmin ? <p className="text-sm text-muted-foreground">Only an admin can record the inspection.</p> : null}
          <div className="flex flex-col gap-2">
            <Label>Reason category</Label>
            <Select value={category} onValueChange={setCategory} disabled={!isAdmin}>
              <SelectTrigger className="bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {row.reason_category === "Not recorded" ? <SelectItem value="Not recorded">Not recorded</SelectItem> : null}
                {INTAKE_REASON_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Result</Label>
            <Select value={result} onValueChange={(value) => { setResult(value); setOutcome("") }} disabled={!isAdmin}>
              <SelectTrigger className="bg-card">
                <SelectValue placeholder="Pass or Fail" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Pass">Pass</SelectItem>
                <SelectItem value="Fail">Fail</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Grade</Label>
            <Select value={grade} onValueChange={setGrade} disabled={!isAdmin}>
              <SelectTrigger className="bg-card">
                <SelectValue placeholder="A, B, or C" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="A">A</SelectItem>
                <SelectItem value="B">B</SelectItem>
                <SelectItem value="C">C</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A suggests Resell. B suggests Rent out for Starlink. C suggests Dispose. The grade is a guide.
              {suggestion ? ` Suggested outcome: ${suggestion}.` : ""}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Comments</Label>
            <Textarea className="bg-card min-h-[88px]" value={comments} onChange={(event) => setComments(event.target.value)} disabled={!isAdmin} />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Outcome</Label>
            <Select value={outcome} onValueChange={setOutcome} disabled={!isAdmin || outcomes.length === 0}>
              <SelectTrigger className="bg-card">
                <SelectValue placeholder="Choose an outcome" />
              </SelectTrigger>
              <SelectContent>
                {outcomes.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsWarehouse ? (
            <div className="flex flex-col gap-2">
              <Label>Warehouse</Label>
              <Select value={location} onValueChange={setLocation} disabled={!isAdmin}>
                <SelectTrigger className="bg-card">
                  <SelectValue placeholder="Pick a warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {INTERNAL_LOCATIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {isAdmin ? (
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Record inspection"}
            </Button>
          ) : null}
        </section>
      ) : (
        <section className="rounded-md border border-border p-4">
          <h2 className="text-sm font-medium text-foreground mb-2">Closed</h2>
          <Detail label="Outcome" value={row.outcome ?? "—"} />
          <Detail label="Grade" value={row.grade ?? "—"} />
          <Detail label="Result" value={row.result ?? "—"} />
          <Detail label="Comments" value={row.comments ?? "—"} />
          <Detail label="Recorded by" value={row.closed_by_name ?? "Recorded"} />
        </section>
      )}
    </div>
  )
}
