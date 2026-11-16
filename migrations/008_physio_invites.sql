-- Physio invite links: a physio shares betterhood.in/quiz-landing-page/?physio=<their slug>; a patient who takes the
-- assessment from it and saves the result is linked to that physio straight away (no admin matching).
set search_path = app;
alter table patients add column if not exists invited_by text references physios (id) on delete set null;
create index if not exists patients_invited_by_idx on patients (invited_by) where invited_by is not null;
