/**
 * Start Next.js against the TEST project (.env.test), not .env.local / production.
 *
 *   npm run dev:test
 *
 * Loads .env.test with override, refuses the production ref, then runs the same
 * restore-dev-routes + next dev pipeline as `npm run dev`.
 *
 * Prefer port 3000 so probe-http's default VERIFY_APP_URL works:
 *   VERIFY_APP_URL=http://localhost:3000 npm run verify:all
 */
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const {
  loadVerifyEnv,
  resolveHarnessDbUrl,
  PRODUCTION_SUPABASE_REF,
  projectRefFromUrl,
} = require("./verify-env.cjs")

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

loadVerifyEnv({ production: false })
const { ref, production } = resolveHarnessDbUrl(false)
const apiRef = projectRefFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL || "")
if (production || ref === PRODUCTION_SUPABASE_REF || apiRef === PRODUCTION_SUPABASE_REF) {
  console.error("dev:test refuses production Supabase ref")
  process.exit(1)
}

console.log(`dev:test → API ${process.env.NEXT_PUBLIC_SUPABASE_URL} (ref=${apiRef || ref})`)
console.log("probe-http will use this app when VERIFY_APP_URL=http://127.0.0.1:3000")

const port = process.env.PORT || "3000"
const child = spawn(
  process.execPath,
  [
    "--require",
    "./scripts/dev/tls-classic.cjs",
    "scripts/restore-dev-routes.mjs",
  ],
  { cwd: root, stdio: "inherit", env: process.env, shell: false },
)

child.on("exit", (code) => {
  if (code !== 0 && code != null) process.exit(code)
  const next = spawn(
    process.execPath,
    [
      "--require",
      "./scripts/dev/tls-classic.cjs",
      "./node_modules/next/dist/bin/next",
      "dev",
      "-p",
      port,
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, PORT: port }, shell: false },
  )
  next.on("exit", (c) => process.exit(c ?? 0))
  const stop = () => {
    next.kill("SIGTERM")
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
})
