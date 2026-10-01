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

export function canManageUsers(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** View persisted app event / error logs (admin only). */
export function canViewAppLogs(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** Reverse a quick-scan batch on Transaction history (audit trail + reason). Admin only. */
export function canReverseQuickScanBatches(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/** Record stock movements (Quick Scan, Inventory Movement). Mirrors RLS in 047. */
export function canRecordStockMovement(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === TECHNICIANS
}

/** Undo or reassign a ledger row: its creator, or any admin. Mirrors RLS in 047. */
export function canAmendTransaction(
  role: AppRole | null | undefined,
  transactionCreatedBy: string | null | undefined,
  currentUserId: string | null | undefined
): boolean {
  if (role === ADMIN) return true
  if (role !== TECHNICIANS) return false
  return Boolean(transactionCreatedBy && currentUserId && transactionCreatedBy === currentUserId)
}

/** Export full transaction ledger (admin only). */
export function canExportAllTransactions(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

/**
 * Inventory page add / edit / trash only — deliberately stricter than RLS.
 * Stock movements use canRecordStockMovement (admin + technicians); do not "fix"
 * this to match write policies on inventory_items.
 */
export function canEditInventory(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

export function canViewFinancials(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === ACCOUNTS
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

export function canFulfillStockRequests(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === TECHNICIANS
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
  return role === ADMIN || role === SALES || role === ACCOUNTS || role === TECHNICIANS
}

export function isValidRole(value: string): value is AppRole {
  return ROLES.includes(value as AppRole)
}
