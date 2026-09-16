/**
 * GET /api/facebook/pages - list the caller's connected Facebook Pages.
 *
 * The encrypted Page token column is never selected: it has no use in the UI
 * and keeping it out of the response removes a whole class of accidents.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('facebook-pages');

interface PageRow {
  id: string;
  page_id: string;
  name: string;
  picture_url?: string | null;
  is_active: boolean;
  webhooks_subscribed_at: string | null;
  paused_until?: string | null;
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const db = createServiceClient();
  const { data, error } = await db
    .from('facebook_pages')
    .select('id, page_id, name, picture_url, is_active, webhooks_subscribed_at, paused_until')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to list Facebook Pages');
    return Response.json({ error: 'Failed to load Pages' }, { status: 500 });
  }

  const pages = ((data ?? []) as PageRow[]).map((row) => ({
    id: row.id,
    pageId: row.page_id,
    name: row.name,
    pictureUrl: row.picture_url ?? null,
    isActive: row.is_active,
    // A Page without a subscription is connected but deaf - the UI must be
    // able to show that as a fixable warning rather than a healthy state.
    receivingEvents: Boolean(row.webhooks_subscribed_at),
    pausedUntil: row.paused_until ?? null,
  }));

  return Response.json({ pages });
}
