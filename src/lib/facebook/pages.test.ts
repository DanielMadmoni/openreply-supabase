import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  subscribePageToWebhooks: vi.fn(),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mocks.from }),
}));

vi.mock('@/lib/facebook/api', () => ({
  subscribePageToWebhooks: mocks.subscribePageToWebhooks,
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) }),
}));

import { decrypt } from '@/lib/crypto';

import { connectPages, getDecryptedPageToken } from './pages';

const KEY = 'a'.repeat(64);

function upsertSpy() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  mocks.from.mockReturnValue({ upsert });
  return upsert;
}

beforeEach(() => {
  mocks.subscribePageToWebhooks.mockResolvedValue(undefined);
});

describe('connectPages', () => {
  it('encrypts each Page token before it reaches the database', async () => {
    const upsert = upsertSpy();

    await connectPages('user-1', [{ id: '111', name: 'Clinic', accessToken: 'page-token-1' }]);

    const [rows] = upsert.mock.calls[0] as [Array<Record<string, string>>];
    const row = rows[0] as Record<string, string>;

    expect(row.page_access_token_encrypted).not.toContain('page-token-1');
    expect(decrypt(String(row.page_access_token_encrypted), KEY)).toBe('page-token-1');
    expect(row.user_id).toBe('user-1');
    expect(row.page_id).toBe('111');
  });

  it('subscribes every connected Page to webhooks', async () => {
    upsertSpy();

    await connectPages('user-1', [
      { id: '111', name: 'Clinic', accessToken: 'token-1' },
      { id: '222', name: 'Shop', accessToken: 'token-2' },
    ]);

    expect(mocks.subscribePageToWebhooks).toHaveBeenCalledTimes(2);
    expect(mocks.subscribePageToWebhooks).toHaveBeenCalledWith('111', 'token-1');
    expect(mocks.subscribePageToWebhooks).toHaveBeenCalledWith('222', 'token-2');
  });

  it('records when the webhook subscription succeeded', async () => {
    const upsert = upsertSpy();

    await connectPages('user-1', [{ id: '111', name: 'Clinic', accessToken: 'token-1' }]);

    expect(upsert.mock.calls[0]?.[0][0].webhooks_subscribed_at).toEqual(expect.any(String));
  });

  it('still stores a Page whose webhook subscription failed, flagged as unsubscribed', async () => {
    const upsert = upsertSpy();
    mocks.subscribePageToWebhooks.mockRejectedValue(new Error('no permission'));

    const result = await connectPages('user-1', [
      { id: '111', name: 'Clinic', accessToken: 'token-1' },
    ]);

    expect(upsert.mock.calls[0]?.[0][0].webhooks_subscribed_at).toBeNull();
    expect(result.failedSubscriptions).toEqual(['111']);
  });
});

describe('getDecryptedPageToken', () => {
  it('returns the plaintext token for the engine to send with', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { page_access_token_encrypted: encrypt('page-token-1', KEY) },
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });

    await expect(getDecryptedPageToken('111')).resolves.toBe('page-token-1');
  });

  it('returns null when the Page is not connected', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });

    await expect(getDecryptedPageToken('999')).resolves.toBeNull();
  });
});
