/**
 * Move app/dev aside before production builds so those routes are never compiled.
 * Paired with restore-dev-routes.mjs (postbuild / after failed build).
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = path.join(root, "app", "dev")
const stash = path.join(root, ".dev-routes-stash")

if (!fs.existsSync(src)) {
  console.log("strip-dev-routes: app/dev already absent")
  process.exit(0)
}
if (fs.existsSync(stash)) fs.rmSync(stash, { recursive: true, force: true })
try {
  fs.renameSync(src, stash)
} catch {
  // Windows may lock the folder while next dev is running — copy then remove.
  fs.cpSync(src, stash, { recursive: true })
  fs.rmSync(src, { recursive: true, force: true })
}
console.log("strip-dev-routes: moved app/dev → .dev-routes-stash")
