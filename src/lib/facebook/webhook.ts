/**
 * Messenger webhook routing.
 *
 * Meta delivers Page events to the SAME endpoint as Instagram events, told
 * apart by the top-level `object` field. Signature verification already
 * happened in the route; this module only decides what to enqueue.
 *
 * entry.id is the Page ID for Page events (not an IGSID), which is what makes
 * routing by `object` mandatory: an Instagram handler would look the ID up in
 * the wrong table and silently drop every Messenger message.
 */

import { enqueueJob } from '@/lib/automation/queue';
import { debugLog } from '@/lib/debugLog';
import { createServiceClient } from '@/lib/supabase/service';

/** 24-hour Meta messaging window plus a 1h buffer for queue latency. */
const MAX_EVENT_AGE_MS = 25 * 60 * 60 * 1000;

interface MessengerMessage {
  mid?: string;
  text?: string;
  is_echo?: boolean;
}

interface MessengerMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: MessengerMessage | undefined;
  postback?: { payload?: string; title?: string };
  delivery?: unknown;
  read?: unknown;
}

interface MessengerEntry {
  id?: string;
  time?: number;
  messaging?: MessengerMessagingEvent[];
}

export interface MessengerWebhookBody {
  object?: string;
  entry?: MessengerEntry[];
}

export interface MessengerReplyJobPayload {
  /** facebook_pages.id - the internal row, not the Meta Page ID. */
  facebookPageId: string;
  /** Meta Page ID - needed to build the send URL. */
  pageId: string;
  senderPsid: string;
  messageText: string | null;
  postbackPayload: string | null;
  triggerEventId: string;
  triggerTimestamp: number;
}

export async function processMessengerWebhook(body: MessengerWebhookBody): Promise<number> {
  if (body.object !== 'page') return 0;

  const db = createServiceClient();
  let enqueued = 0;

  for (const entry of body.entry ?? []) {
    if (!entry.id || !entry.messaging?.length) continue;

    const { data: page, error } = await db
      .from('facebook_pages')
      .select('id, page_id')
      .eq('page_id', entry.id)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !page) {
      debugLog('webhook', 'warn', 'page_lookup', 'skipped', `No active Page for entry.id=${entry.id}`, {
        entryId: entry.id,
        hint: 'Connect the Page under Settings, or it was disconnected/paused.',
      });
      continue;
    }

    const facebookPageId = (page as { id: string }).id;
    const pageId = (page as { page_id: string }).page_id;

    for (const messaging of entry.messaging) {
      enqueued += await processMessengerEvent(facebookPageId, pageId, messaging);
    }
  }

  return enqueued;
}

async function processMessengerEvent(
  facebookPageId: string,
  pageId: string,
  messaging: MessengerMessagingEvent
): Promise<number> {
  // Echoes are our own sends coming back; receipts carry no user intent.
  if (messaging.message?.is_echo || messaging.delivery || messaging.read) return 0;

  const senderPsid = messaging.sender?.id;
  if (!senderPsid) return 0;

  // A Page messaging itself would loop forever.
  if (senderPsid === messaging.recipient?.id) return 0;

  const text = messaging.message?.text ?? null;
  const postbackPayload = messaging.postback?.payload ?? null;
  if (!text && !postbackPayload) return 0;

  const triggerTimestamp = messaging.timestamp ?? Date.now();
  if (Date.now() - triggerTimestamp > MAX_EVENT_AGE_MS) {
    debugLog('webhook', 'warn', 'window_check', 'skipped', 'Messenger event beyond the 24h window', {
      pageId,
    });
    return 0;
  }

  const triggerEventId = messaging.message?.mid ?? `postback_${senderPsid}_${triggerTimestamp}`;

  const payload: MessengerReplyJobPayload = {
    facebookPageId,
    pageId,
    senderPsid,
    messageText: text,
    postbackPayload,
    triggerEventId,
    triggerTimestamp,
  };

  const jobId = await enqueueJob(
    'messenger_reply',
    payload as unknown as Record<string, unknown>,
    `messenger_${facebookPageId}_${triggerEventId}`
  );

  return jobId ? 1 : 0;
}
