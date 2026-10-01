/** Visual classes for the existing table primitives. Not a second table engine. */

export const tableContainerClass =
  "relative w-full min-w-0 max-w-full overflow-x-auto rounded-2xl bg-card"

export const tableClass = "w-full caption-bottom text-sm"

export const tableHeaderClass =
  "sticky top-0 z-10 border-b border-border/40 bg-card [&_tr]:border-b-0"

export const tableBodyClass = "[&_tr:last-child]:border-0"

export const tableFooterClass =
  "border-t border-border/40 bg-card font-medium [&>tr]:last:border-b-0"

export const tableRowClass =
  "h-11 border-b border-border/40 transition-colors hover:bg-accent/50 data-[state=selected]:bg-accent"

export const tableHeadClass =
  "h-11 px-4 text-left align-middle text-[11px] font-medium uppercase tracking-wide whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]"

export const tableCellClass =
  "h-11 px-4 py-0 align-middle whitespace-nowrap first:pl-5 last:pr-5 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]"

export const tableCaptionClass = "mt-4 px-4 text-sm text-muted-foreground"

/** Right-aligned figures. Apply on count, money, and quantity cells. */
export const tableNumericClass = "text-right tabular-nums"
