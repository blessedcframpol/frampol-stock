"use client"

import { useEffect, useState } from "react"
import { DEFAULT_ORG_TIMEZONE } from "@/lib/business-date.mjs"
import { fetchAppSettings } from "@/lib/settings"

/** Organisation timezone from app_settings, falling back to the column default until loaded. */
export function useOrgTimezone(): string {
  const [timeZone, setTimeZone] = useState(DEFAULT_ORG_TIMEZONE)

  useEffect(() => {
    let cancelled = false
    void fetchAppSettings()
      .then((settings) => {
        const next = settings.timezone?.trim()
        if (!cancelled && next) setTimeZone(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return timeZone
}
