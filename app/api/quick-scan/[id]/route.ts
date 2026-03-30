import { apiClientError } from "@/lib/api-error-response"

export async function DELETE() {
  return apiClientError(405, "Removing scans is no longer supported via DELETE. Admins must POST /api/quick-scan/reverse with batchId and a reason.", {
    log: "warn",
  })
}
