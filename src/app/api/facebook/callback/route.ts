/**
 * GET /api/facebook/callback - Facebook redirects here after consent.
 *
 * Flow (identity comes exclusively from the signed state JWT - CSRF-safe):
 *   verify state → code → short-lived user token → long-lived user token
 *   → list managed Pages → encrypt each Page token → upsert facebook_pages
 *   → subscribe each Page to webhooks → redirect to /settings
 *
 * Page tokens never appear in the redirect URL: browser history, proxy logs
 * and the Referer header would all capture them.
 */

import { getAppUrl } from '@/lib/env';
import { debugLog } from '@/lib/debugLog';
import {
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  listManagedPages,
} from '@/lib/facebook/oauth';
import { connectPages } from '@/lib/facebook/pages';
import { verifyOAuthState } from '@/lib/instagram/oauth';
import { createLogger } from '@/lib/logger';
import { getMetaSettings } from '@/lib/settings';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const logger = createLogger('facebook-oauth-callback');

export async function GET(request: Request): Promise<Response> {
  const appUrl = getAppUrl(request);
  const settingsRedirect = (params: string): Response =>
    Response.redirect(`${appUrl}/settings?${params}`, 302);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');
  const fbError = url.searchParams.get('error');

  if (fbError) {
    logger.warn({ fbError }, 'User denied Facebook authorization');
    return settingsRedirect('messenger_error=access_denied');
  }
  if (!code || !stateToken) {
    return settingsRedirect('messenger_error=invalid_callback');
  }

  let userId: string;
  try {
    ({ userId } = await verifyOAuthState(stateToken));
  } catch {
    logger.warn({}, 'Facebook OAuth state JWT verification failed');
    return settingsRedirect('messenger_error=state_mismatch');
  }

  const settings = await getMetaSettings();
  if (!settings) {
    return settingsRedirect('messenger_error=setup_required');
  }

  try {
    const redirectUri = `${appUrl}/api/facebook/callback`;

    const shortLived = await exchangeCodeForUserToken(
      code,
      settings.metaAppId,
      settings.metaAppSecret,
      redirectUri
    );
    // Page tokens only inherit "no expiry" when derived from a long-lived
    // user token, so this exchange must happen before listing Pages.
    const longLived = await exchangeForLongLivedUserToken(
      shortLived.access_token,
      settings.metaAppId,
      settings.metaAppSecret
    );

    const pages = await listManagedPages(longLived.access_token);
    if (pages.length === 0) {
      debugLog('oauth', 'warn', 'facebook_no_pages', 'skipped', 'Account manages no Facebook Pages', {
        userId,
      });
      return settingsRedirect('messenger_error=no_pages');
    }

    // Users created in the Supabase dashboard before the migrations ran have
    // no profiles row; without this the FK on facebook_pages would fail.
    const db = createServiceClient();
    await db.from('profiles').upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });

    const result = await connectPages(userId, pages);

    const params = new URLSearchParams({
      messenger_connected: String(result.connected.length),
    });
    if (result.failedSubscriptions.length > 0) {
      params.set('messenger_warning', 'subscription_failed');
    }

    logger.info({ userId, pages: result.connected.length }, 'Facebook Pages connected');
    return settingsRedirect(params.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, userId }, 'Facebook OAuth callback failed');
    debugLog('oauth', 'error', 'facebook_oauth_failed', 'error', message.slice(0, 300), { userId });
    return settingsRedirect('messenger_error=server_error');
  }
}
