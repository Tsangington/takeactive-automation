-- Guests and deleted/anonymized TakeActive participants live on appointment_participant
-- (not in member). Upsert key becomes (appointment_id, external_id).

ALTER TABLE public.appointment_participant
  ADD COLUMN IF NOT EXISTS participant_type text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS guest_username text,
  ADD COLUMN IF NOT EXISTS external_id bigint;

ALTER TABLE public.appointment_participant
  DROP CONSTRAINT IF EXISTS appointment_participant_appointment_id_member_id_key;

ALTER TABLE public.appointment_participant
  ALTER COLUMN member_id DROP NOT NULL;

ALTER TABLE public.appointment_participant
  DROP CONSTRAINT IF EXISTS appointment_participant_participant_type_check;

ALTER TABLE public.appointment_participant
  ADD CONSTRAINT appointment_participant_participant_type_check
  CHECK (participant_type IN ('member', 'guest', 'deleted'));

-- Full unique so PostgREST upsert onConflict works. Multiple NULLs for external_id
-- remain allowed under default PostgreSQL NULLS DISTINCT unique semantics.
ALTER TABLE public.appointment_participant
  DROP CONSTRAINT IF EXISTS appointment_participant_appointment_id_external_id_key;

ALTER TABLE public.appointment_participant
  ADD CONSTRAINT appointment_participant_appointment_id_external_id_key
  UNIQUE (appointment_id, external_id);

CREATE UNIQUE INDEX IF NOT EXISTS appointment_participant_appointment_id_member_id_key
  ON public.appointment_participant (appointment_id, member_id)
  WHERE member_id IS NOT NULL;

-- Only real members contribute to member.event_count.
CREATE OR REPLACE FUNCTION public.refresh_member_event_count(member_id_input text)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.member m
  SET event_count = (
    SELECT count(*)::integer
    FROM public.appointment_participant ap
    JOIN public.appointment a ON a.id = ap.appointment_id
    WHERE ap.member_id = member_id_input
      AND ap.member_id IS NOT NULL
      AND ap.participant_type = 'member'
      AND ap.status = 'attended'
      AND extract(year FROM a.start_date) = extract(year FROM current_date)
  )
  WHERE m.id = member_id_input;
$$;
