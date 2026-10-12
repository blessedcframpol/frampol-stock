"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { ArrowUpRight } from "lucide-react"
import { useAlertFeed } from "@/hooks/use-alert-feed"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { useRequestDisplayStatuses } from "@/hooks/use-request-display-statuses"
import { useAuth } from "@/lib/auth-context"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { ageInDays, formatAgeDays, formatCount } from "@/lib/format-display"
import { loadKitCases } from "@/lib/kit-cases"
import { cn } from "@/lib/utils"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchLatestOpenRequests,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"

/** Open requests are few; this bounds the one fetch the row makes. */
const OPEN_REQUEST_LIMIT = 200

type TodoItem = {
  key: string
  label: string
  /** null while loading. */
  count: number | null
  caption?: string
  href: string
}

function TodoCard({ item }: { item: TodoItem }) {
  const active = (item.count ?? 0) > 0
  return (
    <Link
      href={item.href}
      className={cn(
        "group relative flex min-h-11 flex-col gap-1 rounded-2xl p-4 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-card text-card-foreground hover:bg-accent" : "bg-card/60 text-muted-foreground hover:bg-accent"
      )}
    >
      <ArrowUpRight className="absolute right-3 top-3 size-4 text-muted-foreground" aria-hidden />
      <p className="pr-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.label}</p>
      <p className={cn("text-2xl font-semibold tabular-nums tracking-tight", active && "text-foreground")}>
        {item.count == null ? "—" : formatCount(item.count)}
      </p>
      {item.caption ? <p className="text-xs text-muted-foreground">{item.caption}</p> : null}
    </Link>
  )
}

/** Admin dashboard "To do": things waiting on an admin, each linking to where it gets done. */
export function AdminTodoRow() {
  const { user } = useAuth()
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const { feed, loading: alertsLoading } = useAlertFeed()

  const [openRequests, setOpenRequests] = useState<StockRequestWithRelations[] | null>(null)
  const [inspections, setInspections] = useState<number | null>(null)
  const [problems, setProblems] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const sb = getSupabaseClient()
    void fetchLatestOpenRequests(sb, OPEN_REQUEST_LIMIT)
      .then((rows) => {
        if (!cancelled) setOpenRequests(rows)
      })
      .catch(() => {
        if (!cancelled) setOpenRequests([])
      })
    void loadKitCases("open")
      .then((rows) => {
        if (!cancelled) setInspections(rows.length)
      })
      .catch(() => {
        if (!cancelled) setInspections(0)
      })
    void sb
      .from("problem_reports")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .then(({ count, error }) => {
        if (!cancelled) setProblems(error ? 0 : (count ?? 0))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const displayStatuses = useRequestDisplayStatuses(openRequests ?? [])

  const toIssue = useMemo(
    () =>
      (openRequests ?? [])
        .filter((r) => {
          const s = displayStatuses[r.id]
          return s === "being_reviewed" || s === "partially_issued"
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [openRequests, displayStatuses]
  )

  const awaitingApproval = useMemo(
    () =>
      (openRequests ?? []).filter(
        (r) => displayStatuses[r.id] === "awaiting_approval" && r.created_by !== user?.id
      ),
    [openRequests, displayStatuses, user?.id]
  )

  const oldestDays = toIssue.length > 0 ? ageInDays(toIssue[0].created_at, today) : null
  const requestsLoaded = openRequests !== null

  const items: TodoItem[] = [
    {
      key: "issue",
      label: "Requests to issue",
      count: requestsLoaded ? toIssue.length : null,
      caption: oldestDays != null ? `Oldest waiting ${formatAgeDays(oldestDays)}` : undefined,
      href: "/requests",
    },
    {
      key: "approval",
      label: "00000 awaiting approval",
      count: requestsLoaded ? awaitingApproval.length : null,
      caption: "Not your own requests",
      href: "/requests",
    },
    {
      key: "inspections",
      label: "Inspections waiting",
      count: inspections,
      href: "/inventory/inspections",
    },
    {
      key: "overdue",
      label: "Overdue kits",
      count: alertsLoading ? null : (feed?.counts.overdue ?? 0),
      href: "/alerts",
    },
    {
      key: "problems",
      label: "Open problem reports",
      count: problems,
      href: "/problems?status=open",
    },
  ]

  return (
    <section aria-label="To do" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-foreground">To do</h2>
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-5">
        {items.map((item) => (
          <TodoCard key={item.key} item={item} />
        ))}
      </div>
    </section>
  )
}
