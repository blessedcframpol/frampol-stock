import type { AppRole } from "@/lib/permissions"

export type StockRequestStatus =
  | "draft"
  | "submitted"
  | "in_progress"
  | "serviced"
  | "invoiced"
  | "cancelled"

/**
 * MUST match `tr_stock_requests_guard_status_transition` in migration 049.
 * Changing one without the other produces raw P0001 errors for users.
 */
export const STOCK_REQUEST_TRANSITIONS: Record<
  StockRequestStatus,
  Array<{ to: StockRequestStatus; roles: AppRole[] | "owner_or_admin" }>
> = {
  draft: [
    { to: "submitted", roles: "owner_or_admin" },
    { to: "cancelled", roles: "owner_or_admin" },
  ],
  submitted: [
    { to: "draft", roles: "owner_or_admin" },
    { to: "in_progress", roles: ["admin", "technicians"] },
    { to: "serviced", roles: ["admin", "technicians"] },
    { to: "cancelled", roles: "owner_or_admin" },
  ],
  in_progress: [
    { to: "serviced", roles: ["admin", "technicians"] },
    { to: "cancelled", roles: ["admin", "technicians"] },
  ],
  serviced: [
    { to: "in_progress", roles: ["admin", "technicians"] },
    { to: "invoiced", roles: ["admin", "accounts"] },
  ],
  invoiced: [],
  cancelled: [],
}

export function allowedTransitions(
  status: StockRequestStatus,
  role: AppRole | null | undefined,
  isOwner: boolean
): StockRequestStatus[] {
  const edges = STOCK_REQUEST_TRANSITIONS[status] ?? []
  return edges
    .filter((edge) => {
      if (edge.roles === "owner_or_admin") {
        // Admin always. Ownership only counts for roles that can create requests
        // (sales, technicians — see canCreateStockRequest). Accounts cannot own
        // through the UI; offering those buttons would hit RLS before the trigger.
        return (
          role === "admin" ||
          (isOwner === true && (role === "sales" || role === "technicians"))
        )
      }
      return role != null && edge.roles.includes(role)
    })
    .map((edge) => edge.to)
}

export function isStockRequestStatus(value: string): value is StockRequestStatus {
  return value in STOCK_REQUEST_TRANSITIONS
}
