/**
 * Read-only workbook for Josh. Writes exports/josh-review-<date>.xlsx.
 *
 * Usage: node scripts/export-josh-review.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { todayBusinessDate } from "../lib/business-date.mjs"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { Workbook } = require("exceljs")

const RENTAL_PRODUCT = "Starlink Standard Kit v4(Rental)"
const PLACEHOLDERS = new Set(["", "n/a", "na", "n.a", "n.a.", "none", "-", "null", "nil"])

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
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

function normText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function usable(value) {
  const text = normText(value)
  return PLACEHOLDERS.has(text) ? "" : text
}

function clientLabel(name, company) {
  const left = String(name ?? "").trim()
  const right = String(company ?? "").trim()
  if (!left) return right
  if (!right || right.toLowerCase() === left.toLowerCase()) return left
  return `${left} - ${right}`
}

function ddmmyyyy(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim())
  if (!match) return ""
  return `${match[3]}/${match[2]}/${match[1]}`
}

function createdFromId(id, timeZone) {
  const match = /^CLT-(\d{10,13})/.exec(String(id ?? ""))
  if (!match) return ""
  const raw = match[1]
  const ms = Number(raw.length >= 13 ? raw.slice(0, 13) : raw.padEnd(13, "0"))
  const instant = new Date(ms)
  if (Number.isNaN(instant.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(instant)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ""
  if (!get("year")) return ""
  return `${get("day")}/${get("month")}/${get("year")}`
}

function createdEpoch(id) {
  const match = /^CLT-(\d{10,13})/.exec(String(id ?? ""))
  if (!match) return Number.POSITIVE_INFINITY
  const raw = match[1]
  return Number(raw.length >= 13 ? raw.slice(0, 13) : raw.padEnd(13, "0"))
}

function emailsOf(value) {
  return String(value ?? "")
    .split(/[;]/)
    .map((part) => usable(part))
    .filter(Boolean)
}

function phoneKey(value) {
  const keys = []
  for (const part of String(value ?? "").split(/[;/]/)) {
    let digits = part.replace(/\s+/g, "")
    if (!digits) continue
    if (digits.startsWith("+263")) digits = digits.slice(4)
    digits = digits.replace(/^0+/, "")
    if (digits.length < 6) continue
    if (/^(\d)\1+$/.test(digits)) continue
    keys.push(digits)
  }
  return [...new Set(keys)]
}

function daysOverdue(due, today) {
  const start = Date.parse(`${String(due).slice(0, 10)}T00:00:00Z`)
  const end = Date.parse(`${today}T00:00:00Z`)
  return Math.round((end - start) / 86400000)
}

class UnionFind {
  constructor() {
    this.parent = new Map()
  }
  find(id) {
    if (!this.parent.has(id)) this.parent.set(id, id)
    let root = this.parent.get(id)
    if (root !== id) {
      root = this.find(root)
      this.parent.set(id, root)
    }
    return root
  }
  union(left, right) {
    const a = this.find(left)
    const b = this.find(right)
    if (a !== b) this.parent.set(a, b)
  }
}

function contactScore(client) {
  return [client.email, client.phone, client.company, client.address].filter((value) => usable(value)).length
}

function duplicateRows(clients, counts, timeZone) {
  const byId = new Map(clients.map((client) => [client.id, client]))
  const reasons = new Map(clients.map((client) => [client.id, new Set()]))
  const buckets = new Map()
  function add(key, id, reason) {
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ id, reason })
  }
  for (const client of clients) {
    const name = usable(client.name)
    if (name) add(`name:${name}`, client.id, "name")
    const company = usable(client.company)
    if (company) add(`company:${company}`, client.id, "company")
    const label = clientLabel(client.name, client.company)
    if (label.includes(" - ")) {
      const key = usable(label)
      if (key) add(`label:${key}`, client.id, "name - company")
    }
    for (const email of emailsOf(client.email)) add(`email:${email}`, client.id, "email")
    for (const phone of phoneKey(client.phone)) add(`phone:${phone}`, client.id, "phone")
  }
  const uf = new UnionFind()
  for (const members of buckets.values()) {
    const ids = [...new Set(members.map((member) => member.id))]
    if (ids.length < 2) continue
    const reason = members[0].reason
    for (const id of ids) {
      uf.union(ids[0], id)
      reasons.get(id).add(reason)
    }
  }
  const groups = new Map()
  for (const client of clients) {
    const root = uf.find(client.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(client.id)
  }
  const built = []
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    const members = ids.map((id) => byId.get(id))
    const reasonSet = new Set(members.flatMap((member) => [...reasons.get(member.id)]))
    const names = members.map((member) => usable(member.name))
    const sameName = names.every((name) => name && name === names[0])
    const identity = reasonSet.has("name") || reasonSet.has("company") || reasonSet.has("name - company")
    const low = !identity && !sameName
    const ranked = members
      .map((member) => ({
        member,
        orders: counts.get(member.id)?.orders ?? 0,
        units: counts.get(member.id)?.units ?? 0,
        score: contactScore(member),
        epoch: createdEpoch(member.id),
      }))
      .sort((a, b) => b.orders - a.orders || b.score - a.score || a.epoch - b.epoch || a.member.id.localeCompare(b.member.id))
    const keeper = ranked[0]
    const orderTies = ranked.filter((row) => row.orders === keeper.orders)
    const detailTies = orderTies.filter((row) => row.score === keeper.score)
    let why = `Most orders (${keeper.orders})`
    if (orderTies.length > 1 && detailTies.length === 1) {
      why = `Tied on ${keeper.orders} orders; more complete contact details`
    } else if (detailTies.length > 1) {
      why = `Tied on ${keeper.orders} orders and contact details; oldest record`
    }
    built.push({
      low,
      size: members.length,
      name: keeper.member.name || keeper.member.company || keeper.member.id,
      rows: ranked.map((row) => ({
        reasons: [...reasons.get(row.member.id)].sort().join(", "),
        name: row.member.name ?? "",
        company: row.member.company ?? "",
        id: row.member.id,
        email: row.member.email ?? "",
        phone: row.member.phone ?? "",
        orders: row.orders,
        units: row.units,
        created: createdFromId(row.member.id, timeZone),
        keeper: row.member.id === keeper.member.id ? "Y" : "N",
        why,
        low,
      })),
    })
  }
  built.sort((a, b) => Number(a.low) - Number(b.low) || b.size - a.size || a.name.localeCompare(b.name))
  const rows = []
  built.forEach((group, index) => {
    for (const row of group.rows) {
      rows.push([
        index + 1,
        row.low ? "Low" : "High",
        row.reasons,
        row.name,
        row.company,
        row.id,
        row.email,
        row.phone,
        row.orders,
        row.units,
        row.created,
        row.keeper,
        row.why,
        "",
        "",
      ])
    }
  })
  return {
    rows,
    groups: built.length,
    high: built.filter((group) => !group.low).length,
    low: built.filter((group) => group.low).length,
  }
}

function styleSheet(sheet, headers, decisionCount) {
  const decisionStart = headers.length - decisionCount + 1
  sheet.views = [{ state: "frozen", ySplit: 1 }]
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  }
  sheet.getRow(1).height = 22
  headers.forEach((header, index) => {
    const cell = sheet.getRow(1).getCell(index + 1)
    const decision = index + 1 >= decisionStart
    cell.value = header
    cell.font = { name: "Arial", size: 10, bold: true }
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: decision ? "FFFFE699" : "FFD9E2F3" },
    }
    cell.alignment = { vertical: "middle", wrapText: true }
    const width = Math.min(42, Math.max(14, header.length + 2))
    sheet.getColumn(index + 1).width = width
  })
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex)
    for (let column = 1; column <= headers.length; column += 1) {
      const cell = row.getCell(column)
      cell.font = { name: "Arial", size: 10, bold: column >= decisionStart ? cell.font?.bold : false }
      cell.alignment = { vertical: "middle", wrapText: true }
      if (column >= decisionStart) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }
      }
    }
  }
}

function addTable(workbook, name, headers, rows, decisionCount) {
  const sheet = workbook.addWorksheet(name)
  sheet.addRow(headers)
  for (const row of rows) sheet.addRow(row)
  styleSheet(sheet, headers, decisionCount)
  return sheet
}

const SALE_SQL = `
  SELECT
    txn.id,
    coalesce(txn.batch_id, '') AS batch_id,
    txn.date,
    txn.serial_number,
    txn.item_name,
    txn.client AS stored_client,
    directory.name AS resolved_name,
    directory.company AS resolved_company,
    count(*) OVER (
      PARTITION BY coalesce(nullif(txn.batch_id, ''), txn.id)
    )::int AS batch_qty,
    coalesce(nullif(btrim(actor.display_name), ''), actor.email, '') AS recorded_by
  FROM public.active_transactions AS txn
  JOIN public.client_transaction_resolution AS resolution
    ON resolution.transaction_id = txn.id
  LEFT JOIN public.clients AS directory ON directory.id = resolution.resolved_client_id
  LEFT JOIN public.profiles AS actor ON actor.id = txn.created_by
  WHERE txn.type = 'Sale'
`

async function main() {
  loadEnvLocal()
  const db = new Client({
    connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  try {
    const settings = await db.query(`SELECT timezone FROM public.app_settings LIMIT 1`)
    const timeZone = settings.rows[0]?.timezone || "Africa/Harare"
    const today = todayBusinessDate(timeZone)

    const zero = await db.query(`${SALE_SQL} AND txn.invoice_number = '00000' ORDER BY txn.date, txn.serial_number, txn.id`)
    const blank = await db.query(
      `${SALE_SQL}
       AND (
         txn.invoice_number IS NULL
         OR btrim(txn.invoice_number) = ''
         OR upper(btrim(txn.invoice_number)) = 'N/A'
       )
       ORDER BY txn.date, txn.serial_number, txn.id`
    )
    const saleRow = (row) => [
      row.id,
      row.batch_id,
      ddmmyyyy(row.date),
      row.serial_number,
      row.item_name,
      row.resolved_name ? clientLabel(row.resolved_name, row.resolved_company) : "",
      row.stored_client ?? "",
      row.batch_qty,
      row.recorded_by,
      "",
      "",
    ]

    const clients = await db.query(
      `SELECT id, name, company, email, phone, address FROM public.clients ORDER BY name, id`
    )
    const countRows = await db.query(
      `SELECT client_id, orders, units FROM public.client_sale_dispatch_counts()`
    )
    const counts = new Map(countRows.rows.map((row) => [row.client_id, { orders: row.orders, units: row.units }]))
    const duplicates = duplicateRows(clients.rows, counts, timeZone)

    const overdue = await db.query(
      `SELECT
         item.serial_number,
         product.product_name,
         item.status,
         coalesce(nullif(btrim(item.assigned_to), ''), nullif(btrim(item.client), ''), '') AS holder,
         coalesce(
           (
             SELECT max(left(txn.date, 10))
             FROM public.active_transactions AS txn
             WHERE txn.serial_number = item.serial_number
               AND txn.type = CASE WHEN item.status = 'POC' THEN 'POC Out' ELSE 'Rentals' END
           ),
           nullif(left(coalesce(item.poc_out_date, ''), 10), '')
         ) AS dispatched,
         left(item.return_date, 10) AS due
       FROM public.inventory_items AS item
       JOIN public.product_lines AS product ON product.id = item.product_id
       WHERE item.deleted_at IS NULL
         AND item.status IN ('POC', 'Rented')
         AND nullif(btrim(coalesce(item.return_date, '')), '') IS NOT NULL
         AND left(item.return_date, 10) < $1
       ORDER BY left(item.return_date, 10), item.serial_number`,
      [today]
    )

    const rental = await db.query(
      `WITH rental_hist AS (
         SELECT serial_number, count(*)::int AS rentals, max(left(date, 10)) AS last_rental
         FROM public.active_transactions
         WHERE type = 'Rentals'
         GROUP BY serial_number
       )
       SELECT
         item.serial_number,
         product.product_name,
         item.status,
         coalesce(nullif(btrim(item.assigned_to), ''), nullif(btrim(item.client), ''), '') AS holder,
         coalesce(hist.rentals, 0)::int AS rentals,
         hist.last_rental,
         product.product_name = $1 AS on_product,
         item.status = 'Rented' AS rented_now,
         item.status = 'In Stock' AND coalesce(hist.rentals, 0) > 0 AS stock_history
       FROM public.inventory_items AS item
       JOIN public.product_lines AS product ON product.id = item.product_id
       LEFT JOIN rental_hist AS hist ON hist.serial_number = item.serial_number
       WHERE item.deleted_at IS NULL
         AND (
           product.product_name = $1
           OR item.status = 'Rented'
           OR (item.status = 'In Stock' AND coalesce(hist.rentals, 0) > 0)
         )
       ORDER BY item.serial_number`,
      [RENTAL_PRODUCT]
    )

    const workbook = new Workbook()
    workbook.creator = "Fram-Stock"
    const invoiceHeaders = [
      "Transaction id",
      "Batch",
      "Business date",
      "Kit serial",
      "Product",
      "Client",
      "Stored client text",
      "Quantity in batch",
      "Recorded by",
      "Complimentary / Pending / Real invoice no.",
      "Reason or invoice no.",
    ]
    addTable(workbook, "Invoice 00000", invoiceHeaders, zero.rows.map(saleRow), 2)
    addTable(workbook, "No invoice", invoiceHeaders, blank.rows.map(saleRow), 2)
    addTable(
      workbook,
      "Duplicate clients",
      [
        "Group no.",
        "Confidence",
        "Match reason(s)",
        "Client name as stored",
        "Company as stored",
        "Record id",
        "Email",
        "Phone",
        "Orders",
        "Units",
        "Date created",
        "Suggested keeper",
        "Why",
        "Same client? Y/N",
        "Keep this record? Y/N",
      ],
      duplicates.rows,
      2
    )
    addTable(
      workbook,
      "Overdue",
      [
        "Kit serial",
        "Product",
        "Type",
        "Client",
        "Date dispatched",
        "Due-back date",
        "Days overdue",
        "Returned / Sold / Still out",
        "Date",
        "Invoice no. (if sold)",
      ],
      overdue.rows.map((row) => [
        row.serial_number,
        row.product_name,
        row.status === "POC" ? "POC" : "Rental",
        row.holder,
        ddmmyyyy(row.dispatched),
        ddmmyyyy(row.due),
        daysOverdue(row.due, today),
        "",
        "",
        "",
      ]),
      3
    )
    addTable(
      workbook,
      "Rental group (proposed)",
      [
        "Serial",
        "Product",
        "Status",
        "Current client",
        "Number of rentals",
        "Last rental date",
        "Why proposed",
        "Rental group? Y/N",
      ],
      rental.rows.map((row) => {
        const why = []
        if (row.on_product) why.push("On the rental product")
        if (row.rented_now) why.push("Currently rented")
        if (row.stock_history) why.push("In stock with rental history")
        return [
          row.serial_number,
          row.product_name,
          row.status,
          row.holder,
          row.rentals,
          ddmmyyyy(row.last_rental),
          why.join("; "),
          "",
        ]
      }),
      1
    )

    const readme = workbook.addWorksheet("Read me")
    const notes = [
      [
        "Invoice 00000",
        "Sale lines that still count, whose invoice is exactly 00000. One row is one kit. In the yellow columns write Complimentary, Pending, or the real invoice number, and the reason or the invoice number.",
      ],
      [
        "No invoice",
        "Sale lines that still count, with a null invoice, a blank invoice, or N/A. Fill the yellow columns the same way as Invoice 00000.",
      ],
      [
        "Duplicate clients",
        "Every client record that matches another on a normalised name, company, or name - company, or on the same email (each address separated by a semicolon), or the same phone after spaces, +263, and a leading 0 are removed. Low confidence means the group is linked only by phone or email and the names differ. Suggested keeper is Y on the record with the most orders, then the most complete contact details, then the oldest record. Write Y or N for whether they are the same client, and Y or N for whether to keep that record.",
      ],
      [
        "Overdue",
        `Kits still on POC or Rental whose due-back date is before ${ddmmyyyy(today)} (Africa/Harare), oldest first. Write Returned, Sold, or Still out. Add the date, and an invoice number when the kit was sold.`,
      ],
      [
        "Rental group (proposed)",
        `Kits on ${RENTAL_PRODUCT}, kits that are rented now, and in-stock kits with a rental still on the ledger. Write Y or N for whether the kit belongs in the Rental group.`,
      ],
    ]
    readme.addRow(["Sheet", "What it shows and how to fill it in"])
    for (const note of notes) readme.addRow(note)
    readme.views = [{ state: "frozen", ySplit: 1 }]
    readme.getColumn(1).width = 28
    readme.getColumn(2).width = 110
    readme.getRow(1).height = 22
    for (let rowIndex = 1; rowIndex <= readme.rowCount; rowIndex += 1) {
      const row = readme.getRow(rowIndex)
      row.height = rowIndex === 1 ? 22 : 48
      for (let column = 1; column <= 2; column += 1) {
        const cell = row.getCell(column)
        cell.font = { name: "Arial", size: 10, bold: rowIndex === 1 }
        cell.alignment = { vertical: "top", wrapText: true }
        if (rowIndex === 1) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } }
        }
      }
    }

    const dir = path.join(process.cwd(), "exports")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `josh-review-${today}.xlsx`)
    await workbook.xlsx.writeFile(file)
    console.log(JSON.stringify({
      file,
      invoice00000: zero.rows.length,
      noInvoice: blank.rows.length,
      duplicateRows: duplicates.rows.length,
      duplicateGroups: duplicates.groups,
      highConfidenceGroups: duplicates.high,
      lowConfidenceGroups: duplicates.low,
      overdue: overdue.rows.length,
      rentalGroup: rental.rows.length,
    }, null, 2))
  } finally {
    await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
