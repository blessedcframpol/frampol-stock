/**
 * Build Josh's fixture-review workbook from scripts/t3-fixture-sweep.json.
 * Read-only against the database. Usage: node scripts/export-t3-review.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const ExcelJS = require("exceljs")

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

function ymdToDmy(value) {
  if (!value) return ""
  const s = String(value).slice(0, 10)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return String(value)
  return `${m[3]}/${m[2]}/${m[1]}`
}

function todayYmdHarare() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Harare",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

function isOverdue(returnDate, today) {
  if (!returnDate) return false
  return returnDate.slice(0, 10) < today
}

const DECIDE_Y = "Test record — remove? Y/N"
const DECIDE_N = "Note"
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } }
const HEADER_FONT = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } }
const BODY_FONT = { name: "Arial", size: 10 }
const WRAP = { wrapText: true, vertical: "top" }

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = { vertical: "middle", wrapText: true }
  })
  row.height = 28
}

function addDecisionCols(headers) {
  return [...headers, DECIDE_Y, DECIDE_N]
}

function writeSheet(wb, name, headers, rows, { freeze = true, decisions = true } = {}) {
  const ws = wb.addWorksheet(name)
  const cols = decisions ? addDecisionCols(headers) : headers
  ws.addRow(cols)
  styleHeader(ws.getRow(1))
  if (freeze) ws.views = [{ state: "frozen", ySplit: 1 }]

  for (const row of rows) {
    const values = headers.map((h) => row[h] ?? "")
    if (decisions) values.push("", "")
    const excelRow = ws.addRow(values)
    excelRow.font = BODY_FONT
    excelRow.alignment = WRAP
  }

  cols.forEach((h, i) => {
    const width =
      h === DECIDE_N
        ? 36
        : h === DECIDE_Y
          ? 22
          : Math.min(40, Math.max(12, String(h).length + 4))
    ws.getColumn(i + 1).width = width
  })

  return { name, dataRows: rows.length }
}

loadEnvLocal()
const sweep = JSON.parse(fs.readFileSync("scripts/t3-fixture-sweep.json", "utf8"))
const items = sweep.tables.inventory_items.remove
const txns = sweep.tables.transactions.remove
const clients = sweep.tables.clients.remove
const invoices = sweep.tables.batch_invoices.remove
const extensions = sweep.tables.holding_extensions.remove
const users = sweep.tables["auth.users"].remove
const today = todayYmdHarare()

const db = new Client({
  connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const itemIds = items.map((i) => i.id)
const clientIds = clients.map((c) => c.id)
const serials = items.map((i) => i.serial)

const { rows: itemRows } = await db.query(
  `SELECT i.id, i.serial_number, i.status, i.location, i.date_added, i.client,
          i.return_date, i.poc_out_date, i.product_id, i.deleted_at,
          p.product_name, p.vendor,
          lsp.is_low
   FROM public.inventory_items i
   LEFT JOIN public.product_lines p ON p.id = i.product_id
   LEFT JOIN public.low_stock_products lsp ON lsp.product_id = i.product_id
   WHERE i.id = ANY($1::text[])`,
  [itemIds],
)
const itemById = new Map(itemRows.map((r) => [r.id, r]))

const { rows: clientRows } = await db.query(
  `SELECT c.id, c.name, c.company, c.email,
     (SELECT min(a.at) FROM public.audit_log a
      WHERE a.table_name = 'clients' AND a.row_id = c.id AND a.action = 'insert') AS created_at,
     (SELECT count(*)::int FROM public.transactions t
      WHERE t.client_id = c.id AND t.type = 'Sale'
        AND NOT public.batch_is_currently_reversed(t.batch_id)) AS sale_count
   FROM public.clients c
   WHERE c.id = ANY($1::text[])`,
  [clientIds],
)
const clientById = new Map(clientRows.map((r) => [r.id, r]))

const { rows: dispatchRows } = await db.query(
  `SELECT DISTINCT ON (serial_number)
     serial_number, date, type, client_id, client, invoice_number, id, batch_id
   FROM public.transactions
   WHERE serial_number = ANY($1::text[])
     AND type IN ('POC Out','Rentals','Sale')
   ORDER BY serial_number, date DESC, id DESC`,
  [serials],
)
const dispatchBySerial = new Map(dispatchRows.map((r) => [r.serial_number, r]))

const { rows: reignTxns } = await db.query(
  `SELECT id, serial_number, type, date, invoice_number, batch_id, client_id, client
   FROM public.transactions
   WHERE id = ANY($1::text[])
   ORDER BY date, id`,
  [
    txns
      .filter((t) => t.client_id === "CLT-1774007295290-1pl6z68" || /RS1074|1791295039222/.test(t.id))
      .map((t) => t.id),
  ],
)

const { rows: invDetail } = await db.query(
  `SELECT batch_id, status, invoice_number, entered_at, approved_at
   FROM public.batch_invoices WHERE batch_id = ANY($1::text[])`,
  [invoices.map((i) => i.id)],
)
const invById = new Map(invDetail.map((r) => [r.batch_id, r]))

const { rows: extDetail } = await db.query(
  `SELECT id, item_id, serial_number, holding_type, previous_date, new_date, reason, created_at
   FROM public.holding_extensions WHERE id = ANY($1::uuid[])`,
  [extensions.map((e) => e.id)],
)

const { rows: profileRows } = await db.query(
  `SELECT id::text AS id, email, role, active FROM public.profiles WHERE id = ANY($1::uuid[])`,
  [users.map((u) => u.id)],
)
const profileById = new Map(profileRows.map((r) => [r.id, r]))

const { rows: allTxnRows } = await db.query(
  `SELECT id, type, date, serial_number, client_id, client, batch_id, invoice_number
   FROM public.transactions WHERE id = ANY($1::text[])
   ORDER BY date, id`,
  [txns.map((t) => t.id)],
)

await db.end()

function seenWhere(item) {
  const bits = ["Inventory"]
  if (item.is_low) bits.push("low-stock count (Alerts)")
  return bits.join("; ")
}

function alertFlag(item) {
  if (item.status !== "POC" && item.status !== "Rented") return "No"
  if (!item.return_date) return "No (no return date)"
  if (isOverdue(item.return_date, today)) return "Yes — Overdue"
  return "Yes — Alerts (not overdue)"
}

const inStock = items
  .filter((i) => i.item_status === "In Stock" && !i.trashed)
  .map((i) => {
    const r = itemById.get(i.id) || {}
    return {
      Serial: r.serial_number || i.serial,
      Product: r.product_name || "",
      Vendor: r.vendor || "",
      Warehouse: r.location || "",
      "Date added": ymdToDmy(r.date_added),
      "Where Josh would see it": seenWhere(r),
      Script: i.script,
    }
  })
  .sort((a, b) => a.Serial.localeCompare(b.Serial))

const outWithClients = items
  .filter((i) => ["POC", "Rented", "Sold"].includes(i.item_status) && !i.trashed)
  .map((i) => {
    const r = itemById.get(i.id) || {}
    const d = dispatchBySerial.get(i.serial) || {}
    const clientName =
      r.client ||
      (d.client_id && clientById.get(d.client_id)?.name) ||
      d.client ||
      ""
    return {
      Status: i.item_status,
      Serial: r.serial_number || i.serial,
      Product: r.product_name || "",
      Client: clientName,
      "Dispatch date": ymdToDmy(d.date),
      "Return date": ymdToDmy(r.return_date),
      "Appeared in Alerts / Overdue": alertFlag(r),
      Script: i.script,
    }
  })
  .sort((a, b) => a.Status.localeCompare(b.Status) || a.Serial.localeCompare(b.Serial))

const waiting = items
  .filter((i) => ["Pending Inspection", "RMA Hold", "Disposed"].includes(i.item_status) && !i.trashed)
  .map((i) => {
    const r = itemById.get(i.id) || {}
    return {
      Status: i.item_status,
      Serial: r.serial_number || i.serial,
      Product: r.product_name || "",
      Vendor: r.vendor || "",
      Location: r.location || "",
      "Date added": ymdToDmy(r.date_added),
      Script: i.script,
    }
  })
  .sort((a, b) => a.Status.localeCompare(b.Status) || a.Serial.localeCompare(b.Serial))

const clientSheet = clients
  .map((c) => {
    const r = clientById.get(c.id) || {}
    return {
      Name: r.name || c.name || "",
      Company: r.company || "",
      Email: r.email || c.email || "",
      "Created date": ymdToDmy(r.created_at),
      "Sale count": r.sale_count ?? 0,
      "Client id": c.id,
      Script: c.script,
    }
  })
  .sort((a, b) => a.Name.localeCompare(b.Name))

const reignSheet = reignTxns.map((t) => ({
  "Transaction id": t.id,
  Type: t.type,
  Serial: t.serial_number,
  Date: ymdToDmy(t.date),
  Invoice: t.invoice_number || "",
  Batch: t.batch_id || "",
  "Client id": t.client_id || "",
  "Client name": t.client || "Reign Acre",
  "Client record kept?": "Yes — Reign Acre stays; only these test movements are removed",
}))

const invExtRows = [
  ...invoices.map((inv) => {
    const r = invById.get(inv.id) || {}
    return {
      Kind: "Invoice batch",
      Id: inv.id,
      "Invoice number": inv.invoice_number || r.invoice_number || "",
      Status: inv.invoice_status || r.status || "",
      Detail: "Test batch with invoice number 100",
      Date: ymdToDmy(r.entered_at || r.approved_at),
      Script: inv.script,
    }
  }),
  ...extDetail.map((e) => ({
    Kind: "Holding extension",
    Id: e.id,
    "Invoice number": "",
    Status: e.holding_type,
    Detail: `${e.serial_number}: ${e.previous_date || "—"} → ${e.new_date} (${e.reason || ""})`,
    Date: ymdToDmy(e.created_at),
    Script: "p33b",
  })),
]

const txnSheet = allTxnRows.map((t) => {
  const meta = txns.find((x) => x.id === t.id) || {}
  return {
    Id: t.id,
    Type: t.type,
    Date: ymdToDmy(t.date),
    Serial: t.serial_number || "",
    Client: t.client || t.client_id || "",
    Batch: t.batch_id || "",
    Invoice: t.invoice_number || "",
    Script: meta.script || "",
  }
})

const userSheet = users.map((u) => {
  const p = profileById.get(u.id) || {}
  return {
    Email: u.email || p.email || "",
    Role: p.role || "",
    Banned: "Yes",
    Active: p.active === false ? "No (inactive)" : String(p.active ?? ""),
    Script: u.script,
  }
})

const wb = new ExcelJS.Workbook()
wb.creator = "fram-stock T3r"
wb.created = new Date()

const readme = wb.addWorksheet("Read me")
readme.views = [{ state: "frozen", ySplit: 1 }]
readme.getColumn(1).width = 100
const readmeLines = [
  "Test records review — Frampol stock",
  "",
  "What these are",
  "These rows were created by automatic verification scripts while testing the system. They are not real stock, real clients, or real invoices Josh entered. They are leftover test fixtures that still sit in the live database.",
  "",
  "How to fill this in",
  `On every sheet except this one, use the two columns on the right:`,
  `  • "${DECIDE_Y}" — put Y to remove with the cleanup, or N to keep.`,
  `  • "${DECIDE_N}" — optional. Required if you mark N (why keep it / what to check).`,
  "",
  "What happens next",
  "Anything marked Y is queued for the fixture sweep (deletion on the record).",
  "Anything marked N is kept and investigated — it will not be deleted until you say so.",
  "The Reign Acre client company record itself is never deleted; only the one test sale (and related test movements) on that client are listed.",
  "The 37 test users are already banned and inactive; they are listed for completeness and will be deleted with the sweep after their rows are gone.",
  "",
  `Generated ${ymdToDmy(today)} from scripts/t3-fixture-sweep.json. Dates are DD/MM/YYYY.`,
  "Sheet names: Excel limits names to 31 characters and forbids /. The pending / RMA / disposed kits are on \"Pending, RMA, Disposed\".",
]
readmeLines.forEach((line, i) => {
  const row = readme.addRow([line])
  row.font = i === 0 ? { name: "Arial", size: 14, bold: true } : BODY_FONT
  row.alignment = WRAP
})
styleHeader(readme.getRow(1))
readme.getRow(1).getCell(1).value = "Read me"
readme.mergeCells(1, 1, 1, 1)

const counts = []
counts.push({ name: "Read me", dataRows: 0 })
counts.push(
  writeSheet(wb, "In stock (26)", [
    "Serial",
    "Product",
    "Vendor",
    "Warehouse",
    "Date added",
    "Where Josh would see it",
    "Script",
  ], inStock),
)
counts.push(
  writeSheet(
    wb,
    "Out with clients",
    [
      "Status",
      "Serial",
      "Product",
      "Client",
      "Dispatch date",
      "Return date",
      "Appeared in Alerts / Overdue",
      "Script",
    ],
    outWithClients,
  ),
)
counts.push(
  writeSheet(
    wb,
    "Pending, RMA, Disposed",
    ["Status", "Serial", "Product", "Vendor", "Location", "Date added", "Script"],
    waiting,
  ),
)
counts.push(
  writeSheet(wb, "Clients (8)", [
    "Name",
    "Company",
    "Email",
    "Created date",
    "Sale count",
    "Client id",
    "Script",
  ], clientSheet),
)
counts.push(
  writeSheet(
    wb,
    "Reign Acre",
    [
      "Transaction id",
      "Type",
      "Serial",
      "Date",
      "Invoice",
      "Batch",
      "Client id",
      "Client name",
      "Client record kept?",
    ],
    reignSheet,
  ),
)
counts.push(
  writeSheet(
    wb,
    "Invoices and extension",
    ["Kind", "Id", "Invoice number", "Status", "Detail", "Date", "Script"],
    invExtRows,
  ),
)
counts.push(
  writeSheet(
    wb,
    "Transactions (200)",
    ["Id", "Type", "Date", "Serial", "Client", "Batch", "Invoice", "Script"],
    txnSheet,
  ),
)
counts.push(
  writeSheet(wb, "Test users (37)", ["Email", "Role", "Banned", "Active", "Script"], userSheet),
)

const outDir = path.join(process.cwd(), "exports")
fs.mkdirSync(outDir, { recursive: true })
const outName = `test-records-review-${today}.xlsx`
const outPath = path.join(outDir, outName)
await wb.xlsx.writeFile(outPath)

console.log(
  JSON.stringify(
    {
      path: outPath,
      sheets: counts.map((c) => ({
        sheet: c.name,
        data_rows: c.dataRows,
        note:
          c.name === "In stock (26)"
            ? `expected 26 live In Stock (trash excluded); actual ${inStock.length}`
            : c.name === "Out with clients"
              ? `POC/Rented/Sold actual ${outWithClients.length} (12+7+12=${12 + 7 + 12})`
              : c.name.startsWith("Waiting")
                ? `PI/RMA/Disposed actual ${waiting.length} (8+5+3=${8 + 5 + 3})`
                : undefined,
      })),
      inStock: inStock.length,
      outWithClients: outWithClients.length,
      waiting: waiting.length,
      clients: clientSheet.length,
      reign: reignSheet.length,
      invExt: invExtRows.length,
      txns: txnSheet.length,
      users: userSheet.length,
    },
    null,
    2,
  ),
)
