-- Patient discharge (end of an episode of care) and the practice a booking is for.

-- Discharged patients keep their history; discharged_at is cleared when the physio takes them on again.
alter table patients add column if not exists discharged_at timestamptz;
-- { outcome, note, advice, at } as the physio recorded it.
alter table patients add column if not exists discharge jsonb;

-- Physios who consult at more than one place: which one the patient booked ("Name, address").
alter table bookings add column if not exists location text;
