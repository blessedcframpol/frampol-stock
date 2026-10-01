"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import {
  fetchLowStockProducts,
  getLowStockAlerts,
  SETTINGS_UPDATED_EVENT,
  type LowStockProduct,
} from "@/lib/settings"
import { useInventoryStore } from "@/lib/inventory-store"

export function useLowStockProducts() {
  const { user, loading: authLoading } = useAuth()
  const { inventory } = useInventoryStore()
  const [products, setProducts] = useState<LowStockProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!user) {
      setProducts([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setProducts(await fetchLowStockProducts())
      setError(null)
    } catch (caught) {
      setProducts([])
      setError(caught instanceof Error ? caught.message : "Could not load low-stock products")
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    const request = user ? fetchLowStockProducts() : Promise.resolve([])
    void request
      .then((rows) => {
        if (cancelled) return
        setProducts(rows)
        setError(null)
      })
      .catch((caught) => {
        if (cancelled) return
        setProducts([])
        setError(caught instanceof Error ? caught.message : "Could not load low-stock products")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, user, inventory])

  useEffect(() => {
    const handleSettingsUpdate = () => void refresh()
    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettingsUpdate)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettingsUpdate)
  }, [refresh])

  const lowStock = useMemo(() => getLowStockAlerts(products), [products])

  return { products, lowStock, loading, error, refresh }
}
