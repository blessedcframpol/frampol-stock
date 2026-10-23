"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { MapPin, Plus, Trash2 } from "lucide-react"
import type { ClientEntityKind } from "@/lib/client-complete"
import type { ClientSite } from "@/lib/data"
import { cn } from "@/lib/utils"

type Props = {
  idPrefix?: string
  kind: ClientEntityKind
  onKind: (kind: ClientEntityKind) => void
  name: string
  onName: (v: string) => void
  company: string
  onCompany: (v: string) => void
  email: string
  onEmail: (v: string) => void
  phone: string
  onPhone: (v: string) => void
  sites: ClientSite[]
  onSites: (sites: ClientSite[]) => void
  errors?: Record<string, string>
  /** Hide entity picker when editing legacy rows */
  showKindPicker?: boolean
}

export function ClientNc1Fields({
  idPrefix = "client",
  kind,
  onKind,
  name,
  onName,
  company,
  onCompany,
  email,
  onEmail,
  phone,
  onPhone,
  sites,
  onSites,
  errors = {},
  showKindPicker = true,
}: Props) {
  function updateSite(index: number, field: "name" | "address", value: string) {
    onSites(sites.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  return (
    <div className="flex flex-col gap-4">
      {showKindPicker ? (
        <div className="flex flex-col gap-2">
          <Label>Company or individual?</Label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["company", "Company"],
                ["individual", "Individual"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={kind === value ? "default" : "outline"}
                className="min-h-11 sm:min-h-9"
                onClick={() => onKind(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-name`}>{kind === "individual" ? "Full name" : "Contact name"}</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => onName(e.target.value)}
          aria-invalid={Boolean(errors.name)}
          className={cn(errors.name && "border-destructive")}
        />
        {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
      </div>

      {kind === "company" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-company`}>Company name</Label>
          <Input
            id={`${idPrefix}-company`}
            value={company}
            onChange={(e) => onCompany(e.target.value)}
            aria-invalid={Boolean(errors.company)}
            className={cn(errors.company && "border-destructive")}
          />
          {errors.company ? <p className="text-xs text-destructive">{errors.company}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-email`}>Email</Label>
        <Input
          id={`${idPrefix}-email`}
          type="text"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={`${idPrefix}-email-hint`}
          className={cn(errors.email && "border-destructive")}
        />
        <p id={`${idPrefix}-email-hint`} className="text-xs text-muted-foreground">
          Separate multiple emails with ;
        </p>
        {errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-phone`}>Phone</Label>
        <Input
          id={`${idPrefix}-phone`}
          type="tel"
          autoComplete="tel"
          placeholder="077 123 4567"
          value={phone}
          onChange={(e) => onPhone(e.target.value)}
          aria-invalid={Boolean(errors.phone)}
          className={cn(errors.phone && "border-destructive")}
        />
        {errors.phone ? <p className="text-xs text-destructive">{errors.phone}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
            Physical address / site
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onSites([...sites, { address: "" }])}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add site
          </Button>
        </div>
        {errors.sites ? <p className="text-xs text-destructive">{errors.sites}</p> : null}
        <div className="space-y-2">
          {sites.map((site, i) => (
            <div key={i} className="flex gap-2 items-start">
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input
                  placeholder="Site name (optional)"
                  value={site.name ?? ""}
                  onChange={(e) => updateSite(i, "name", e.target.value)}
                  className="h-9"
                />
                <Input
                  placeholder="Full physical address"
                  value={site.address}
                  onChange={(e) => updateSite(i, "address", e.target.value)}
                  aria-invalid={Boolean(errors[`site_${i}`])}
                  className={cn("h-9", errors[`site_${i}`] && "border-destructive")}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onSites(sites.filter((_, j) => j !== i))}
                disabled={sites.length <= 1}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
