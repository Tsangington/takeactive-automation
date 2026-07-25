-- Store cancel timestamps from TakeActive participant payloads.
ALTER TABLE public.appointment_participant
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

-- Keep member.event_count = count of attended appointments in the current calendar year.
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
      AND ap.status = 'attended'
      AND extract(year FROM a.start_date) = extract(year FROM current_date)
  )
  WHERE m.id = member_id_input;
$$;

CREATE OR REPLACE FUNCTION public.trg_appointment_participant_event_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.member_id IS NOT NULL THEN
      PERFORM public.refresh_member_event_count(OLD.member_id);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.member_id IS DISTINCT FROM NEW.member_id
     AND OLD.member_id IS NOT NULL THEN
    PERFORM public.refresh_member_event_count(OLD.member_id);
  END IF;

  IF NEW.member_id IS NOT NULL THEN
    PERFORM public.refresh_member_event_count(NEW.member_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointment_participant_event_count ON public.appointment_participant;

CREATE TRIGGER appointment_participant_event_count
AFTER INSERT OR UPDATE OR DELETE ON public.appointment_participant
FOR EACH ROW
EXECUTE FUNCTION public.trg_appointment_participant_event_count();
