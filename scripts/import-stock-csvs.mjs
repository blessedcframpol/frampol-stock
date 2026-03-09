#!/usr/bin/env node
/**
 * Reads all CSVs from "stock files/", assigns category (Starlink/Fortinet) and
 * product type from filename/header, outputs JSON for Supabase seed.
 *
 * Run: node scripts/import-stock-csvs.mjs
 * Output: data/stock-seed.json (and optionally data/stock-seed.sql)
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.join(__dirname, "..")
const STOCK_DIR = path.join(PROJECT_ROOT, "stock files")
const OUT_JSON = path.join(PROJECT_ROOT, "data", "stock-seed.json")
const OUT_SQL = path.join(PROJECT_ROOT, "data", "stock-seed.sql")

const LOCATION = "Warehouse A"
const DATE_ADDED = new Date().toISOString().slice(0, 10)
const DEFAULT_ITEM_TYPE = "Starlink Kit" // for seed; Fortinet items we'll use "Router" / "Switch" etc. broadly

function filenameToProductType(filename) {
  const base = path.basename(filename, ".csv")
  const normalized = base
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (normalized.toLowerCase().includes("fortigate")) return "FortiGate 50G"
  if (normalized.toLowerCase().includes("48 port") || base === "48_port_POE") return "48 port POE"
  return normalized
}

function getCategory(filename) {
  const lower = path.basename(filename).toLowerCase()
  if (lower.includes("forti") || lower.includes("48_port")) return "Fortinet"
  return "Starlink"
}

function looksLikeHeader(cell) {
  if (!cell || typeof cell !== "string") return false
  const t = cell.trim()
  if (!t) return true
  if (t.length > 40) return true
  if (/^[A-Za-z][A-Za-z\s\-]+$/.test(t) && !/^\d+$/.test(t) && t.includes(" ")) return true
  if (["Enterprise Kits", "Standard pipe adapter", "Standard Wall mount", "Standard mobility mount", "Starlink power", "FortiAP", "50G"].some((h) => t.includes(h))) return true
  return false
}

function isSerial(value) {
  if (!value || typeof value !== "string") return false
  const t = value.trim()
  if (!t) return false
  return t.length >= 4 && /[A-Za-z0-9]/.test(t)
}

function generateId() {
  return `INV-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function parseCsvFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8")
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return []

  const category = getCategory(filePath)
  const filename = path.basename(filePath)
  const firstLine = lines[0]
  const firstCells = firstLine.split(",").map((c) => c.trim())

  const isTwoColumn = filename.includes("108f") && firstCells.length >= 2 && firstCells.some((c) => looksLikeHeader(c))
  const productTypesFromHeader = isTwoColumn ? firstCells.map((c) => c.trim()).filter(Boolean) : null

  const rows = []
  const startIndex = productTypesFromHeader ? 1 : looksLikeHeader(firstCells[0]) ? 1 : 0

  for (let i = startIndex; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim())
    if (productTypesFromHeader && cells.length >= 2) {
      if (isSerial(cells[0])) rows.push({ serial: cells[0], productType: productTypesFromHeader[0] })
      if (isSerial(cells[1])) rows.push({ serial: cells[1], productType: productTypesFromHeader[1] })
    } else if (productTypesFromHeader && cells.length === 1 && isSerial(cells[0])) {
      rows.push({ serial: cells[0], productType: productTypesFromHeader[1] })
    } else {
      const productType = productTypesFromHeader ? productTypesFromHeader[0] : filenameToProductType(filename)
      const serial = cells[0] || cells.find(isSerial)
      if (serial && isSerial(serial)) rows.push({ serial, productType })
    }
  }

  return rows.map((r) => ({ ...r, category }))
}

function main() {
  if (!fs.existsSync(STOCK_DIR)) {
    console.error("Directory not found:", STOCK_DIR)
    process.exit(1)
  }

  const files = fs.readdirSync(STOCK_DIR).filter((f) => f.endsWith(".csv"))
  const allRows = []

  for (const file of files) {
    const filePath = path.join(STOCK_DIR, file)
    try {
      const rows = parseCsvFile(filePath)
      for (const row of rows) {
        allRows.push({
          id: generateId(),
          serial_number: row.serial,
          item_type: row.category === "Fortinet" ? "Router" : "Starlink Kit",
          name: row.productType,
          category: row.category,
          status: "In Stock",
          date_added: DATE_ADDED,
          location: LOCATION,
        })
      }
      console.log(file, "->", rows.length, "items")
    } catch (err) {
      console.error("Error reading", file, err.message)
    }
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, JSON.stringify(allRows, null, 2), "utf-8")
  console.log("\nWrote", allRows.length, "items to", OUT_JSON)

  const sqlLines = [
    "-- Seed from stock files. Run in Supabase SQL Editor or use app seed.",
    `-- Generated ${new Date().toISOString()}`,
    "",
  ]
  for (const row of allRows) {
    const cat = row.category ? `'${row.category.replace(/'/g, "''")}'` : "NULL"
    sqlLines.push(
      `INSERT INTO public.inventory_items (id, serial_number, item_type, name, category, status, date_added, location) VALUES ('${row.id}', '${row.serial_number.replace(/'/g, "''")}', '${row.item_type}', '${row.name.replace(/'/g, "''")}', ${cat}, 'In Stock', '${row.date_added}', '${row.location}') ON CONFLICT (id) DO NOTHING;`
    )
  }
  fs.writeFileSync(OUT_SQL, sqlLines.join("\n"), "utf-8")
  console.log("Wrote SQL to", OUT_SQL)
}

main()
