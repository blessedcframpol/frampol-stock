/**
 * Production build with app/dev stripped, absence check, then restore.
 */
import { spawnSync } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const node = process.execPath

function run(rel, args = []) {
  const result = spawnSync(node, [path.join(root, rel), ...args], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  })
  return result.status ?? 1
}

const strip = run("scripts/strip-dev-routes.mjs")
if (strip !== 0) process.exit(strip)

const build = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "build"],
  { cwd: root, stdio: "inherit", env: process.env, shell: process.platform === "win32" }
)
const buildCode = build.status ?? 1

let checkCode = 0
if (buildCode === 0) {
  checkCode = run("scripts/check-dev-routes-absent.mjs")
}

const restore = run("scripts/restore-dev-routes.mjs")
process.exit(buildCode !== 0 ? buildCode : checkCode !== 0 ? checkCode : restore)
