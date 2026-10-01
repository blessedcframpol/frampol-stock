"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { getSupabaseClient } from "@/lib/supabase/client"
import { UPLOAD_BUCKET } from "@/lib/upload-documents"
import { cn } from "@/lib/utils"

export function SignedStorageLink({
  path,
  children,
  className,
}: {
  path: string
  children: React.ReactNode
  className?: string
}) {
  const [loading, setLoading] = useState(false)

  async function open() {
    if (loading) return
    const popup = window.open("about:blank", "_blank")
    if (popup) popup.opener = null
    setLoading(true)
    try {
      const { data, error } = await getSupabaseClient()
        .storage.from(UPLOAD_BUCKET)
        .createSignedUrl(path, 300)
      if (error) throw error
      if (popup) popup.location.href = data.signedUrl
      else window.location.assign(data.signedUrl)
    } catch (error) {
      popup?.close()
      toastFromCaughtError(error, "Could not open file")
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => void open()}
      className={cn("disabled:opacity-60", className)}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  )
}
