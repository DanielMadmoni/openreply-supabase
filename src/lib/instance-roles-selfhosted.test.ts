import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260908000001_instance_roles.sql'
);

function sql(): string {
  return readFileSync(migrationPath, 'utf8');
}

describe('instance role trigger on self-hosted Supabase', () => {
  it('does not call auth.role() unguarded', () => {
    const text = sql();

    // auth.role() is a convenience helper, not guaranteed to exist on a
    // self-hosted instance. An unguarded call raises "function does not
    // exist", and because the trigger fires BEFORE UPDATE that failure would
    // block every profile update - not just a role change.
    expect(text).not.toMatch(/COALESCE\(auth\.role\(\)/);
  });

  it('reads the role claim from the request JWT instead', () => {
    const text = sql();

    expect(text).toMatch(/current_setting\('request\.jwt\.claims'/);
    expect(text).toMatch(/service_role/);
  });

  it('still lets the database superuser manage roles', () => {
    expect(sql()).toMatch(/current_user IN \('postgres', 'supabase_admin', 'service_role'\)/);
  });

  it('tolerates a missing JWT claim setting rather than erroring', () => {
    // current_setting(..., true) returns NULL instead of raising when the
    // setting is absent - which is the normal case for direct SQL sessions.
    expect(sql()).toMatch(/current_setting\('request\.jwt\.claims',\s*true\)/);
  });
});
