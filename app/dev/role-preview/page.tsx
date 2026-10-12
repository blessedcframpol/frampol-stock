"use client"

import { useRouter } from "next/navigation"
import { DashboardShell } from "@/components/dashboard-shell"
import { PageHeader } from "@/components/page-nav"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/lib/auth-context"
import { devRolePreviewAllowed, useDevRolePreview, useEffectiveRole } from "@/lib/dev-role-preview"
import { ROLES, ROLE_LABELS, type AppRole } from "@/lib/permissions"
import { ROLE_LANDING } from "@/lib/role-pages"

/**
 * Development preview of each role's menu and landing page.
 * Stripped from production builds via scripts/strip-dev-routes.mjs (npm run build).
 */
function RolePreviewContent() {
  const router = useRouter()
  const { role: realRole } = useAuth()
  const effective = useEffectiveRole()
  const { previewRole, setPreviewRole } = useDevRolePreview()

  function open(role: AppRole) {
    setPreviewRole(role)
    router.push(ROLE_LANDING[role])
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <PageHeader
        title="Role preview"
        description="Development only. Changes the menu and pages you see; the database still uses your real role."
      />
      {!devRolePreviewAllowed() ? (
        <p className="text-sm text-muted-foreground">Role preview is only available in development.</p>
      ) : null}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Signed in as {realRole ? ROLE_LABELS[realRole] : "no role"}
            {previewRole ? ` · previewing ${ROLE_LABELS[previewRole]}` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {ROLES.map((role) => (
            <div key={role} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {ROLE_LABELS[role]}
                  {effective === role ? <span className="ml-2 text-xs text-muted-foreground">current</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">Lands on {ROLE_LANDING[role]}</p>
              </div>
              <Button
                type="button"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={!devRolePreviewAllowed()}
                onClick={() => open(role)}
              >
                Open as {ROLE_LABELS[role]}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            className="mt-2 min-h-11 sm:min-h-9"
            disabled={!previewRole}
            onClick={() => {
              setPreviewRole(null)
              router.push(realRole ? ROLE_LANDING[realRole] : "/")
            }}
          >
            Clear preview
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export default function Page() {
  return (
    <DashboardShell>
      <RolePreviewContent />
    </DashboardShell>
  )
}
