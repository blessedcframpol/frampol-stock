/**
 * Dev-only helpers for the RQ3 issue-screen preview.
 * Builds a mixed-line fixture UI while routing preview_issue_scan to real
 * single-vendor requests (Starlink and Fortinet cannot share one request).
 */
import type { AppSupabaseClient } from "@/lib/supabase/app-client"
import {
  fetchStockRequestById,
  submitRequest,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"

export const RQ3_PREVIEW_STARLINK_NOTES = "RQ3b-dev-preview-fixture-starlink"
export const RQ3_PREVIEW_FORTINET_NOTES = "RQ3b-dev-preview-fixture-fortinet"

export const RQ3_PREVIEW_STARLINK_PRODUCT = "Starlink Standard Kit v4"
export const RQ3_PREVIEW_FORTINET_PRODUCT = "FortiGate 50G"

const ATLAS =
  "https://ai.frampolafrica.com:10801/projects/11111111-1111-1111-1111-111111111111?task=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const FIXTURE_LINE_STARLINK = "fixture-line-starlink-standard-v4"
const FIXTURE_LINE_FORTINET = "fixture-line-fortigate-50g"

export type Rq3PreviewFixture = {
  /** Merged UI request (mixed vendors — display only). */
  request: StockRequestWithRelations
  issuedByLine: Record<string, number>
  displayStatus: "being_reviewed"
  requesterLabel: string
  /** product_id → real stock_requests.id for preview_issue_scan */
  previewRequestByProductId: Record<string, string>
  previewFallbackRequestId: string
  starlinkRequestId: string
  fortinetRequestId: string
}

async function findProduct(
  sb: AppSupabaseClient,
  name: string
): Promise<{ id: string; product_name: string; vendor: string | null; requires_cloud_key: boolean | null }> {
  const { data, error } = await sb
    .from("product_lines")
    .select("id, product_name, vendor, requires_cloud_key")
    .eq("product_name", name)
    .eq("is_active", true)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error(`Product not found: ${name}`)
  return data
}

async function findOpenByNotes(sb: AppSupabaseClient, notes: string): Promise<string | null> {
  const { data, error } = await sb
    .from("stock_requests")
    .select("id")
    .eq("notes", notes)
    .eq("review_state", "submitted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

async function ensureRequest(
  sb: AppSupabaseClient,
  notes: string,
  productId: string,
  quantity: number
): Promise<string> {
  const existing = await findOpenByNotes(sb, notes)
  if (existing) return existing

  const { data: settings, error: settingsError } = await sb
    .from("app_settings")
    .select("internal_client_id")
    .eq("id", true)
    .maybeSingle()
  if (settingsError) throw settingsError
  let clientId = settings?.internal_client_id as string | null
  if (!clientId) {
    const { data: client, error: clientError } = await sb
      .from("clients")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (clientError) throw clientError
    clientId = client?.id ?? null
  }
  if (!clientId) throw new Error("No client available to create the RQ3b preview fixture request")

  return submitRequest(sb, {
    clientId,
    type: "Sale",
    atlasTaskUrl: ATLAS,
    notes,
    invoiceChoice: "pending",
    lines: [{ productId, productName: notes.includes("fortinet") ? RQ3_PREVIEW_FORTINET_PRODUCT : RQ3_PREVIEW_STARLINK_PRODUCT, quantity }],
  })
}

/** Ensure backing Sale requests exist, then return a merged fixture for the real issue UI. */
export async function loadRq3IssuePreviewFixture(sb: AppSupabaseClient): Promise<Rq3PreviewFixture> {
  const starlinkProduct = await findProduct(sb, RQ3_PREVIEW_STARLINK_PRODUCT)
  const fortinetProduct = await findProduct(sb, RQ3_PREVIEW_FORTINET_PRODUCT)

  const starlinkRequestId = await ensureRequest(sb, RQ3_PREVIEW_STARLINK_NOTES, starlinkProduct.id, 2)
  const fortinetRequestId = await ensureRequest(sb, RQ3_PREVIEW_FORTINET_NOTES, fortinetProduct.id, 1)

  const [starlinkReq, fortinetReq] = await Promise.all([
    fetchStockRequestById(sb, starlinkRequestId),
    fetchStockRequestById(sb, fortinetRequestId),
  ])
  if (!starlinkReq || !fortinetReq) {
    throw new Error("Could not load RQ3b preview fixture requests")
  }

  const now = new Date().toISOString()
  const request: StockRequestWithRelations = {
    ...starlinkReq,
    id: "rq3b-dev-preview-fixture",
    request_number: "REQ-PREVIEW",
    type: "Sale",
    notes: "Dev preview — Issue is disabled. Scans use real preview_issue_scan (read-only).",
    created_at: now,
    stock_request_lines: [
      {
        id: FIXTURE_LINE_STARLINK,
        request_id: "rq3b-dev-preview-fixture",
        product_id: starlinkProduct.id,
        product_name: starlinkProduct.product_name,
        quantity_requested: 2,
        sort_order: 0,
        requires_serial: true,
        requires_cloud_key: Boolean(starlinkProduct.requires_cloud_key),
        vendor: starlinkProduct.vendor,
      },
      {
        id: FIXTURE_LINE_FORTINET,
        request_id: "rq3b-dev-preview-fixture",
        product_id: fortinetProduct.id,
        product_name: fortinetProduct.product_name,
        quantity_requested: 1,
        sort_order: 1,
        requires_serial: true,
        requires_cloud_key: Boolean(fortinetProduct.requires_cloud_key),
        vendor: fortinetProduct.vendor,
      },
    ],
  }

  return {
    request,
    issuedByLine: { [FIXTURE_LINE_STARLINK]: 0, [FIXTURE_LINE_FORTINET]: 0 },
    displayStatus: "being_reviewed",
    requesterLabel: "Preview",
    previewRequestByProductId: {
      [starlinkProduct.id]: starlinkRequestId,
      [fortinetProduct.id]: fortinetRequestId,
    },
    previewFallbackRequestId: starlinkRequestId,
    starlinkRequestId,
    fortinetRequestId,
  }
}
