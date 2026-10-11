-- Weekly plans match synced appointments by weekday, start time, and duration.
-- A daily cron asks book-appointments to record new matches as scheduled.

ALTER TABLE public.appointment
  ADD COLUMN IF NOT EXISTS duration integer;

ALTER TABLE public.booking_attempt
  DROP CONSTRAINT IF EXISTS booking_attempt_status_check;

ALTER TABLE public.booking_attempt
  ADD CONSTRAINT booking_attempt_status_check
  CHECK (status IN ('scheduled', 'pending', 'booked', 'failed', 'cancelled'));

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE
  existing bigint;
BEGIN
  SELECT jobid INTO existing FROM cron.job WHERE jobname = 'enroll-weekly-bookings';
  IF existing IS NOT NULL THEN
    PERFORM cron.unschedule(existing);
  END IF;
END $$;

-- 04:00 UTC is 06:00 Berlin during CEST and 05:00 during CET.
-- Vault secrets, created once in the SQL editor:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<anon key>', 'publishable_key');
SELECT cron.schedule(
  'enroll-weekly-bookings',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/book-appointments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key')
    ),
    body := '{"action":"enroll"}'::jsonb
  ) AS request_id;
  $$
);
