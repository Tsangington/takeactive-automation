-- Booking window from TakeActive (bookable_from_date is Europe/Berlin wall time).

ALTER TABLE public.appointment
  ADD COLUMN IF NOT EXISTS bookable_from integer,
  ADD COLUMN IF NOT EXISTS bookable_till integer,
  ADD COLUMN IF NOT EXISTS bookable_from_at timestamp without time zone;

-- once: a single appointment id
-- weekly: same Berlin weekday, start time, and duration (not the name)
CREATE TABLE IF NOT EXISTS public.booking_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('once', 'weekly')),
  appointment_id text,
  weekday smallint CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  start_time time,
  duration integer,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'once' AND appointment_id IS NOT NULL)
    OR (
      kind = 'weekly'
      AND weekday IS NOT NULL
      AND start_time IS NOT NULL
      AND duration IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS public.booking_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.booking_plan(id) ON DELETE CASCADE,
  appointment_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'booked', 'failed', 'cancelled')),
  error text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, appointment_id)
);

ALTER TABLE public.booking_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_attempt ENABLE ROW LEVEL SECURITY;
