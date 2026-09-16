import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REQUIRED_PAGE_SCOPES,
  buildFacebookLoginUrl,
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  listManagedPages,
} from './oauth';

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildFacebookLoginUrl', () => {
  it('asks Meta for the Page messaging permissions Messenger needs', () => {
    const url = new URL(
      buildFacebookLoginUrl('123456', 'https://app.example.com/api/facebook/callback', 'state-jwt')
    );

    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('123456');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/facebook/callback');
    expect(url.searchParams.get('state')).toBe('state-jwt');
    expect(url.searchParams.get('response_type')).toBe('code');

    const scopes = (url.searchParams.get('scope') ?? '').split(',');
    expect(scopes).toContain('pages_show_list');
    expect(scopes).toContain('pages_messaging');
    expect(scopes).toContain('pages_manage_metadata');
    expect(scopes).toContain('pages_read_engagement');
    expect(REQUIRED_PAGE_SCOPES.split(',')).toEqual(scopes);
  });
});

describe('exchangeCodeForUserToken', () => {
  it('sends the authorization code to the Graph token endpoint', async () => {
    const fetchMock = mockFetchOnce({ access_token: 'short-lived', token_type: 'bearer' });

    const result = await exchangeCodeForUserToken(
      'the-code',
      '123456',
      'app-secret',
      'https://app.example.com/api/facebook/callback'
    );

    expect(result.access_token).toBe('short-lived');

    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://graph.facebook.com/v23.0/oauth/access_token');
    expect(calledUrl.searchParams.get('code')).toBe('the-code');
    expect(calledUrl.searchParams.get('client_id')).toBe('123456');
    expect(calledUrl.searchParams.get('client_secret')).toBe('app-secret');
    expect(calledUrl.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/facebook/callback');
  });

  it('surfaces Meta errors instead of returning an unusable token', async () => {
    mockFetchOnce({ error: { message: 'bad code' } }, { ok: false, status: 400 });

    await expect(
      exchangeCodeForUserToken('bad', '123456', 'app-secret', 'https://app.example.com/cb')
    ).rejects.toThrow(/400/);
  });
});

describe('exchangeForLongLivedUserToken', () => {
  it('upgrades a short-lived user token with fb_exchange_token', async () => {
    const fetchMock = mockFetchOnce({ access_token: 'long-lived', expires_in: 5183944 });

    const result = await exchangeForLongLivedUserToken('short-lived', '123456', 'app-secret');

    expect(result.access_token).toBe('long-lived');

    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(calledUrl.searchParams.get('fb_exchange_token')).toBe('short-lived');
  });
});

describe('listManagedPages', () => {
  it('returns each Page with the token used to send messages as that Page', async () => {
    const fetchMock = mockFetchOnce({
      data: [
        { id: '111', name: 'Clinic', access_token: 'page-token-1' },
        { id: '222', name: 'Shop', access_token: 'page-token-2' },
      ],
    });

    const pages = await listManagedPages('long-lived');

    expect(pages).toEqual([
      { id: '111', name: 'Clinic', accessToken: 'page-token-1' },
      { id: '222', name: 'Shop', accessToken: 'page-token-2' },
    ]);

    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://graph.facebook.com/v23.0/me/accounts');
    expect(calledUrl.searchParams.get('access_token')).toBe('long-lived');
  });

  it('returns an empty list when the admin manages no Pages', async () => {
    mockFetchOnce({ data: [] });

    await expect(listManagedPages('long-lived')).resolves.toEqual([]);
  });
});
