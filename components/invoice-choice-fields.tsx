"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import {
  invoiceChoiceProblem,
  type InvoiceChoice,
} from "@/lib/invoices"

export function InvoiceChoiceFields({
  idPrefix,
  choice,
  invoiceNumber,
  reason,
  onChoice,
  onInvoiceNumber,
  onReason,
}: {
  idPrefix: string
  choice: InvoiceChoice | ""
  invoiceNumber: string
  reason: string
  onChoice: (choice: InvoiceChoice) => void
  onInvoiceNumber: (value: string) => void
  onReason: (value: string) => void
}) {
  const problem = choice ? invoiceChoiceProblem(choice, invoiceNumber, reason) : null
  return (
    <div className="flex flex-col gap-3">
      <Label>Invoice</Label>
      <RadioGroup
        value={choice}
        onValueChange={(value) => {
          const next = value as InvoiceChoice
          onChoice(next)
          if (next !== "number") onInvoiceNumber("")
          if (next !== "not_invoiced") onReason("")
        }}
        className="gap-2"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-number`} value="number" />
          <Label htmlFor={`${idPrefix}-number`} className="font-normal">Invoice number</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-pending`} value="pending" />
          <Label htmlFor={`${idPrefix}-pending`} className="font-normal">Invoice pending</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-zero`} value="not_invoiced" />
          <Label htmlFor={`${idPrefix}-zero`} className="font-normal">00000 — not invoiced</Label>
        </div>
      </RadioGroup>
      {choice === "number" ? (
        <Input
          id={`${idPrefix}-value`}
          className="font-mono"
          value={invoiceNumber}
          placeholder="Invoice number"
          onChange={(event) => onInvoiceNumber(event.target.value)}
        />
      ) : null}
      {choice === "not_invoiced" ? (
        <Textarea
          id={`${idPrefix}-reason`}
          value={reason}
          placeholder="Reason, at least 15 characters"
          onChange={(event) => onReason(event.target.value)}
        />
      ) : null}
      {problem ? <p className="text-sm text-destructive">{problem}</p> : null}
    </div>
  )
}
