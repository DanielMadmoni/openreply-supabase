import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessengerText, subscribePageToWebhooks } from './api';

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
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

describe('sendMessengerText', () => {
  it('posts to the Page messages edge using the Page token', async () => {
    const fetchMock = mockFetch({ message_id: 'mid.123' });

    const result = await sendMessengerText({
      pageId: '111',
      pageAccessToken: 'page-token',
      recipientId: 'psid-999',
      text: 'Olá!',
    });

    expect(result.messageId).toBe('mid.123');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/111/messages');
    expect(init.method).toBe('POST');

    const payload = JSON.parse(String(init.body));
    expect(payload.recipient).toEqual({ id: 'psid-999' });
    expect(payload.message).toEqual({ text: 'Olá!' });
    // RESPONSE is the only tag-free type valid inside the 24-hour window.
    expect(payload.messaging_type).toBe('RESPONSE');
    expect(payload.access_token).toBe('page-token');
  });

  it('never puts the Page token in the URL, where it would leak into logs', async () => {
    const fetchMock = mockFetch({ message_id: 'mid.123' });

    await sendMessengerText({
      pageId: '111',
      pageAccessToken: 'page-token',
      recipientId: 'psid-999',
      text: 'Olá!',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('page-token');
  });

  it('raises the Meta error so the job can be retried or paused', async () => {
    mockFetch({ error: { message: 'outside window', code: 10 } }, { ok: false, status: 400 });

    await expect(
      sendMessengerText({
        pageId: '111',
        pageAccessToken: 'page-token',
        recipientId: 'psid-999',
        text: 'Olá!',
      })
    ).rejects.toThrow(/outside window/);
  });
});

describe('subscribePageToWebhooks', () => {
  it('subscribes the Page to the message and postback fields', async () => {
    const fetchMock = mockFetch({ success: true });

    await subscribePageToWebhooks('111', 'page-token');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/111/subscribed_apps');
    expect(init.method).toBe('POST');

    const payload = JSON.parse(String(init.body));
    const fields = String(payload.subscribed_fields).split(',');
    expect(fields).toContain('messages');
    expect(fields).toContain('messaging_postbacks');
    expect(payload.access_token).toBe('page-token');
  });
});
