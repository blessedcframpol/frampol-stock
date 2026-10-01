import Link from "next/link"
import { cn } from "@/lib/utils"

const stageStrip = {
  blue: "bg-stage-blue",
  orange: "bg-stage-orange",
  yellow: "bg-stage-yellow",
  green: "bg-stage-green",
} as const

export type StageTone = keyof typeof stageStrip

export function StageCard({
  tone,
  label,
  count,
  href,
  onClick,
}: {
  tone: StageTone
  label: string
  count: React.ReactNode
  href?: string
  onClick?: () => void
}) {
  const body = (
    <>
      <div className={cn("px-5 py-2 text-sm font-medium text-stage-foreground", stageStrip[tone])}>{label}</div>
      <div className="bg-card px-5 py-4">
        <p className="text-3xl font-semibold tabular-nums text-card-foreground">{count}</p>
      </div>
    </>
  )
  const className = "block w-full overflow-hidden rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {body}
      </button>
    )
  }
  return <div className={className}>{body}</div>
}
