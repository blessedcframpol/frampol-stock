"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import {
  DIRECT_NO_REQUEST,
  requestHref,
  type BatchRequestContext,
} from "@/lib/batch-request-context"

/** Drawer facts for the request behind a movement batch. */
export function batchRequestDrawerFacts(ctx: BatchRequestContext | null | undefined): {
  request: ReactNode
  requestedBy: ReactNode
  atlasTask: ReactNode
} {
  if (!ctx) {
    return {
      request: DIRECT_NO_REQUEST,
      requestedBy: "—",
      atlasTask: "—",
    }
  }
  return {
    request: (
      <Link href={requestHref(ctx.requestId)} className="text-brand hover:underline">
        Request {ctx.requestNumber}
      </Link>
    ),
    requestedBy: ctx.requesterName,
    atlasTask: ctx.atlasTaskUrl ? (
      <a href={ctx.atlasTaskUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
        Atlas task
      </a>
    ) : (
      "—"
    ),
  }
}

/** Compact request number + requester for kit history / client sheets. */
export function BatchRequestSummary({ ctx }: { ctx: BatchRequestContext | null | undefined }) {
  if (!ctx) {
    return <span className="text-muted-foreground">{DIRECT_NO_REQUEST}</span>
  }
  return (
    <span className="text-foreground">
      <Link href={requestHref(ctx.requestId)} className="text-brand hover:underline">
        {ctx.requestNumber}
      </Link>
      {ctx.requesterName ? ` · ${ctx.requesterName}` : ""}
    </span>
  )
}
