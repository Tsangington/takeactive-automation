-- At :29 and :59, call book-appointments when an enabled plan has a slot
-- whose Berlin booking window opens within 70 seconds, or is already open.
-- :59 is one minute before an hour mark, :29 one minute before a half-hour.
-- The function logs in, sleeps until that instant, then accepts.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE
  existing bigint;
BEGIN
  SELECT jobid INTO existing FROM cron.job WHERE jobname = 'book-appointments-on-open';
  IF existing IS NOT NULL THEN
    PERFORM cron.unschedule(existing);
  END IF;
END $$;

-- Vault secrets, same pair as enroll-weekly-bookings:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<anon key>', 'publishable_key');
SELECT cron.schedule(
  'book-appointments-on-open',
  '29,59 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/book-appointments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key')
    ),
    body := '{"action":"book"}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id
  WHERE EXISTS (
    SELECT 1
    FROM public.booking_plan p
    JOIN public.appointment a ON (
      (p.kind = 'once' AND a.id = p.appointment_id)
      OR (
        p.kind = 'weekly'
        AND a.duration = p.duration
        AND a.start_time = p.start_time
        AND EXTRACT(DOW FROM a.start_date)::smallint = p.weekday
      )
    )
    LEFT JOIN public.booking_attempt ba
      ON ba.plan_id = p.id
      AND ba.appointment_id = a.id
    WHERE p.enabled
      AND COALESCE(a.is_decline, false) = false
      AND a.bookable_from_at IS NOT NULL
      AND (a.start_date + a.start_time) > (now() AT TIME ZONE 'Europe/Berlin')
      AND a.bookable_from_at <= (now() AT TIME ZONE 'Europe/Berlin') + interval '70 seconds'
      AND (
        ba.status IS NULL
        OR ba.status IN ('scheduled', 'failed')
        OR (
          ba.status = 'pending'
          AND ba.attempted_at < now() - interval '70 seconds'
        )
      )
  );
  $$
);
