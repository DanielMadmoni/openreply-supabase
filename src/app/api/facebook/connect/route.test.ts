import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  getMetaSettings: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

vi.mock('@/lib/settings', () => ({ getMetaSettings: mocks.getMetaSettings }));
vi.mock('@/lib/env', () => ({
  getAppUrl: () => 'https://app.example.com',
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) }),
}));

import { GET } from './route';

beforeEach(() => {
  mocks.getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c' });
  mocks.getMetaSettings.mockResolvedValue({
    metaAppId: '123456',
    metaAppSecret: 'secret',
    metaFbAppSecret: 'fb-secret',
    webhookVerifyToken: 'verify',
    setupCompleted: true,
  });
});

describe('GET /api/facebook/connect', () => {
  it('requires a signed-in user', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);

    const response = await GET(new Request('https://app.example.com/api/facebook/connect'));

    expect(response.status).toBe(401);
  });

  it('refuses to start OAuth before the Meta app is configured', async () => {
    mocks.getMetaSettings.mockResolvedValue(null);

    const response = await GET(new Request('https://app.example.com/api/facebook/connect'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'setup_required' });
  });

  it('returns a Facebook login URL carrying a CSRF state token', async () => {
    const response = await GET(new Request('https://app.example.com/api/facebook/connect'));
    const { url } = (await response.json()) as { url: string };

    const parsed = new URL(url);
    expect(parsed.hostname).toBe('www.facebook.com');
    expect(parsed.searchParams.get('client_id')).toBe('123456');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/facebook/callback'
    );
    expect(parsed.searchParams.get('state')).toBeTruthy();
    expect(parsed.searchParams.get('scope')).toContain('pages_messaging');
  });
});
