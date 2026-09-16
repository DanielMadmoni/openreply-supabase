/**
 * GET /api/facebook/connect - build the Facebook Login URL for Messenger.
 * Returns { url }; the frontend navigates the browser there.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { getAppUrl } from '@/lib/env';
import { buildFacebookLoginUrl } from '@/lib/facebook/oauth';
import { signOAuthState } from '@/lib/instagram/oauth';
import { getMetaSettings } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const settings = await getMetaSettings();
  if (!settings) {
    return Response.json(
      {
        error: 'setup_required',
        message: 'Complete the Setup Wizard (Meta App ID + Secret) before connecting Messenger.',
      },
      { status: 409 }
    );
  }

  // Same signed, 10-minute state JWT the Instagram flow uses - identity comes
  // from the token on the way back, never from a query parameter.
  const state = await signOAuthState(user.id);
  const redirectUri = `${getAppUrl(request)}/api/facebook/callback`;
  const url = buildFacebookLoginUrl(settings.metaAppId, redirectUri, state);

  return Response.json({ url });
}
