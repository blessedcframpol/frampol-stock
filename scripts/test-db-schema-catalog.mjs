/**
 * Schema-only catalog dump for comparing production vs test (no pg_dump required).
 * Emits a stable, sorted text representation of public (+ key auth/storage) objects.
 */
export async function dumpSchemaCatalog(db) {
  const lines = []

  const extensions = await db.query(`
    SELECT extname, extversion
    FROM pg_extension
    WHERE extname NOT IN ('plpgsql')
    ORDER BY 1
  `)
  for (const row of extensions.rows) {
    lines.push(`EXT ${row.extname} ${row.extversion}`)
  }

  const enums = await db.query(`
    SELECT n.nspname AS schema, t.typname AS name,
           string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'auth')
    GROUP BY 1, 2
    ORDER BY 1, 2
  `)
  for (const row of enums.rows) {
    lines.push(`ENUM ${row.schema}.${row.name} ${row.labels}`)
  }

  const tables = await db.query(`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema IN ('public')
    ORDER BY 1, 2
  `)
  for (const row of tables.rows) {
    lines.push(`TABLE ${row.table_schema}.${row.table_name} ${row.table_type}`)
  }

  const columns = await db.query(`
    SELECT table_schema, table_name, column_name, ordinal_position,
           data_type, udt_name, is_nullable, column_default,
           character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY 1, 2, 4
  `)
  for (const row of columns.rows) {
    lines.push(
      [
        "COL",
        `${row.table_schema}.${row.table_name}.${row.column_name}`,
        row.udt_name || row.data_type,
        row.is_nullable,
        row.character_maximum_length ?? "",
        row.numeric_precision ?? "",
        row.numeric_scale ?? "",
        normalizeDefault(row.column_default),
      ].join("\t"),
    )
  }

  const constraints = await db.query(`
    SELECT n.nspname AS schema, c.relname AS table_name, con.conname,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY 1, 2, 3
  `)
  for (const row of constraints.rows) {
    lines.push(`CON ${row.schema}.${row.table_name}.${row.conname} ${compact(row.def)}`)
  }

  const indexes = await db.query(`
    SELECT schemaname, tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY 1, 2, 3
  `)
  for (const row of indexes.rows) {
    lines.push(`IDX ${row.schemaname}.${row.tablename}.${row.indexname} ${compact(row.indexdef)}`)
  }

  const routines = await db.query(`
    SELECT n.nspname AS schema, p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           CASE p.prokind WHEN 'f' THEN 'func' WHEN 'p' THEN 'proc' WHEN 'a' THEN 'agg' ELSE p.prokind::text END AS kind,
           p.prosecdef AS security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY 1, 2, 3
  `)
  for (const row of routines.rows) {
    lines.push(
      `FN ${row.schema}.${row.name}(${row.args}) → ${compact(row.result)} ${row.kind}${row.security_definer ? " DEFINER" : ""}`,
    )
  }

  const triggers = await db.query(`
    SELECT event_object_schema AS schema, event_object_table AS table_name,
           trigger_name, action_timing, string_agg(event_manipulation, ',' ORDER BY event_manipulation) AS events,
           action_statement
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
    GROUP BY 1, 2, 3, 4, 6
    ORDER BY 1, 2, 3
  `)
  for (const row of triggers.rows) {
    lines.push(
      `TRG ${row.schema}.${row.table_name}.${row.trigger_name} ${row.action_timing} ${row.events} ${compact(row.action_statement)}`,
    )
  }

  const policies = await db.query(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY 1, 2, 3
  `)
  for (const row of policies.rows) {
    lines.push(
      `POL ${row.schemaname}.${row.tablename}.${row.policyname} ${row.cmd} ${row.permissive} roles=${row.roles} qual=${compact(row.qual)} with_check=${compact(row.with_check)}`,
    )
  }

  const grants = await db.query(`
    SELECT table_schema, table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
    ORDER BY 1, 2, 3, 4
  `)
  for (const row of grants.rows) {
    lines.push(`GRANT ${row.table_schema}.${row.table_name} ${row.grantee} ${row.privilege_type}`)
  }

  return lines.join("\n") + "\n"
}

function compact(value) {
  if (value == null) return ""
  return String(value).replace(/\s+/g, " ").trim()
}

function normalizeDefault(value) {
  if (value == null) return ""
  return compact(value).replace(/::[a-zA-Z0-9_."\[\] ]+/g, "")
}

export function diffCatalogs(prodText, testText) {
  const prod = new Set(prodText.split(/\r?\n/).filter(Boolean))
  const test = new Set(testText.split(/\r?\n/).filter(Boolean))
  const onlyProd = [...prod].filter((l) => !test.has(l)).sort()
  const onlyTest = [...test].filter((l) => !prod.has(l)).sort()
  return { onlyProd, onlyTest }
}
