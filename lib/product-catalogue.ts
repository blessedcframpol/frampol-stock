import { getSupabaseClient } from "@/lib/supabase/client"

/** One row from public.product_catalogue — active products only; never kits/serials. */
export type ProductCatalogueRow = {
  product_id: string
  product_name: string
  vendor: string | null
  is_active: boolean
  requires_cloud_key: boolean
}

/** Active catalogue for every signed-in role (HF1). */
export async function fetchProductCatalogue(): Promise<ProductCatalogueRow[]> {
  const { data, error } = await getSupabaseClient().rpc("product_catalogue")
  if (error) throw error
  return (data ?? []) as ProductCatalogueRow[]
}
