"use client"

import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/page-nav"

export function ReportsContent() {
  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Reports"
        description="Reporting is in development."
      />
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
