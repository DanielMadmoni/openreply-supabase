/**
 * Messenger Platform send + webhook subscription calls.
 *
 * All requests carry the Page Access Token in the JSON body, never in the
 * query string: Meta logs full URLs on their side and so do most proxies, and
 * a leaked Page token lets anyone message the Page's entire audience.
 */

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Fields the Messenger channel needs on every connected Page. */
export const SUBSCRIBED_FIELDS = ['messages', 'messaging_postbacks'].join(',');

export interface SendMessengerTextInput {
  pageId: string;
  pageAccessToken: string;
  /** Page-Scoped ID of the person being replied to. */
  recipientId: string;
  text: string;
}

export interface SendMessengerTextResult {
  messageId: string | null;
}

async function graphPost<T>(path: string, payload: Record<string, unknown>, context: string): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${context} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

/**
 * Sends a plain text DM as the Page. messaging_type RESPONSE is only valid
 * inside the 24-hour customer service window; the caller is responsible for
 * checking the window before queueing the send.
 */
export async function sendMessengerText(
  input: SendMessengerTextInput
): Promise<SendMessengerTextResult> {
  const body = await graphPost<{ message_id?: string }>(
    `${input.pageId}/messages`,
    {
      recipient: { id: input.recipientId },
      message: { text: input.text },
      messaging_type: 'RESPONSE',
      access_token: input.pageAccessToken,
    },
    'Messenger send'
  );

  return { messageId: body.message_id ?? null };
}

/** Subscribes the app to this Page's message events. Idempotent on Meta's side. */
export async function subscribePageToWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  await graphPost(
    `${pageId}/subscribed_apps`,
    {
      subscribed_fields: SUBSCRIBED_FIELDS,
      access_token: pageAccessToken,
    },
    'Messenger webhook subscription'
  );
}
