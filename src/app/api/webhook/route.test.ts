import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hmacSha256Hex } from '@/lib/crypto';

const mocks = vi.hoisted(() => ({
  getMetaSettings: vi.fn(),
  processWebhookPayload: vi.fn(),
  processMessengerWebhook: vi.fn(),
  processDueJobs: vi.fn(),
  after: vi.fn(),
}));

vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => mocks.after(fn),
}));

vi.mock('@/lib/settings', () => ({ getMetaSettings: mocks.getMetaSettings }));
vi.mock('@/lib/automation/processWebhook', () => ({
  processWebhookPayload: mocks.processWebhookPayload,
}));
vi.mock('@/lib/facebook/webhook', () => ({
  processMessengerWebhook: mocks.processMessengerWebhook,
}));
vi.mock('@/lib/automation/engine', () => ({ processDueJobs: mocks.processDueJobs }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from './route';

const APP_SECRET = 'app-secret';

function signedRequest(body: unknown) {
  const raw = JSON.stringify(body);
  return new Request('https://app.example.com/api/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': `sha256=${hmacSha256Hex(APP_SECRET, raw)}` },
    body: raw,
  });
}

/** Runs whatever the route deferred via after(). */
async function flushAfter() {
  const deferred = mocks.after.mock.calls.at(-1)?.[0] as (() => Promise<void>) | undefined;
  if (deferred) await deferred();
}

beforeEach(() => {
  mocks.getMetaSettings.mockResolvedValue({
    metaAppId: '123',
    metaAppSecret: APP_SECRET,
    metaFbAppSecret: null,
    webhookVerifyToken: 'verify',
    setupCompleted: true,
  });
  mocks.processWebhookPayload.mockResolvedValue(0);
  mocks.processMessengerWebhook.mockResolvedValue(0);
  mocks.processDueJobs.mockResolvedValue(undefined);
});

describe('POST /api/webhook channel routing', () => {
  it('routes Page events to the Messenger processor', async () => {
    const body = { object: 'page', entry: [{ id: '111', time: 1, messaging: [] }] };

    const response = await POST(signedRequest(body));
    await flushAfter();

    expect(response.status).toBe(200);
    expect(mocks.processMessengerWebhook).toHaveBeenCalledWith(body);
    expect(mocks.processWebhookPayload).not.toHaveBeenCalled();
  });

  it('routes Instagram events to the Instagram processor', async () => {
    const body = { object: 'instagram', entry: [{ id: '222', time: 1, changes: [] }] };

    await POST(signedRequest(body));
    await flushAfter();

    expect(mocks.processWebhookPayload).toHaveBeenCalledWith(body);
    expect(mocks.processMessengerWebhook).not.toHaveBeenCalled();
  });

  it('drains the queue after a Messenger event is enqueued', async () => {
    mocks.processMessengerWebhook.mockResolvedValue(2);

    await POST(signedRequest({ object: 'page', entry: [] }));
    await flushAfter();

    expect(mocks.processDueJobs).toHaveBeenCalled();
  });

  it('still rejects a Page event whose signature does not match', async () => {
    const response = await POST(
      new Request('https://app.example.com/api/webhook', {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
        body: JSON.stringify({ object: 'page', entry: [] }),
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.processMessengerWebhook).not.toHaveBeenCalled();
  });
});
