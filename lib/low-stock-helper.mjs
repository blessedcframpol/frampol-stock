/**
 * Map rows from public.low_stock_products to the shape used by dashboard and Alerts UI.
 * The database view is the only low-stock classifier. This helper does not recompute
 * in-stock counts, reorder thresholds, or which catalogue rows qualify.
 *
 * @param {Array<{
 *   productId: string,
 *   productName: string,
 *   vendor: string,
 *   inStockCount: number,
 *   effectiveReorderLevel: number,
 *   isLow: boolean
 * }>} products
 */
export function getLowStockAlerts(products) {
  return products
    .filter((product) => product.isLow)
    .map((product) => ({
      productId: product.productId,
      groupName: product.productName,
      vendor: product.vendor,
      inStock: product.inStockCount,
      threshold: product.effectiveReorderLevel,
    }))
}
