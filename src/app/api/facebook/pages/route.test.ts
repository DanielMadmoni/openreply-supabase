import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mocks.from }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from './route';

beforeEach(() => {
  mocks.getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c' });
});

function selectReturning(rows: unknown[]) {
  const order = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  mocks.from.mockReturnValue({ select });
  return { select, eq };
}

describe('GET /api/facebook/pages', () => {
  it('requires a signed-in user', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);

    const response = await GET(new Request('https://app.example.com/api/facebook/pages'));

    expect(response.status).toBe(401);
  });

  it('returns only the Pages owned by the caller', async () => {
    const { eq } = selectReturning([
      { id: 'uuid-1', page_id: '111', name: 'Clinic', is_active: true, webhooks_subscribed_at: 'now' },
    ]);

    const response = await GET(new Request('https://app.example.com/api/facebook/pages'));

    expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
    const body = (await response.json()) as { pages: Array<Record<string, unknown>> };
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0]?.pageId).toBe('111');
  });

  it('never selects the encrypted token column', async () => {
    const { select } = selectReturning([]);

    await GET(new Request('https://app.example.com/api/facebook/pages'));

    expect(String(select.mock.calls[0]?.[0])).not.toContain('page_access_token_encrypted');
  });

  it('flags a Page that is connected but not receiving events', async () => {
    selectReturning([
      { id: 'uuid-1', page_id: '111', name: 'Clinic', is_active: true, webhooks_subscribed_at: null },
    ]);

    const response = await GET(new Request('https://app.example.com/api/facebook/pages'));
    const body = (await response.json()) as { pages: Array<Record<string, unknown>> };

    expect(body.pages[0]?.receivingEvents).toBe(false);
  });
});
