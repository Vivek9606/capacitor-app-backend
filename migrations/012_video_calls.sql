set search_path = app;
-- When each side first joined a video consult (set when the API hands out a call token).
-- "Held" on the admin dashboard = both sides joined.
alter table bookings add column if not exists physio_joined_at timestamptz;
alter table bookings add column if not exists patient_joined_at timestamptz;
