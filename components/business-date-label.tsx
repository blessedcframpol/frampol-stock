"use client"

import { formatBusinessDate, formatRecordedAt } from "@/lib/business-date.mjs"

export function BusinessDateLabel({
  date,
  createdAt,
  timeZone,
}: {
  date: string | null | undefined
  createdAt?: string | null
  timeZone: string
}) {
  const recorded = formatRecordedAt(createdAt, date, timeZone)
  return (
    <>
      {formatBusinessDate(date)}
      {recorded ? (
        <span className="text-muted-foreground text-xs ml-1 tabular-nums">{recorded}</span>
      ) : null}
    </>
  )
}
