-- Restore the 20-minute window: remove the temporary 2-hour lookback used for debugging.
CREATE OR REPLACE FUNCTION public.get_upcoming_unchecked_appointments(
  from_time timestamp with time zone,
  to_time timestamp with time zone
)
RETURNS TABLE(id text, max_participants integer, master_company_id text)
LANGUAGE sql
AS $$
  select id, max_participants, master_company_id
  from appointment
  where checked = false
  and (start_date + start_time)::timestamp at time zone 'Europe/Berlin' >= from_time
  and (start_date + start_time)::timestamp at time zone 'Europe/Berlin' <= to_time;
$$;
