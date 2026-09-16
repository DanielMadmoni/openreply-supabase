import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260914000001_messenger_channel.sql'
);

function sql(): string {
  return readFileSync(migrationPath, 'utf8');
}

describe('messenger channel migration', () => {
  it('exists', () => {
    expect(existsSync(migrationPath), 'messenger channel migration is missing').toBe(true);
  });

  it('stores Page tokens encrypted, never in a plaintext column', () => {
    const text = sql();

    expect(text).toMatch(/page_access_token_encrypted\s+TEXT\s+NOT NULL/i);
    expect(text).not.toMatch(/\bpage_access_token\s+TEXT/i);
  });

  it('scopes every Page to its owner and enables RLS', () => {
    const text = sql();

    expect(text).toMatch(/CREATE TABLE public\.facebook_pages/i);
    expect(text).toMatch(/user_id\s+UUID\s+NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/i);
    expect(text).toMatch(/ALTER TABLE public\.facebook_pages ENABLE ROW LEVEL SECURITY/i);
    expect(text).toMatch(/FOR SELECT USING \(auth\.uid\(\) = user_id\)/i);
    expect(text).toMatch(/FOR DELETE USING \(auth\.uid\(\) = user_id\)/i);
  });

  it('prevents the same Page from being connected twice', () => {
    expect(sql()).toMatch(/CREATE UNIQUE INDEX[\s\S]*facebook_pages\(page_id\)/i);
  });

  it('gives Messenger the same circuit-breaker fields Instagram has', () => {
    const text = sql();

    expect(text).toMatch(/paused_until\s+TIMESTAMPTZ/i);
    expect(text).toMatch(/pause_reason\s+TEXT/i);
    expect(text).toMatch(/is_active\s+BOOLEAN\s+NOT NULL DEFAULT true/i);
  });
});
