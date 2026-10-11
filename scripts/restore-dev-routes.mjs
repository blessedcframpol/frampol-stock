/**
 * Restore app/dev after a production build (or when strip was used).
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = path.join(root, "app", "dev")
const stash = path.join(root, ".dev-routes-stash")

if (!fs.existsSync(stash)) {
  console.log("restore-dev-routes: nothing to restore")
  process.exit(0)
}
if (fs.existsSync(src)) fs.rmSync(src, { recursive: true, force: true })
fs.renameSync(stash, src)
console.log("restore-dev-routes: restored app/dev")
