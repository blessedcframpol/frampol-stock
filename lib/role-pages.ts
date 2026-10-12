/**
 * RH1 — single role → pages map for menu, landing redirects, and tests.
 * Keep in sync with DashboardShell nav and post-login landing.
 */
import type { AppRole } from "@/lib/permissions"
import {
  ADMIN,
  ACCOUNTS,
  SALES,
  TECHNICIANS,
  VIEWER,
} from "@/lib/permissions"

export type RoleNavItem = {
  href: string
  label: string
  /** Match this path prefix for "allowed" checks (defaults to href). */
  match?: string
}

/** Post-sign-in landing for each role. No-role → /pending-role (handled separately). */
export const ROLE_LANDING: Record<AppRole, string> = {
  admin: "/",
  viewer: "/",
  sales: "/requests",
  technicians: "/requests",
  accounts: "/invoices",
}

/** Sidebar / rail menu items per role (header Notifications bell is separate). */
export const ROLE_MENU: Record<AppRole, readonly RoleNavItem[]> = {
  sales: [
    { href: "/requests", label: "My requests" },
    { href: "/requests/new", label: "New request" },
    { href: "/stock", label: "Stock" },
    { href: "/notifications", label: "Notifications" },
    { href: "/problems/new", label: "Report a problem" },
  ],
  technicians: [
    { href: "/requests", label: "My requests" },
    { href: "/requests/new", label: "New request" },
    { href: "/stock", label: "Stock" },
    { href: "/notifications", label: "Notifications" },
    { href: "/problems/new", label: "Report a problem" },
  ],
  accounts: [
    { href: "/invoices", label: "Invoices" },
    { href: "/requests", label: "Requests" },
    { href: "/notifications", label: "Notifications" },
    { href: "/problems/new", label: "Report a problem" },
  ],
  admin: [
    { href: "/", label: "Dashboard", match: "/$" },
    { href: "/search", label: "Search" },
    { href: "/inventory", label: "Inventory", match: "/inventory" },
    { href: "/transaction-history", label: "Transaction history" },
    { href: "/invoices", label: "Invoices" },
    { href: "/alerts", label: "Alerts" },
    { href: "/clients", label: "Clients" },
    { href: "/requests", label: "Requests", match: "/requests" },
    { href: "/reports", label: "Reports", match: "/reports" },
    { href: "/notifications", label: "Notifications" },
    { href: "/problems/new", label: "Report a problem" },
  ],
  viewer: [
    { href: "/", label: "Dashboard", match: "/$" },
    { href: "/search", label: "Search" },
    { href: "/inventory", label: "Inventory", match: "/inventory" },
    { href: "/transaction-history", label: "Transaction history" },
    { href: "/invoices", label: "Invoices" },
    { href: "/alerts", label: "Alerts" },
    { href: "/clients", label: "Clients" },
    { href: "/requests", label: "Requests", match: "/requests" },
    { href: "/reports", label: "Reports", match: "/reports" },
    { href: "/notifications", label: "Notifications" },
    { href: "/problems/new", label: "Report a problem" },
  ],
}

/** Extra paths every signed-in role may open (detail pages, settings, user menu). */
const SHARED_ALLOWED_PREFIXES = [
  "/problems",
  "/pending-role",
  "/settings",
  "/login",
  "/auth",
] as const

const ADMIN_EXTRA = [
  "/users",
  "/logs",
  "/problems",
  "/inventory",
  "/search",
  "/transaction-history",
  "/alerts",
  "/clients",
  "/reports",
  "/stock",
] as const

const VIEWER_EXTRA = ADMIN_EXTRA

const ACCOUNTS_EXTRA = ["/invoices", "/requests", "/notifications", "/problems", "/stock"] as const

const REQUESTER_EXTRA = [
  "/requests",
  "/stock",
  "/notifications",
  "/problems",
] as const

function prefixesForRole(role: AppRole): readonly string[] {
  switch (role) {
    case ADMIN:
      return [...SHARED_ALLOWED_PREFIXES, ...ADMIN_EXTRA, "/"]
    case VIEWER:
      return [...SHARED_ALLOWED_PREFIXES, ...VIEWER_EXTRA, "/"]
    case ACCOUNTS:
      return [...SHARED_ALLOWED_PREFIXES, ...ACCOUNTS_EXTRA]
    case SALES:
    case TECHNICIANS:
      return [...SHARED_ALLOWED_PREFIXES, ...REQUESTER_EXTRA]
    default:
      return SHARED_ALLOWED_PREFIXES
  }
}

export function roleLandingPath(role: AppRole | null | undefined): string {
  if (!role) return "/pending-role"
  return ROLE_LANDING[role] ?? "/pending-role"
}

export function roleMenuItems(role: AppRole | null | undefined): readonly RoleNavItem[] {
  if (!role) return []
  return ROLE_MENU[role] ?? []
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname === "/"
  if (prefix.endsWith("$")) {
    const bare = prefix.slice(0, -1)
    return pathname === bare || pathname === bare.replace(/\/$/, "")
  }
  return pathname === prefix || pathname.startsWith(prefix + "/")
}

/** True when the role may stay on this path; otherwise redirect to landing. */
export function roleCanAccessPath(
  role: AppRole | null | undefined,
  pathname: string
): boolean {
  if (!role) return pathname.startsWith("/pending-role") || pathname.startsWith("/login")
  const path = pathname.split("?")[0] || "/"
  // Always allow the role's explicit menu destinations.
  for (const item of ROLE_MENU[role]) {
    const match = item.match ?? item.href
    if (pathMatchesPrefix(path, match === "/$" ? "/" : match)) return true
    if (path === item.href || path.startsWith(item.href + "/")) return true
  }
  for (const prefix of prefixesForRole(role)) {
    if (pathMatchesPrefix(path, prefix)) return true
  }
  // Admin/viewer home
  if ((role === ADMIN || role === VIEWER) && path === "/") return true
  return false
}

/** Where to send a role that opened a forbidden page. */
export function roleRedirectForPath(
  role: AppRole | null | undefined,
  pathname: string
): string | null {
  if (roleCanAccessPath(role, pathname)) return null
  return roleLandingPath(role)
}

/**
 * Where to send a signed-in role after login or OAuth: the requested page when it
 * is a safe in-app path this role may open, otherwise the role's landing page.
 */
export function roleRedirectAfterSignIn(
  role: AppRole | null | undefined,
  requested: string | null | undefined
): string {
  const landing = roleLandingPath(role)
  const next = (requested ?? "").trim()
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return landing
  const path = next.split("?")[0].split("#")[0] || "/"
  if (path.startsWith("/login") || path.startsWith("/auth")) return landing
  if (!role) return landing
  return roleCanAccessPath(role, path) ? next : landing
}

/** Global-search entity types derived from ROLE_MENU pages (not bottom-nav extras). */
export type RoleSearchEntity = "inventory" | "clients" | "users" | "products"

function menuHas(role: AppRole, ...prefixes: string[]): boolean {
  return ROLE_MENU[role].some((item) =>
    prefixes.some((p) => item.href === p || item.href.startsWith(p + "/"))
  )
}

/**
 * Entity types the header search may query for this role.
 * Empty → hide search. Requesters get product names from Stock only (no serials).
 */
export function roleSearchEntities(role: AppRole | null | undefined): RoleSearchEntity[] {
  if (!role) return []
  const out: RoleSearchEntity[] = []
  if (menuHas(role, "/inventory", "/search", "/transaction-history")) {
    out.push("inventory")
  } else if (menuHas(role, "/stock")) {
    out.push("products")
  }
  if (menuHas(role, "/clients")) out.push("clients")
  // Users page is bottom-nav for admin/viewer; include when they have the Search page.
  if (menuHas(role, "/search") || menuHas(role, "/")) {
    if (role === ADMIN || role === VIEWER) out.push("users")
  }
  // Deduplicate while keeping order
  return [...new Set(out)]
}

export function roleSearchPlaceholder(role: AppRole | null | undefined): string | null {
  const entities = roleSearchEntities(role)
  if (entities.length === 0) return null
  const labels: Record<RoleSearchEntity, string> = {
    inventory: "inventory",
    products: "products",
    clients: "clients",
    users: "users",
  }
  return `Search ${entities.map((e) => labels[e]).join(", ")}…`
}
