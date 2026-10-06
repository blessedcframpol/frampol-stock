"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { downloadCsv } from "@/lib/download-csv"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { fetchReturnsReport, type ReturnsReport } from "@/lib/returns-report"

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number)
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function ReportTable({
  title,
  filename,
  headers,
  rows,
  onExport,
}: {
  title: string
  filename: string
  headers: string[]
  rows: string[][]
  onExport: () => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <Button type="button" variant="outline" size="sm" onClick={onExport}>
          <Download className="mr-1.5 size-3.5" />
          Export
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header}>{header}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={headers.length} className="text-muted-foreground">
                  None in this range.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => (
                <TableRow key={`${filename}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <TableCell key={`${headerKey(headers, cellIndex)}-${index}`} className={cellIndex > 0 ? "tabular-nums" : undefined}>
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function headerKey(headers: string[], index: number): string {
  return headers[index] ?? String(index)
}

export function ReturnsReportPanel() {
  const timeZone = useOrgTimezone()
  const [from, setFrom] = useState(() => addDays(todayBusinessDate(), -90))
  const [to, setTo] = useState(() => todayBusinessDate())
  const [report, setReport] = useState<ReturnsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (from > to) return
    let cancelled = false
    void fetchReturnsReport(from, to)
      .then((next) => {
        if (cancelled) return
        setReport(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : "Could not load the returns report")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [from, to])

  const rangeInvalid = from > to
  const nowRows = report
    ? [
        ...report.now.waiting.map((row) => [row.type, String(row.units)]),
        ["Oldest wait (days)", report.now.oldest_wait_days == null ? "" : String(report.now.oldest_wait_days)],
        ["Oldest since", report.now.oldest_since ?? ""],
        ["Units out on rental", String(report.now.rental_out)],
      ]
    : []
  const reasonRows = report
    ? report.returns.flatMap((category) =>
        category.reasons.length > 0
          ? category.reasons.map((reason) => [category.category, String(category.units), reason.text, String(reason.units)])
          : [[category.category, String(category.units), "", "0"]],
      )
    : []
  const outcomeRows = report
    ? report.outcomes.map((row) => [row.outcome, String(row.starlink), String(row.other)])
    : []
  const resultRows = report ? report.results.map((row) => [row.result, String(row.units)]) : []
  const gradeRows = report ? report.grades.map((row) => [row.grade, String(row.units)]) : []
  const siteRows = report ? report.sites.map((row) => [row.site, String(row.units)]) : []

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-muted-foreground">
          From
          <input
            type="date"
            value={from}
            onChange={(event) => {
              const next = event.target.value
              if (next <= to) setLoading(true)
              setFrom(next)
            }}
            className="h-10 rounded-full bg-card px-3 text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted-foreground">
          To
          <input
            type="date"
            value={to}
            onChange={(event) => {
              const next = event.target.value
              if (from <= next) setLoading(true)
              setTo(next)
            }}
            className="h-10 rounded-full bg-card px-3 text-foreground"
          />
        </label>
        <p className="pb-2 text-xs text-muted-foreground">Timezone {timeZone}. The last 90 days is the default.</p>
      </div>
      {rangeInvalid ? <p className="text-sm text-danger">From is after to.</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading the report…</p> : null}
      {report && !rangeInvalid ? (
        <div className="flex flex-col gap-8">
          <ReportTable
            title="Now"
            filename="returns-now.csv"
            headers={["Item", "Value"]}
            rows={nowRows}
            onExport={() => downloadCsv([["Item", "Value"], ...nowRows], "returns-now.csv")}
          />
          <ReportTable
            title="Returns in the period"
            filename="returns-by-reason.csv"
            headers={["Category", "Units", "Reason", "Reason units"]}
            rows={reasonRows}
            onExport={() => downloadCsv([["Category", "Units", "Reason", "Reason units"], ...reasonRows], "returns-by-reason.csv")}
          />
          <ReportTable
            title="Inspection outcomes"
            filename="returns-outcomes.csv"
            headers={["Outcome", "Starlink", "Other"]}
            rows={outcomeRows}
            onExport={() => downloadCsv([["Outcome", "Starlink", "Other"], ...outcomeRows], "returns-outcomes.csv")}
          />
          <div className="grid gap-6 md:grid-cols-2">
            <ReportTable
              title="Pass / Fail"
              filename="returns-results.csv"
              headers={["Result", "Units"]}
              rows={resultRows}
              onExport={() => downloadCsv([["Result", "Units"], ...resultRows], "returns-results.csv")}
            />
            <ReportTable
              title="Grades"
              filename="returns-grades.csv"
              headers={["Grade", "Units"]}
              rows={gradeRows}
              onExport={() => downloadCsv([["Grade", "Units"], ...gradeRows], "returns-grades.csv")}
            />
          </div>
          <ReportTable
            title="Client cancellations by site"
            filename="returns-sites.csv"
            headers={["Site", "Cancellations"]}
            rows={siteRows}
            onExport={() => downloadCsv([["Site", "Cancellations"], ...siteRows], "returns-sites.csv")}
          />
        </div>
      ) : null}
    </div>
  )
}
