-- TakeActive cancelled slots stay status=ACTIVE with is_decline=true.
-- Store that on appointment; exclude declined slots from session counts.

ALTER TABLE public.appointment
  ADD COLUMN IF NOT EXISTS is_decline boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decline_message text;

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
      AND a.is_decline = false
      AND extract(year FROM a.start_date) = extract(year FROM current_date)
  )
  WHERE m.id = member_id_input;
$$;

-- List sync can flip is_decline after participants are already stored.
CREATE OR REPLACE FUNCTION public.trg_appointment_is_decline_event_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_decline IS DISTINCT FROM NEW.is_decline THEN
    PERFORM public.refresh_member_event_count(ap.member_id)
    FROM public.appointment_participant ap
    WHERE ap.appointment_id = NEW.id
      AND ap.member_id IS NOT NULL
      AND ap.participant_type = 'member';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointment_is_decline_event_count ON public.appointment;

CREATE TRIGGER appointment_is_decline_event_count
AFTER UPDATE OF is_decline ON public.appointment
FOR EACH ROW
WHEN (OLD.is_decline IS DISTINCT FROM NEW.is_decline)
EXECUTE FUNCTION public.trg_appointment_is_decline_event_count();
