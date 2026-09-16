/**
 * Facebook Login OAuth helpers for the Messenger channel.
 *
 * Unlike Instagram Business Login (instagram.com/oauth/authorize), Messenger
 * requires Facebook's dialog/oauth: the admin authorises the app, we list the
 * Pages they manage, and each connected Page gets its own never-expiring Page
 * Access Token derived from a long-lived User Access Token.
 */

const GRAPH_VERSION = 'v23.0';
const FB_DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface FacebookTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

export interface ManagedPage {
  id: string;
  name: string;
  /** Page Access Token - used to send messages AS the Page. Never log it. */
  accessToken: string;
}

interface PageAccountsResponse {
  data?: Array<{ id?: string; name?: string; access_token?: string }>;
}

/**
 * Permissions required to list Pages, read their metadata, subscribe them to
 * webhooks, and send/receive Messenger messages. All four require Meta App
 * Review before the app can serve the general public.
 */
export const REQUIRED_PAGE_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
].join(',');

export function buildFacebookLoginUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: REQUIRED_PAGE_SCOPES,
    response_type: 'code',
    state,
  });
  return `${FB_DIALOG_URL}?${params.toString()}`;
}

async function graphGet<T>(url: string, context: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${context} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

/** Exchanges the OAuth code for a short-lived User Access Token. */
export async function exchangeCodeForUserToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string
): Promise<FacebookTokenResponse> {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  });
  return graphGet<FacebookTokenResponse>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
    'Facebook token exchange'
  );
}

/**
 * Upgrades a short-lived User Access Token to a long-lived one (~60 days).
 * Page tokens derived from a long-lived user token do not expire, which is why
 * this step must happen before listing Pages.
 */
export async function exchangeForLongLivedUserToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string
): Promise<FacebookTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });
  return graphGet<FacebookTokenResponse>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
    'Facebook long-lived token exchange'
  );
}

/** Lists the Pages the authenticated admin manages, each with its Page token. */
export async function listManagedPages(userAccessToken: string): Promise<ManagedPage[]> {
  const params = new URLSearchParams({
    fields: 'id,name,access_token',
    access_token: userAccessToken,
  });
  const body = await graphGet<PageAccountsResponse>(
    `${GRAPH_BASE}/me/accounts?${params.toString()}`,
    'Facebook Page listing'
  );

  return (body.data ?? [])
    .filter((page): page is { id: string; name: string; access_token: string } =>
      Boolean(page.id && page.access_token)
    )
    .map((page) => ({
      id: page.id,
      name: page.name ?? page.id,
      accessToken: page.access_token,
    }));
}
