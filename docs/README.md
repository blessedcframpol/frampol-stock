# Fram Stock documentation

| Document | Purpose |
|----------|---------|
| **[app-features.md](./app-features.md)** | Detailed guide: each feature’s purpose, workflows, UI behaviour, data rules, limits, and how pieces connect. |
| **[inventory-movements-and-rma.md](./inventory-movements-and-rma.md)** | Deep dive: statuses, transaction types, RMA / **Sale Return** flow, DB rules, undo notes. |

Implementation details live next to code (e.g. `lib/supabase/movement-utils.ts`, `lib/permissions.ts`, Supabase migrations under `supabase/migrations/`).

## Keeping docs in sync

When you change behaviour in the app, update documentation in the **same PR or commit** when it would confuse a reader otherwise.

| If you change… | Update… |
|-----------------|--------|
| Screens, flows, permissions, nav, settings, requests, alerts, search, reports | [app-features.md](./app-features.md) (the relevant section(s)) |
| Statuses, movement types, RMA, DB transition rules, undo semantics | [inventory-movements-and-rma.md](./inventory-movements-and-rma.md) |
| Add a new top-level doc | Add a row to the table above and link from here |

Agents and contributors should treat these files as part of the feature, not optional follow-up.
