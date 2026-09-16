-- ═══════════════════════════════════════════════════════════════════════════
-- Messenger automations - keyword rules per connected Facebook Page.
--
-- Deliberately separate from public.automations: that table is hard-wired to
-- instagram_account_id and carries Instagram-only concepts (post_id, stories,
-- follow gate). Forcing Messenger into it would mean nullable foreign keys and
-- a type column that lies. A sibling table keeps both channels honest until
-- the unified channels/conversations model lands.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.messenger_automations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  facebook_page_id UUID        NOT NULL REFERENCES public.facebook_pages(id) ON DELETE CASCADE,

  name             TEXT        NOT NULL,
  is_active        BOOLEAN     NOT NULL DEFAULT true,

  -- NULL = any message triggers. Otherwise case-insensitive whole-word match,
  -- same semantics as the Instagram keyword matcher.
  keywords         TEXT[],

  reply_text       TEXT        NOT NULL,

  total_sent       BIGINT      NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messenger_automations_user_id ON public.messenger_automations(user_id);
CREATE INDEX idx_messenger_automations_active_page
  ON public.messenger_automations(facebook_page_id) WHERE is_active = true;

CREATE TRIGGER messenger_automations_updated_at
  BEFORE UPDATE ON public.messenger_automations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.messenger_automations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own messenger automations"
  ON public.messenger_automations FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own messenger automations"
  ON public.messenger_automations FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own messenger automations"
  ON public.messenger_automations FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own messenger automations"
  ON public.messenger_automations FOR DELETE USING (auth.uid() = user_id);

-- ── messenger_sent_log (deduplication - DB-level guarantee) ────────────────
CREATE TABLE public.messenger_sent_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id  UUID        NOT NULL REFERENCES public.messenger_automations(id) ON DELETE CASCADE,
  recipient_psid TEXT        NOT NULL,
  event_id       TEXT        NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One reply per person per automation, and one per triggering event: a Meta
-- webhook retry must never produce a second message.
CREATE UNIQUE INDEX uq_messenger_sent_log_automation_psid
  ON public.messenger_sent_log(automation_id, recipient_psid);
CREATE UNIQUE INDEX uq_messenger_sent_log_automation_event
  ON public.messenger_sent_log(automation_id, event_id);

ALTER TABLE public.messenger_sent_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own messenger sent log"
  ON public.messenger_sent_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.messenger_automations a
    WHERE a.id = messenger_sent_log.automation_id AND a.user_id = auth.uid()
  ));

-- ── RPC: atomic sent counter ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_messenger_automation_sent(automation_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.messenger_automations SET total_sent = total_sent + 1 WHERE id = automation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_messenger_automation_sent(UUID) TO service_role;
