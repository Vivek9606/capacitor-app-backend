set search_path = app;

-- Nudges an admin sent by hand from the dashboard: their phone. Null = the automatic job.
alter table nudges add column if not exists sent_by text;
