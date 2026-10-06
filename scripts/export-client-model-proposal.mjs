/**
 * Read-only proposal for the client / contact model. Writes
 * exports/client-model-proposal-<date>.xlsx. Does not change the database.
 *
 * Usage: node scripts/export-client-model-proposal.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { todayBusinessDate } from "../lib/business-date.mjs"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { Workbook } = require("exceljs")

const EXPECTED_RECORDS = 1853

/** Kind markers. Legal forms and organisation words, plus close variants. */
const MARKER_TOKENS = [
  "pvt",
  "pty",
  "ltd",
  "limited",
  "private",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "plc",
  "llc",
  "llp",
  "gmbh",
  "investments",
  "investment",
  "trading",
  "holdings",
  "holding",
  "enterprises",
  "enterprise",
  "group",
  "solutions",
  "solution",
  "services",
  "service",
  "systems",
  "system",
  "school",
  "college",
  "trust",
  "church",
  "farm",
  "farms",
  "bank",
  "company",
  "centre",
  "center",
  "association",
  "union",
  "unions",
  "embassy",
  "lodge",
  "safaris",
  "safari",
  "ministry",
  "ministries",
  "university",
  "hospital",
  "council",
  "society",
  "foundation",
  "cooperative",
  "partners",
  "partnership",
  "authority",
  "institute",
  "academy",
  "hotel",
  "hotels",
  "organisation",
  "organization",
]

const COMMON_LEGAL = [
  ["private", "limited"],
  ["limited"],
  ["ltd"],
  ["pvt"],
  ["p", "l"],
]

const UNUSUAL_LEGAL = [
  ["incorporated"],
  ["corporation"],
  ["corp"],
  ["pty"],
  ["plc"],
  ["llc"],
  ["llp"],
  ["inc"],
  ["gmbh"],
]

const CURRENCY_TOKENS = new Set(["zwg", "usd", "zwd"])

const GENERIC_TOKENS = new Set([
  "and",
  "the",
  "of",
  "for",
  "zimbabwe",
  "harare",
  "pvt",
  "ltd",
  "limited",
  "company",
  "services",
  "service",
  "group",
  "investments",
  "investment",
  "trading",
  "private",
  "enterprise",
  "enterprises",
  "holdings",
  "holding",
])

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.za",
  "yahoo.co.zw",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "outlook.co.za",
  "outlook.co.zw",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.co.za",
  "live.com",
  "live.co.uk",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "fastmail.com",
  "tutanota.com",
  "tutamail.com",
])

const PUBLIC_EMAIL_LABELS = new Set([
  "gmail",
  "googlemail",
  "yahoo",
  "ymail",
  "rocketmail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "icloud",
  "aol",
  "protonmail",
  "gmx",
  "zoho",
  "yandex",
  "fastmail",
])

const BUSINESS_LOOK = new Set([
  "hardware",
  "paints",
  "logistics",
  "mining",
  "motors",
  "properties",
  "property",
  "computers",
  "technologies",
  "technology",
  "irrigation",
  "beverages",
  "security",
  "engineering",
  "construction",
  "travel",
  "tours",
  "tour",
  "shop",
  "stores",
  "store",
  "supermarket",
  "pharmacy",
  "electrical",
  "plastics",
  "printing",
  "media",
  "consulting",
  "foods",
  "brands",
  "telecom",
  "telecommunications",
  "networks",
  "network",
  "digital",
  "software",
  "agriculture",
  "agro",
  "bitumen",
  "concrete",
  "quarry",
  "minerals",
  "mineral",
  "farmers",
  "petroleum",
  "energy",
  "insurance",
  "tobacco",
  "steel",
  "cement",
  "textiles",
  "clothing",
  "timber",
  "poultry",
  "dairy",
  "bakery",
  "asphalt",
  "chemicals",
  "chemical",
  "tech",
  "medical",
  "laboratories",
  "laboratory",
  "labs",
  "distributors",
  "distributor",
  "homes",
  "diesel",
  "marketing",
  "accountants",
  "lawyers",
  "products",
  "electronics",
  "supplies",
  "communications",
  "comms",
  "sports",
  "village",
  "chicks",
  "club",
  "gas",
  "gear",
])

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

function tokensOf(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function stripTrailingPhrase(tokens, phrases) {
  const removed = []
  let current = tokens.slice()
  let guard = 0
  while (current.length > 0 && guard < 8) {
    guard += 1
    const phrase = phrases.find(
      (candidate) =>
        candidate.length <= current.length &&
        candidate.every((token, index) => current[current.length - candidate.length + index] === token)
    )
    if (!phrase) break
    removed.push(phrase.join(" "))
    current = current.slice(0, current.length - phrase.length)
  }
  return { tokens: current, removed }
}

function stripTrailingCurrency(tokens) {
  const removed = []
  let current = tokens.slice()
  while (current.length > 1 && CURRENCY_TOKENS.has(current[current.length - 1])) {
    removed.push(current[current.length - 1])
    current = current.slice(0, -1)
  }
  return { tokens: current, removed }
}

function analyseName(value) {
  const rawTokens = tokensOf(value)
  const currency = stripTrailingCurrency(rawTokens)
  const common = stripTrailingPhrase(currency.tokens, COMMON_LEGAL)
  const unusual = stripTrailingPhrase(common.tokens, UNUSUAL_LEGAL)
  const strict = common.tokens.join(" ")
  return {
    key: unusual.tokens.join(" "),
    strictKey: strict,
    currency: currency.removed.length > 0,
    unusual: unusual.removed.length > 0,
    unusualSuffixes: unusual.removed,
    original: String(value ?? "").trim(),
  }
}

function hasMarker(value) {
  const raw = String(value ?? "")
  if (/\bp\s*\/\s*l\b/i.test(raw) || /\bt\s*\/\s*a\b/i.test(raw) || /\btrading\s+as\b/i.test(raw)) {
    return true
  }
  const tokens = new Set(tokensOf(raw))
  return MARKER_TOKENS.some((token) => tokens.has(token))
}

function isNaValue(value) {
  const key = tokensOf(value).join(" ")
  return key === "n a" || key === "na" || key === ""
}

function isJunkName(value) {
  const raw = String(value ?? "").trim()
  if (!raw || isNaValue(raw)) return true
  const tokens = tokensOf(raw)
  if (tokens.length === 0) return true
  const digits = (raw.match(/\d/g) ?? []).length
  if (digits >= 3) return true
  if (tokens.every((token) => /^\d+$/.test(token))) return true
  if (
    digits > 0 &&
    /\b(road|rd|drive|street|st|avenue|ave|way|close|crescent|lane)\b/i.test(raw)
  ) {
    return true
  }
  return false
}

function isFrampolKey(key) {
  return key === "frampol" || key.startsWith("frampol ") || key.startsWith("frampolafrica")
}

function isSimbisaKey(key) {
  return key === "simbisa" || key === "simbisa brands" || key.startsWith("simbisa brands ")
}

function isFarmKey(key) {
  return key === "farm and city centre"
}

function isHarry(record) {
  return analyseName(record.name).key === "harry greaves"
}

function isPersonName(name, company) {
  if (isJunkName(name)) return false
  if (hasMarker(name)) return false
  const nameInfo = analyseName(name)
  const companyInfo = analyseName(company)
  if (!nameInfo.key || isFrampolKey(nameInfo.key) || isSimbisaKey(nameInfo.key)) return false
  if (nameInfo.key === companyInfo.key) return false
  if (companyInfo.key.startsWith(`${nameInfo.key} `) || nameInfo.key.startsWith(`${companyInfo.key} `)) {
    return false
  }
  if (/\b(in[-\s]?house|accounts|cash sales)\b/i.test(name)) return false
  return /[a-z]/i.test(nameInfo.key) && nameInfo.key.split(" ").length <= 6
}

function recordStamp(id) {
  const match = /^CLT-(\d+)/.exec(String(id))
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function realValue(value) {
  const text = String(value ?? "").trim()
  if (!text || isNaValue(text) || text === "-" || text === "0") return ""
  return text
}

function completeness(record) {
  let score = 0
  if (realValue(record.email)) score += 2
  if (realValue(record.phone)) score += 1
  if (realValue(record.address)) score += 1
  return score
}

function compareKeeper(left, right) {
  if (right.orders !== left.orders) return right.orders - left.orders
  const completenessGap = completeness(right) - completeness(left)
  if (completenessGap !== 0) return completenessGap
  if (recordStamp(left.id) !== recordStamp(right.id)) return recordStamp(left.id) - recordStamp(right.id)
  return String(left.id).localeCompare(String(right.id))
}

function pickKeeper(records) {
  return records.slice().sort(compareKeeper)[0]
}

function levenshtein(left, right) {
  if (left === right) return 0
  if (!left.length) return right.length
  if (!right.length) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

function squash(key) {
  return key.replace(/ /g, "")
}

function pluralOrEnding(left, right) {
  return (
    left + "s" === right ||
    right + "s" === left ||
    left + "es" === right ||
    right + "es" === left ||
    left + "ing" === right ||
    right + "ing" === left
  )
}

function nearReason(left, right) {
  if (!left || !right || left === right) return ""
  const leftTokens = left.split(" ")
  const rightTokens = right.split(" ")
  if (
    left.length >= 8 &&
    right.length >= 8 &&
    squash(left) === squash(right) &&
    Math.abs(leftTokens.length - rightTokens.length) <= 2
  ) {
    return "space"
  }
  if (leftTokens.length !== rightTokens.length || leftTokens.length === 0) return ""
  const different = []
  for (let index = 0; index < leftTokens.length; index += 1) {
    if (leftTokens[index] !== rightTokens[index]) different.push(index)
  }
  if (different.length !== 1) return ""
  const leftToken = leftTokens[different[0]]
  const rightToken = rightTokens[different[0]]
  if (GENERIC_TOKENS.has(leftToken) || GENERIC_TOKENS.has(rightToken)) return ""
  if (Math.min(leftToken.length, rightToken.length) < 4) return ""
  if (pluralOrEnding(leftToken, rightToken)) return "ending"
  if (Math.min(leftToken.length, rightToken.length) >= 5 && levenshtein(leftToken, rightToken) === 1) {
    return "spelling"
  }
  return ""
}

function stripCurrencyWords(value) {
  const info = analyseName(value)
  if (!info.currency) return String(value ?? "").trim()
  return String(value ?? "")
    .replace(/\s*[~-]*\s*\(?\s*(zwg|usd|zwd)\s*\)?\s*\.?\s*$/i, "")
    .trim()
}

function classOf(record) {
  const nameInfo = analyseName(record.name)
  const companyInfo = analyseName(record.company)
  if (isNaValue(record.name) && isNaValue(record.company)) {
    return { key: "archive:na", realm: "archive", force: "archive", nameInfo, companyInfo }
  }
  if (isHarry(record)) {
    return { key: "person:harry greaves", realm: "person", force: "harry", nameInfo, companyInfo }
  }
  if (isFrampolKey(nameInfo.key) || isFrampolKey(companyInfo.key) || isFrampolKey(nameInfo.strictKey) || isFrampolKey(companyInfo.strictKey)) {
    return { key: "josh:frampol", realm: "josh", force: "frampol", nameInfo, companyInfo }
  }
  if (isSimbisaKey(nameInfo.key) || isSimbisaKey(companyInfo.key)) {
    return { key: "josh:simbisa", realm: "josh", force: "simbisa", nameInfo, companyInfo }
  }
  if (isNaValue(record.company)) {
    return { key: `person:${nameInfo.key}`, realm: "person", force: "", nameInfo, companyInfo }
  }
  if (isFarmKey(companyInfo.key) || isFarmKey(nameInfo.key)) {
    return { key: "org:farm and city centre", realm: "org", force: "farm", nameInfo, companyInfo }
  }
  return { key: `org:${companyInfo.key}`, realm: "org", force: "", nameInfo, companyInfo }
}

function canonicalKey(group) {
  if (group.force === "frampol") return "frampol"
  if (group.force === "simbisa") return "simbisa brands"
  if (group.force === "farm") return "farm and city centre"
  if (group.force === "harry") return "harry greaves"
  if (group.force === "archive") return "na"
  return group.key.split(":").slice(1).join(":")
}

function displayName(group) {
  if (group.force === "frampol") return "Frampol"
  if (group.force === "archive") return "N/A"
  if (group.force === "harry") return "Harry Greaves"
  const canonical = canonicalKey(group)
  const candidates = []
  for (const record of group.records) {
    for (const field of [record.company, record.name]) {
      const info = analyseName(field)
      if (info.key !== canonical && info.strictKey !== canonical) continue
      const label = info.currency ? stripCurrencyWords(field) : String(field ?? "").trim()
      if (!label || isNaValue(label)) continue
      candidates.push({ label, orders: record.orders, keeper: record.id === group.keeper.id, currency: info.currency })
    }
  }
  if (group.force === "simbisa") {
    const short = candidates.find((candidate) => analyseName(candidate.label).key === "simbisa brands" && !candidate.currency)
    if (short) return short.label
    return "Simbisa Brands"
  }
  const usable = candidates.filter((candidate) => !candidate.currency)
  const pool = usable.length > 0 ? usable : candidates
  pool.sort((left, right) => {
    if (left.keeper !== right.keeper) return left.keeper ? -1 : 1
    if (right.orders !== left.orders) return right.orders - left.orders
    return right.label.length - left.label.length
  })
  const chosen = pool[0]
    ? pool[0].label
    : stripCurrencyWords(group.keeper.company) || stripCurrencyWords(group.keeper.name) || group.keeper.company || group.keeper.name
  return String(chosen).trim().replace(/\.+$/g, "").trim()
}

function groupKind(group, label) {
  if (group.force === "archive") return ""
  if (group.force === "harry") return "individual"
  if (group.force === "frampol" || group.force === "simbisa") return "company"
  if (hasMarker(label)) return "company"
  for (const record of group.records) {
    if (hasMarker(record.company) || hasMarker(record.name)) return "company"
  }
  return "individual"
}

function mergeReasonFor(record, group) {
  const canonical = canonicalKey(group)
  const own = record.classified.companyInfo.key
  const ownStrict = record.classified.companyInfo.strictKey
  if (record.classified.companyInfo.currency || record.classified.nameInfo.currency) {
    const stripped = record.classified.companyInfo.key
    if (stripped === canonical || record.classified.nameInfo.key === canonical) return "currency copy"
  }
  if (group.force === "frampol" || group.force === "simbisa" || group.force === "farm" || group.force === "harry") {
    if (own !== canonical && ownStrict !== canonical && record.classified.nameInfo.key !== canonical) {
      return "Josh's decision"
    }
  }
  return "shell duplicate"
}

function looksLikePersonLabel(label) {
  const tokens = tokensOf(label)
  if (tokens.length < 2 || tokens.length > 3) return false
  if (tokens.some((token) => token === "zimbabwe" || token === "africa" || token === "harare" || token === "bulawayo")) {
    return false
  }
  return tokens.every(
    (token) => token.length >= 2 && !/\d/.test(token) && !BUSINESS_LOOK.has(token) && !MARKER_TOKENS.includes(token)
  )
}

function looksLikeBusiness(label, group) {
  if (group.kind !== "individual") return ""
  const raw = String(label ?? "").trim()
  const tokens = tokensOf(raw)
  const notes = []
  if (tokens.some((token) => BUSINESS_LOOK.has(token))) {
    notes.push(`the name looks like a business (${raw})`)
  }
  if (/^[A-Z]{2,5}$/.test(raw) && (group.orders > 0 || group.contacts.length > 0)) {
    notes.push(`${raw} is a short capitalised name`)
  }
  if (group.contacts.length > 0 && !looksLikePersonLabel(raw)) {
    notes.push(
      `${group.contacts.length} contact${group.contacts.length === 1 ? "" : "s"} sit under it and the name does not look like a person`
    )
  }
  if (notes.length === 0) return ""
  return `No business marker and no contacts, but ${notes.join("; ")}. Marked individual. Kind can be changed later and does not affect sales.`
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index)
  function find(index) {
    let current = index
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  function unite(left, right) {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }
  return { find, unite }
}

function clusterGroups(groups) {
  const realms = new Map()
  for (const group of groups) {
    const realm = group.key.slice(0, group.key.indexOf(":"))
    if (realm === "josh" || realm === "archive") continue
    if (!realms.has(realm)) realms.set(realm, [])
    realms.get(realm).push(group)
  }
  const consumed = new Set()
  const clustered = []
  for (const realmGroups of realms.values()) {
    const find = unionFind(realmGroups.length)
    const pairs = []
    for (let left = 0; left < realmGroups.length; left += 1) {
      for (let right = left + 1; right < realmGroups.length; right += 1) {
        const leftKey = realmGroups[left].key.split(":").slice(1).join(":")
        const rightKey = realmGroups[right].key.split(":").slice(1).join(":")
        const how = nearReason(leftKey, rightKey)
        if (!how) continue
        find.unite(left, right)
        pairs.push({
          left,
          text: `${leftKey} ↔ ${rightKey} (${how === "space" ? "spacing" : "spelling"})`,
        })
      }
    }
    const nearByRoot = new Map()
    for (const pair of pairs) {
      const root = find.find(pair.left)
      if (!nearByRoot.has(root)) nearByRoot.set(root, [])
      nearByRoot.get(root).push(pair.text)
    }
    const buckets = new Map()
    for (let index = 0; index < realmGroups.length; index += 1) {
      const root = find.find(index)
      if (!buckets.has(root)) buckets.set(root, [])
      buckets.get(root).push(index)
    }
    for (const indexes of buckets.values()) {
      if (indexes.length === 1) continue
      const combined = {
        key: realmGroups[indexes[0]].key,
        force: realmGroups[indexes[0]].force,
        records: [],
        near: nearByRoot.get(find.find(indexes[0])) ?? [],
      }
      for (const index of indexes) {
        consumed.add(realmGroups[index])
        combined.records.push(...realmGroups[index].records)
        if (realmGroups[index].force && !combined.force) combined.force = realmGroups[index].force
      }
      combined.keeper = pickKeeper(combined.records)
      clustered.push(combined)
    }
  }
  return [...groups.filter((group) => !consumed.has(group)), ...clustered]
}

function distinctEmails(records) {
  const seen = new Set()
  const values = []
  for (const record of records) {
    for (const part of String(record.email ?? "").split(/[;,]/)) {
      const value = realValue(part)
      const key = value.toLowerCase()
      if (!value || seen.has(key)) continue
      seen.add(key)
      values.push(value)
    }
  }
  return values.join("; ")
}

function distinctPhones(records) {
  const seen = new Set()
  const values = []
  for (const record of records) {
    const value = realValue(record.phone)
    const key = value.replace(/\s+/g, "").toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    values.push(value)
  }
  return values.join("; ")
}

function idsOf(records) {
  return records
    .slice()
    .sort((left, right) => recordStamp(left.id) - recordStamp(right.id) || String(left.id).localeCompare(String(right.id)))
    .map((record) => record.id)
    .join("\n")
}

function whyGrouped(group) {
  if (group.force === "archive") {
    return "Empty N/A records. Proposed for archive. Not a company or an individual."
  }
  const parts = []
  if (group.records.length === 1) parts.push("Single source record.")
  else parts.push(`${group.records.length} source records. Keeper is the record with the most orders, then the most complete details, then the oldest.`)
  if (group.force === "frampol") {
    parts.push("Josh's decision: Frampol Africa, Frampol Investments, and the Invesetments / Investiments misspellings are one company, Frampol, internal. Staff are contacts.")
  } else if (group.force === "simbisa") {
    parts.push("Josh's decision: Simbisa Brands and Simbisa Brands Zimbabwe are one company.")
  } else if (group.force === "farm") {
    parts.push("Josh's decision: Farm & City Centre and Farm and City Centre are one company. The names already match once & is read as and.")
  } else if (group.force === "harry") {
    parts.push("Josh's decision: Harry Greaves is an individual. The company field was N/A.")
  }
  const reasons = new Set(group.merges.map((merge) => merge.reason))
  if (reasons.has("currency copy")) parts.push("Currency copies (ZWG, USD, ZWD) are folded into the base name.")
  if (reasons.has("shell duplicate")) {
    parts.push("Other copies match after case, punctuation, &/and, trailing dots, or a legal suffix.")
  }
  if (group.kindFromContacts) {
    parts.push("Marked company because at least one contact is recorded under this name.")
  }
  if (group.near.length > 0) parts.push(`Near spelling, please confirm: ${group.near.join("; ")}.`)
  if (group.unusual) parts.push(`Grouped only after removing an unusual suffix (${group.unusualSuffixes.join(", ")}).`)
  const conflicts = group.records.filter((record) => {
    if (!hasMarker(record.name) || !hasMarker(record.company)) return false
    return record.classified.nameInfo.key !== record.classified.companyInfo.key
  })
  if (conflicts.length > 0) {
    parts.push("At least one source record has two different company names. The company field was used.")
  }
  return parts.join(" ")
}

function buildModel(records) {
  const initial = new Map()
  for (const record of records) {
    record.classified = classOf(record)
    if (!initial.has(record.classified.key)) {
      initial.set(record.classified.key, {
        key: record.classified.key,
        force: record.classified.force,
        records: [],
        near: [],
      })
    }
    initial.get(record.classified.key).records.push(record)
  }
  let groups = [...initial.values()]
  for (const group of groups) group.keeper = pickKeeper(group.records)
  groups = clusterGroups(groups)
  for (const group of groups) {
    group.keeper = pickKeeper(group.records)
    group.label = displayName(group)
    group.kind = groupKind(group, group.label)
    group.internal = group.force === "frampol"
    group.contacts = []
    group.merges = []
    group.unusualSuffixes = [
      ...new Set(group.records.flatMap((record) => record.classified.companyInfo.unusualSuffixes.concat(record.classified.nameInfo.unusualSuffixes))),
    ]
    const strictKeys = new Set(
      group.records.flatMap((record) => [record.classified.companyInfo.strictKey, record.classified.nameInfo.strictKey]).filter(Boolean)
    )
    group.unusual = group.unusualSuffixes.length > 0 && strictKeys.size > 1
  }

  for (const group of groups) {
    if (group.force === "archive") continue
    const people = new Map()
    const canonical = canonicalKey(group)
    for (const record of group.records) {
      if (!isPersonName(record.name, record.company)) continue
      const personKey = analyseName(record.name).key
      if (personKey === canonical) continue
      if (!people.has(personKey)) people.set(personKey, [])
      people.get(personKey).push(record)
    }
    for (const [personKey, personRecords] of people) {
      const keeper = pickKeeper(personRecords)
      group.contacts.push({
        key: personKey,
        name: keeper.name.trim(),
        email: distinctEmails(personRecords),
        phone: distinctPhones(personRecords),
        records: personRecords,
        keeper,
        orders: personRecords.reduce((sum, record) => sum + record.orders, 0),
      })
      for (const record of personRecords) {
        if (record.id === keeper.id) continue
        group.merges.push({
          record,
          keeper,
          reason: "same person",
        })
      }
    }
  }

  for (const group of groups) {
    if (group.records.length < 2 || group.force === "archive") continue
    const contactIds = new Set(group.merges.map((merge) => merge.record.id))
    for (const contact of group.contacts) contactIds.add(contact.keeper.id)
    for (const record of group.records) {
      if (record.id === group.keeper.id) continue
      if (contactIds.has(record.id)) continue
      group.merges.push({
        record,
        keeper: group.keeper,
        reason: mergeReasonFor(record, group),
      })
    }
  }

  for (const group of groups) {
    group.orders = group.records.reduce((sum, record) => sum + record.orders, 0)
    group.units = group.records.reduce((sum, record) => sum + record.units, 0)
  }
  const kindFromContacts = applyContactKind(groups)
  for (const group of groups) group.why = whyGrouped(group)
  return { groups, kindFromContacts }
}

function applyContactKind(groups) {
  let changed = 0
  let guessesWithOrders = 0
  let guessesResolved = 0
  for (const group of groups) {
    const guess = group.kind === "individual" && Boolean(looksLikeBusiness(group.label, group))
    const withOrders = guess && group.orders > 0
    if (withOrders) guessesWithOrders += 1
    if (group.contacts.length > 0 && group.kind === "individual" && group.force !== "harry") {
      group.kind = "company"
      group.kindFromContacts = true
      changed += 1
      if (withOrders) guessesResolved += 1
    }
  }
  return { changed, guessesWithOrders, guessesResolved }
}

function isPublicEmailDomain(domain) {
  const normalised = domain.toLowerCase()
  if (PUBLIC_EMAIL_DOMAINS.has(normalised)) return true
  const label = normalised.split(".")[0]
  return PUBLIC_EMAIL_LABELS.has(label)
}

function companyDomains(group) {
  const domains = new Set()
  for (const record of group.records) {
    for (const part of String(record.email ?? "").split(/[;,\s]+/)) {
      const match = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(part)
      if (!match) continue
      const domain = match[1].toLowerCase().replace(/\.+$/g, "")
      if (!domain || isPublicEmailDomain(domain)) continue
      domains.add(domain)
    }
  }
  return domains
}

function sameFirstWord(left, right) {
  const leftWord = left.split(" ").filter(Boolean)[0] ?? ""
  const rightWord = right.split(" ").filter(Boolean)[0] ?? ""
  if (leftWord.length < 4 || rightWord.length < 4) return false
  if (leftWord === "the" || rightWord === "the") return false
  if (leftWord === rightWord) return true
  const shorter = leftWord.length <= rightWord.length ? leftWord : rightWord
  const longer = leftWord.length <= rightWord.length ? rightWord : leftWord
  return longer.startsWith(shorter) && longer.length - shorter.length >= 3
}

function possiblySameRows(groups) {
  const byDomain = new Map()
  for (const group of groups) {
    if (group.force === "archive") continue
    for (const domain of companyDomains(group)) {
      if (!byDomain.has(domain)) byDomain.set(domain, [])
      byDomain.get(domain).push(group)
    }
  }
  const found = []
  for (const [domain, members] of byDomain) {
    if (members.length < 2) continue
    const find = unionFind(members.length)
    const keys = members.map((group) => analyseName(group.label).key)
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        if (sameFirstWord(keys[left], keys[right])) find.unite(left, right)
      }
    }
    const buckets = new Map()
    for (let index = 0; index < members.length; index += 1) {
      const root = find.find(index)
      if (!buckets.has(root)) buckets.set(root, [])
      buckets.get(root).push(members[index])
    }
    for (const picked of buckets.values()) {
      if (picked.length < 2) continue
      found.push({ groups: picked, domains: new Set([domain]) })
    }
  }
  const parent = found.map((_, index) => index)
  const findCluster = (index) => {
    let current = index
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  for (let left = 0; left < found.length; left += 1) {
    for (let right = left + 1; right < found.length; right += 1) {
      const shared = found[left].groups.some((group) => found[right].groups.includes(group))
      if (shared) parent[findCluster(right)] = findCluster(left)
    }
  }
  const clusters = new Map()
  for (let index = 0; index < found.length; index += 1) {
    const root = findCluster(index)
    if (!clusters.has(root)) clusters.set(root, { groups: new Map(), domains: new Set() })
    const cluster = clusters.get(root)
    for (const group of found[index].groups) cluster.groups.set(group.label, group)
    for (const domain of found[index].domains) cluster.domains.add(domain)
  }
  return [...clusters.values()]
    .map((cluster) => ({ groups: [...cluster.groups.values()], domains: cluster.domains }))
    .map((cluster) => {
      const orders = cluster.groups.reduce((sum, group) => sum + group.orders, 0)
      const names = cluster.groups
        .slice()
        .sort((left, right) => right.orders - left.orders || left.label.localeCompare(right.label))
      return {
        issue: "Possibly the same company",
        client: names.map((group) => group.label).join(" / "),
        detail: `Shared company email domain ${[...cluster.domains].sort().join(", ")}. Same first word, including a spacing difference such as drip / driptech. Not merged. ${names
          .map((group) => `${group.label} (${group.orders} orders)`)
          .join("; ")}.`,
        ids: names.map((group) => idsOf(group.records)).join("\n"),
        orders,
      }
    })
    .sort((left, right) => right.orders - left.orders || left.client.localeCompare(right.client))
}

function styleHeader(sheet, headers, decisionCount, headerRow = 1) {
  const decisionStart = headers.length - decisionCount + 1
  sheet.views = [{ state: "frozen", ySplit: headerRow }]
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow, column: headers.length },
  }
  sheet.getRow(headerRow).height = 22
  headers.forEach((header, index) => {
    const cell = sheet.getRow(headerRow).getCell(index + 1)
    const decision = index + 1 >= decisionStart
    cell.value = header
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF1F2933" } }
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: decision ? "FFFFE699" : "FFD9E2F3" },
    }
    cell.alignment = { vertical: "middle", wrapText: true }
  })
  const widths = headers.map((header) => Math.min(46, Math.max(14, header.length + 4)))
  headers.forEach((header, index) => {
    if (/ids|why|what to look at|email/i.test(header)) widths[index] = 46
    if (header === "Proposed client" || header === "Contact" || header === "Source name") widths[index] = 36
    sheet.getColumn(index + 1).width = widths[index]
  })
}

function writeRows(sheet, headers, rows, decisionCount, banner = "") {
  const headerRow = banner ? 2 : 1
  if (banner) {
    sheet.mergeCells(1, 1, 1, headers.length)
    const note = sheet.getRow(1).getCell(1)
    note.value = banner
    note.font = { name: "Arial", size: 10, italic: true }
    note.alignment = { vertical: "middle", wrapText: true }
    sheet.getRow(1).height = 36
  }
  styleHeader(sheet, headers, decisionCount, headerRow)
  const decisionStart = headers.length - decisionCount + 1
  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(headerRow + 1 + rowIndex)
    excelRow.height = 30
    row.forEach((value, column) => {
      const cell = excelRow.getCell(column + 1)
      cell.value = value
      cell.font = { name: "Arial", size: 10 }
      cell.alignment = { vertical: "top", wrapText: true }
      if (column + 1 >= decisionStart) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }
      }
      if (typeof value === "number") cell.numFmt = "#,##0"
    })
  })
}

function addTotalRow(sheet, labelColumn, sumColumns, dataRows) {
  const rowNumber = dataRows + 2
  const row = sheet.getRow(rowNumber)
  row.height = 22
  const label = row.getCell(labelColumn)
  label.value = "Total"
  label.font = { name: "Arial", size: 10, bold: true }
  for (const column of sumColumns) {
    const letter = sheet.getColumn(column).letter
    const cell = row.getCell(column)
    cell.value = { formula: `SUM(${letter}2:${letter}${dataRows + 1})` }
    cell.font = { name: "Arial", size: 10, bold: true }
    cell.numFmt = "#,##0"
  }
}

function checkRows(groups) {
  const rows = []
  for (const group of groups) {
    if (group.near.length > 0) {
      rows.push({
        issue: "Near spelling",
        client: group.label,
        detail: group.near.join("\n"),
        ids: idsOf(group.records),
        orders: group.orders,
      })
    }
    if (group.unusual) {
      rows.push({
        issue: "Unusual suffix",
        client: group.label,
        detail: `These records only group once ${group.unusualSuffixes.join(", ")} is removed. Names: ${[
          ...new Set(group.records.flatMap((record) => [record.name, record.company].map((value) => String(value).trim())).filter(Boolean)),
        ].join(" | ")}.`,
        ids: idsOf(group.records),
        orders: group.orders,
      })
    }
    if (group.force === "archive") {
      rows.push({
        issue: "Empty records",
        client: group.label,
        detail: `${group.records.length} records are N/A / N/A with ${group.orders} orders and ${group.units} units. Proposed for archive.`,
        ids: idsOf(group.records),
        orders: group.orders,
      })
    }
  }
  rows.push(...possiblySameRows(groups))
  const issueOrder = ["Near spelling", "Possibly the same company", "Unusual suffix", "Empty records"]
  rows.sort((left, right) => {
    const issue = issueOrder.indexOf(left.issue) - issueOrder.indexOf(right.issue)
    if (issue !== 0) return issue
    return right.orders - left.orders || left.client.localeCompare(right.client)
  })
  return rows
}

function kindGuessRows(groups) {
  return groups
    .filter((group) => group.kind === "individual" && looksLikeBusiness(group.label, group))
    .map((group) => ({
      client: group.label,
      kind: group.kind,
      detail: looksLikeBusiness(group.label, group),
      ids: idsOf(group.records),
      orders: group.orders,
      units: group.units,
    }))
    .sort((left, right) => right.orders - left.orders || left.client.localeCompare(right.client))
}

function assertModel(records, groups) {
  const seen = new Map()
  for (const group of groups) {
    for (const record of group.records) {
      if (seen.has(record.id)) throw new Error(`Record ${record.id} is in more than one client`)
      seen.set(record.id, group)
    }
  }
  if (seen.size !== records.length) throw new Error(`Mapped ${seen.size} of ${records.length} records`)
  const orders = groups.reduce((sum, group) => sum + group.orders, 0)
  const units = groups.reduce((sum, group) => sum + group.units, 0)
  const sourceOrders = records.reduce((sum, record) => sum + record.orders, 0)
  const sourceUnits = records.reduce((sum, record) => sum + record.units, 0)
  if (orders !== sourceOrders || units !== sourceUnits) {
    throw new Error(`Rolled up ${orders}/${units} against source ${sourceOrders}/${sourceUnits}`)
  }
  return { orders, units }
}

async function main() {
  loadEnvLocal()
  const db = new Client({
    connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  try {
    const settings = await db.query(`SELECT timezone FROM public.app_settings LIMIT 1`)
    const today = todayBusinessDate(settings.rows[0]?.timezone || "Africa/Harare")
    const loaded = await db.query(`
      SELECT
        clients.id,
        clients.name,
        clients.company,
        clients.email,
        clients.phone,
        clients.address,
        coalesce(counts.orders, 0)::int AS orders,
        coalesce(counts.units, 0)::int AS units
      FROM public.clients AS clients
      LEFT JOIN public.client_sale_dispatch_counts() AS counts ON counts.client_id = clients.id
      ORDER BY clients.id
    `)
    const records = loaded.rows.map((row) => ({
      id: row.id,
      name: row.name ?? "",
      company: row.company ?? "",
      email: row.email ?? "",
      phone: row.phone ?? "",
      address: row.address ?? "",
      orders: row.orders,
      units: row.units,
    }))
    const beforeWithSales = records.filter((record) => record.orders > 0).length
    const built = buildModel(records)
    const groups = built.groups
    const kindFromContacts = built.kindFromContacts
    const totals = assertModel(records, groups)

    const clients = groups.slice().sort((left, right) => right.orders - left.orders || left.label.localeCompare(right.label))
    const contacts = clients.flatMap((group) =>
      group.contacts
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((contact) => ({ ...contact, client: group.label }))
    )
    contacts.sort((left, right) => left.client.localeCompare(right.client) || left.name.localeCompare(right.name))
    const merges = clients.flatMap((group) =>
      group.merges.map((merge) => ({
        ...merge,
        client: group.label,
      }))
    )
    merges.sort(
      (left, right) =>
        left.reason.localeCompare(right.reason) ||
        left.client.localeCompare(right.client) ||
        String(left.record.name).localeCompare(String(right.record.name))
    )
    const checks = checkRows(groups)

    const workbook = new Workbook()
    workbook.creator = "Fram-Stock"
    workbook.created = new Date()

    const clientSheet = workbook.addWorksheet("Clients")
    const clientHeaders = [
      "Proposed client",
      "Kind",
      "Internal",
      "Source records",
      "Keeper record id",
      "Source record ids",
      "Orders",
      "Units",
      "Why grouped",
      "Correct? Y/N + note",
    ]
    writeRows(
      clientSheet,
      clientHeaders,
      clients.map((group) => [
        group.label,
        group.kind,
        group.internal ? "Yes" : "No",
        group.records.length,
        group.keeper.id,
        idsOf(group.records),
        group.orders,
        group.units,
        group.why,
        "",
      ]),
      1
    )
    addTotalRow(clientSheet, 1, [4, 7, 8], clients.length)

    const contactSheet = workbook.addWorksheet("Contacts")
    const contactHeaders = [
      "Contact",
      "Client",
      "Email",
      "Phone",
      "Source record ids",
      "Orders",
      "Correct? Y/N + note",
    ]
    writeRows(
      contactSheet,
      contactHeaders,
      contacts.map((contact) => [
        contact.name,
        contact.client,
        contact.email,
        contact.phone,
        idsOf(contact.records),
        contact.orders,
        "",
      ]),
      1
    )
    addTotalRow(contactSheet, 1, [6], contacts.length)

    const mergeSheet = workbook.addWorksheet("Merges")
    const mergeHeaders = [
      "Source record id",
      "Source name",
      "Source company",
      "Proposed client",
      "Keeper record id",
      "Keeper name",
      "Keeper company",
      "Reason",
      "Correct? Y/N + note",
    ]
    writeRows(
      mergeSheet,
      mergeHeaders,
      merges.map((merge) => [
        merge.record.id,
        merge.record.name,
        merge.record.company,
        merge.client,
        merge.keeper.id,
        merge.keeper.name,
        merge.keeper.company,
        merge.reason,
        "",
      ]),
      1
    )

    const checkSheet = workbook.addWorksheet("Check these")
    const checkHeaders = [
      "Issue",
      "Proposed client",
      "What to look at",
      "Source record ids",
      "Orders",
      "Correct? Y/N + note",
    ]
    writeRows(
      checkSheet,
      checkHeaders,
      checks.map((check) => [check.issue, check.client, check.detail, check.ids, check.orders, ""]),
      1
    )

    const kindRows = kindGuessRows(groups)
    const kindSheet = workbook.addWorksheet("Kind (optional)")
    const kindHeaders = [
      "Proposed client",
      "Kind",
      "Orders",
      "Units",
      "Why it is listed",
      "Source record ids",
      "Correct? Y/N + note",
    ]
    writeRows(
      kindSheet,
      kindHeaders,
      kindRows.map((row) => [row.client, row.kind, row.orders, row.units, row.detail, row.ids, ""]),
      1,
      "Optional. Kind can be changed any time later and does not affect sales. These clients have no contacts, so a missing business marker leaves them as individual."
    )

    const readme = workbook.addWorksheet("Read me")
    const kindCounts = {
      company: clients.filter((group) => group.kind === "company" && !group.internal).length,
      internal: clients.filter((group) => group.internal).length,
      individual: clients.filter((group) => group.kind === "individual").length,
      archive: clients.filter((group) => group.force === "archive").length,
    }
    const mergeCounts = merges.reduce((counts, merge) => {
      counts[merge.reason] = (counts[merge.reason] ?? 0) + 1
      return counts
    }, {})
    const afterWithSales = clients.filter((group) => group.orders > 0).length
    const readmeLines = [
      ["How to review this in 15 minutes", ""],
      [
        "1. Check these",
        "Open Check these first. Decide Near spelling, Possibly the same company, Unusual suffix, and Empty records. Possibly the same company means a shared company email domain and the same first word. Those clients are not merged. Mark Correct? Y/N + note.",
      ],
      [
        "2. Merges",
        "Skim by Reason. Currency copy and shell duplicate are mechanical. Same person means one contact kept for a repeated name. Josh's decision is Frampol, Simbisa Brands with Simbisa Brands Zimbabwe, Farm & City Centre with Farm and City Centre, and Harry Greaves as an individual.",
      ],
      [
        "3. Clients",
        `Skim the names with orders. Kind is company or individual. A client with any contact is a company, whatever its name. Internal is Yes only for Frampol. The total row is the sum of every proposed client: ${totals.orders.toLocaleString("en-GB")} orders and ${totals.units.toLocaleString("en-GB")} units.`,
      ],
      [
        "4. Contacts",
        "People recorded under a company. Sales stay on the client. A contact is optional. The same person under one client is listed once. Kind (optional) lists individuals whose names look like businesses. Kind can be changed any time later and does not affect sales.",
      ],
      [
        "What this workbook is",
        "A dry run over every current client record. Nothing is written to the database and nothing is deleted. Where several records become one client, the keeper is the one with the most orders, then the most complete email, phone, and address, then the oldest record. Other records point at that keeper.",
      ],
      [
        "Kind markers",
        `A client is a company when it has one or more contacts, or when the name contains one of: ${MARKER_TOKENS.join(", ")}; or P/L; or t/a; or trading as. Otherwise it is an individual. Names with no marker and no contacts that still look like businesses are on Kind (optional).`,
      ],
      [
        "Grouping",
        "Case, punctuation, & = and, and trailing dots are ignored. Legal suffixes removed: (Private) Limited, Private Limited, Limited, Ltd, Pvt, P/L. Currency suffixes removed: ZWG, (ZWG), - ZWG, USD, ZWD, ~ USD. Similar legal suffixes (Inc, Pty, PLC, LLC, LLP, Corp, GmbH) also fold, and those groups are listed under Unusual suffix. A shared email or phone never merges two clients. A shared company email domain plus the same first word is listed under Possibly the same company and is not merged. Public mail (gmail, yahoo, outlook, hotmail, icloud, and the like) is ignored.",
      ],
      [
        "Counts in this file",
        `${records.length} source records → ${clients.length} proposed clients (${kindCounts.company} companies, ${kindCounts.internal} internal, ${kindCounts.individual} individuals, ${kindCounts.archive} archive). ${contacts.length} contacts. ${merges.length} merges. ${checks.length} Check these rows. ${kindRows.length} Kind (optional) rows. Clients with sales ${beforeWithSales} before, ${afterWithSales} after. Contacts changed ${kindFromContacts.changed} clients to company and resolved ${kindFromContacts.guessesResolved} of ${kindFromContacts.guessesWithOrders} kind guesses that have orders.`,
      ],
    ]
    readme.addRow(["Topic", "Note"])
    for (const line of readmeLines) readme.addRow(line)
    readme.views = [{ state: "frozen", ySplit: 1 }]
    readme.getColumn(1).width = 36
    readme.getColumn(2).width = 110
    for (let rowIndex = 1; rowIndex <= readme.rowCount; rowIndex += 1) {
      const row = readme.getRow(rowIndex)
      row.height = rowIndex === 1 ? 22 : 48
      for (let column = 1; column <= 2; column += 1) {
        const cell = row.getCell(column)
        cell.font = { name: "Arial", size: 10, bold: rowIndex === 1 || column === 1 }
        cell.alignment = { vertical: "top", wrapText: true }
        if (rowIndex === 1) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } }
        }
      }
    }

    const dir = path.join(process.cwd(), "exports")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `client-model-proposal-${today}.xlsx`)
    const temporary = path.join(dir, `client-model-proposal-${today}.writing.xlsx`)
    await workbook.xlsx.writeFile(temporary)
    fs.rmSync(file, { force: true })
    fs.renameSync(temporary, file)

    const byKind = {
      company: kindCounts.company,
      companyInternal: kindCounts.internal,
      individual: kindCounts.individual,
      archive: kindCounts.archive,
    }
    console.log(
      JSON.stringify(
        {
          file,
          sourceRecords: records.length,
          proposedClients: clients.length,
          byKind,
          contacts: contacts.length,
          merges: merges.length,
          mergesByReason: mergeCounts,
          kindChangedByContacts: kindFromContacts.changed,
          kindGuessesWithOrders: kindFromContacts.guessesWithOrders,
          kindGuessesWithOrdersResolved: kindFromContacts.guessesResolved,
          checkThese: checks.length,
          checkTheseByIssue: checks.reduce((counts, check) => {
            counts[check.issue] = (counts[check.issue] ?? 0) + 1
            return counts
          }, {}),
          kindOptional: kindRows.length,
          possiblySame: checks
            .filter((check) => check.issue === "Possibly the same company")
            .map((check) => check.client),
          clientsWithSales: { before: beforeWithSales, after: afterWithSales },
          orders: totals.orders,
          units: totals.units,
        },
        null,
        2
      )
    )
    if (records.length !== EXPECTED_RECORDS) {
      throw new Error(`Expected ${EXPECTED_RECORDS} client records and found ${records.length}`)
    }
  } finally {
    await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exit(1)
  })
