/**
 * App roles and permission helpers for UI and route guards.
 * Must stay in sync with public.app_role enum and RLS in the database.
 */

export const ROLES = ["admin", "sales", "accounts", "technicians"] as const
export type AppRole = (typeof ROLES)[number]

export const ADMIN: AppRole = "admin"
export const SALES: AppRole = "sales"
export const ACCOUNTS: AppRole = "accounts"
export const TECHNICIANS: AppRole = "technicians"

export function canManageUsers(role: AppRole | null | undefined): boolean {
  return role === ADMIN
}

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
  return role === ADMIN || role === ACCOUNTS
}

export function canAccessRequests(role: AppRole | null | undefined): boolean {
  return role === ADMIN || role === SALES || role === TECHNICIANS
}

export function isValidRole(value: string): value is AppRole {
  return ROLES.includes(value as AppRole)
}
