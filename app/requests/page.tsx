import { DashboardShell } from "@/components/dashboard-shell"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MessageSquare, Clock } from "lucide-react"

const requests = [
  { id: 1, from: "Reception", item: "Starlink Kit x2", note: "Client waiting in lobby", time: "10 min ago", status: "Pending" },
  { id: 2, from: "Sales Team", item: "Dell XPS 15", note: "Demo unit needed for meeting", time: "25 min ago", status: "Pending" },
  { id: 3, from: "IT Support", item: "Cisco Meraki MX68", note: "Replacement for faulty unit", time: "1 hour ago", status: "Pending" },
]

export default function RequestsPage() {
  return (
    <DashboardShell>
      <div className="flex flex-col gap-4 md:gap-6 min-w-0">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Requests</h1>
          <p className="text-sm text-muted-foreground mt-1">Incoming stock requests from reception and other departments.</p>
        </div>

        <div className="flex flex-col gap-3 md:gap-4">
          {requests.map((req) => (
            <Card key={req.id}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-500/10 shrink-0">
                    <MessageSquare className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{req.item}</p>
                      <Badge variant="secondary" className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-0">{req.status}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">From: {req.from}</p>
                    <p className="text-sm text-foreground mt-2">{req.note}</p>
                    <div className="flex items-center gap-1.5 mt-2">
                      <Clock className="w-3 h-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{req.time}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardShell>
  )
}
