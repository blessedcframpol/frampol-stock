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
  Monitor,
  ShieldAlert,
  Clock,
  History,
} from "lucide-react"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useIsMobile } from "@/hooks/use-mobile"
import { useState, useMemo } from "react"
import { clients, appUsers } from "@/lib/data"
import { runSearch } from "@/lib/search"
import { SearchSuggestions } from "@/components/search-suggestions"

const inventoryChildren = [
  { href: "/inventory/dispatched", label: "Dispatched" },
  { href: "/inventory/movement", label: "Inventory movement" },
]

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/search", label: "Search", icon: Search },
  { href: "/inventory", label: "Inventory", icon: Package, children: inventoryChildren },
  { href: "/scan-history", label: "Scan history", icon: History },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/requests", label: "Requests", icon: MessageSquare, badge: 3 },
]

const bottomNavItems = [
  { href: "/settings", label: "Settings", icon: Settings },
]

function SidebarNav({ onNavigate, alertCount = 0 }: { onNavigate?: () => void; alertCount?: number }) {
  const pathname = usePathname()
  const [inventoryExpanded, setInventoryExpanded] = useState(true)

  return (
    <>
      <nav className="flex-1 flex flex-col py-4 px-3 gap-1 overflow-y-auto">
        <span className="text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/40 px-3 mb-2">
          Main Menu
        </span>
        {navItems.map((item) => {
          const hasChildren = "children" in item && item.children && item.children.length > 0
          const isParentActive = item.href === "/inventory" ? pathname.startsWith("/inventory") : pathname === item.href
          const badge = item.href === "/alerts" ? alertCount : item.badge

          if (hasChildren && item.children) {
            const isExpanded = item.href === "/inventory" ? inventoryExpanded : false
            return (
              <div key={item.href} className="flex flex-col gap-0.5">
                <div
                  className={cn(
                    "flex items-center gap-1 rounded-lg text-sm font-medium transition-colors",
                    isParentActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className="flex flex-1 min-w-0 items-center gap-3 px-3 py-2.5 rounded-lg"
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
                      className="p-2 rounded-md hover:bg-sidebar-primary/20 shrink-0"
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
                  <div className="flex flex-col gap-0.5 pl-2 ml-3 border-l border-sidebar-border/60">
                    {item.children.map((child) => {
                      const isChildActive = pathname === child.href
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          onClick={onNavigate}
                          className={cn(
                            "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
                            isChildActive
                              ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground"
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
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isParentActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <item.icon className="w-[18px] h-[18px] shrink-0" />
              <span className="flex-1">{item.label}</span>
              {badge != null && badge > 0 && (
                <Badge className="bg-sidebar-primary/20 text-sidebar-primary-foreground border-0 text-[10px] h-5 min-w-5 flex items-center justify-center">
                  {badge}
                </Badge>
              )}
            </Link>
          )
        })}
      </nav>
      <div className="px-3 pb-4 flex flex-col gap-1 border-t border-sidebar-border pt-4">
        {bottomNavItems.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <item.icon className="w-[18px] h-[18px] shrink-0" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </div>
    </>
  )
}

function ThemeToggle() {
  const { setTheme, theme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
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
        <DropdownMenuItem onClick={() => setTheme("system")} className={cn(theme === "system" && "bg-accent")}>
          <Monitor className="mr-2 h-4 w-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const isMobile = useIsMobile()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const { inventory, getAlerts } = useInventoryStore()

  const searchSuggestions = useMemo(
    () =>
      runSearch(
        { inventory, clients, users: appUsers },
        searchQuery
      ),
    [inventory, searchQuery]
  )

  function handleSearchSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    const q = searchQuery.trim()
    if (q) router.push(`/search?q=${encodeURIComponent(q)}`)
    setMobileSearchOpen(false)
  }
  const alerts = getAlerts()
  const alertCount =
    alerts.lowStock.length + alerts.warrantyExpiring.length + alerts.rentalOverdue.length

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop Sidebar */}
      {!isMobile && (
        <aside
          className={cn(
            "hidden md:flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-all duration-300 shrink-0",
            collapsed ? "w-[68px]" : "w-[260px]"
          )}
        >
          {/* Logo */}
          <div className="flex items-center gap-3 px-5 h-16 border-b border-sidebar-border shrink-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-sidebar-primary">
              <Satellite className="w-4 h-4 text-sidebar-primary-foreground" />
            </div>
            {!collapsed && (
              <span className="text-lg font-semibold tracking-tight text-sidebar-foreground">
                Fram-Stock
              </span>
            )}
          </div>

          {/* Nav */}
          {collapsed ? (
            <>
              <nav className="flex-1 flex flex-col py-4 px-3 gap-1 overflow-y-auto">
                {navItems.map((item) => {
                  const isActive =
                    item.href === "/inventory"
                      ? pathname.startsWith("/inventory")
                      : pathname === item.href
                  const badge = item.href === "/alerts" ? alertCount : item.badge
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      className={cn(
                        "flex items-center justify-center p-2.5 rounded-lg transition-colors relative",
                        isActive
                          ? "bg-sidebar-primary text-sidebar-primary-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      )}
                    >
                      <item.icon className="w-[18px] h-[18px]" />
                      {badge != null && badge > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] flex items-center justify-center font-bold">
                          {badge}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </nav>
              <div className="px-3 pb-4 flex flex-col gap-1 border-t border-sidebar-border pt-4">
                {bottomNavItems.map((item) => {
                  const isActive = pathname === item.href
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      className={cn(
                        "flex items-center justify-center p-2.5 rounded-lg transition-colors",
                        isActive
                          ? "bg-sidebar-primary text-sidebar-primary-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      )}
                    >
                      <item.icon className="w-[18px] h-[18px]" />
                    </Link>
                  )
                })}
                <button
                  onClick={() => setCollapsed(false)}
                  className="flex items-center justify-center p-2.5 rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
                >
                  <ChevronLeft className="w-[18px] h-[18px] rotate-180" />
                </button>
              </div>
            </>
          ) : (
            <>
              <SidebarNav alertCount={alertCount} />
              <div className="px-3 pb-2">
                <button
                  onClick={() => setCollapsed(true)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors w-full"
                >
                  <ChevronLeft className="w-[18px] h-[18px] shrink-0" />
                  <span>Collapse</span>
                </button>
              </div>
            </>
          )}
        </aside>
      )}

      {/* Mobile Sidebar Sheet */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[280px] p-0 bg-sidebar text-sidebar-foreground border-sidebar-border [&>button]:text-sidebar-foreground">
          <SheetHeader className="px-5 h-16 flex-row items-center gap-3 border-b border-sidebar-border space-y-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-sidebar-primary">
              <Satellite className="w-4 h-4 text-sidebar-primary-foreground" />
            </div>
            <SheetTitle className="text-lg font-semibold tracking-tight text-sidebar-foreground">
              Fram-Stock
            </SheetTitle>
          </SheetHeader>
          <SidebarNav onNavigate={() => setMobileOpen(false)} alertCount={alertCount} />
        </SheetContent>
      </Sheet>

      {/* Mobile search sheet */}
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
                placeholder="Search inventory, clients, users..."
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
                onSeeAll={() => setMobileSearchOpen(false)}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <header className="flex items-center justify-between h-14 md:h-16 px-4 md:px-6 border-b border-border bg-card shrink-0 gap-3">
          {/* Left side */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {/* Mobile hamburger */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden text-muted-foreground hover:text-foreground shrink-0"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="w-5 h-5" />
              <span className="sr-only">Open menu</span>
            </Button>

            {/* Search with live suggestions */}
            <Popover open={searchQuery.trim().length >= 1}>
              <PopoverAnchor asChild>
                <form
                  className="relative hidden sm:block w-full max-w-xs lg:max-w-sm"
                  onSubmit={handleSearchSubmit}
                >
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <Input
                    type="search"
                    placeholder="Search inventory, clients, users..."
                    className="pl-9 h-9 bg-secondary border-0 text-foreground placeholder:text-muted-foreground"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="Search"
                    aria-autocomplete="list"
                    aria-expanded={searchQuery.trim().length >= 1}
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
                  onSeeAll={() => setSearchQuery("")}
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {/* Mobile search */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="sm:hidden text-muted-foreground hover:text-foreground"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search className="w-[18px] h-[18px]" />
              <span className="sr-only">Search</span>
            </Button>

            <ThemeToggle />

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground">
                  <Bell className="w-[18px] h-[18px]" />
                  {alertCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-amber-950 text-[10px] font-semibold flex items-center justify-center">
                      {alertCount > 99 ? "99+" : alertCount}
                    </span>
                  )}
                  <span className="sr-only">Notifications</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(100vw-2rem,480px)] p-0 overflow-hidden" sideOffset={8}>
                <div className="flex flex-col max-h-[min(400px,80vh)] min-w-0">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                    <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
                    {alertCount > 0 && (
                      <span className="text-xs text-muted-foreground">{alertCount} alert{alertCount !== 1 ? "s" : ""}</span>
                    )}
                  </div>
                  {alertCount === 0 ? (
                    <>
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground flex-1">
                        No alerts. You're all set.
                      </div>
                      <div className="border-t border-border px-4 py-2 shrink-0">
                        <Button variant="ghost" size="sm" className="w-full justify-center text-foreground" asChild>
                          <Link href="/alerts">View all alerts</Link>
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Tabs defaultValue="all" className="flex flex-col flex-1 min-h-0">
                      <TabsList className="w-full min-w-0 justify-start rounded-none border-b border-border bg-transparent p-0 h-auto gap-0 mx-0 mt-2 shrink-0 overflow-x-auto flex-nowrap [&::-webkit-scrollbar]:h-1 px-2 sm:px-4">
                        <TabsTrigger value="all" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 sm:px-3 py-2 gap-1 shrink-0">
                          All
                          <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                            {alertCount}
                          </Badge>
                        </TabsTrigger>
                        <TabsTrigger value="lowStock" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 sm:px-3 py-2 gap-1 shrink-0">
                          Low stock
                          {alerts.lowStock.length > 0 && (
                            <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                              {alerts.lowStock.length}
                            </Badge>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="warranty" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 sm:px-3 py-2 gap-1 shrink-0">
                          Warranty
                          {alerts.warrantyExpiring.length > 0 && (
                            <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                              {alerts.warrantyExpiring.length}
                            </Badge>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="rental" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 sm:px-3 py-2 gap-1 shrink-0">
                          Rental
                          {alerts.rentalOverdue.length > 0 && (
                            <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                              {alerts.rentalOverdue.length}
                            </Badge>
                          )}
                        </TabsTrigger>
                      </TabsList>
                      <div className="overflow-y-auto flex-1 min-h-0 py-2">
                        <TabsContent value="all" className="mt-0 flex flex-col gap-2">
                          {alerts.lowStock.length > 0 && (
                            <div className="px-4 py-1">
                              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-1">
                                <Package className="w-3.5 h-3.5" />
                                Low stock
                              </p>
                              <ul className="space-y-0.5">
                                {alerts.lowStock.slice(0, 4).map((a) => (
                                  <li key={a.groupName} className="text-sm text-foreground py-1.5 px-2 rounded-md hover:bg-muted/50">
                                    <span className="font-medium truncate block">{a.groupName}</span>
                                    <span className="text-xs text-muted-foreground">{a.inStock} in stock (≤{a.threshold})</span>
                                  </li>
                                ))}
                                {alerts.lowStock.length > 4 && (
                                  <li className="text-xs text-muted-foreground px-2 py-1">+{alerts.lowStock.length - 4} more</li>
                                )}
                              </ul>
                            </div>
                          )}
                          {alerts.warrantyExpiring.length > 0 && (
                            <div className="px-4 py-1">
                              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-1">
                                <ShieldAlert className="w-3.5 h-3.5" />
                                Warranty expiring
                              </p>
                              <ul className="space-y-0.5">
                                {alerts.warrantyExpiring.slice(0, 3).map((item) => (
                                  <li key={item.id} className="text-sm text-foreground py-1.5 px-2 rounded-md hover:bg-muted/50 font-mono text-xs">
                                    {item.serialNumber} <span className="text-muted-foreground font-sans">· {formatDateDDMMYYYY(item.warrantyEndDate)}</span>
                                  </li>
                                ))}
                                {alerts.warrantyExpiring.length > 3 && (
                                  <li className="text-xs text-muted-foreground px-2 py-1">+{alerts.warrantyExpiring.length - 3} more</li>
                                )}
                              </ul>
                            </div>
                          )}
                          {alerts.rentalOverdue.length > 0 && (
                            <div className="px-4 py-1">
                              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-1">
                                <Clock className="w-3.5 h-3.5" />
                                Rental past return date
                              </p>
                              <ul className="space-y-0.5">
                                {alerts.rentalOverdue.slice(0, 3).map((item) => (
                                  <li key={item.id} className="text-sm text-foreground py-1.5 px-2 rounded-md hover:bg-muted/50 font-mono text-xs">
                                    {item.serialNumber} <span className="text-muted-foreground font-sans">· {item.assignedTo ?? "—"}</span>
                                  </li>
                                ))}
                                {alerts.rentalOverdue.length > 3 && (
                                  <li className="text-xs text-muted-foreground px-2 py-1">+{alerts.rentalOverdue.length - 3} more</li>
                                )}
                              </ul>
                            </div>
                          )}
                        </TabsContent>
                        <TabsContent value="lowStock" className="mt-0">
                          <ul className="space-y-0.5 px-4">
                            {alerts.lowStock.map((a) => (
                              <li key={a.groupName} className="text-sm text-foreground py-2 px-2 rounded-md hover:bg-muted/50 border-b border-border/50 last:border-0">
                                <span className="font-medium truncate block">{a.groupName}</span>
                                <span className="text-xs text-muted-foreground">{a.inStock} in stock (≤{a.threshold})</span>
                              </li>
                            ))}
                          </ul>
                        </TabsContent>
                        <TabsContent value="warranty" className="mt-0">
                          <ul className="space-y-0.5 px-4">
                            {alerts.warrantyExpiring.map((item) => (
                              <li key={item.id} className="text-sm text-foreground py-2 px-2 rounded-md hover:bg-muted/50 font-mono text-xs border-b border-border/50 last:border-0">
                                {item.serialNumber} <span className="text-muted-foreground font-sans">· {formatDateDDMMYYYY(item.warrantyEndDate)}</span>
                              </li>
                            ))}
                          </ul>
                        </TabsContent>
                        <TabsContent value="rental" className="mt-0">
                          <ul className="space-y-0.5 px-4">
                            {alerts.rentalOverdue.map((item) => (
                              <li key={item.id} className="text-sm text-foreground py-2 px-2 rounded-md hover:bg-muted/50 font-mono text-xs border-b border-border/50 last:border-0">
                                {item.serialNumber} <span className="text-muted-foreground font-sans">· {item.assignedTo ?? "—"}</span>
                              </li>
                            ))}
                          </ul>
                        </TabsContent>
                      </div>
                      <div className="border-t border-border px-4 py-2 shrink-0">
                        <Button variant="ghost" size="sm" className="w-full justify-center text-foreground" asChild>
                          <Link href="/alerts">View all alerts</Link>
                        </Button>
                      </div>
                    </Tabs>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <div className="flex items-center gap-2 sm:gap-3 ml-1 sm:ml-2">
              <Avatar className="w-8 h-8">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                  EM
                </AvatarFallback>
              </Avatar>
              <div className="hidden lg:block">
                <p className="text-sm font-medium text-foreground leading-none">Eric Mugabo</p>
                <p className="text-xs text-muted-foreground mt-0.5">Admin</p>
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 md:p-6 bg-background min-w-0">
          {children}
        </main>
      </div>
    </div>
  )
}
