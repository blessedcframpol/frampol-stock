/** PostgREST's default max rows in one response. A result of this length is not proof the table ended. */
export const POSTGREST_ROW_CAP = 1000

const MAX_ROWS = POSTGREST_ROW_CAP * 500

export class PostgrestCapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PostgrestCapError"
  }
}

type PageResponse<T> = {
  data: T[] | null
  error: { message: string } | null
}

/**
 * Reads every row by asking for the next range until a page comes back short of the cap.
 * A page that is exactly the cap is expected mid-pagination and is never treated as the end of the table.
 * Callers must order by a unique column so a tie on a page boundary cannot skip or repeat a row.
 */
export async function fetchAllPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<PageResponse<T>>
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += POSTGREST_ROW_CAP) {
    const to = from + POSTGREST_ROW_CAP - 1
    const { data, error } = await loadPage(from, to)
    if (error) throw new PostgrestCapError(error.message)
    const page = data ?? []
    if (page.length > POSTGREST_ROW_CAP) {
      const message = `PostgREST returned ${page.length} rows, above the ${POSTGREST_ROW_CAP} cap.`
      console.error(message)
      throw new PostgrestCapError(message)
    }
    rows.push(...page)
    if (page.length < POSTGREST_ROW_CAP) return rows
    const message = `PostgREST returned exactly ${POSTGREST_ROW_CAP} rows at offset ${from}. Fetching the next page so this read is not truncated.`
    console.debug(message)
    if (rows.length >= MAX_ROWS) {
      throw new PostgrestCapError(
        `Stopped after ${rows.length} rows because every page was still exactly ${POSTGREST_ROW_CAP}.`
      )
    }
  }
}

const LARGE_TABLES = ["transactions", "clients", "inventory_items"] as const

/**
 * A list read of a table that can exceed the cap must sit in the same statement as fetchAllPages.
 * Single-row reads and head-only counts are not list reads.
 */
export function findUnpagedLargeTableReads(source: string, filePath: string): string[] {
  const violations: string[] = []
  const re = /\.from\(\s*["'](transactions|clients|inventory_items)["']\s*\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) {
    const start = match.index
    const line = source.slice(0, start).split("\n").length
    const statement = (source.slice(start, start + 700).split(";")[0] ?? "")
    const selectAt = statement.search(/\.select\(/)
    const writeAt = statement.search(/\.(update|insert|delete)\(/)
    if (selectAt === -1) continue
    if (writeAt !== -1 && writeAt < selectAt) continue
    if (/\.(maybeSingle|single)\(/.test(statement)) continue
    if (/\bhead\s*:\s*true\b/.test(statement)) continue
    const before = source.slice(Math.max(0, start - 400), start)
    const marker = before.lastIndexOf("fetchAllPages")
    if (marker >= 0 && !before.slice(marker).includes(";")) continue
    const table = match[1]
    if (!table || !LARGE_TABLES.includes(table as (typeof LARGE_TABLES)[number])) continue
    violations.push(`${filePath}:${line} reads ${table} without fetchAllPages`)
  }
  return violations
}
