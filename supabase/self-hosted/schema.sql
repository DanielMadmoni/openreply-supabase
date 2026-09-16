-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM / openreply-supabase - full schema for SELF-HOSTED Supabase
--
-- GENERATED FILE - do not edit by hand.
-- Regenerate with: node scripts/build-self-hosted-schema.mjs
--
-- HOW TO APPLY
--   1. Open Studio → SQL Editor on your self-hosted instance.
--   2. Paste this entire file and run it once.
--
-- Everything runs inside one transaction: if any statement fails, nothing is
-- applied and you can fix the cause and paste again. The guard below stops a
-- second run from erroring halfway through and leaving a partial schema.
--
-- REQUIREMENTS (already true on a standard supabase/postgres image):
--   - schema "auth" exists      (GoTrue has started at least once)
--   - schema "storage" exists   (Storage API has started at least once)
-- If either is missing, start those services first, then run this file.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Preflight ──────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regnamespace('auth') IS NULL THEN
    RAISE EXCEPTION 'Schema "auth" not found. Start the Supabase auth service (GoTrue) once, then run this file again.';
  END IF;

  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'Schema "storage" not found. Start the Supabase storage service once, then run this file again.';
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    RAISE EXCEPTION 'Schema already applied (public.profiles exists). This file is not re-runnable; use a targeted migration instead.';
  END IF;
END
$preflight$;

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260729000001_core_schema.sql
-- ───────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM - Core schema
--
-- profiles            → extends auth.users
-- instagram_accounts  → connected IG accounts (AES-256-GCM encrypted tokens)
-- automations         → AutoDM rules
-- dm_jobs             → audit log of every processed job
-- dm_sent_log         → deduplication (UNIQUE constraints are the guarantee)
-- automation_sessions → 2-step DM flow state (quick-reply button routing)
-- dm_logs             → per-session conversation history
-- debug_events        → live debug panel event stream
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Shared trigger: auto-update updated_at ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ── profiles ───────────────────────────────────────────────────────────────
CREATE TABLE public.profiles (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill: users created in the dashboard BEFORE this migration ran have no
-- profiles row (the trigger above didn't exist yet). No-op on fresh projects.
INSERT INTO public.profiles (id, full_name, avatar_url)
SELECT id, raw_user_meta_data->>'full_name', raw_user_meta_data->>'avatar_url'
FROM auth.users
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- ── instagram_accounts ─────────────────────────────────────────────────────
CREATE TABLE public.instagram_accounts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  instagram_user_id       TEXT        NOT NULL,  -- Meta IGSID of the business account
  username                TEXT        NOT NULL,
  name                    TEXT,
  profile_picture_url     TEXT,

  -- AES-256-GCM encrypted. Format: iv_hex:ciphertext_hex:authtag_hex. NEVER logged.
  access_token_encrypted  TEXT        NOT NULL,
  token_expires_at        TIMESTAMPTZ,

  is_active               BOOLEAN     NOT NULL DEFAULT true,

  -- Safety circuit breaker: when Meta returns a policy/spam block for this
  -- account, the engine pauses all sends until this timestamp.
  paused_until            TIMESTAMPTZ,
  pause_reason            TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_instagram_accounts_igsid ON public.instagram_accounts(instagram_user_id);
CREATE INDEX idx_instagram_accounts_user_id ON public.instagram_accounts(user_id);
CREATE INDEX idx_instagram_accounts_is_active ON public.instagram_accounts(is_active) WHERE is_active = true;
CREATE INDEX idx_instagram_accounts_token_expiry ON public.instagram_accounts(token_expires_at) WHERE is_active = true;

CREATE TRIGGER instagram_accounts_updated_at
  BEFORE UPDATE ON public.instagram_accounts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.instagram_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own instagram accounts"
  ON public.instagram_accounts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own instagram accounts"
  ON public.instagram_accounts FOR DELETE USING (auth.uid() = user_id);

-- ── automations ────────────────────────────────────────────────────────────
CREATE TYPE public.automation_type AS ENUM ('comment_dm', 'dm_reply', 'story_reply');

CREATE TABLE public.automations (
  id                                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                             UUID            NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  instagram_account_id                UUID            NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,

  name                                TEXT            NOT NULL,
  type                                automation_type NOT NULL,
  is_active                           BOOLEAN         NOT NULL DEFAULT true,

  -- Trigger: specific post (comment_dm) or NULL = all posts
  post_id                             TEXT,
  post_thumbnail_url                  TEXT,           -- UI snapshot, best-effort
  post_caption                        TEXT,           -- UI snapshot, best-effort

  -- NULL = any content triggers. ["*ANY*"] = explicit wildcard.
  -- Otherwise: case-insensitive whole-word match.
  keywords                            TEXT[],

  -- Public comment replies - one picked at random per trigger. Empty = none.
  comment_reply_options               TEXT[]          NOT NULL DEFAULT '{}',

  -- Opening DM
  dm_opening_message_enabled          BOOLEAN         NOT NULL DEFAULT true,
  dm_opening_message                  TEXT            NOT NULL DEFAULT '',
  dm_opening_message_button_title     TEXT,
  dm_opening_message_button_link      TEXT,

  -- Ask-to-follow gate (honor system - Meta has no follower-check endpoint)
  ask_to_follow_enabled               BOOLEAN         NOT NULL DEFAULT false,
  ask_to_follow_message               TEXT            NOT NULL DEFAULT 'Hey! It seems you''re not following me yet 😊',
  ask_to_follow_visit_profile_button  TEXT            NOT NULL DEFAULT 'Visit Profile',
  ask_to_follow_confirm_button        TEXT            NOT NULL DEFAULT 'I''m following ✅',

  -- Sequential responses after the quick-reply tap. JSONB array of DMResponse.
  dm_responses                        JSONB           NOT NULL DEFAULT '[]'::JSONB,

  total_dms_sent                      BIGINT          NOT NULL DEFAULT 0,

  created_at                          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

ALTER TABLE public.automations
  ADD CONSTRAINT chk_dm_responses_is_array CHECK (jsonb_typeof(dm_responses) = 'array');

CREATE INDEX idx_automations_user_id ON public.automations(user_id);
CREATE INDEX idx_automations_active_account_type
  ON public.automations(instagram_account_id, type) WHERE is_active = true;

CREATE TRIGGER automations_updated_at
  BEFORE UPDATE ON public.automations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own automations"
  ON public.automations FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own automations"
  ON public.automations FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own automations"
  ON public.automations FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own automations"
  ON public.automations FOR DELETE USING (auth.uid() = user_id);

-- ── dm_jobs (audit log) ────────────────────────────────────────────────────
CREATE TYPE public.dm_job_status AS ENUM ('queued', 'processing', 'sent', 'failed', 'skipped');

CREATE TABLE public.dm_jobs (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id         UUID          NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  instagram_account_id  UUID          NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,

  trigger_type          TEXT          NOT NULL CHECK (trigger_type IN ('comment', 'dm', 'story_reply', 'dm_reply_followup')),
  trigger_user_id       TEXT          NOT NULL,
  trigger_event_id      TEXT          NOT NULL,
  trigger_timestamp     TIMESTAMPTZ   NOT NULL,

  status                dm_job_status NOT NULL DEFAULT 'queued',
  error_message         TEXT,
  attempts              INTEGER       NOT NULL DEFAULT 0,
  sent_at               TIMESTAMPTZ,
  -- Idempotency for the public comment reply: a retried job must never post
  -- the visible reply a second time even when the DM leg is retried.
  public_reply_sent_at  TIMESTAMPTZ,

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Required by the status-upsert (ON CONFLICT target)
CREATE UNIQUE INDEX uq_dm_jobs_automation_event ON public.dm_jobs(automation_id, trigger_event_id);
CREATE INDEX idx_dm_jobs_created_at ON public.dm_jobs(created_at DESC);

CREATE TRIGGER dm_jobs_updated_at
  BEFORE UPDATE ON public.dm_jobs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.dm_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dm jobs"
  ON public.dm_jobs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = dm_jobs.automation_id AND a.user_id = auth.uid()));

-- ── dm_sent_log (deduplication - DB-level guarantee) ───────────────────────
CREATE TABLE public.dm_sent_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  automation_id         UUID        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  trigger_user_id       TEXT        NOT NULL,
  trigger_event_id      TEXT        NOT NULL,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One DM per trigger event per automation. Non-negotiable.
CREATE UNIQUE INDEX uq_dm_sent_log_automation_event ON public.dm_sent_log(automation_id, trigger_event_id);
-- One DM per person per automation (even across multiple comments).
CREATE UNIQUE INDEX uq_dm_sent_log_automation_user ON public.dm_sent_log(automation_id, trigger_user_id);
CREATE INDEX idx_dm_sent_log_sent_at ON public.dm_sent_log(sent_at DESC);

ALTER TABLE public.dm_sent_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dm sent log"
  ON public.dm_sent_log FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = dm_sent_log.automation_id AND a.user_id = auth.uid()));

-- ── automation_sessions (2-step quick-reply flow) ──────────────────────────
CREATE TABLE public.automation_sessions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id         UUID        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  audience_ig_user_id   TEXT        NOT NULL,
  current_step          INTEGER     NOT NULL DEFAULT 1,
  completed             BOOLEAN     NOT NULL DEFAULT FALSE,
  expires_at            TIMESTAMPTZ NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active session per (automation, audience member).
CREATE UNIQUE INDEX automation_sessions_active_unique
  ON public.automation_sessions (automation_id, audience_ig_user_id) WHERE completed = FALSE;
CREATE INDEX automation_sessions_lookup_idx
  ON public.automation_sessions (instagram_account_id, audience_ig_user_id, completed, expires_at);

ALTER TABLE public.automation_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own automation sessions"
  ON public.automation_sessions FOR SELECT
  USING (automation_id IN (SELECT id FROM public.automations WHERE user_id = auth.uid()));

-- ── dm_logs (conversation history) ─────────────────────────────────────────
CREATE TABLE public.dm_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID        NOT NULL REFERENCES public.automation_sessions(id) ON DELETE CASCADE,
  direction    TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  step         INTEGER,
  message_text TEXT        NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX dm_logs_session_idx ON public.dm_logs (session_id, sent_at);

ALTER TABLE public.dm_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dm logs"
  ON public.dm_logs FOR SELECT
  USING (session_id IN (
    SELECT s.id FROM public.automation_sessions s
    JOIN public.automations a ON a.id = s.automation_id
    WHERE a.user_id = auth.uid()
  ));

-- ── debug_events (live debug panel) ────────────────────────────────────────
CREATE TABLE public.debug_events (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  service      TEXT         NOT NULL,                  -- 'webhook' | 'worker' | 'instagram'
  level        TEXT         NOT NULL DEFAULT 'info',   -- 'info' | 'warn' | 'error'
  event_type   TEXT         NOT NULL,
  status       TEXT         NOT NULL DEFAULT 'ok',     -- 'ok' | 'error' | 'skipped' | 'processing'
  message      TEXT         NOT NULL,
  metadata     JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX debug_events_created_at_idx ON public.debug_events (created_at DESC);

-- No user policies: service-role only (read surfaced via API in debug mode).
ALTER TABLE public.debug_events ENABLE ROW LEVEL SECURITY;

-- ── RPC: atomic DM counter ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_automation_dms_sent(automation_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.automations SET total_dms_sent = total_dms_sent + 1 WHERE id = automation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_automation_dms_sent(UUID) TO service_role;

-- ── Storage bucket for card DM images (public: Meta must fetch the URLs) ───
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('card-images', 'card-images', true, 2097152, ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Auth users upload card images') THEN
    CREATE POLICY "Auth users upload card images"
      ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'card-images');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Public read card images') THEN
    CREATE POLICY "Public read card images"
      ON storage.objects FOR SELECT TO public USING (bucket_id = 'card-images');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Auth users delete card images') THEN
    CREATE POLICY "Auth users delete card images"
      ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'card-images');
  END IF;
END $$;

-- END 20260729000001_core_schema.sql

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260729000002_app_settings.sql
-- ───────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM - App settings (single-row table)
--
-- Holds the self-hoster's Meta app credentials, entered through the in-app
-- Setup Wizard. The App Secret is AES-256-GCM encrypted with the deployment's
-- TOKEN_ENCRYPTION_KEY before it is stored - never plaintext in the DB.
--
-- No RLS user policies: this table is service-role only. All reads/writes go
-- through authenticated API routes which mask/decrypt as appropriate.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.app_settings (
  -- Single-row table: id is always 1
  id                          INTEGER     PRIMARY KEY CHECK (id = 1),

  meta_app_id                 TEXT,
  meta_app_secret_encrypted   TEXT,       -- AES-256-GCM: iv:ciphertext:authtag
  -- Optional. Meta signs webhooks with the Instagram app secret for
  -- Instagram-Login apps but the Facebook app secret for Facebook-Login apps.
  -- Storing both lets signature verification accept either - kills a whole
  -- class of "webhook silently rejected" setup failures.
  meta_fb_app_secret_encrypted TEXT,      -- AES-256-GCM: iv:ciphertext:authtag
  webhook_verify_token        TEXT,       -- generated by the setup wizard

  setup_completed             BOOLEAN     NOT NULL DEFAULT false,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Seed the singleton row so the app can always UPDATE id=1
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- END 20260729000002_app_settings.sql

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260729000003_job_queue_and_rate_limiter.sql
-- ───────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM - Postgres-native job queue + sliding-window rate limiter
--
-- Replaces BullMQ + Redis from the original two-service architecture.
-- Serverless-safe: jobs are claimed with FOR UPDATE SKIP LOCKED so any number
-- of concurrent function invocations can drain the queue without double-sends.
--
-- job_queue      → pending/delayed AutoDM work (overflow, retries, follow-ups)
-- dm_rate_events → one row per DM sent, used for the 180/hour rolling window
-- ═══════════════════════════════════════════════════════════════════════════

-- ── job_queue ──────────────────────────────────────────────────────────────
CREATE TABLE public.job_queue (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type     TEXT        NOT NULL CHECK (job_type IN ('auto_dm', 'follow_up')),
  payload      JSONB       NOT NULL,
  -- Idempotency: Meta retries webhooks - same event never creates two jobs.
  dedupe_key   TEXT        NOT NULL UNIQUE,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  run_after    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts     INTEGER     NOT NULL DEFAULT 0,
  max_attempts INTEGER     NOT NULL DEFAULT 3,
  last_error   TEXT,
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_queue_due ON public.job_queue (run_after) WHERE status = 'pending';
CREATE INDEX idx_job_queue_created_at ON public.job_queue (created_at DESC);

CREATE TRIGGER job_queue_updated_at
  BEFORE UPDATE ON public.job_queue
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Service-role only
ALTER TABLE public.job_queue ENABLE ROW LEVEL SECURITY;

-- ── RPC: claim due jobs (concurrency-safe) ─────────────────────────────────
-- Atomically claims up to p_limit due jobs. Also self-heals: 'processing'
-- jobs whose invocation died (locked > 10 minutes ago) are reclaimed.
CREATE OR REPLACE FUNCTION public.claim_due_jobs(p_limit INTEGER DEFAULT 10)
RETURNS SETOF public.job_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Reclaim jobs stuck in 'processing' (crashed/timed-out invocations)
  UPDATE public.job_queue
  SET status = 'pending', locked_at = NULL
  WHERE status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes';

  RETURN QUERY
  UPDATE public.job_queue jq
  SET status = 'processing', locked_at = NOW()
  WHERE jq.id IN (
    SELECT id FROM public.job_queue
    WHERE status = 'pending' AND run_after <= NOW()
    ORDER BY run_after ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING jq.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_due_jobs(INTEGER) TO service_role;

-- ── dm_rate_events + atomic rate-limit check ───────────────────────────────
CREATE TABLE public.dm_rate_events (
  id                    BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dm_rate_events_window ON public.dm_rate_events (instagram_account_id, sent_at DESC);

ALTER TABLE public.dm_rate_events ENABLE ROW LEVEL SECURITY;

-- Checks the rolling 60-minute window for an account. If under the limit,
-- records the send and returns allowed=true. Runs in a single transaction with
-- a per-account advisory lock, so concurrent invocations can never overshoot.
--
-- Default limit 180/hour: Meta's hard limit is 200 - the 20-DM buffer covers
-- manual DMs the creator sends themselves.
CREATE OR REPLACE FUNCTION public.check_and_record_dm_rate_limit(
  p_account_id UUID,
  p_limit      INTEGER DEFAULT 180
)
RETURNS TABLE (allowed BOOLEAN, current_count INTEGER, retry_after_seconds INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count  INTEGER;
  v_oldest TIMESTAMPTZ;
BEGIN
  -- Serialize concurrent checks for the same account within this transaction
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));

  -- Opportunistic cleanup of expired window entries for this account
  DELETE FROM public.dm_rate_events
  WHERE instagram_account_id = p_account_id AND sent_at < NOW() - INTERVAL '1 hour';

  SELECT COUNT(*) INTO v_count
  FROM public.dm_rate_events
  WHERE instagram_account_id = p_account_id AND sent_at > NOW() - INTERVAL '1 hour';

  IF v_count >= p_limit THEN
    SELECT MIN(sent_at) INTO v_oldest
    FROM public.dm_rate_events
    WHERE instagram_account_id = p_account_id AND sent_at > NOW() - INTERVAL '1 hour';

    RETURN QUERY SELECT
      false,
      v_count,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_oldest + INTERVAL '1 hour' - NOW())))::INTEGER + 1);
    RETURN;
  END IF;

  INSERT INTO public.dm_rate_events (instagram_account_id) VALUES (p_account_id);

  RETURN QUERY SELECT true, v_count + 1, 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_and_record_dm_rate_limit(UUID, INTEGER) TO service_role;

-- ── RPC: housekeeping (called by the cron endpoint) ────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_old_rows()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.debug_events WHERE created_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.job_queue WHERE status IN ('done', 'failed') AND updated_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.dm_rate_events WHERE sent_at < NOW() - INTERVAL '2 hours';
  DELETE FROM public.automation_sessions WHERE completed = TRUE AND last_activity_at < NOW() - INTERVAL '30 days';
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_rows() TO service_role;

-- END 20260729000003_job_queue_and_rate_limiter.sql

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260730000001_contacts.sql
-- ───────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM - Contacts (automation-captured audience CRM)
--
-- A contact is every unique audience member captured through an automation
-- interaction: commented a trigger, DM'd a keyword, story-replied, or tapped
-- a flow button. Rows are written by the engine (service role) as events flow;
-- usernames + follow status are enriched from Instagram's User Profile API
-- (available for anyone who has messaged the account).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.contacts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  audience_ig_user_id   TEXT        NOT NULL,   -- IGSID of the audience member

  username              TEXT,                   -- enriched: comments carry it; DMs via profile API
  follows_business      BOOLEAN,                -- last known follow status (null = never checked)

  first_interaction_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_interaction_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_trigger_type     TEXT,                   -- 'comment' | 'dm' | 'story_reply' | 'button'
  last_automation_id    UUID        REFERENCES public.automations(id) ON DELETE SET NULL,
  total_triggers        INTEGER     NOT NULL DEFAULT 1,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_contacts_account_audience
  ON public.contacts (instagram_account_id, audience_ig_user_id);
CREATE INDEX idx_contacts_last_interaction
  ON public.contacts (instagram_account_id, last_interaction_at DESC);

CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- Users see contacts captured by their own connected accounts. Writes are
-- service-role only (the engine).
CREATE POLICY "Users can view own contacts"
  ON public.contacts FOR SELECT
  USING (
    instagram_account_id IN (
      SELECT id FROM public.instagram_accounts WHERE user_id = auth.uid()
    )
  );

-- ── RPC: record an interaction (atomic upsert + counter) ───────────────────
CREATE OR REPLACE FUNCTION public.record_contact_interaction(
  p_account_id    UUID,
  p_audience_id   TEXT,
  p_username      TEXT,
  p_trigger_type  TEXT,
  p_automation_id UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.contacts (
    instagram_account_id, audience_ig_user_id, username,
    last_trigger_type, last_automation_id
  )
  VALUES (p_account_id, p_audience_id, NULLIF(TRIM(p_username), ''), p_trigger_type, p_automation_id)
  ON CONFLICT (instagram_account_id, audience_ig_user_id) DO UPDATE SET
    last_interaction_at = NOW(),
    last_trigger_type   = EXCLUDED.last_trigger_type,
    last_automation_id  = COALESCE(EXCLUDED.last_automation_id, contacts.last_automation_id),
    username            = COALESCE(EXCLUDED.username, contacts.username),
    total_triggers      = contacts.total_triggers + 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_contact_interaction(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;

-- ── RPC: enrich profile fields (username / follow status) ──────────────────
CREATE OR REPLACE FUNCTION public.update_contact_profile(
  p_account_id  UUID,
  p_audience_id TEXT,
  p_username    TEXT,
  p_follows     BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.contacts SET
    username         = COALESCE(NULLIF(TRIM(p_username), ''), username),
    follows_business = COALESCE(p_follows, follows_business)
  WHERE instagram_account_id = p_account_id AND audience_ig_user_id = p_audience_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_contact_profile(UUID, TEXT, TEXT, BOOLEAN) TO service_role;

-- END 20260730000001_contacts.sql

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260908000001_instance_roles.sql
-- ───────────────────────────────────────────────────────────────────────────

-- Instance-level roles for protecting global credentials and setup.
-- The earliest existing profile becomes owner; later users default to member.

ALTER TABLE public.profiles
  ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('owner', 'admin', 'member'));

WITH first_profile AS (
  SELECT id
  FROM public.profiles
  ORDER BY created_at ASC, id ASC
  LIMIT 1
)
UPDATE public.profiles
SET role = 'owner'
FROM first_profile
WHERE public.profiles.id = first_profile.id
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles existing_owner
    WHERE existing_owner.role = 'owner'
  );

-- New users remain members unless the instance has no owner yet. The lock keeps
-- simultaneous first-user inserts from creating more than one bootstrap owner.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  assigned_role TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('open-autodm-bootstrap-owner'));

  IF EXISTS (SELECT 1 FROM public.profiles WHERE role = 'owner') THEN
    assigned_role := 'member';
  ELSE
    assigned_role := 'owner';
  END IF;

  INSERT INTO public.profiles (id, full_name, avatar_url, role)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url',
    assigned_role
  );
  RETURN NEW;
END;
$$;

-- RLS alone cannot compare OLD and NEW values. This trigger ensures an
-- authenticated client cannot promote itself while service-role/admin SQL can
-- still manage instance roles.
--
-- The role is read from the request JWT rather than auth.role(): that helper
-- is not guaranteed to exist on a self-hosted instance, and because this
-- trigger fires BEFORE UPDATE, a missing function would block EVERY profile
-- update instead of only role changes. current_setting(..., true) returns
-- NULL when the setting is absent (plain SQL sessions) instead of raising.
CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  jwt_role TEXT;
BEGIN
  IF NEW.role = OLD.role THEN
    RETURN NEW;
  END IF;

  BEGIN
    jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  EXCEPTION WHEN OTHERS THEN
    -- Malformed or absent claims: treat as an untrusted caller.
    jwt_role := NULL;
  END;

  IF COALESCE(jwt_role, '') = 'service_role'
    OR current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'profile role can only be changed by the service role';
END;
$$;

DROP TRIGGER IF EXISTS prevent_profile_role_escalation ON public.profiles;
CREATE TRIGGER prevent_profile_role_escalation
  BEFORE UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_role_escalation();

-- Recreate the self-update policy explicitly so the migration documents that
-- ordinary profile fields remain editable. Role changes are blocked above.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- END 20260908000001_instance_roles.sql

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260908000002_storage_isolation.sql
-- ───────────────────────────────────────────────────────────────────────────

-- Restrict card image writes to <auth.uid()>/... object paths.
-- Public reads remain enabled because Meta must fetch card images by URL.

DROP POLICY IF EXISTS "Auth users upload card images" ON storage.objects;
CREATE POLICY "Auth users upload card images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'card-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Auth users delete card images" ON storage.objects;
CREATE POLICY "Auth users delete card images"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'card-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- END 20260908000002_storage_isolation.sql

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260914000001_messenger_channel.sql
-- ───────────────────────────────────────────────────────────────────────────

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

-- END 20260914000001_messenger_channel.sql

-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN 20260914000002_messenger_automations.sql
-- ───────────────────────────────────────────────────────────────────────────

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

-- END 20260914000002_messenger_automations.sql

COMMIT;
