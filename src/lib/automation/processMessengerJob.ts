/**
 * Messenger reply job executor.
 *
 * Mirrors the Instagram auto-DM path: match keyword → claim the dedupe row →
 * send → count. Claiming BEFORE sending is what makes a webhook retry or a
 * queue re-claim safe; the UNIQUE index is the actual guarantee, not a check.
 */

import { sendMessengerText } from '@/lib/facebook/api';
import { getDecryptedPageToken } from '@/lib/facebook/pages';
import { keywordMatches } from '@/lib/automation/keywordMatch';
import { debugLog } from '@/lib/debugLog';
import { createLogger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase/service';
import type { MessengerReplyJobPayload } from '@/lib/facebook/webhook';

const logger = createLogger('messenger-job');

interface MessengerAutomationRow {
  id: string;
  keywords: string[] | null;
  reply_text: string;
}

export async function processMessengerReplyJob(
  payload: MessengerReplyJobPayload
): Promise<void> {
  const db = createServiceClient();

  const { data, error } = await db
    .from('messenger_automations')
    .select('id, keywords, reply_text')
    .eq('facebook_page_id', payload.facebookPageId)
    .eq('is_active', true);

  if (error) {
    // Transient DB failure - let the engine retry with backoff.
    throw new Error(`Failed to load Messenger automations: ${error.message}`);
  }

  const automations = (data ?? []) as MessengerAutomationRow[];
  if (automations.length === 0) return;

  // A postback carries the button payload rather than typed text; either can
  // satisfy a keyword rule.
  const triggerText = payload.messageText ?? payload.postbackPayload ?? '';

  const match = automations.find((automation) =>
    keywordMatches(triggerText, automation.keywords)
  );
  if (!match) {
    debugLog('worker', 'info', 'messenger_no_match', 'skipped', 'No Messenger automation matched', {
      pageId: payload.pageId,
    });
    return;
  }

  // Claim first: if this insert loses the race, someone already replied.
  const { error: dedupeError } = await db.from('messenger_sent_log').insert({
    automation_id: match.id,
    recipient_psid: payload.senderPsid,
    event_id: payload.triggerEventId,
  });

  if (dedupeError) {
    if (dedupeError.code === '23505') {
      logger.info(
        { automationId: match.id, psid: payload.senderPsid },
        'Messenger reply already sent - duplicate ignored'
      );
      return;
    }
    throw new Error(`Failed to claim Messenger dedupe row: ${dedupeError.message}`);
  }

  const pageToken = await getDecryptedPageToken(payload.pageId);
  if (!pageToken) {
    // Throwing (not returning) matters: the Page may have been reconnected by
    // the time the job retries, and a silent return would lose the reply.
    throw new Error(`No Page access token available for Page ${payload.pageId}`);
  }

  await sendMessengerText({
    pageId: payload.pageId,
    pageAccessToken: pageToken,
    recipientId: payload.senderPsid,
    text: match.reply_text,
  });

  await db.rpc('increment_messenger_automation_sent', { automation_id: match.id });

  debugLog('worker', 'info', 'messenger_sent', 'ok', 'Messenger reply sent', {
    automationId: match.id,
    pageId: payload.pageId,
  });
}
