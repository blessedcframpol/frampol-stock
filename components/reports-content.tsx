"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/page-nav"
import { useAuth } from "@/lib/auth-context"
import { canViewAuditLog } from "@/lib/permissions"

export function ReportsContent() {
  const { role } = useAuth()
  const showAudit = canViewAuditLog(role)

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Reports"
        description="Reporting is in development."
      />
      {showAudit ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Audit exceptions</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Weekly reversals, voids, role changes, direct SQL, and other exception categories.
            </p>
            <Link
              href="/reports/audit-exceptions"
              className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
            >
              Open audit exceptions
            </Link>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            Reports are being built from live stock data. Coming first: stock cover, POC pipeline, and overdue rentals.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
