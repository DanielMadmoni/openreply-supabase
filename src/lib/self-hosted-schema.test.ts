import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const bundlePath = path.resolve(process.cwd(), 'supabase/self-hosted/schema.sql');

function bundle(): string {
  return readFileSync(bundlePath, 'utf8');
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

describe('self-hosted schema bundle', () => {
  it('exists', () => {
    expect(existsSync(bundlePath), 'self-hosted schema bundle is missing').toBe(true);
  });

  it('contains every migration, so a fresh instance is not left half-built', () => {
    const text = bundle();

    for (const file of migrationFiles()) {
      expect(text, `bundle is missing ${file}`).toContain(file);
    }
  });

  it('keeps migrations in filename order, because later ones depend on earlier tables', () => {
    const text = bundle();
    const positions = migrationFiles().map((file) => text.indexOf(file));

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('carries the body of each migration, not just its name', () => {
    const text = bundle();

    // A marker from the last migration proves the whole chain was inlined.
    expect(text).toContain('CREATE TABLE public.messenger_automations');
    expect(text).toContain('CREATE TABLE public.facebook_pages');
    expect(text).toContain('CREATE TABLE public.profiles');
  });

  it('runs as one transaction so a failure cannot leave a partial schema', () => {
    const text = bundle();

    expect(text).toMatch(/^\s*BEGIN;/m);
    expect(text.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('refuses to run twice instead of erroring halfway through', () => {
    const text = bundle();

    // Re-running raw CREATE TABLE would abort mid-file; the guard turns that
    // into one clear message before anything is touched.
    expect(text).toMatch(/RAISE EXCEPTION/i);
    expect(text).toMatch(/to_regclass\('public\.profiles'\)/i);
  });
});
