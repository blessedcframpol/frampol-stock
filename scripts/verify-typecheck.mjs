/**
 * TQ1 — run `npm run typecheck` (tsc --noEmit) so verify:all fails on type errors.
 */
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import { printVerifySummary } from "./verify-harness.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function runTypecheck() {
  return new Promise((resolve) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
    const child = spawn(npmCmd, ["run", "typecheck"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
    })
    let out = ""
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      out += text
      process.stdout.write(text)
    })
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      out += text
      process.stderr.write(text)
    })
    child.on("close", (code) => {
      resolve({ code: code ?? 1, out })
    })
  })
}

const { code } = await runTypecheck()
const ok = code === 0
if (!ok) {
  console.log("FAIL  typecheck — tsc --noEmit reported errors")
}
printVerifySummary(ok, ok ? 1 : 0, ok ? 0 : 1)
process.exitCode = ok ? 0 : 1
