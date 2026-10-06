import { getSupabaseClient } from "@/lib/supabase/client"

export type ReturnsWaiting = { type: string; units: number }
export type ReturnsReason = { text: string; units: number }
export type ReturnsCategory = { category: string; units: number; reasons: ReturnsReason[] }
export type ReturnsOutcome = { outcome: string; starlink: number; other: number }
export type ReturnsResult = { result: string; units: number }
export type ReturnsGrade = { grade: string; units: number }
export type ReturnsSite = { site: string; units: number }

export type ReturnsReport = {
  from: string
  to: string
  now: {
    waiting: ReturnsWaiting[]
    oldest_wait_days: number | null
    oldest_since: string | null
    rental_out: number
  }
  returns: ReturnsCategory[]
  outcomes: ReturnsOutcome[]
  results: ReturnsResult[]
  grades: ReturnsGrade[]
  sites: ReturnsSite[]
}

export function fetchReturnsReport(from: string, to: string): Promise<ReturnsReport> {
  return getSupabaseClient()
    .rpc("returns_report", { p_from: from, p_to: to })
    .then(({ data, error }: { data: ReturnsReport | null; error: { message: string } | null }) => {
      if (error) throw error
      if (!data) throw new Error("The returns report was empty")
      return data
    })
}
