"use client"

import { useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { StatusPill } from "@/components/fs/status-pill"

/** Serial search appears once a batch is long enough that scanning the list is slower than filtering. */
const SERIAL_SEARCH_MIN = 10

export type BatchDrawerLine = {
  serialNumber: string
  client?: string
  invoiceNumber?: string
  date?: string
  recordedAt?: string
  status?: string
  assignedTo?: string
}

export type BatchDrawerFact = {
  label: string
  value: React.ReactNode
  span?: 1 | 2
}

export type BatchDrawerDetail = {
  movement?: React.ReactNode
  client?: React.ReactNode
  date?: React.ReactNode
  invoice?: React.ReactNode
  deliveryNote?: React.ReactNode
  recordedBy?: React.ReactNode
  extra?: BatchDrawerFact[]
}

async function copySerials(serials: string[], toastLabel: string) {
  const text = serials.join("\n")
  if (!text.trim()) {
    toast.error("Nothing to copy")
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.success(toastLabel)
  } catch {
    toast.error("Could not copy — check browser permissions for clipboard")
  }
}

function Fact({ label, children, span = 1 }: { label: string; children: React.ReactNode; span?: 1 | 2 }) {
  return (
    <div className={span === 2 ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children ?? "—"}</dd>
    </div>
  )
}

export function BatchLinesDrawer({
  open,
  onOpenChange,
  title,
  description,
  detail,
  notice,
  lines,
  showInvoice = false,
  dimmed = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  detail?: BatchDrawerDetail
  notice?: React.ReactNode
  lines: BatchDrawerLine[]
  showInvoice?: boolean
  dimmed?: boolean
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [search, setSearch] = useState("")
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSearch("")
  }

  const showSearch = lines.length > SERIAL_SEARCH_MIN
  const filtered = useMemo(() => {
    const query = showSearch ? search.trim().toLowerCase() : ""
    if (!query) return lines
    return lines.filter((line) => line.serialNumber.toLowerCase().includes(query))
  }, [lines, search, showSearch])

  const serials = filtered.map((line) => line.serialNumber)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full max-w-none gap-0 overflow-hidden p-0 sm:max-w-none md:w-[480px] md:max-w-[480px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          headingRef.current?.focus()
        }}
      >
        <div className="shrink-0">
          <SheetHeader className="pr-10">
            <SheetTitle ref={headingRef} tabIndex={-1} className="outline-none">
              {title}
            </SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </SheetHeader>
          {detail ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 pb-4">
              <Fact label="Movement">{detail.movement || "—"}</Fact>
              <Fact label="Client">{detail.client || "—"}</Fact>
              <Fact label="Date">{detail.date || "—"}</Fact>
              {showInvoice ? (
                <Fact label="Invoice">
                  <span className="font-mono">{detail.invoice || "—"}</span>
                </Fact>
              ) : null}
              <Fact label="Delivery note">{detail.deliveryNote || "—"}</Fact>
              <Fact label="Recorded by">{detail.recordedBy || "—"}</Fact>
              {detail.extra?.map((fact) => (
                <Fact key={fact.label} label={fact.label} span={fact.span}>
                  {fact.value}
                </Fact>
              ))}
            </dl>
          ) : null}
          {notice}
          <div className="flex items-center gap-2 border-t border-border px-4 py-2">
            {showSearch ? (
              <Input
                aria-label="Search serial numbers"
                placeholder="Search serial numbers..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-8 min-w-0 flex-1"
              />
            ) : (
              <span className="sr-only">Serial numbers</span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-8 shrink-0"
              onClick={() =>
                void copySerials(
                  serials,
                  search.trim() && showSearch
                    ? `Copied ${serials.length} serial number${serials.length === 1 ? "" : "s"} (filtered)`
                    : `Copied ${serials.length} serial number${serials.length === 1 ? "" : "s"}`,
                )
              }
            >
              <Copy className="mr-1.5 size-3.5" />
              {search.trim() && showSearch ? `Copy filtered (${serials.length})` : `Copy all (${serials.length})`}
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {showSearch && search.trim() ? "No serial numbers match your search." : "No items."}
            </p>
          ) : (
            <ul>
              {filtered.map((line, index) => (
                <li
                  key={`${line.serialNumber}-${index}`}
                  className={`group flex h-8 items-center gap-2 rounded px-2 hover:bg-muted/50 ${dimmed ? "text-muted-foreground" : ""}`}
                >
                  <Link
                    href={`/inventory?serial=${encodeURIComponent(line.serialNumber)}`}
                    title={line.serialNumber}
                    className={`min-w-0 flex-1 truncate font-mono text-sm text-brand hover:underline ${dimmed ? "line-through" : ""}`}
                  >
                    {line.serialNumber}
                  </Link>
                  {line.status ? (
                    <>
                      <span className="text-muted-foreground" aria-hidden>
                        ·
                      </span>
                      <StatusPill value={line.status} className="shrink-0 px-1.5 py-0 text-xs" />
                    </>
                  ) : null}
                  {line.assignedTo ? (
                    <>
                      <span className="text-muted-foreground" aria-hidden>
                        ·
                      </span>
                      <span className="max-w-[40%] truncate text-xs text-muted-foreground">{line.assignedTo}</span>
                    </>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    title="Copy serial"
                    onClick={() => void copySerials([line.serialNumber], "Copied serial")}
                  >
                    <Copy className="size-3.5" />
                    <span className="sr-only">Copy serial</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {showSearch && search.trim() ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Showing {filtered.length} of {lines.length}
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
