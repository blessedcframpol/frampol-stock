import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** POC Return has no default. The caller keeps the choice empty until the user picks. */
export function ReturnPoolChoice({
  value,
  onChange,
}: {
  value: "sale" | "demo" | ""
  onChange: (value: "sale" | "demo") => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-foreground">When this kit is back</Label>
      <Select value={value || undefined} onValueChange={(next) => onChange(next as "sale" | "demo")}>
        <SelectTrigger className="bg-card text-foreground border-border">
          <SelectValue placeholder="Choose a group" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sale">Back in sellable stock</SelectItem>
          <SelectItem value="demo">Demo unit, not for sale</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">Required. A demo kit is not available for sale.</p>
    </div>
  )
}
