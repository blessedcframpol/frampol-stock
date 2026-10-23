"use client"

import { useCallback, useState } from "react"
import type { ClientSite, Client } from "@/lib/data"
import type { ClientEntityKind, ClientDuplicateMatch } from "@/lib/client-complete"
import { newClientFieldErrors } from "@/lib/client-complete"
import { mapClientDbError } from "@/lib/map-client-db-error"
import {
  createClientFromCompleteInput,
  fetchClientDuplicateCandidates,
  clientCompleteToInsert,
} from "@/lib/create-client-flow"
import type { InsertClientInput } from "@/lib/supabase/clients-db"
import { getSupabaseClient } from "@/lib/supabase/client"
import { toast } from "sonner"

export function useNc1ClientCreate(isAdmin: boolean) {
  const [kind, setKind] = useState<ClientEntityKind>("company")
  const [name, setName] = useState("")
  const [company, setCompany] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [sites, setSites] = useState<ClientSite[]>([{ address: "" }])
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [dupOpen, setDupOpen] = useState(false)
  const [dupMatches, setDupMatches] = useState<ClientDuplicateMatch[]>([])
  const [dupForceReason, setDupForceReason] = useState("")
  const [pendingCreate, setPendingCreate] = useState<InsertClientInput | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = useCallback(() => {
    setKind("company")
    setName("")
    setCompany("")
    setEmail("")
    setPhone("")
    setSites([{ address: "" }])
    setFieldErrors({})
    setDupOpen(false)
    setDupMatches([])
    setDupForceReason("")
    setPendingCreate(null)
  }, [])

  function buildPayload(): InsertClientInput {
    const validSites = sites
      .filter((s) => s.address.trim())
      .map((s) => ({
        ...(s.name?.trim() ? { name: s.name.trim() } : {}),
        address: s.address.trim(),
      }))
    return { kind, name, company, email, phone, sites: validSites }
  }

  const finishCreate = useCallback(async (payload: InsertClientInput): Promise<Client> => {
    try {
      return await createClientFromCompleteInput(getSupabaseClient(), {
        kind: payload.kind,
        name: payload.name,
        company: payload.company,
        email: payload.email,
        phone: payload.phone,
        sites: payload.sites,
        duplicateOverrideReason: payload.duplicateOverrideReason,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const mapped = mapClientDbError(msg)
      setFieldErrors(mapped)
      throw e
    }
  }, [])

  const submitNewClient = useCallback(async (): Promise<Client | null> => {
    const payload = buildPayload()
    setFieldErrors({})
    const errors = newClientFieldErrors({
      kind: payload.kind,
      name: payload.name,
      company: payload.company,
      email: payload.email,
      phone: payload.phone,
      sites: payload.sites,
    })
    if (errors) {
      setFieldErrors(errors)
      toast.error("Fix the highlighted fields")
      return null
    }

    setBusy(true)
    try {
      const matches = await fetchClientDuplicateCandidates(getSupabaseClient(), payload)
      if (matches.length > 0) {
        setPendingCreate(payload)
        setDupMatches(matches)
        setDupOpen(true)
        return null
      }
      const client = await finishCreate(payload)
      reset()
      return client
    } catch {
      toast.error("Could not create client")
      return null
    } finally {
      setBusy(false)
    }
  }, [company, email, finishCreate, kind, name, phone, reset, sites])

  const confirmCreateAnyway = useCallback(async (): Promise<Client | null> => {
    const reason = dupForceReason.trim()
    if (!pendingCreate || !isAdmin || reason.length < 10) return null
    setBusy(true)
    try {
      const client = await finishCreate({
        ...pendingCreate,
        duplicateOverrideReason: reason,
      })
      setDupOpen(false)
      reset()
      return client
    } catch {
      toast.error("Could not create client")
      return null
    } finally {
      setBusy(false)
    }
  }, [dupForceReason, finishCreate, isAdmin, pendingCreate, reset])

  return {
    kind,
    setKind,
    name,
    setName,
    company,
    setCompany,
    email,
    setEmail,
    phone,
    setPhone,
    sites,
    setSites,
    fieldErrors,
    dupOpen,
    setDupOpen,
    dupMatches,
    dupForceReason,
    setDupForceReason,
    busy,
    reset,
    submitNewClient,
    confirmCreateAnyway,
    buildPayload,
    clientCompleteToInsert,
  }
}
