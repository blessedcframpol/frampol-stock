import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { requireAdmin } from "@/lib/require-admin"
import { isValidRole } from "@/lib/permissions"

/**
 * PATCH profile access via set_user_access as the signed-in admin (not service_role),
 * so audit_log.actor is that admin.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return apiClientError(400, "id required")
    }
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = (await request.json()) as {
      role?: string
      active?: boolean
      display_name?: string
      reason?: string
    }

    if (body.role === undefined || !isValidRole(body.role)) {
      return apiClientError(400, "A valid role is required", {
        log: "warn",
        logLabel: "Admin profile update",
      })
    }
    if (typeof body.active !== "boolean") {
      return apiClientError(400, "active is required", {
        log: "warn",
        logLabel: "Admin profile update",
      })
    }

    const { data, error } = await auth.supabase.rpc("set_user_access", {
      p_profile_id: id,
      p_role: body.role,
      p_active: body.active,
      p_display_name: typeof body.display_name === "string" ? body.display_name : null,
      p_reason: typeof body.reason === "string" ? body.reason : null,
    })

    if (error) {
      const msg = error.message || "Update failed"
      const status =
        /admin only|cannot change your own|insufficient/i.test(msg) ? 403 : 400
      return apiClientError(status, msg, { log: "warn", logLabel: "Admin profile update" })
    }

    return NextResponse.json(data)
  } catch (err) {
    return apiErrorResponse(500, "Internal server error", {
      cause: err,
      logLabel: "Admin profile PATCH",
    })
  }
}
