/** Shared Recharts defaults. Series colours stay on --chart-* at the call site. */

export const chartBarRadius: [number, number, number, number] = [8, 8, 0, 0]

export const chartAxisTick = {
  fill: "var(--muted-foreground)",
  fontSize: 11,
} as const

export const chartGridProps = {
  vertical: false,
  stroke: "var(--border)",
  strokeOpacity: 0.35,
  strokeDasharray: "3 3",
} as const

export const chartTooltipStyle = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  fontSize: 11,
} as const
