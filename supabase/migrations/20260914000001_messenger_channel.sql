-- ═══════════════════════════════════════════════════════════════════════════
-- Messenger channel - Facebook Pages connected via Facebook Login.
--
-- Mirrors instagram_accounts: one row per connected Page, AES-256-GCM
-- encrypted Page Access Token, per-user RLS, and the same circuit-breaker
-- fields the automation engine already understands.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.facebook_pages (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  page_id                     TEXT        NOT NULL,  -- Meta Page ID
  name                        TEXT        NOT NULL,
  picture_url                 TEXT,

  -- AES-256-GCM. Format: iv_hex:ciphertext_hex:authtag_hex. NEVER logged.
  -- Page tokens derived from a long-lived user token do not expire, but they
  -- are revoked when the admin removes the app or loses Page access.
  page_access_token_encrypted TEXT        NOT NULL,

  is_active                   BOOLEAN     NOT NULL DEFAULT true,

  -- Set once /PAGE_ID/subscribed_apps succeeds; a Page without this is
  -- connected but will never receive webhook events.
  webhooks_subscribed_at      TIMESTAMPTZ,

  -- Safety circuit breaker: Meta policy blocks pause all sends for this Page.
  paused_until                TIMESTAMPTZ,
  pause_reason                TEXT,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A Page belongs to exactly one instance user: connecting it twice would make
-- inbound webhook routing ambiguous.
CREATE UNIQUE INDEX uq_facebook_pages_page_id ON public.facebook_pages(page_id);
CREATE INDEX idx_facebook_pages_user_id ON public.facebook_pages(user_id);
CREATE INDEX idx_facebook_pages_is_active ON public.facebook_pages(is_active) WHERE is_active = true;

CREATE TRIGGER facebook_pages_updated_at
  BEFORE UPDATE ON public.facebook_pages
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.facebook_pages ENABLE ROW LEVEL SECURITY;

-- Reads and disconnects are user-driven. Inserts and token updates go through
-- the service role only, so the browser never handles a Page token.
CREATE POLICY "Users can view own facebook pages"
  ON public.facebook_pages FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own facebook pages"
  ON public.facebook_pages FOR DELETE USING (auth.uid() = user_id);
