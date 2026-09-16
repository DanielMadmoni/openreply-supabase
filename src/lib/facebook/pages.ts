/**
 * Facebook Page persistence for the Messenger channel.
 *
 * Page Access Tokens are AES-256-GCM encrypted before they touch the database
 * and decrypted only here, at send time. The browser never receives one.
 */

import { subscribePageToWebhooks } from '@/lib/facebook/api';
import type { ManagedPage } from '@/lib/facebook/oauth';
import { decrypt, encrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/service';

export interface ConnectPagesResult {
  connected: string[];
  /**
   * Pages stored without an active webhook subscription. They are connected
   * but will receive no events until the admin retries - surfacing this lets
   * the UI show a fixable warning instead of failing the whole connection.
   */
  failedSubscriptions: string[];
}

export async function connectPages(
  userId: string,
  pages: ManagedPage[]
): Promise<ConnectPagesResult> {
  const env = getEnv();
  const db = createServiceClient();
  const failedSubscriptions: string[] = [];

  const rows = [];
  for (const page of pages) {
    let subscribedAt: string | null = null;
    try {
      await subscribePageToWebhooks(page.id, page.accessToken);
      subscribedAt = new Date().toISOString();
    } catch {
      // Subscribing needs pages_manage_metadata; a missing grant must not
      // discard a Page the admin already authorised.
      failedSubscriptions.push(page.id);
    }

    rows.push({
      user_id: userId,
      page_id: page.id,
      name: page.name,
      page_access_token_encrypted: encrypt(page.accessToken, env.TOKEN_ENCRYPTION_KEY),
      webhooks_subscribed_at: subscribedAt,
      is_active: true,
    });
  }

  const { error } = await db.from('facebook_pages').upsert(rows, { onConflict: 'page_id' });
  if (error) throw new Error(`Failed to save Facebook Pages: ${error.message}`);

  return { connected: pages.map((page) => page.id), failedSubscriptions };
}

/** Plaintext Page token for the send engine. Returns null if not connected. */
export async function getDecryptedPageToken(pageId: string): Promise<string | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('facebook_pages')
    .select('page_access_token_encrypted')
    .eq('page_id', pageId)
    .maybeSingle();

  if (error || !data) return null;

  const encrypted = (data as { page_access_token_encrypted?: string }).page_access_token_encrypted;
  if (!encrypted) return null;

  try {
    return decrypt(encrypted, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    // TOKEN_ENCRYPTION_KEY rotated after connection - treat as disconnected.
    return null;
  }
}
