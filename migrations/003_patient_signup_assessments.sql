-- Patients can now sign up on their own (no physio yet). An admin confirms which physio they go to.
set search_path = app;
alter table patients alter column physio_id drop not null;
alter table patients add column if not exists city text;
alter table patients add column if not exists email text;
alter table patients add column if not exists self_signup boolean not null default false;
-- pending: no suggestion yet · suggested: system picked a physio, waiting for admin · confirmed: physio assigned
alter table patients add column if not exists match_status text check (match_status in ('pending', 'suggested', 'confirmed'));
alter table patients add column if not exists suggested_physio_id text references physios (id) on delete set null;
-- One self-signed-up (unassigned) account per number.
create unique index if not exists patients_self_phone_idx on patients (phone) where physio_id is null;

-- Results of the betterhood pain assessments taken in the app.
create table if not exists assessments (
  id          text primary key,
  patient_id  text not null references patients (id) on delete cascade,
  slug        text not null,       -- e.g. assessment-lower-back-pain
  area        text not null,       -- back | neck | shoulder | knee
  title       text not null,
  cat         text,                -- muscle | nerve | bone | joint
  condition   text,
  result      text,                -- betterhood.in result page slug
  advisory    text,
  totals      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists assessments_patient_idx on assessments (patient_id, created_at desc);
alter table assessments enable row level security;
