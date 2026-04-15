"use client"

import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

/** Internal sentinel; must not collide with real product names. */
const ADD_NEW = "__product_name_picker_add_new__"

export type ProductNamePickerProps = {
  id?: string
  label?: string
  value: string
  onChange: (next: string) => void
  /** Distinct product names from inventory (sorted for display). */
  options: string[]
  disabled?: boolean
  className?: string
  selectTriggerClassName?: string
  /** Placeholder when no catalog product is selected yet. */
  placeholder?: string
}

export function ProductNamePicker({
  id,
  label,
  value,
  onChange,
  options,
  disabled,
  className,
  selectTriggerClassName,
  placeholder = "Select a product…",
}: ProductNamePickerProps) {
  const inCatalog = options.includes(value)
  const [addingNew, setAddingNew] = useState(() => !inCatalog && value !== "")

  useEffect(() => {
    if (options.includes(value)) setAddingNew(false)
  }, [value, options])

  const selectValue: string | undefined = inCatalog ? value : addingNew ? ADD_NEW : undefined

  const showNewNameInput = (!inCatalog && value !== "") || addingNew

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {label ? (
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
      ) : null}
      <Select
        disabled={disabled}
        value={selectValue}
        onValueChange={(v) => {
          if (v === ADD_NEW) {
            setAddingNew(true)
            onChange("")
            return
          }
          setAddingNew(false)
          onChange(v)
        }}
      >
        <SelectTrigger
          id={id}
          className={cn(
            "h-10 w-full max-w-none bg-card border-border text-foreground font-normal shadow-xs",
            selectTriggerClassName
          )}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className="max-h-[min(60vh,320px)]">
          {options.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
          <SelectItem value={ADD_NEW} className="text-primary">
            + Add new product…
          </SelectItem>
        </SelectContent>
      </Select>
      {showNewNameInput ? (
        <Input
          aria-label={label ? `${label} (new name)` : "New product name"}
          className="h-10 bg-card border-border text-foreground"
          placeholder="Enter product name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      ) : null}
    </div>
  )
}
