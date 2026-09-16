import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyOAuthState: vi.fn(),
  getMetaSettings: vi.fn(),
  exchangeCodeForUserToken: vi.fn(),
  exchangeForLongLivedUserToken: vi.fn(),
  listManagedPages: vi.fn(),
  connectPages: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/instagram/oauth', () => ({ verifyOAuthState: mocks.verifyOAuthState }));
vi.mock('@/lib/settings', () => ({ getMetaSettings: mocks.getMetaSettings }));
vi.mock('@/lib/facebook/oauth', () => ({
  exchangeCodeForUserToken: mocks.exchangeCodeForUserToken,
  exchangeForLongLivedUserToken: mocks.exchangeForLongLivedUserToken,
  listManagedPages: mocks.listManagedPages,
}));
vi.mock('@/lib/facebook/pages', () => ({ connectPages: mocks.connectPages }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => ({ upsert: mocks.upsert }) }),
}));
vi.mock('@/lib/env', () => ({ getAppUrl: () => 'https://app.example.com' }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from './route';

function callback(params: Record<string, string>) {
  const url = new URL('https://app.example.com/api/facebook/callback');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url);
}

function redirectTarget(response: Response): URL {
  return new URL(response.headers.get('location') ?? '');
}

beforeEach(() => {
  mocks.verifyOAuthState.mockResolvedValue({ userId: 'user-1' });
  mocks.getMetaSettings.mockResolvedValue({
    metaAppId: '123456',
    metaAppSecret: 'secret',
    metaFbAppSecret: null,
    webhookVerifyToken: 'verify',
    setupCompleted: true,
  });
  mocks.exchangeCodeForUserToken.mockResolvedValue({ access_token: 'short' });
  mocks.exchangeForLongLivedUserToken.mockResolvedValue({ access_token: 'long' });
  mocks.listManagedPages.mockResolvedValue([
    { id: '111', name: 'Clinic', accessToken: 'page-token-1' },
  ]);
  mocks.connectPages.mockResolvedValue({ connected: ['111'], failedSubscriptions: [] });
  mocks.upsert.mockResolvedValue({ error: null });
});

describe('GET /api/facebook/callback', () => {
  it('redirects with an error when the user denies consent', async () => {
    const response = await GET(callback({ error: 'access_denied' }));

    expect(redirectTarget(response).searchParams.get('messenger_error')).toBe('access_denied');
    expect(mocks.connectPages).not.toHaveBeenCalled();
  });

  it('rejects a callback whose state token does not verify', async () => {
    mocks.verifyOAuthState.mockRejectedValue(new Error('bad state'));

    const response = await GET(callback({ code: 'the-code', state: 'forged' }));

    expect(redirectTarget(response).searchParams.get('messenger_error')).toBe('state_mismatch');
    expect(mocks.exchangeCodeForUserToken).not.toHaveBeenCalled();
  });

  it('exchanges the code for a long-lived token before listing Pages', async () => {
    await GET(callback({ code: 'the-code', state: 'valid' }));

    expect(mocks.exchangeForLongLivedUserToken).toHaveBeenCalledWith('short', '123456', 'secret');
    expect(mocks.listManagedPages).toHaveBeenCalledWith('long');
  });

  it('stores the Pages against the user from the state token, not the query', async () => {
    await GET(callback({ code: 'the-code', state: 'valid' }));

    expect(mocks.connectPages).toHaveBeenCalledWith('user-1', [
      { id: '111', name: 'Clinic', accessToken: 'page-token-1' },
    ]);
  });

  it('tells the user when the account manages no Pages', async () => {
    mocks.listManagedPages.mockResolvedValue([]);

    const response = await GET(callback({ code: 'the-code', state: 'valid' }));

    expect(redirectTarget(response).searchParams.get('messenger_error')).toBe('no_pages');
    expect(mocks.connectPages).not.toHaveBeenCalled();
  });

  it('reports partial success when a Page could not be subscribed', async () => {
    mocks.connectPages.mockResolvedValue({ connected: ['111'], failedSubscriptions: ['111'] });

    const response = await GET(callback({ code: 'the-code', state: 'valid' }));
    const target = redirectTarget(response);

    expect(target.searchParams.get('messenger_connected')).toBe('1');
    expect(target.searchParams.get('messenger_warning')).toBe('subscription_failed');
  });

  it('redirects with a success count when everything works', async () => {
    const response = await GET(callback({ code: 'the-code', state: 'valid' }));
    const target = redirectTarget(response);

    expect(target.pathname).toBe('/settings');
    expect(target.searchParams.get('messenger_connected')).toBe('1');
    expect(target.searchParams.get('messenger_warning')).toBeNull();
  });

  it('never leaks a Page token into the redirect URL', async () => {
    const response = await GET(callback({ code: 'the-code', state: 'valid' }));

    expect(response.headers.get('location')).not.toContain('page-token-1');
    expect(response.headers.get('location')).not.toContain('long');
  });
});
