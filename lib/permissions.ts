/**
 * App roles and permission helpers for UI and route guards.
 * Must stay in sync with public.app_role enum and RLS in the database.
 */

export const ROLES = ["admin", "sales", "accounts", "technicians", "viewer"] as const
export type AppRole = (typeof ROLES)[number]

export const ADMIN: AppRole = "admin"
export const SALES: AppRole = "sales"
export const ACCOUNTS: AppRole = "accounts"
export const TECHNICIANS: AppRole = "technicians"
export const VIEWER: AppRole = "viewer"

/**
 * Privileged operations: reverse and restore quick-scan batches, change stock
 * pool, manage users. Admin only. The Admin viewer role never writes.
 */
export function canPrivilegedAdminOps(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

export function canManageUsers(role: AppRole | null | undefined): boolean {
  return canPrivilegedAdminOps(role)
}

/** Read the user list (admin writes, Admin viewer reads). */
export function canViewUsers(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === VIEWER
}

/** Settings → Audit. Admin and Admin viewer read; the SQL function enforces the same gate. */
export function canViewAuditLog(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === VIEWER
}

/** View persisted app event / error logs (admin only). */
export function canViewAppLogs(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** Reverse a quick-scan batch on Transaction history (audit trail + reason). Admin only. */
export function canReverseQuickScanBatches(role: AppRole | null | undefined): boolean {
  return canPrivilegedAdminOps(role)
}

/** Cancel the latest holding extension. Admin only. */
export function canCancelHoldingExtension(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** Record stock movements (Quick Scan, Inventory Movement). Admin only; everyone else raises requests. */
export function canRecordStockMovement(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** Undo or reassign a ledger row. Admin only after RQ2 (technicians raise requests). */
export function canAmendTransaction(
  role: AppRole | null | undefined,
  _transactionCreatedBy?: string | null,
  _currentUserId?: string | null
): boolean {
  return role === ADMIN
}

/** Export full transaction ledger (admin only). */
export function canExportAllTransactions(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/**
 * Inventory page add / edit / trash only — deliberately stricter than RLS.
 * Stock movements use canRecordStockMovement (admin only after RQ2); do not "fix"
 * this to match write policies on inventory_items.
 */
export function canEditInventory(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** Change an In Stock kit between sale, rental, and demo. Admin only. */
export function canChangeStockPool(role: AppRole | null | undefined): boolean {
  return canPrivilegedAdminOps(role)
}

export function canCompleteInspection(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

export function canViewFinancials(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === ACCOUNTS
}

/** Enter, change, and review batch invoices. Admin and accounts. Approval is admin only. */
export function canManageInvoices(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === ACCOUNTS
}

/** Read the invoice list (admin, accounts, Admin viewer). Writes use canManageInvoices. */
export function canViewInvoices(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === ACCOUNTS || role === VIEWER
}

export function canCreateStockRequest(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === SALES || role === TECHNICIANS
}

export function canAccessReports(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === ACCOUNTS || role === VIEWER
}

export function canAccessRequests(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === SALES || role === TECHNICIANS || role === ACCOUNTS || role === VIEWER
}

/** Issue units against a request. issue_units limits accounts to Fortinet. */
export function canFulfillStockRequests(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === ACCOUNTS
}

export function canInvoiceStockRequests(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === ACCOUNTS
}

export function canEditClients(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === SALES || role === ACCOUNTS || role === TECHNICIANS
}

export function canManageRemediation(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === SALES || role === ACCOUNTS || role === TECHNICIANS
}

export function canAccessSettings(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === SALES || role === ACCOUNTS || role === TECHNICIANS || role === VIEWER
}

/** Any signed-in staff role can file a problem report. */
export function canReportProblem(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === SALES || role === ACCOUNTS || role === TECHNICIANS || role === VIEWER
}

/** Admin manages all problem reports (list + status). */
export function canManageProblemReports(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** Sales/technicians see their reports under Requests; others via the user menu. */
export function problemReportsLiveUnderRequests(role: AppRole | null | undefined): boolean {
  return role === SALES || role === TECHNICIANS
}

/** UI label for each role. */
export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Admin",
  sales: "Sales",
  accounts: "Accounts",
  technicians: "Technicians",
  viewer: "Admin viewer",
}

export function isValidRole(value: string): value is AppRole {
  return ROLES.includes(value as AppRole)
}
