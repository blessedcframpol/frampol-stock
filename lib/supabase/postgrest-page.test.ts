import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  POSTGREST_ROW_CAP,
  fetchAllPages,
  findUnpagedLargeTableReads,
} from "./postgrest-page"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("fetchAllPages", () => {
  it("does not stop when a response is exactly the cap", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const calls: Array<[number, number]> = []
    const rows = await fetchAllPages<number>(async (from, to) => {
      calls.push([from, to])
      if (from === 0) {
        return { data: Array.from({ length: POSTGREST_ROW_CAP }, (_, index) => index), error: null }
      }
      return { data: [POSTGREST_ROW_CAP], error: null }
    })
    expect(rows).toHaveLength(POSTGREST_ROW_CAP + 1)
    expect(rows[POSTGREST_ROW_CAP]).toBe(POSTGREST_ROW_CAP)
    expect(calls).toEqual([
      [0, POSTGREST_ROW_CAP - 1],
      [POSTGREST_ROW_CAP, POSTGREST_ROW_CAP * 2 - 1],
    ])
    expect(error).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalled()
    expect(String(debug.mock.calls[0]?.[0])).toContain(`exactly ${POSTGREST_ROW_CAP}`)
  })

  it("returns a short page without logging", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const rows = await fetchAllPages<number>(async () => ({ data: [1, 2], error: null }))
    expect(rows).toEqual([1, 2])
    expect(error).not.toHaveBeenCalled()
  })
})

describe("findUnpagedLargeTableReads", () => {
  it("flags a list read that is not paged", () => {
    const source = `const { data } = await supabase.from("transactions").select("*").order("date")`
    expect(findUnpagedLargeTableReads(source, "app/example.ts")).toEqual([
      "app/example.ts:1 reads transactions without fetchAllPages",
    ])
  })

  it("accepts fetchAllPages, single-row reads, and head counts", () => {
    const source = `
      const rows = await fetchAllPages((from, to) =>
        supabase.from("clients").select("*").order("id").range(from, to)
      )
      const one = await supabase.from("inventory_items").select("*").eq("id", id).maybeSingle()
      const { count } = await supabase.from("transactions").select("id", { count: "exact", head: true })
    `
    expect(findUnpagedLargeTableReads(source, "app/example.ts")).toEqual([])
  })

  it("fails if a table over 1,000 rows is read without the pager", () => {
    const roots = ["app", "components", "lib", "scripts"].map((dir) => path.join(process.cwd(), dir))
    const files: string[] = []
    const walk = (dir: string) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".next") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
        files.push(full)
      }
    }
    for (const root of roots) walk(root)
    const violations = files.flatMap((file) =>
      findUnpagedLargeTableReads(readFileSync(file, "utf8"), path.relative(process.cwd(), file))
    )
    expect(violations).toEqual([])
  })
})
