import { getSupabaseClient } from "@/lib/supabase/client"

export type KitCaseRow = {
  id: string
  case_type: string
  stage: string
  outcome: string | null
  reason_category: string
  reason_text: string
  opened_at: string
  closed_at: string | null
  opened_by: string | null
  closed_by: string | null
  client_id: string | null
  inventory_item_id: string
  serial_number: string
  kit_status: string
  stock_pool: string
  location: string | null
  holder: string | null
  product_id: string | null
  product_name: string | null
  vendor: string | null
  source_type: string
  source_label: string
  client_name: string | null
  client_company: string | null
  grade: string | null
  result: string | null
  comments: string | null
  closed_by_name: string | null
}

export function daysWaiting(openedAt: string, now = Date.now()): number {
  const opened = new Date(openedAt).getTime()
  if (Number.isNaN(opened)) return 0
  return Math.max(0, Math.floor((now - opened) / 86_400_000))
}

export function clientLabel(row: Pick<KitCaseRow, "client_name" | "client_company" | "holder">): string {
  if (row.client_name && row.client_company) return `${row.client_name} - ${row.client_company}`
  return row.holder || "—"
}

export function gradeSuggestion(grade: string, vendor: string | null): string | null {
  if (grade === "A") return "Resell"
  if (grade === "B") return vendor === "Starlink" ? "Rent out" : "Rent out is only for Starlink kits"
  if (grade === "C") return "Dispose"
  return null
}

export function inspectionOutcomes(result: string, vendor: string | null): string[] {
  if (result === "Pass" && vendor === "Starlink") return ["Resell", "Rent out", "Dispose"]
  if (result === "Pass") return ["Resell", "Dispose"]
  if (result === "Fail") return ["Return to vendor", "Dispose"]
  return []
}

export async function loadKitCases(stage: "open" | "closed"): Promise<KitCaseRow[]> {
  const supabase = getSupabaseClient()
  if (!supabase) return []
  const orderColumn = stage === "open" ? "opened_at" : "closed_at"
  const { data, error } = await supabase
    .from("kit_case_list")
    .select("*")
    .eq("stage", stage)
    .order(orderColumn, { ascending: stage === "open" })
  if (error) throw new Error(error.message)
  return (data ?? []) as KitCaseRow[]
}

export async function loadKitCase(caseId: string): Promise<KitCaseRow | null> {
  const supabase = getSupabaseClient()
  if (!supabase) return null
  const { data, error } = await supabase.from("kit_case_list").select("*").eq("id", caseId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as KitCaseRow | null) ?? null
}

export async function loadOpenCaseId(itemId: string): Promise<string | null> {
  const supabase = getSupabaseClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from("kit_cases")
    .select("id")
    .eq("inventory_item_id", itemId)
    .eq("stage", "open")
    .maybeSingle()
  if (error) return null
  return data?.id ?? null
}

export async function completeInspection(input: {
  caseId: string
  result: "Pass" | "Fail"
  comments: string
  grade: "A" | "B" | "C"
  outcome: string
  location: string | null
  reasonCategory: string | null
}): Promise<void> {
  const supabase = getSupabaseClient()
  if (!supabase) throw new Error("Not signed in")
  const { error } = await supabase.rpc("complete_inspection", {
    p_case_id: input.caseId,
    p_result: input.result,
    p_comments: input.comments,
    p_grade: input.grade,
    p_outcome: input.outcome,
    p_location: input.location,
    p_reason_category: input.reasonCategory,
  })
  if (error) throw new Error(error.message)
}
