"use client"

import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const INTAKE_REASON_CATEGORIES = ["Client cancelled", "Service termination"] as const
export type IntakeReasonCategory = (typeof INTAKE_REASON_CATEGORIES)[number]

export function IntakeReasonFields({
  category,
  reason,
  onCategory,
  onReason,
}: {
  category: string
  reason: string
  onCategory: (value: string) => void
  onReason: (value: string) => void
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label className="text-foreground">Reason category</Label>
        <Select value={category} onValueChange={onCategory}>
          <SelectTrigger className="bg-card text-foreground border-border">
            <SelectValue placeholder="Select a category..." />
          </SelectTrigger>
          <SelectContent>
            {INTAKE_REASON_CATEGORIES.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label className="text-foreground">Reason</Label>
        <Textarea
          className="bg-card text-foreground border-border min-h-[72px]"
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          placeholder="Typed reason for this return"
        />
      </div>
    </>
  )
}
