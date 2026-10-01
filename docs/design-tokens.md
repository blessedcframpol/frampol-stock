# Design tokens

Reference for P2.2, P2.3, and P3. Dark is the default theme (`defaultTheme="dark"`, `enableSystem={false}`). Light is `:root`. The `.dark` class overrides it. Print forces the light values so a future DYMO `@page` rule is not fighting a dark canvas.

Utilities come from `@theme inline` in `app/globals.css`. `bg-brand`, `text-success`, `bg-success-soft`, `bg-stage-blue`, `bg-canvas`, and the rest are real Tailwind classes.

## Surfaces

Page behind the frame is `--canvas`. The app frame (sidebar and main) is `--background`. Cards sit on the frame and are lighter than it, so the tiers separate even when borders are still present. Do not remove card borders in this step; P2.3 does that.

| Token | Utility | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--canvas` | `bg-canvas` | `oklch(0.34 0 0)` | `oklch(0.86 0 0)` | Page behind the frame. `body` uses this. The gutter has to read at 12px. |
| `--background` | `bg-background` | `oklch(0.13 0 0)` | `oklch(0.96 0 0)` | App frame and main. |
| `--foreground` | `text-foreground` | `oklch(0.97 0 0)` | `oklch(0.18 0 0)` | Primary text. |
| `--card` | `bg-card` | `oklch(0.20 0 0)` | `oklch(1 0 0)` | Cards. Lighter than the frame so they read as raised. |
| `--card-foreground` | `text-card-foreground` | `oklch(0.97 0 0)` | `oklch(0.18 0 0)` | Text on a card. |
| `--popover` | `bg-popover` | `oklch(0.20 0 0)` | `oklch(1 0 0)` | Menus and popovers. Same as card. |
| `--popover-foreground` | `text-popover-foreground` | `oklch(0.97 0 0)` | `oklch(0.18 0 0)` | Text on a popover. |
| `--secondary` | `bg-secondary` | `oklch(0.25 0 0)` | `oklch(0.94 0 0)` | Secondary buttons and quiet fills. |
| `--secondary-foreground` | `text-secondary-foreground` | `oklch(0.97 0 0)` | `oklch(0.18 0 0)` | Text on secondary. |
| `--muted` | `bg-muted` | `oklch(0.25 0 0)` | `oklch(0.94 0 0)` | Quiet fills, Dispose / Transfer pills, draft. |
| `--muted-foreground` | `text-muted-foreground` | `oklch(0.72 0 0)` | `oklch(0.40 0 0)` | Helper text and Dispose pill text. Must stay AA on `--card` and on `--muted`. |
| `--accent` | `bg-accent` | `oklch(0.25 0 0)` | `oklch(0.94 0 0)` | Hover fills on ghost controls. Not the periwinkle. |
| `--accent-foreground` | `text-accent-foreground` | `oklch(0.97 0 0)` | `oklch(0.18 0 0)` | Text on accent hover. |
| `--border` | `border-border` | `oklch(0.28 0 0)` | `oklch(0.86 0 0)` | Card and control borders. Keep them until P2.3. |
| `--input` | `border-input` | `oklch(0.28 0 0)` | `oklch(0.86 0 0)` | Input borders. Same as border. |
| `--radius` | `rounded-lg` | `1rem` | `1rem` | Base radius. `sm` / `md` / `xl` derive from it. |

## Primary and brand

Primary is an inverted neutral: white button on dark, near-black button on light. Periwinkle is `--brand`, and it is only for charts, links, and focus.

| Token | Utility | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--primary` | `bg-primary` | `oklch(0.97 0 0)` | `oklch(0.15 0 0)` | Primary buttons, active nav tile, avatar fallback. |
| `--primary-foreground` | `text-primary-foreground` | `oklch(0.13 0 0)` | `oklch(0.99 0 0)` | Label on a primary control. |
| `--brand` | `bg-brand` `text-brand` | `oklch(0.68 0.14 270)` | `oklch(0.45 0.16 270)` | Links, focus borders, rental pills, chart series 1. Light is darker so text on white stays AA. |
| `--brand-foreground` | `text-brand-foreground` | `oklch(0.15 0 0)` | `oklch(0.99 0 0)` | Text on a solid brand fill. |
| `--ring` | `ring-ring` | `var(--brand)` | `var(--brand)` | Focus ring. |

Rental pills use `bg-brand/15 text-brand` (about a 15% tint). There is no `--brand-soft` token.

## Charts

One colour per series. Monthly sales is a single series and uses `--chart-1` only. Do not paint each bar a different hue.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--chart-1` | `oklch(0.68 0.14 270)` (brand) | `oklch(0.45 0.16 270)` (brand) | First series, monthly sales. |
| `--chart-2` | `oklch(0.78 0.12 55)` | `oklch(0.62 0.14 55)` | Orange series. Light is deeper so it reads on white. |
| `--chart-3` | `oklch(0.87 0.12 95)` | `oklch(0.70 0.13 95)` | Yellow series. |
| `--chart-4` | `oklch(0.80 0.14 150)` | `oklch(0.52 0.14 150)` | Green series. |
| `--chart-5` | `oklch(0.68 0.17 25)` | `oklch(0.55 0.17 25)` | Red series. |

In JavaScript, read `var(--chart-1)` … `var(--chart-5)`. Do not wrap them in `hsl()`.

## Stage strips

Pastel strips for later layout work (P2.2). Text on a strip is `--stage-foreground` (near-black) in both themes. Light pastels are slightly deeper than dark.

| Token | Utility | Dark | Light |
| --- | --- | --- | --- |
| `--stage-blue` | `bg-stage-blue` | `oklch(0.78 0.08 250)` | `oklch(0.72 0.09 250)` |
| `--stage-orange` | `bg-stage-orange` | `oklch(0.80 0.10 55)` | `oklch(0.74 0.10 55)` |
| `--stage-yellow` | `bg-stage-yellow` | `oklch(0.88 0.10 95)` | `oklch(0.80 0.11 95)` |
| `--stage-green` | `bg-stage-green` | `oklch(0.82 0.10 150)` | `oklch(0.74 0.10 150)` |
| `--stage-foreground` | `text-stage-foreground` | `oklch(0.18 0 0)` | `oklch(0.18 0 0)` |

## Status

Pills are `bg-*-soft text-*`. Soft fills are about a 15% tint of the status colour. Solid fills (`bg-success text-success-foreground`) are for dots and small counts, not for paragraph text.

| Token | Dark | Light | Meaning |
| --- | --- | --- | --- |
| `--success` | `oklch(0.82 0.13 150)` | `oklch(0.40 0.12 150)` | Sale, Sold, In Stock, Inbound, Inspection Pass. |
| `--success-foreground` | `oklch(0.16 0.02 150)` | `oklch(0.99 0 0)` | Text on a solid success fill. |
| `--success-soft` | `oklch(0.28 0.04 150)` | `oklch(0.94 0.03 150)` | Pill background. |
| `--warning` | `oklch(0.86 0.12 85)` | `oklch(0.42 0.11 70)` | Reversal, Sale Return, Maintenance, RMA Hold, remediation loaner, submitted requests, log warnings. |
| `--warning-foreground` | `oklch(0.20 0.02 85)` | `oklch(0.99 0 0)` | Text on a solid warning fill (header count). |
| `--warning-soft` | `oklch(0.30 0.045 85)` | `oklch(0.95 0.04 90)` | Pill and banner background. |
| `--danger` | `oklch(0.78 0.15 25)` | `oklch(0.45 0.16 25)` | Errors, Inspection Fail, cancelled requests, inactive. Not Sale. |
| `--danger-foreground` | `oklch(0.16 0.02 25)` | `oklch(0.99 0 0)` | Text on a solid danger fill. |
| `--danger-soft` | `oklch(0.28 0.05 25)` | `oklch(0.95 0.025 25)` | Error pill and form-error background. |
| `--info` | `oklch(0.80 0.08 230)` | `oklch(0.42 0.11 250)` | POC, Pending Inspection, Decommissioned, in-progress requests. |
| `--info-foreground` | `oklch(0.16 0.02 230)` | `oklch(0.99 0 0)` | Text on a solid info fill. |
| `--info-soft` | `oklch(0.28 0.035 230)` | `oklch(0.94 0.025 240)` | Pill background. |
| `--destructive` | `oklch(0.52 0.18 25)` | `oklch(0.52 0.18 25)` | Filled destructive button. Dark enough for white text in both themes. |
| `--destructive-foreground` | `oklch(0.99 0 0)` | `oklch(0.99 0 0)` | Label on the destructive button. |

Dispose, Transfer, invoiced, and draft use `bg-muted text-muted-foreground`.

## Sidebar

The rail sits a half-step off the frame, with a hairline `--sidebar-border`.

| Token | Dark | Light |
| --- | --- | --- |
| `--sidebar` | `oklch(0.18 0 0)` | `oklch(0.93 0 0)` |
| `--sidebar-foreground` | `oklch(0.97 0 0)` | `oklch(0.18 0 0)` |
| `--sidebar-primary` | `oklch(0.97 0 0)` | `oklch(0.15 0 0)` |
| `--sidebar-primary-foreground` | `oklch(0.13 0 0)` | `oklch(0.99 0 0)` |
| `--sidebar-accent` | `oklch(0.25 0 0)` | `oklch(0.94 0 0)` |
| `--sidebar-accent-foreground` | `oklch(0.97 0 0)` | `oklch(0.18 0 0)` |
| `--sidebar-border` | `oklch(0.28 0 0)` | `oklch(0.86 0 0)` |
| `--sidebar-ring` | `oklch(0.68 0.14 270)` | `oklch(0.45 0.16 270)` |

## Type

- `--font-sans`: Plus Jakarta Sans (`next/font` variable `--font-plus-jakarta`), then `"Plus Jakarta Sans"`, `ui-sans-serif`, `system-ui`, `sans-serif`.
- `--font-mono`: JetBrains Mono, then `ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`, `Consolas`, `monospace`.

Use mono for serials, IDs, and invoice numbers. Product-name fields and search inputs stay sans.

## What not to hardcode

Do not add Tailwind palette classes (`bg-emerald-500`, `text-red-500`, `bg-slate-500`) or hex fills in `app/` and `components/` outside `components/ui`. Chart series read `--chart-*`.

Left as-is on purpose:

- Microsoft sign-in mark (`#f25022`, `#00a4ef`, `#7fba00`, `#ffb900`) on the login page. Those are the logo, not theme chrome.
- Print `body { background: #fff; color: #000; }` inside `@media print`.
- Viewport `themeColor` `#383838`. The meta tag cannot take a CSS variable. This is dark `--canvas` (`oklch(0.34 0 0)`). The app theme does not follow the OS, so there is one value.
- `components/ui` internals (slider thumb `bg-white`, overlay `bg-black/50`, toast red classes, recharts `#ccc` selectors).

## Contrast

Relative luminance from the oklch values. Every text pair is at least 4.5:1. Status and stage colours did not change in P2.1b; the surface step did, so muted-on-card and brand-on-card were recomputed.

| Pair | Dark | Light |
| --- | --- | --- |
| Muted text on card | 7.30 | 9.21 |
| Muted text on muted (Dispose) | 6.45 | 7.72 |
| Success on success-soft | 8.64 | 7.32 |
| Warning on warning-soft | 8.88 | 7.47 |
| Danger on danger-soft | 6.70 | 6.93 |
| Info on info-soft | 7.89 | 7.12 |
| Brand text on brand/15 (Rental) | 5.10 | 6.07 |
| Stage label on blue | 9.45 | 7.62 |
| Stage label on orange | 9.82 | 7.94 |
| Stage label on yellow | 13.15 | 10.10 |
| Stage label on green | 11.18 | 8.49 |
