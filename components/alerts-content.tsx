"use client"

import Link from "next/link"
import { Fragment, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/fs/empty-state"
import { FilterChip } from "@/components/fs/filter-chip"
import { StatusPill } from "@/components/fs/status-pill"
import { PageHeader } from "@/components/page-nav"
import { useAuth } from "@/lib/auth-context"
import { useAlertFeed } from "@/hooks/use-alert-feed"
import { formatBusinessDate } from "@/lib/business-date.mjs"
import {
  alertChipFromSearch,
  canRecordReturn,
  formatReturnAge,
  groupReturnRows,
  isInternalHolder,
  recordReturnHref,
  sectionCount,
  showsSection,
  visibleReturnRows,
  type AlertChip,
  type AlertCounts,
  type ReturnAlertRow,
} from "@/lib/alerts"
import { ConvertToSaleDialog, ExtendHoldingDialog } from "@/components/holding-actions"
import { AlertTriangle, ChevronRight } from "lucide-react"

const CHIPS: { id: AlertChip; label: string; count: (counts: AlertCounts) => number }[] = [
  { id: "all", label: "All", count: (counts) => counts.all },
  { id: "overdue", label: "Overdue", count: (counts) => counts.overdue },
  { id: "dueSoon", label: "Due soon", count: (counts) => counts.dueSoon },
  { id: "lowStock", label: "Low stock", count: (counts) => counts.lowStock },
  { id: "poc", label: "POC", count: (counts) => counts.poc },
  { id: "rental", label: "Rental", count: (counts) => counts.rental },
]

function ReturnTable({
  rows,
  today,
  showActions,
  onConvert,
  onExtend,
}: {
  rows: ReturnAlertRow[]
  today: string
  showActions: boolean
  onConvert: (serial: string) => void
  onExtend: (row: ReturnAlertRow) => void
}) {
  const groups = groupReturnRows(rows)
  const columns = showActions ? 7 : 6
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Serial</TableHead>
            <TableHead>Product</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Holder</TableHead>
            <TableHead>Return date</TableHead>
            <TableHead>Age</TableHead>
            {showActions ? <TableHead className="text-right">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => {
            const grouped = group.rows.length > 1
            return (
              <Fragment key={group.key}>
                {grouped ? (
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={columns} className="whitespace-normal">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {group.holder}
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            · {formatBusinessDate(group.returnDate)} · {group.rows.length} units
                          </span>
                        </span>
                        {showActions ? (
                          <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                            <Link href={recordReturnHref(group.kind, group.rows.map((row) => row.serialNumber))}>
                              Record return ({group.rows.length})
                              <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                            </Link>
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
                {group.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-sm text-foreground">{row.serialNumber}</TableCell>
                    <TableCell className="text-sm text-foreground">{row.product}</TableCell>
                    <TableCell>
                      <StatusPill value={row.kind === "POC" ? "POC" : "Rented"}>
                        {row.kind}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.holder}
                      {isInternalHolder(row.holder) ? (
                        <span className="ml-2 text-xs uppercase tracking-wide">Internal</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatBusinessDate(row.returnDate)}</TableCell>
                    <TableCell className="text-sm">{formatReturnAge(row.returnDate, today)}</TableCell>
                    {showActions ? (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {grouped ? null : (
                            <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                              <Link href={recordReturnHref(row.kind, [row.serialNumber])}>
                                Record return
                                <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                              </Link>
                            </Button>
                          )}
                          {row.kind === "POC" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() => onConvert(row.serialNumber)}
                            >
                              Convert to sale
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => onExtend(row)}
                          >
                            Extend
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

export function AlertsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const chipParam = searchParams.get("chip")
  const { role } = useAuth()
  const { feed, loading, error } = useAlertFeed()
  const [chip, setChip] = useState<AlertChip>(() => alertChipFromSearch(chipParam))
  const [chipParamSeen, setChipParamSeen] = useState(chipParam)
  if (chipParam !== chipParamSeen) {
    setChipParamSeen(chipParam)
    setChip(alertChipFromSearch(chipParam))
  }
  const [hideInternal, setHideInternal] = useState(false)
  const [convertSerial, setConvertSerial] = useState<string | null>(null)
  const [extendRow, setExtendRow] = useState<ReturnAlertRow | null>(null)
  const showActions = canRecordReturn(role)
  const counts = feed?.counts

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <PageHeader
        title="Alerts"
        description="Overdue returns, returns due in the next 14 days, and low stock. Record a return in Inventory movement."
      />

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {CHIPS.map((item) => (
            <FilterChip
              key={item.id}
              label={item.label}
              count={counts ? item.count(counts) : undefined}
              selected={chip === item.id}
              onSelect={() => setChip(item.id)}
            />
          ))}
          <FilterChip
            label="Internal"
            count={counts?.internal}
            selected={hideInternal}
            onSelect={() => setHideInternal((current) => !current)}
          />
        </div>
        {counts ? (
          <p className="text-sm text-muted-foreground">
            {counts.internal} {counts.internal === 1 ? "unit is" : "units are"} with internal holders.
          </p>
        ) : null}
      </div>

      {loading && !feed ? (
        <p className="text-sm text-muted-foreground">Loading alerts…</p>
      ) : feed && counts && counts.all === 0 ? (
        <EmptyState
          icon={<AlertTriangle />}
          message="No alerts. You're all set. New alerts will appear here when a return is overdue, a return is due in the next 14 days, or stock is low."
        />
      ) : feed && counts ? (
        <div className="flex flex-col gap-6">
          {showsSection(chip, "overdue") ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">
                Overdue returns
                <span className="ml-2 tabular-nums text-muted-foreground">{sectionCount(counts, "overdue", chip)}</span>
              </h2>
              {visibleReturnRows(feed.overdue, chip, hideInternal).length === 0 ? (
                <EmptyState message="No overdue returns." />
              ) : (
                <Card className="border-border p-0">
                  <ReturnTable
                    rows={visibleReturnRows(feed.overdue, chip, hideInternal)}
                    today={feed.today}
                    showActions={showActions}
                    onConvert={setConvertSerial}
                    onExtend={setExtendRow}
                  />
                </Card>
              )}
            </section>
          ) : null}

          {showsSection(chip, "dueSoon") ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">
                Due soon
                <span className="ml-2 tabular-nums text-muted-foreground">{sectionCount(counts, "dueSoon", chip)}</span>
              </h2>
              {visibleReturnRows(feed.dueSoon, chip, hideInternal).length === 0 ? (
                <EmptyState message="No returns due in the next 14 days." />
              ) : (
                <Card className="border-border p-0">
                  <ReturnTable
                    rows={visibleReturnRows(feed.dueSoon, chip, hideInternal)}
                    today={feed.today}
                    showActions={showActions}
                    onConvert={setConvertSerial}
                    onExtend={setExtendRow}
                  />
                </Card>
              )}
            </section>
          ) : null}

          {showsSection(chip, "lowStock") ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">
                Low stock
                <span className="ml-2 tabular-nums text-muted-foreground">{counts.lowStock}</span>
              </h2>
              {feed.lowStock.length === 0 ? (
                <EmptyState message="No low stock alerts." />
              ) : (
                <Card className="border-border p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Product</TableHead>
                          <TableHead>Vendor</TableHead>
                          <TableHead className="text-right">In stock</TableHead>
                          <TableHead className="text-right">Reorder at</TableHead>
                          {role != null && role !== "viewer" ? <TableHead className="text-right">Actions</TableHead> : null}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {feed.lowStock.map((row) => (
                          <TableRow
                            key={row.productId}
                            className="cursor-pointer"
                            onClick={() => router.push(`/inventory/${row.productId}`)}
                          >
                            <TableCell className="font-medium text-foreground">{row.product}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{row.vendor}</TableCell>
                            <TableCell className="text-right tabular-nums text-sm">{row.inStock}</TableCell>
                            <TableCell className="text-right tabular-nums text-sm">{row.reorderAt}</TableCell>
                            {role != null && role !== "viewer" ? (
                              <TableCell className="text-right">
                                <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
                                  <Link href={`/inventory/${row.productId}`} onClick={(event) => event.stopPropagation()}>
                                    Open
                                    <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                                  </Link>
                                </Button>
                              </TableCell>
                            ) : null}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
      <ConvertToSaleDialog
        open={convertSerial != null}
        serial={convertSerial ?? ""}
        onOpenChange={(open) => {
          if (!open) setConvertSerial(null)
        }}
      />
      <ExtendHoldingDialog
        open={extendRow != null}
        itemId={extendRow?.id ?? ""}
        serial={extendRow?.serialNumber ?? ""}
        onOpenChange={(open) => {
          if (!open) setExtendRow(null)
        }}
      />
    </div>
  )
}
