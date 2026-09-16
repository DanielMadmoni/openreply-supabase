#!/usr/bin/env node
/**
 * Builds supabase/self-hosted/schema.sql from supabase/migrations/*.sql.
 *
 * Self-hosted Supabase has no `supabase link --project-ref`, so `db push` is
 * unavailable: the schema has to be pasted into the Studio SQL editor. This
 * concatenates every migration, in order, into one transactional file.
 *
 * Run after adding a migration:  node scripts/build-self-hosted-schema.mjs
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migrationsDir = path.join(root, 'supabase', 'migrations');
const outDir = path.join(root, 'supabase', 'self-hosted');
const outFile = path.join(outDir, 'schema.sql');

const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('No migrations found - refusing to write an empty schema.');
  process.exit(1);
}

const header = `-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM / openreply-supabase - full schema for SELF-HOSTED Supabase
--
-- GENERATED FILE - do not edit by hand.
-- Regenerate with: node scripts/build-self-hosted-schema.mjs
--
-- HOW TO APPLY
--   1. Open Studio → SQL Editor on your self-hosted instance.
--   2. Paste this entire file and run it once.
--
-- Everything runs inside one transaction: if any statement fails, nothing is
-- applied and you can fix the cause and paste again. The guard below stops a
-- second run from erroring halfway through and leaving a partial schema.
--
-- REQUIREMENTS (already true on a standard supabase/postgres image):
--   - schema "auth" exists      (GoTrue has started at least once)
--   - schema "storage" exists   (Storage API has started at least once)
-- If either is missing, start those services first, then run this file.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Preflight ──────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regnamespace('auth') IS NULL THEN
    RAISE EXCEPTION 'Schema "auth" not found. Start the Supabase auth service (GoTrue) once, then run this file again.';
  END IF;

  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'Schema "storage" not found. Start the Supabase storage service once, then run this file again.';
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    RAISE EXCEPTION 'Schema already applied (public.profiles exists). This file is not re-runnable; use a targeted migration instead.';
  END IF;
END
$preflight$;

`;

const parts = [header];

for (const file of files) {
  const sql = readFileSync(path.join(migrationsDir, file), 'utf8').trimEnd();
  parts.push(
    `-- ───────────────────────────────────────────────────────────────────────────\n` +
      `-- BEGIN ${file}\n` +
      `-- ───────────────────────────────────────────────────────────────────────────\n\n` +
      `${sql}\n\n` +
      `-- END ${file}\n\n`
  );
}

parts.push(`COMMIT;\n`);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, parts.join(''), 'utf8');

console.log(`Wrote ${path.relative(root, outFile)} from ${files.length} migrations:`);
for (const file of files) console.log(`  - ${file}`);
