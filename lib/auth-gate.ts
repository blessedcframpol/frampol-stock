/**
 * Pure auth-gate decisions for proxy.ts (unit-testable without NextRequest).
 */

export const PUBLIC_PATHS = [
  "/login",
  "/auth/callback",
  "/api/push/send",
  "/sw.js",
  "/manifest.webmanifest",
] as const

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export type AuthGateDecision =
  | { kind: "allow" }
  | { kind: "api_unauthorized" }
  | { kind: "redirect_login"; redirectTo: string }

/**
 * After getUser(): decide allow / 401 JSON / login redirect.
 * Public paths always allow (cookie refresh still runs before this).
 */
export function decideAuthGate(pathname: string, hasUser: boolean): AuthGateDecision {
  if (isPublicPath(pathname)) return { kind: "allow" }
  if (hasUser) return { kind: "allow" }
  if (pathname.startsWith("/api/")) return { kind: "api_unauthorized" }
  return { kind: "redirect_login", redirectTo: pathname }
}
