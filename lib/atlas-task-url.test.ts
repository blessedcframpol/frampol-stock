import { describe, expect, it } from "vitest"
import {
  ATLAS_TASK_LINK_HINT,
  atlasTaskUrlProblem,
  parseAtlasTaskUrl,
} from "@/lib/atlas-task-url"

const PROJECT = "0b9f4c1e-3c52-4e0a-9d0a-1f4c2b7a8e11"
const TASK = "9a7d2f10-55aa-4b13-8c77-2e6f0d1c3b22"

/** Real Atlas shapes Jaime and others paste. */
const SHAPES = {
  projectsWithPort: `https://ai.frampolafrica.com:10801/projects/${PROJECT}?task=${TASK}`,
  myTasks: `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`,
  myTasksExtraParams: `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}&board=1`,
  taskFirst: `https://ai.frampolafrica.com:10801/my-tasks?task=${TASK}&view=all`,
  trailingSlash: `https://ai.frampolafrica.com:10801/projects/${PROJECT}/?task=${TASK}`,
  noPort: `https://ai.frampolafrica.com/my-tasks?view=all&task=${TASK}`,
  http: `http://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`,
  whitespace: `  https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}  `,
} as const

describe("parseAtlasTaskUrl / atlasTaskUrlProblem (HF1)", () => {
  it("accepts every real Atlas shape", () => {
    for (const [name, link] of Object.entries(SHAPES)) {
      const parsed = parseAtlasTaskUrl(link)
      expect(parsed, name).not.toBeNull()
      expect(parsed!.taskId).toBe(TASK)
      expect(atlasTaskUrlProblem(link)).toBeNull()
    }
  })

  it("stores the trimmed paste, not a rewritten canonical URL", () => {
    const raw = SHAPES.myTasksExtraParams
    expect(parseAtlasTaskUrl(`  ${raw}  `)?.url).toBe(raw)
  })

  it("requires a value with a clear message", () => {
    expect(atlasTaskUrlProblem("")).toBe("Atlas task link is required")
    expect(atlasTaskUrlProblem("   ")).toBe("Atlas task link is required")
  })

  it("rejects wrong host, wrong port, missing/invalid task — never a raw regex dump", () => {
    const bad = [
      "https://example.com/projects/x?task=" + TASK,
      `https://ai.frampolafrica.com:9999/my-tasks?task=${TASK}`,
      `https://ai.frampolafrica.com:10801/my-tasks?view=all`,
      `https://ai.frampolafrica.com:10801/my-tasks?task=not-a-uuid`,
      "not a url",
    ]
    for (const link of bad) {
      expect(parseAtlasTaskUrl(link)).toBeNull()
      expect(atlasTaskUrlProblem(link)).toBe(ATLAS_TASK_LINK_HINT)
    }
  })
})

/**
 * Snapshot of what the *previous* whole-string regex rejected (reproduction).
 * Kept so HF1's root cause stays documented in CI.
 */
describe("HF1 reproduction — old whole-string regex failures", () => {
  const OLD =
    /^https:\/\/ai\.frampolafrica\.com:10801\/projects\/[0-9a-f-]{36}\?task=[0-9a-f-]{36}$/

  function oldAccepts(raw: string): boolean {
    return OLD.test(raw.trim())
  }

  it("reports which real shapes the old validator rejected and why", () => {
    const report: { shape: string; oldOk: boolean; why: string }[] = [
      {
        shape: "projects/<id>?task=<uuid>",
        oldOk: oldAccepts(SHAPES.projectsWithPort),
        why: "canonical — only shape the old regex allowed",
      },
      {
        shape: "my-tasks?view=all&task=<uuid>",
        oldOk: oldAccepts(SHAPES.myTasks),
        why: "path is /my-tasks, not /projects/<uuid>; also has view=",
      },
      {
        shape: "extra query params",
        oldOk: oldAccepts(SHAPES.myTasksExtraParams),
        why: "anything after task=uuid fails $ end anchor",
      },
      {
        shape: "params in a different order",
        oldOk: oldAccepts(SHAPES.taskFirst),
        why: "regex required ?task= immediately after /projects/<id>",
      },
      {
        shape: "trailing slash on projects path",
        oldOk: oldAccepts(SHAPES.trailingSlash),
        why: "extra / before ? is not in the regex",
      },
      {
        shape: "no port",
        oldOk: oldAccepts(SHAPES.noPort),
        why: "regex required :10801",
      },
      {
        shape: "http",
        oldOk: oldAccepts(SHAPES.http),
        why: "regex required https",
      },
      {
        shape: "surrounding whitespace on canonical projects URL",
        oldOk: oldAccepts(`  ${SHAPES.projectsWithPort}  `),
        why: "trim made the canonical projects shape pass even under the old regex",
      },
      {
        shape: "surrounding whitespace on my-tasks URL",
        oldOk: oldAccepts(SHAPES.whitespace),
        why: "trim cannot fix path/query — still fails the old regex",
      },
    ]

    const failed = report.filter((r) => !r.oldOk)
    // Document in the assertion message for `npm test` output.
    expect(
      failed.map((r) => `${r.shape}: ${r.why}`).join("\n"),
      "old regex should reject most real Atlas shapes"
    ).toContain("my-tasks")

    expect(report.find((r) => r.shape.startsWith("projects"))!.oldOk).toBe(true)
    expect(
      report.find((r) => r.shape.includes("whitespace on canonical"))!.oldOk
    ).toBe(true)
    for (const row of failed) {
      expect(row.oldOk, `${row.shape} — ${row.why}`).toBe(false)
    }
  })
})
