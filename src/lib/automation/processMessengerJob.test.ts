import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  getDecryptedPageToken: vi.fn(),
  sendMessengerText: vi.fn(),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));

vi.mock('@/lib/facebook/pages', () => ({
  getDecryptedPageToken: mocks.getDecryptedPageToken,
}));

vi.mock('@/lib/facebook/api', () => ({ sendMessengerText: mocks.sendMessengerText }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { processMessengerReplyJob } from './processMessengerJob';

const JOB = {
  facebookPageId: 'page-uuid',
  pageId: '111',
  senderPsid: 'psid-999',
  messageText: 'quero orçamento',
  postbackPayload: null,
  triggerEventId: 'mid.1',
  triggerTimestamp: Date.now(),
};

/** Wires from('messenger_automations') and from('messenger_sent_log'). */
function wireTables(options: {
  automations?: Array<Record<string, unknown>>;
  sentLogError?: { code: string } | null;
}) {
  const insert = vi.fn().mockResolvedValue({ error: options.sentLogError ?? null });

  mocks.from.mockImplementation((table: string) => {
    if (table === 'messenger_sent_log') return { insert };

    const eq2 = vi.fn().mockResolvedValue({ data: options.automations ?? [], error: null });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    return { select: vi.fn().mockReturnValue({ eq: eq1 }) };
  });

  return { insert };
}

beforeEach(() => {
  mocks.getDecryptedPageToken.mockResolvedValue('page-token');
  mocks.sendMessengerText.mockResolvedValue({ messageId: 'mid.out' });
  mocks.rpc.mockResolvedValue({ error: null });
});

describe('processMessengerReplyJob', () => {
  it('sends the reply of the automation whose keyword matched', async () => {
    wireTables({
      automations: [
        { id: 'auto-1', keywords: ['orçamento'], reply_text: 'Claro! Segue o valor.' },
        { id: 'auto-2', keywords: ['endereço'], reply_text: 'Rua X' },
      ],
    });

    await processMessengerReplyJob(JOB);

    expect(mocks.sendMessengerText).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessengerText).toHaveBeenCalledWith({
      pageId: '111',
      pageAccessToken: 'page-token',
      recipientId: 'psid-999',
      text: 'Claro! Segue o valor.',
    });
  });

  it('sends nothing when no keyword matches', async () => {
    wireTables({ automations: [{ id: 'auto-1', keywords: ['endereço'], reply_text: 'Rua X' }] });

    await processMessengerReplyJob(JOB);

    expect(mocks.sendMessengerText).not.toHaveBeenCalled();
  });

  it('treats a null keyword list as matching any message', async () => {
    wireTables({ automations: [{ id: 'auto-1', keywords: null, reply_text: 'Olá!' }] });

    await processMessengerReplyJob(JOB);

    expect(mocks.sendMessengerText).toHaveBeenCalled();
  });

  it('claims the dedupe row BEFORE sending, so a retry cannot double-send', async () => {
    const order: string[] = [];
    const { insert } = wireTables({
      automations: [{ id: 'auto-1', keywords: null, reply_text: 'Olá!' }],
    });
    insert.mockImplementation(async () => {
      order.push('dedupe');
      return { error: null };
    });
    mocks.sendMessengerText.mockImplementation(async () => {
      order.push('send');
      return { messageId: 'mid.out' };
    });

    await processMessengerReplyJob(JOB);

    expect(order).toEqual(['dedupe', 'send']);
  });

  it('does not send when this person was already answered by the automation', async () => {
    wireTables({
      automations: [{ id: 'auto-1', keywords: null, reply_text: 'Olá!' }],
      sentLogError: { code: '23505' },
    });

    await processMessengerReplyJob(JOB);

    expect(mocks.sendMessengerText).not.toHaveBeenCalled();
  });

  it('fails loudly when the Page token is gone, so the job retries', async () => {
    wireTables({ automations: [{ id: 'auto-1', keywords: null, reply_text: 'Olá!' }] });
    mocks.getDecryptedPageToken.mockResolvedValue(null);

    await expect(processMessengerReplyJob(JOB)).rejects.toThrow(/token/i);
    expect(mocks.sendMessengerText).not.toHaveBeenCalled();
  });

  it('counts the send for reporting', async () => {
    wireTables({ automations: [{ id: 'auto-1', keywords: null, reply_text: 'Olá!' }] });

    await processMessengerReplyJob(JOB);

    expect(mocks.rpc).toHaveBeenCalledWith('increment_messenger_automation_sent', {
      automation_id: 'auto-1',
    });
  });

  it('matches a postback payload when the message carries no text', async () => {
    wireTables({ automations: [{ id: 'auto-1', keywords: ['comprar'], reply_text: 'Ok!' }] });

    await processMessengerReplyJob({
      ...JOB,
      messageText: null,
      postbackPayload: 'comprar',
    });

    expect(mocks.sendMessengerText).toHaveBeenCalled();
  });
});
