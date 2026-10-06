#!/usr/bin/env node
/** Copy repo hooks into .git/hooks. Does not change git config. */
import fs from "fs"
import path from "path"

const root = process.cwd()
const srcDir = path.join(root, ".githooks")
const destDir = path.join(root, ".git", "hooks")
if (!fs.existsSync(path.join(root, ".git"))) {
  console.warn("install-git-hooks: no .git directory; skip")
  process.exit(0)
}
if (!fs.existsSync(srcDir)) {
  console.warn("install-git-hooks: .githooks missing; skip")
  process.exit(0)
}
fs.mkdirSync(destDir, { recursive: true })
for (const name of fs.readdirSync(srcDir)) {
  const src = path.join(srcDir, name)
  if (!fs.statSync(src).isFile()) continue
  const dest = path.join(destDir, name)
  fs.copyFileSync(src, dest)
  try {
    fs.chmodSync(dest, 0o755)
  } catch {
    // Windows may ignore chmod
  }
  console.log(`installed ${name} -> ${path.relative(root, dest)}`)
}
