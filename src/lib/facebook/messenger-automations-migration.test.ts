import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260914000002_messenger_automations.sql'
);

function sql(): string {
  return readFileSync(migrationPath, 'utf8');
}

describe('messenger automations migration', () => {
  it('exists', () => {
    expect(existsSync(migrationPath), 'messenger automations migration is missing').toBe(true);
  });

  it('scopes automations to a Page and to its owner', () => {
    const text = sql();

    expect(text).toMatch(/CREATE TABLE public\.messenger_automations/i);
    expect(text).toMatch(/facebook_page_id\s+UUID\s+NOT NULL REFERENCES public\.facebook_pages\(id\) ON DELETE CASCADE/i);
    expect(text).toMatch(/user_id\s+UUID\s+NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/i);
  });

  it('enables RLS with full owner-scoped CRUD', () => {
    const text = sql();

    expect(text).toMatch(/ALTER TABLE public\.messenger_automations ENABLE ROW LEVEL SECURITY/i);
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(text, `missing ${op} policy`).toMatch(new RegExp(`FOR ${op}`, 'i'));
    }
  });

  it('deduplicates replies so one person is answered once per automation', () => {
    expect(sql()).toMatch(/CREATE UNIQUE INDEX[\s\S]*messenger_sent_log\(automation_id, recipient_psid\)/i);
  });
});
