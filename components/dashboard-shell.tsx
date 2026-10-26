"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useInventoryStore } from "@/lib/inventory-store"
import { useTheme } from "next-themes"
import {
  LayoutDashboard,
  Package,
  Users,
  BarChart3,
  MessageSquare,
  Settings,
  Satellite,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  Bell,
  Menu,
  Moon,
  Sun,
  History,
  FileText,
  Loader2,
  LogOut,
  ScrollText,
  UsersRound,
  Volume2,
  VolumeX,
  MessageSquareWarning,
  Boxes,
  BellRing,
  FilePlus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from "@/components/ui/popover"
import { useIsClient } from "@/hooks/use-is-client"
import { useIsMobile } from "@/hooks/use-mobile"
import { useState, useMemo, useEffect } from "react"
import { useAuth } from "@/lib/auth-context"
import { useDevRolePreview, useEffectiveRole } from "@/lib/dev-role-preview"
import {
  roleCanAccessPath,
  roleMenuItems,
  roleRedirectForPath,
  roleSearchEntities,
  roleSearchPlaceholder,
} from "@/lib/role-pages"
import {
  canAccessReports,
  canAccessRequests,
  canViewInvoices,
  canAccessSettings,
  canEditInventory,
  canRecordStockMovement,
  canViewUsers,
  canViewAppLogs,
  canManageProblemReports,
  canReportProblem,
  problemReportsLiveUnderRequests,
  isValidRole,
  ROLE_LABELS,
  type AppRole,
} from "@/lib/permissions"
import { useInboxNotifications } from "@/hooks/use-inbox-notifications"
import { useAlertFeed } from "@/hooks/use-alert-feed"
import { notificationHref } from "@/lib/notifications-live"
import { useClients } from "@/lib/clients-store"
import { useSearchUsers } from "@/lib/supabase/search-users"
import { runSearch } from "@/lib/search"
import { SearchSuggestions } from "@/components/search-suggestions"
import { PageBreadcrumbProvider, PageBreadcrumbSlot } from "@/components/page-breadcrumbs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useOrgTimezone } from "@/hooks/use-org-timezone"

const inventoryChildren = [
  { href: "/inventory/dispatched", label: "Dispatched" },
  { href: "/inventory/inspections", label: "Inspections" },
  { href: "/inventory/movement", label: "Inventory movement", movementOnly: true as const },
  { href: "/inventory/remediation", label: "Remediation" },
  { href: "/inventory/stock-take", label: "Stock take", adminOnly: true as const },
  { href: "/inventory/trash", label: "Trash", adminOnly: true as const },
]

type NavChild = {
  href: string
  label: string
  adminOnly?: boolean
  /** Shown only to roles that can record stock movements (admin). */
  movementOnly?: boolean
}
type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  children?: NavChild[]
  badge?: number
}

type NavIcon = React.ComponentType<{ className?: string }>

/** Icon per menu destination (labels come from lib/role-pages.ts). */
const NAV_ICONS: Record<string, NavIcon> = {
  "/": LayoutDashboard,
  "/search": Search,
  "/inventory": Package,
  "/transaction-history": History,
  "/invoices": FileText,
  "/alerts": Bell,
  "/clients": Users,
  "/requests": MessageSquare,
  "/requests/new": FilePlus,
  "/reports": BarChart3,
  "/stock": Boxes,
  "/notifications": BellRing,
  "/problems/new": MessageSquareWarning,
}

/** Main nav for a role, built from the single role → pages map. */
function buildNavItems(
  role: string | null | undefined,
  notificationBadge = 0,
  alertBadge = 0,
): NavItem[] {
  const r = role as AppRole | null | undefined
  return roleMenuItems(r).map((entry) => ({
    href: entry.href,
    label: entry.label,
    icon: NAV_ICONS[entry.href] ?? MessageSquare,
    badge:
      entry.href === "/notifications"
        ? notificationBadge
        : entry.href === "/alerts"
          ? alertBadge
          : undefined,
    children: entry.href === "/inventory" ? inventoryChildren : undefined,
  }))
}

/** Active when this is the most specific menu entry matching the path. */
function isNavActive(pathname: string, href: string, allHrefs: string[]): boolean {
  if (href === "/") return pathname === "/"
  if (pathname === href) return true
  if (!pathname.startsWith(`${href}/`)) return false
  return !allHrefs.some(
    (other) =>
      other !== href &&
      other.length > href.length &&
      (pathname === other || pathname.startsWith(`${other}/`))
  )
}

type BottomNavEntry = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  adminOnly?: boolean
}

const bottomNavItems: BottomNavEntry[] = [
  { href: "/users", label: "User management", icon: UsersRound, adminOnly: true },
  { href: "/problems", label: "Reported problems", icon: MessageSquareWarning, adminOnly: true },
  { href: "/logs", label: "Error logs", icon: ScrollText, adminOnly: true },
  { href: "/settings", label: "Settings", icon: Settings },
]

function filterBottomNavForRole(role: string | null | undefined): BottomNavEntry[] {
  const r = role as AppRole | null | undefined
  return bottomNavItems.filter((item) => {
    if (item.href === "/settings") return canAccessSettings(r)
    if (!item.adminOnly) return true
    if (item.href === "/users") return canViewUsers(r)
    if (item.href === "/problems") return canManageProblemReports(r)
    return canViewAppLogs(r)
  })
}

const railTileClass =
  "relative flex size-10 shrink-0 items-center justify-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"

const labeledNavClass =
  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"

function navTone(active: boolean) {
  return active
    ? "bg-primary text-primary-foreground"
    : "text-muted-foreground hover:bg-accent hover:text-foreground"
}

function formatHeaderToday(timeZone: string, now = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(now)
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric" }).format(now)
  const month = new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(now)
  return `Today, ${weekday} ${day} ${month}`
}

function initialsFromDisplayName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const first = parts[0]?.[0] ?? ""
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : ""
  return `${first}${last}`.toUpperCase() || "?"
}

function RailCount({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none",
        active ? "bg-background text-foreground" : "bg-primary text-primary-foreground"
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

function filterNavByRole(items: NavItem[], role: string | null | undefined): NavItem[] {
  const r = role as AppRole | null | undefined
  return items
    .filter((item) => {
      if (item.href === "/reports") return canAccessReports(r)
      if (item.href === "/invoices") return canViewInvoices(r)
      if (item.href === "/requests") return canAccessRequests(r)
      return true
    })
    .map((item) => {
      if (item.href === "/inventory" && item.children?.length) {
        return {
          ...item,
          children: item.children.filter(
            (c) =>
              (!c.adminOnly || canEditInventory(r)) &&
              (!c.movementOnly || canRecordStockMovement(r))
          ),
        }
      }
      return item
    })
}

function SidebarNav({
  onNavigate,
  navItems,
  onSignOut,
}: {
  onNavigate?: () => void
  navItems: NavItem[]
  onSignOut: () => void
}) {
  const pathname = usePathname()
  const role = useEffectiveRole()
  const bottomFiltered = useMemo(() => filterBottomNavForRole(role), [role])
  const [inventoryExpanded, setInventoryExpanded] = useState(true)
  const navHrefs = useMemo(() => navItems.map((n) => n.href), [navItems])

  return (
    <>
      <nav className="flex-1 flex flex-col py-5 px-4 gap-1 overflow-y-auto">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3 block px-0.5">
          Main Menu
        </span>
        {navItems.map((item) => {
          const hasChildren = "children" in item && item.children && item.children.length > 0
          const isParentActive = isNavActive(pathname, item.href, navHrefs)
          const badge = item.badge

          if (hasChildren && item.children) {
            const isExpanded = item.href === "/inventory" ? inventoryExpanded : false
            return (
              <div key={item.href} className="flex flex-col gap-0.5">
                <div
                  className={cn(
                    "flex items-center gap-1 rounded-xl text-sm font-medium transition-colors",
                    navTone(isParentActive)
                  )}
                >
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <item.icon className="w-[18px] h-[18px] shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                  </Link>
                  {item.href === "/inventory" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        setInventoryExpanded((v) => !v)
                      }}
                      className="mr-0.5 shrink-0 rounded-md p-2 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 opacity-70" />
                      ) : (
                        <ChevronRight className="w-4 h-4 opacity-70" />
                      )}
                    </button>
                  )}
                </div>
                {item.href === "/inventory" && isExpanded && (
                  <div className="flex flex-col gap-0.5 mt-0.5 ml-2 pl-4 border-l-2 border-sidebar-border/50">
                    {item.children.map((child) => {
                      const isChildActive =
                        pathname === child.href || pathname.startsWith(`${child.href}/`)
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          onClick={onNavigate}
                          className={cn(
                            "flex items-center gap-2 rounded-xl py-2 pl-3 pr-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            isChildActive
                              ? "bg-accent font-medium text-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          )}
                        >
                          <span className="flex-1">{child.label}</span>
                        </Link>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(labeledNavClass, navTone(isParentActive))}
            >
              <item.icon className="w-[18px] h-[18px] shrink-0 ml-0.5" />
              <span className="flex-1 pr-1">{item.label}</span>
              {badge != null && badge > 0 && (
                <Badge className="flex h-5 min-w-5 items-center justify-center border-0 bg-background/80 text-[10px] text-foreground">
                  {badge}
                </Badge>
              )}
            </Link>
          )
        })}
      </nav>
      <div className="px-4 pb-5 flex flex-col gap-1 border-t border-sidebar-border pt-4">
        {bottomFiltered.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(labeledNavClass, navTone(isActive))}
            >
              <item.icon className="w-[18px] h-[18px] shrink-0 ml-0.5" />
              <span className="pr-1">{item.label}</span>
            </Link>
          )
        })}
        <button
          type="button"
          onClick={onSignOut}
          className={cn(labeledNavClass, "text-muted-foreground hover:bg-accent hover:text-foreground")}
        >
          <LogOut className="ml-0.5 h-[18px] w-[18px] shrink-0" />
          <span>Sign out</span>
        </button>
      </div>
    </>
  )
}

function RailIconLink({
  href,
  label,
  active,
  badge = 0,
  icon: Icon,
  onNavigate,
}: {
  href: string
  label: string
  active: boolean
  badge?: number
  icon: React.ComponentType<{ className?: string }>
  onNavigate?: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          onClick={onNavigate}
          className={cn(railTileClass, navTone(active))}
        >
          <Icon className="size-[18px]" />
          <RailCount count={badge} active={active} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function InventoryRailItem({
  item,
  active,
  pathname,
}: {
  item: NavItem
  active: boolean
  pathname: string
}) {
  const [open, setOpen] = useState(false)
  const children = item.children ?? []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={item.label}
              className={cn(railTileClass, navTone(active))}
            >
              <item.icon className="size-[18px]" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-56 p-1.5"
      >
        <div className="flex flex-col gap-0.5">
          <Link
            href={item.href}
            onClick={() => setOpen(false)}
            className={cn(
              "rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
              pathname === item.href
                ? "bg-accent font-medium text-foreground"
                : "text-foreground hover:bg-accent"
            )}
          >
            {item.label}
          </Link>
          {children.map((child) => {
            const childActive = pathname === child.href || pathname.startsWith(`${child.href}/`)
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  childActive
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {child.label}
              </Link>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ThemeToggle() {
  const { setTheme, theme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-10 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
          <Sun className="h-[18px] w-[18px] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-[18px] w-[18px] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")} className={cn(theme === "light" && "bg-accent")}>
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")} className={cn(theme === "dark" && "bg-accent")}>
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const isMobile = useIsMobile()
  const [collapsed, setCollapsed] = useState(true)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const { user, profile, signOut, loading, refetch } = useAuth()
  const role = useEffectiveRole()
  const { previewRole } = useDevRolePreview()
  const { feed } = useAlertFeed()
  const users = useSearchUsers()
  const mounted = useIsClient()
  const searchEntities = useMemo(() => roleSearchEntities(role), [role])
  const searchPlaceholder = roleSearchPlaceholder(role)
  const showGlobalSearch = searchEntities.length > 0
  // Start the shared directory as soon as we know the user is signed in, even
  // before role/searchEntities resolve — waiting on role delayed the first
  // clients request ~250–350ms vs main's ungated useClients(). Roles that never
  // search clients still skip once role is known (enabled becomes false).
  const { clients } = useClients({
    enabled: role == null || searchEntities.includes("clients"),
  })
  // Ledger only when the header search needs inventory matches (not on every page).
  const ledgerForSearch =
    searchQuery.trim().length > 0 && searchEntities.includes("inventory")
  const { inventory } = useInventoryStore({ enabled: ledgerForSearch })

  const blockReason: "inactive" | "no-role" | null =
    user && profile && !profile.active
      ? "inactive"
      : user && profile?.active && profile.role === null
        ? "no-role"
        : null

  useEffect(() => {
    if (loading) return
    if (!user) {
      const next = pathname.startsWith("/login") ? "/" : pathname || "/"
      router.replace(`/login?redirectTo=${encodeURIComponent(next)}`)
      return
    }
    if (user && profile && blockReason) {
      router.replace(`/pending-role?reason=${blockReason}`)
    }
  }, [loading, user, profile, blockReason, pathname, router])

  const {
    unread: inboxUnread,
    count: inboxCount,
    loading: inboxLoading,
    markRead: markInboxRead,
    muted: notificationsMuted,
    setMuted: setNotificationsMuted,
  } = useInboxNotifications()
  const alertCounts = feed?.counts
  const totalAlertCount = alertCounts?.all ?? 0
  const alertCount = mounted && !previewRole ? totalAlertCount : 0
  // Preview cannot load another role's inbox/alerts from the DB — hide badges while previewing.
  const navBadgeShown = mounted && !previewRole ? inboxCount : 0
  const alertNavBadge = alertCount
  const filteredNavItems = useMemo(
    () => filterNavByRole(buildNavItems(role, navBadgeShown, alertNavBadge), role),
    [role, navBadgeShown, alertNavBadge]
  )
  const navHrefs = useMemo(() => filteredNavItems.map((n) => n.href), [filteredNavItems])

  // Send a role that opened a page outside its menu to its landing page.
  // /dev/* preview routes are exempt (they are stripped from production builds).
  const roleRedirect =
    !loading && user && profile && !blockReason && role && !pathname.startsWith("/dev/")
      ? roleRedirectForPath(role, pathname)
      : null
  useEffect(() => {
    if (roleRedirect) router.replace(roleRedirect)
  }, [roleRedirect, router])
  const bottomNavFiltered = useMemo(() => filterBottomNavForRole(role), [role])
  const timeZone = useOrgTimezone()
  const headerToday = mounted ? formatHeaderToday(timeZone) : "Today"
  const displayName = profile?.display_name || user?.email?.split("@")[0] || "User"
  const initials = initialsFromDisplayName(displayName)
  const roleLabel = role ? (isValidRole(role) ? ROLE_LABELS[role] : role) : ""

  const searchSuggestions = useMemo(
    () =>
      runSearch(
        { inventory, clients, users },
        searchQuery,
        searchEntities
      ),
    [inventory, clients, users, searchQuery, searchEntities]
  )

  const searchSeeAllHref = useMemo(() => {
    const q = searchQuery.trim()
    if (!q) return null
    if (roleCanAccessPath(role, "/search")) return `/search?q=${encodeURIComponent(q)}`
    if (searchEntities.includes("products")) return `/stock?q=${encodeURIComponent(q)}`
    return null
  }, [searchQuery, role, searchEntities])

  function handleSearchSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (searchSeeAllHref) router.push(searchSeeAllHref)
    setMobileSearchOpen(false)
  }
  const headerBellCount = mounted && !previewRole ? inboxCount : 0
  const showSettings = canAccessSettings(role)

  async function handleSignOut() {
    await signOut()
    router.push("/login")
    router.refresh()
  }

  const authGateSpinner = (
    <div className="flex h-screen items-center justify-center bg-background">
      <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
      <span className="sr-only">Loading…</span>
    </div>
  )

  if (loading) return authGateSpinner
  if (!user) return authGateSpinner
  if (user && !profile) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-4">
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          We couldn&apos;t load your account profile. Try again, or contact your administrator if this keeps happening.
        </p>
        <Button type="button" variant="secondary" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  if (blockReason) return authGateSpinner
  if (roleRedirect) return authGateSpinner

  return (
    <PageBreadcrumbProvider>
    <div className="box-border flex h-dvh w-full overflow-hidden bg-canvas p-0 md:p-3">
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded-full focus-visible:bg-primary focus-visible:px-4 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-primary-foreground"
      >
        Skip to content
      </a>
      <div className="flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background md:rounded-3xl">
      {!isMobile && (
        <aside
          className={cn(
            "hidden h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-300 md:flex",
            collapsed ? "w-[72px]" : "w-[272px]"
          )}
        >
          <div className={cn("flex shrink-0 items-center gap-2 px-3 pt-4", collapsed ? "flex-col" : "h-16 flex-row px-4 pt-3")}>
            <Link
              href="/"
              aria-label="Fram-Stock"
              className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Satellite className="size-4" />
            </Link>
            {!collapsed ? (
              <span className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-foreground">
                Fram-Stock
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-4" />}
            </button>
          </div>

          {collapsed ? (
            <>
              <nav className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-4" aria-label="Main">
                {filteredNavItems.map((item) => {
                  const isActive = isNavActive(pathname, item.href, navHrefs)
                  const badge = item.badge ?? 0
                  if (item.children && item.children.length > 0) {
                    return (
                      <InventoryRailItem
                        key={item.href}
                        item={item}
                        active={isActive}
                        pathname={pathname}
                      />
                    )
                  }
                  return (
                    <RailIconLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      active={isActive}
                      badge={badge}
                      icon={item.icon}
                    />
                  )
                })}
              </nav>
              <div className="flex flex-col items-center gap-1 px-2 pb-4">
                {bottomNavFiltered.map((item) => (
                  <RailIconLink
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    active={pathname === item.href}
                    icon={item.icon}
                  />
                ))}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Sign out"
                      onClick={() => void handleSignOut()}
                      className={cn(railTileClass, "rounded-full text-muted-foreground hover:bg-accent hover:text-foreground")}
                    >
                      <LogOut className="size-[18px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Sign out</TooltipContent>
                </Tooltip>
              </div>
            </>
          ) : (
            <SidebarNav
              navItems={filteredNavItems}
              onSignOut={() => void handleSignOut()}
            />
          )}
        </aside>
      )}

      {/* Mobile Sidebar Sheet */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[min(100vw-2rem,300px)] border-border bg-background p-0 text-foreground [&>button]:text-foreground">
          <SheetHeader className="h-16 flex-row items-center gap-3 space-y-0 px-4">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary">
              <Satellite className="size-4 text-primary-foreground" />
            </div>
            <SheetTitle className="text-lg font-semibold tracking-tight text-foreground">
              Fram-Stock
            </SheetTitle>
          </SheetHeader>
          <SidebarNav
            onNavigate={() => setMobileOpen(false)}
            navItems={filteredNavItems}
            onSignOut={() => {
              setMobileOpen(false)
              void handleSignOut()
            }}
          />
        </SheetContent>
      </Sheet>

      {/* Mobile search sheet */}
      {showGlobalSearch ? (
        <Sheet open={mobileSearchOpen} onOpenChange={setMobileSearchOpen}>
          <SheetContent side="top" className="pt-6 flex flex-col">
            <SheetHeader>
              <SheetTitle className="sr-only">Search</SheetTitle>
            </SheetHeader>
            <form onSubmit={handleSearchSubmit} className="flex gap-2 pt-2 shrink-0">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder={searchPlaceholder ?? "Search…"}
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                  aria-label="Search"
                />
              </div>
              <Button type="submit">Search</Button>
            </form>
            <p className="text-xs text-muted-foreground mt-2 shrink-0">Press Enter to see all results</p>
            {searchQuery.trim().length >= 1 && (
              <div className="mt-4 flex-1 min-h-0 overflow-auto border-t border-border pt-4">
                <SearchSuggestions
                  query={searchQuery}
                  results={searchSuggestions}
                  compact
                  seeAllHref={searchSeeAllHref}
                  onSeeAll={() => setMobileSearchOpen(false)}
                />
              </div>
            )}
          </SheetContent>
        </Sheet>
      ) : null}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <header className="flex h-16 shrink-0 items-center gap-3 px-4 md:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="w-5 h-5" />
              <span className="sr-only">Open menu</span>
            </Button>

            {showGlobalSearch ? (
              <Popover open={searchQuery.trim().length >= 1}>
                <PopoverAnchor asChild>
                  <form
                    className="relative hidden w-full max-w-xs md:block lg:max-w-sm"
                    onSubmit={handleSearchSubmit}
                  >
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type="search"
                      placeholder={searchPlaceholder ?? "Search…"}
                      className="h-10 rounded-full border-0 bg-card pl-10 text-foreground shadow-none placeholder:text-muted-foreground"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      aria-label="Search"
                    />
                  </form>
                </PopoverAnchor>
                <PopoverContent
                  className="min-w-[280px] w-[min(24rem,90vw)] max-w-[400px] p-2"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <SearchSuggestions
                    query={searchQuery}
                    results={searchSuggestions}
                    seeAllHref={searchSeeAllHref}
                    onSeeAll={() => setSearchQuery("")}
                  />
                </PopoverContent>
              </Popover>
            ) : null}
          </div>

          <p className="hidden shrink-0 text-sm text-muted-foreground xl:block">{headerToday}</p>

          <div className="flex shrink-0 items-center gap-2">
            {showGlobalSearch ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
                onClick={() => setMobileSearchOpen(true)}
              >
                <Search className="w-[18px] h-[18px]" />
                <span className="sr-only">Search</span>
              </Button>
            ) : null}

            <ThemeToggle />

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="relative size-10 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
                  <Bell className="w-[18px] h-[18px]" />
                  {headerBellCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-warning text-warning-foreground text-[9px] font-semibold flex items-center justify-center ring-2 ring-background">
                      {headerBellCount > 99 ? "99+" : headerBellCount}
                    </span>
                  )}
                  <span className="sr-only">Notifications</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(100vw-2rem,400px)] p-0 overflow-hidden" sideOffset={8}>
                <div className="flex flex-col max-h-[min(420px,80vh)] min-w-0">
                  <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border shrink-0">
                    <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
                    <div className="flex items-center gap-1">
                      {inboxCount > 0 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => void markInboxRead(inboxUnread.map((n) => n.id))}
                        >
                          Mark all read
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        aria-pressed={notificationsMuted}
                        aria-label={notificationsMuted ? "Unmute notification sound" : "Mute notification sound"}
                        title={notificationsMuted ? "Notification sound is off" : "Notification sound is on"}
                        onClick={() => setNotificationsMuted(!notificationsMuted)}
                      >
                        {notificationsMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                      </Button>
                    </div>
                  </div>
                  <div className="overflow-y-auto flex-1 min-h-0 py-1">
                    {inboxLoading ? (
                      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Loading…
                      </div>
                    ) : inboxUnread.length === 0 ? (
                      <p className="px-4 py-10 text-center text-sm text-muted-foreground">No unread notifications.</p>
                    ) : (
                      <ul className="px-1">
                        {inboxUnread.slice(0, 12).map((n) => (
                          <li key={n.id}>
                            <Link
                              href={notificationHref(n)}
                              className="flex min-h-11 flex-col gap-0.5 rounded-md px-3 py-2.5 text-sm hover:bg-muted/80"
                              onClick={() => void markInboxRead([n.id])}
                            >
                              <span className="flex items-start gap-2 font-medium text-foreground">
                                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" aria-hidden />
                                {n.title}
                              </span>
                              {n.body ? <span className="pl-4 text-xs text-muted-foreground">{n.body}</span> : null}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="border-t border-border px-4 py-2 shrink-0">
                    <Button variant="ghost" size="sm" className="w-full justify-center text-foreground" asChild>
                      <Link href="/notifications">View all notifications</Link>
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {showSettings ? (
              <Button variant="ghost" size="icon" className="size-10 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" asChild>
                <Link href="/settings" aria-label="Settings">
                  <Settings className="size-[18px]" />
                </Link>
              </Button>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={roleLabel ? `${displayName}, ${roleLabel}` : displayName}
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Avatar className="size-10">
                    <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium text-foreground">{displayName}</p>
                  {roleLabel ? <p className="text-xs text-muted-foreground">{roleLabel}</p> : null}
                </div>
                {canReportProblem(role) ? (
                  <DropdownMenuItem asChild>
                    <Link href={`/problems/new?from=${encodeURIComponent(pathname || "/")}`}>
                      Report a problem
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {canReportProblem(role) && !problemReportsLiveUnderRequests(role) ? (
                  <DropdownMenuItem asChild>
                    <Link href="/problems/mine">My reported problems</Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onClick={() => void handleSignOut()}>
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <PageBreadcrumbSlot />

        <main id="main-content" tabIndex={-1} className="relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background p-3 outline-none sm:p-4 md:p-6">
          {children}
        </main>
      </div>
      </div>
    </div>
    </PageBreadcrumbProvider>
  )
}
