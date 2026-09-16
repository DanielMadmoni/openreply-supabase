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
