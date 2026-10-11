/** Match REQ-YY-NNNN by full value or trailing digits ("42" → REQ-26-0042). */
export function matchesRequestNumber(
  requestNumber: string | null | undefined,
  query: string | null | undefined,
): boolean {
  const q = (query ?? "").trim().toLowerCase()
  const n = (requestNumber ?? "").trim().toLowerCase()
  if (!q || !n) return false
  if (n.includes(q)) return true
  if (!/^\d+$/.test(q)) return false
  const match = n.match(/^req-\d{2}-(\d+)$/)
  if (!match) return false
  const counter = match[1]
  const bareCounter = counter.replace(/^0+/, "") || "0"
  const bareQuery = q.replace(/^0+/, "") || "0"
  return bareCounter === bareQuery || counter === q || counter.endsWith(q)
}
