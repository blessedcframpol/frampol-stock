/** Sample stock requests (reception / departments). Replace with API when wired. */
export type StockRequest = {
  id: number
  from: string
  item: string
  note: string
  time: string
  status: string
}

export const stockRequests: StockRequest[] = [
  { id: 1, from: "Reception", item: "Starlink Kit x2", note: "Client waiting in lobby", time: "10 min ago", status: "Pending" },
  { id: 2, from: "Sales Team", item: "Dell XPS 15", note: "Demo unit needed for meeting", time: "25 min ago", status: "Pending" },
  { id: 3, from: "IT Support", item: "Cisco Meraki MX68", note: "Replacement for faulty unit", time: "1 hour ago", status: "Pending" },
]
