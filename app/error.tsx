"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[app/error]", error)
  }, [error])

  return (
    <div className="min-h-svh flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-lg border-destructive/30">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>
            Copy the details below when reporting this during testing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="text-xs font-mono whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-3 text-foreground">
            {error.message || "Unknown error"}
          </pre>
          {error.digest ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Reference:</span> {error.digest}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button type="button" onClick={reset}>
            Try again
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
