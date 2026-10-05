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

function formatZonedDate(instant, timeZone) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return ""
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

function createdOn(value, timeZone) {
  if (!value) return ""
  const instant = value instanceof Date ? value : new Date(value)
  return formatZonedDate(instant, timeZone)
}

function storedInvoice(value) {
  if (value == null) return "(none)"
  if (String(value).trim() === "") return "(blank)"
  return String(value)
}

function daysOverdue(due, today) {
  const start = Date.parse(`${String(due).slice(0, 10)}T00:00:00Z`)
  const end = Date.parse(`${today}T00:00:00Z`)
  return Math.round((end - start) / 86400000)
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
    txn.invoice_number,
    txn.serial_number,
    txn.item_name,
    txn.client AS stored_client,
    directory.name AS resolved_name,
    directory.company AS resolved_company,
    count(*) OVER (
      PARTITION BY coalesce(nullif(txn.batch_id, ''), txn.id)
    )::int AS batch_qty,
    coalesce(nullif(btrim(actor.display_name), ''), actor.email, '') AS recorded_by,
    txn.created_at
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
      storedInvoice(row.invoice_number),
      row.serial_number,
      row.item_name,
      row.resolved_name ? clientLabel(row.resolved_name, row.resolved_company) : "",
      row.stored_client ?? "",
      row.batch_qty,
      row.recorded_by,
      createdOn(row.created_at, timeZone),
      "",
      "",
    ]

    const todayLabel = ddmmyyyy(today)
    const createdToday = zero.rows.filter((row) => createdOn(row.created_at, timeZone) === todayLabel)
    const noInvoiceSplit = {}
    for (const row of blank.rows) {
      const label = storedInvoice(row.invoice_number)
      noInvoiceSplit[label] = (noInvoiceSplit[label] ?? 0) + 1
    }

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
      "Stored invoice",
      "Kit serial",
      "Product",
      "Client",
      "Stored client text",
      "Quantity in batch",
      "Recorded by",
      "Created",
      "Complimentary / Pending / Real invoice no.",
      "Reason or invoice no.",
    ]
    addTable(workbook, "Invoice 00000", invoiceHeaders, zero.rows.map(saleRow), 2)
    addTable(workbook, "No invoice", invoiceHeaders, blank.rows.map(saleRow), 2)
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
        "Sale lines that still count, whose invoice is exactly 00000. One row is one kit. Stored invoice shows the value on the sale. Created is the day the sale was recorded. In the yellow columns write Complimentary, Pending, or the real invoice number, and the reason or the invoice number.",
      ],
      [
        "No invoice",
        "Sale lines that still count whose invoice is null, blank, or N/A. Stored invoice shows (none) for null, (blank) for an empty value, or the exact text such as N/A. Fill the yellow columns the same way as Invoice 00000.",
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
      row.height = rowIndex === 1 ? 22 : 64
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
    const temporary = path.join(dir, `josh-review-${today}.writing.xlsx`)
    await workbook.xlsx.writeFile(temporary)
    fs.rmSync(file, { force: true })
    fs.renameSync(temporary, file)
    console.log(JSON.stringify({
      file,
      invoice00000: zero.rows.length,
      invoice00000CreatedToday: createdToday.map((row) => ({
        id: row.id,
        batch: row.batch_id,
        businessDate: ddmmyyyy(row.date),
        created: createdOn(row.created_at, timeZone),
        serial: row.serial_number,
        product: row.item_name,
        client: row.stored_client,
        recordedBy: row.recorded_by,
      })),
      noInvoice: blank.rows.length,
      noInvoiceSplit,
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
