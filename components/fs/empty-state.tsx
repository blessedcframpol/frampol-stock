export function EmptyState({
  icon,
  message,
  action,
}: {
  icon?: React.ReactNode
  message: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      {icon ? <div className="text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
      <p className="text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  )
}
