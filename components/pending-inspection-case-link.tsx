"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { loadOpenCaseId } from "@/lib/kit-cases"

export function PendingInspectionCaseLink({ itemId }: { itemId: string }) {
  const [caseId, setCaseId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadOpenCaseId(itemId).then((id) => {
      if (!cancelled) setCaseId(id)
    })
    return () => {
      cancelled = true
    }
  }, [itemId])

  if (!caseId) return null
  return (
    <Link href={`/inventory/inspections/${caseId}`} className="text-sm font-medium text-info underline-offset-4 hover:underline">
      Open inspection case
    </Link>
  )
}
