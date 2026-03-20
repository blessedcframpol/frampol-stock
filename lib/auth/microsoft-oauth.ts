/**
 * Microsoft sign-in via Supabase Auth (Azure AD / Entra ID provider key: "azure").
 * Single-tenant app: in Supabase set Azure Tenant URL to
 * https://login.microsoftonline.com/<TENANT_ID> (never /common).
 * @see https://supabase.com/docs/guides/auth/social-login/auth-azure
 */

export const MICROSOFT_PROVIDER = "azure" as const

/** Scopes Azure / Supabase expect for email + profile in JWT and user_metadata. */
export const MICROSOFT_OAUTH_SCOPES = "email offline_access openid profile"

/**
 * OAuth redirect target: `/auth/callback` exchanges the `code` for a session cookie, then redirects to `next`.
 */
export function getAuthCallbackUrl(origin: string, nextPath: string): string {
  const next = nextPath.startsWith("/") ? nextPath : `/${nextPath}`
  return `${origin.replace(/\/$/, "")}/auth/callback?next=${encodeURIComponent(next)}`
}
