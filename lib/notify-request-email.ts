/**
 * Hook for future email when a stock request is serviced (e.g. Resend + Supabase Edge).
 * No-op unless NOTIFY_REQUEST_EMAIL_URL or similar is configured.
 */
export async function notifyRequestServicedByEmail(_args: {
  requestId: string
  ownerUserId: string
  ownerEmail?: string | null
}): Promise<void> {
  const url = process.env.NOTIFY_REQUEST_EMAIL_URL
  if (!url) return
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_args),
    })
  } catch {
    /* non-blocking */
  }
}
