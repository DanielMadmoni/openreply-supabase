import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  enqueueJob: vi.fn(),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mocks.from }),
}));

vi.mock('@/lib/automation/queue', () => ({
  enqueueJob: mocks.enqueueJob,
}));

vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { processMessengerWebhook } from './webhook';

function pageLookup(page: { id: string; page_id: string } | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: page, error: null });
  const secondEq = vi.fn().mockReturnValue({ maybeSingle });
  const firstEq = vi.fn().mockReturnValue({ eq: secondEq });
  mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq: firstEq }) });
  return { firstEq, secondEq };
}

function messagingEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: { id: 'psid-999' },
    recipient: { id: '111' },
    timestamp: Date.now(),
    message: { mid: 'mid.1', text: 'orçamento' },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.enqueueJob.mockResolvedValue('job-1');
});

describe('processMessengerWebhook', () => {
  it('ignores payloads that are not Page events', async () => {
    const enqueued = await processMessengerWebhook({
      object: 'instagram',
      entry: [{ id: '111', time: Date.now(), messaging: [messagingEvent()] }],
    });

    expect(enqueued).toBe(0);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('skips events for a Page that is not connected to this instance', async () => {
    pageLookup(null);

    const enqueued = await processMessengerWebhook({
      object: 'page',
      entry: [{ id: '999', time: Date.now(), messaging: [messagingEvent()] }],
    });

    expect(enqueued).toBe(0);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues a Messenger reply job for an inbound message', async () => {
    pageLookup({ id: 'page-uuid', page_id: '111' });

    const enqueued = await processMessengerWebhook({
      object: 'page',
      entry: [{ id: '111', time: Date.now(), messaging: [messagingEvent()] }],
    });

    expect(enqueued).toBe(1);
    const [jobType, payload, dedupeKey] = mocks.enqueueJob.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(jobType).toBe('messenger_reply');
    expect(payload.facebookPageId).toBe('page-uuid');
    expect(payload.pageId).toBe('111');
    expect(payload.senderPsid).toBe('psid-999');
    expect(payload.messageText).toBe('orçamento');
    expect(dedupeKey).toContain('mid.1');
  });

  it('ignores echoes of messages the Page itself sent', async () => {
    pageLookup({ id: 'page-uuid', page_id: '111' });

    const enqueued = await processMessengerWebhook({
      object: 'page',
      entry: [
        {
          id: '111',
          time: Date.now(),
          messaging: [messagingEvent({ message: { mid: 'mid.2', text: 'oi', is_echo: true } })],
        },
      ],
    });

    expect(enqueued).toBe(0);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('ignores delivery and read receipts', async () => {
    pageLookup({ id: 'page-uuid', page_id: '111' });

    const enqueued = await processMessengerWebhook({
      object: 'page',
      entry: [
        {
          id: '111',
          time: Date.now(),
          messaging: [
            messagingEvent({ message: undefined, delivery: { watermark: 1 } }),
            messagingEvent({ message: undefined, read: { watermark: 1 } }),
          ],
        },
      ],
    });

    expect(enqueued).toBe(0);
  });

  it('rejects events older than the 24-hour messaging window', async () => {
    pageLookup({ id: 'page-uuid', page_id: '111' });
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;

    const enqueued = await processMessengerWebhook({
      object: 'page',
      entry: [{ id: '111', time: twoDaysAgo, messaging: [messagingEvent({ timestamp: twoDaysAgo })] }],
    });

    expect(enqueued).toBe(0);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('only matches Pages that are still active', async () => {
    const { secondEq } = pageLookup({ id: 'page-uuid', page_id: '111' });

    await processMessengerWebhook({
      object: 'page',
      entry: [{ id: '111', time: Date.now(), messaging: [messagingEvent()] }],
    });

    expect(secondEq).toHaveBeenCalledWith('is_active', true);
  });
});
