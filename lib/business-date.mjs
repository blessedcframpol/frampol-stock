/** Organisation timezone used when app_settings cannot be read. The database column is the source. */
export const DEFAULT_ORG_TIMEZONE = "Africa/Harare"

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/

function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ""
  let hour = get("hour")
  if (hour === "24") hour = "00"
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
  }
}

/** Calendar day YYYY-MM-DD in the given IANA timezone. */
export function todayBusinessDate(timeZone = DEFAULT_ORG_TIMEZONE, now = new Date()) {
  const parts = zonedParts(now, timeZone)
  if (!parts.year || !parts.month || !parts.day) {
    throw new Error("Could not format the business date")
  }
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Store a picked calendar day in the 048 text format, with no clock time. */
export function businessDateToIso(ymd) {
  const raw = String(ymd ?? "").trim()
  if (!YMD_RE.test(raw.slice(0, 10)) || raw.length < 10) {
    throw new Error("Business date must be YYYY-MM-DD")
  }
  return `${raw.slice(0, 10)}T00:00:00.000Z`
}

/**
 * Render a business date as DD/MM/YYYY by slicing the calendar day.
 * Does not construct a Date, so a midnight UTC value cannot become 02:00.
 */
export function formatBusinessDate(dateStr) {
  if (dateStr == null || !String(dateStr).trim()) return "—"
  const match = YMD_RE.exec(String(dateStr).trim())
  if (!match) return String(dateStr)
  return `${match[3]}/${match[2]}/${match[1]}`
}

/**
 * Recorded instant in the organisation timezone.
 * Blank when created_at is null. Time only when that local day matches the
 * business date; otherwise the local date and time.
 */
export function formatRecordedAt(createdAt, businessDate, timeZone = DEFAULT_ORG_TIMEZONE) {
  if (createdAt == null || !String(createdAt).trim()) return ""
  const instant = new Date(createdAt)
  if (Number.isNaN(instant.getTime())) return ""
  const parts = zonedParts(instant, timeZone)
  if (!parts.year || !parts.hour) return ""
  const ymd = `${parts.year}-${parts.month}-${parts.day}`
  const time = `${parts.hour}:${parts.minute}`
  const businessYmd = businessDate ? String(businessDate).slice(0, 10) : ""
  if (!businessYmd || ymd !== businessYmd) {
    return `${parts.day}/${parts.month}/${parts.year} ${time}`
  }
  return time
}

/** History order is the business date, newest first. Recorded time is not a sort key. */
export function compareBusinessDatesDesc(a, b) {
  const left = String(a ?? "").slice(0, 10)
  const right = String(b ?? "").slice(0, 10)
  if (left === right) return 0
  return left < right ? 1 : -1
}

export function latestRecordedAt(values) {
  let best
  for (const value of values ?? []) {
    if (value == null || !String(value).trim()) continue
    const iso = String(value)
    if (!best || iso > best) best = iso
  }
  return best
}
