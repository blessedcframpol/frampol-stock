#!/usr/bin/env node
/**
 * Blocks a commit/push when a tracked file is emptied or loses more than 80%
 * of its lines, or when an existing file under supabase/migrations is changed
 * or deleted. New migration files are allowed.
 *
 *   node scripts/check-truncation-and-migrations.mjs        # staged (pre-commit)
 *   node scripts/check-truncation-and-migrations.mjs --ci   # push/PR range
 */
import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ALLOWLIST_PATH = "scripts/truncation-allowlist.txt"
const MAX_LOSS = 0.8

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { encoding, maxBuffer: 20e6, stdio: ["ignore", "pipe", "pipe"] })
}

function gitOk(args, encoding = "utf8") {
  try {
    return git(args, encoding)
  } catch {
    return null
  }
}

function loadAllowlist() {
  const full = path.join(process.cwd(), ALLOWLIST_PATH)
  const map = new Map()
  if (!fs.existsSync(full)) return map
  for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const tab = trimmed.indexOf("\t")
    if (tab === -1) {
      map.set(trimmed.replaceAll("\\", "/"), "listed")
      continue
    }
    map.set(trimmed.slice(0, tab).replaceAll("\\", "/"), trimmed.slice(tab + 1).trim() || "listed")
  }
  return map
}

function lineCount(text) {
  if (text == null || text.length === 0) return 0
  return text.split(/\n/).length - (text.endsWith("\n") ? 1 : 0)
}

function blob(spec) {
  const out = gitOk(["show", spec], "buffer")
  if (out == null) return null
  return out
}

function isBinary(buf) {
  if (!buf || buf.length === 0) return false
  return buf.includes(0)
}

function textFrom(buf) {
  if (buf == null) return null
  if (isBinary(buf)) return null
  return buf.toString("utf8")
}

function parseNameStatus(rangeArgs) {
  const raw = git(["diff", ...rangeArgs, "--name-status", "-z"])
  const parts = raw.split("\0").filter(Boolean)
  const rows = []
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i]
    const code = status[0]
    if (code === "R" || code === "C") {
      const score = status.slice(1)
      const from = parts[i + 1]
      const to = parts[i + 2]
      i += 2
      rows.push({ status: code, score, from: from.replaceAll("\\", "/"), path: to.replaceAll("\\", "/") })
    } else {
      const file = parts[i + 1]
      i += 1
      rows.push({ status: code, path: file.replaceAll("\\", "/") })
    }
  }
  return rows
}

function checkDiff(label, rangeArgs, allow) {
  const problems = []
  const rows = parseNameStatus(rangeArgs)
  for (const row of rows) {
    const file = row.path
    const reason = allow.get(file)
    const migration =
      file.startsWith("supabase/migrations/") && !file.endsWith("/") && file !== "supabase/migrations/README.md"

    if (migration && (row.status === "M" || row.status === "D" || row.status === "R")) {
      if (reason) continue
      problems.push(
        `${label}: existing migration ${row.status === "D" ? "deleted" : row.status === "R" ? "renamed" : "modified"}: ${file}`,
      )
      continue
    }

    if (row.status === "D") {
      const beforeBuf = blob(`${rangeArgs[0] === "--cached" ? "HEAD" : rangeArgs[0]}:${file}`)
      // deletions of non-migrations are allowed; truncation rule is about remaining content
      continue
    }

    const baseRev = rangeArgs[0] === "--cached" ? "HEAD" : rangeArgs[0]
    const afterRev = rangeArgs[0] === "--cached" ? "" : rangeArgs[1]
    const beforeBuf = blob(`${baseRev}:${file}`)
    const afterBuf = rangeArgs[0] === "--cached" ? blob(`:${file}`) : blob(`${afterRev}:${file}`)
    if (beforeBuf == null) continue
    if (isBinary(beforeBuf) || (afterBuf && isBinary(afterBuf))) continue
    const beforeText = textFrom(beforeBuf) ?? ""
    const afterText = textFrom(afterBuf) ?? ""
    const before = lineCount(beforeText)
    const after = lineCount(afterText)
    const empty = after === 0 || (after <= 1 && afterText.trim() === "")
    const loss = before === 0 ? 0 : (before - after) / before
    if (empty || (before >= 5 && loss > MAX_LOSS)) {
      if (reason) continue
      const kind = empty ? "emptied" : `lost ${Math.round(loss * 100)}% of lines (${before} → ${after})`
      problems.push(`${label}: ${file} ${kind}`)
    }
  }
  return problems
}

function currentTreeEmpties(allow) {
  const problems = []
  const files = git(["ls-files", "-z"]).split("\0").filter(Boolean)
  for (const file of files) {
    const rel = file.replaceAll("\\", "/")
    if (allow.has(rel)) continue
    let stat
    try {
      stat = fs.statSync(rel)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > 2) continue
    const buf = fs.readFileSync(rel)
    if (isBinary(buf)) continue
    const text = buf.toString("utf8")
    if (stat.size === 0 || text.trim() === "") {
      problems.push(`working tree: ${rel} is empty`)
    }
  }
  return problems
}

function ciRanges() {
  const before = process.env.GITHUB_EVENT_BEFORE
  const sha = process.env.GITHUB_SHA
  if (before && sha && !/^0+$/.test(before)) {
    return [[before, sha]]
  }
  const parent = gitOk(["rev-parse", "HEAD^"])
  if (parent) return [[parent.trim(), "HEAD"]]
  return []
}

function main() {
  const allow = loadAllowlist()
  const ci = process.argv.includes("--ci")
  const problems = []

  if (ci) {
    const ranges = ciRanges()
    if (ranges.length === 0) {
      problems.push(...currentTreeEmpties(allow))
    } else {
      for (const [from, to] of ranges) {
        problems.push(...checkDiff(`${from.slice(0, 7)}..${to.slice(0, 7)}`, [from, to], allow))
      }
      problems.push(...currentTreeEmpties(allow))
    }
  } else {
    problems.push(...checkDiff("staged", ["--cached"], allow))
  }

  if (problems.length > 0) {
    console.error("Truncation / migration guard failed:\n")
    for (const line of problems) console.error(`  - ${line}`)
    console.error(`\nIf this is intentional, add the path to ${ALLOWLIST_PATH} with a reason.`)
    process.exit(1)
  }
}

main()
