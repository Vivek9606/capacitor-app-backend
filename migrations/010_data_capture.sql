-- Data capture: keep everything a person tells us, carry it across website → account → app → admin, and record
-- consent properly.
set search_path = app;

-- Assessments: the answers themselves, not just the category they add up to.
alter table assessments add column if not exists answers          jsonb;                 -- [{ q, a }] in the order asked; a is text or a list
alter table assessments add column if not exists pain_score       smallint check (pain_score between 0 and 10);
alter table assessments add column if not exists advisory_reasons text[] not null default '{}'; -- the answers that triggered the critical advisory
alter table assessments add column if not exists taken_at         timestamptz;           -- when it was taken (created_at = when it was saved)
alter table assessments add column if not exists form_version     text;                  -- which version of the questions was asked

-- Website submissions: the result's own id (same id in the account and the app), and whose it turned out to be.
-- A submission's phone was typed, not verified: it is only linked to an account once that person verifies the
-- number and confirms the result is theirs (or saves it themselves, signed in).
alter table web_submissions add column if not exists result_id  text;
alter table web_submissions add column if not exists claimed_by text references patients (id) on delete set null;
alter table web_submissions add column if not exists claimed_at timestamptz;
alter table web_submissions add column if not exists disowned   boolean not null default false; -- "not mine" from the verified owner of that number
create index if not exists web_submissions_result_idx on web_submissions (result_id) where result_id is not null;
create index if not exists web_submissions_claimed_idx on web_submissions (claimed_by) where claimed_by is not null;

-- WhatsApp updates opt-in (OTPs and booking confirmations are transactional and don't need it).
alter table patients add column if not exists whatsapp_opt_in    boolean;
alter table patients add column if not exists whatsapp_opt_in_at timestamptz;
alter table physios  add column if not exists whatsapp_opt_in    boolean;
alter table physios  add column if not exists whatsapp_opt_in_at timestamptz;

-- Every consent given or withdrawn: what was agreed, in which words, where and when. Append-only.
create table if not exists consents_log (
  id           text primary key,
  subject_type text not null check (subject_type in ('patient', 'physio')),
  subject_id   text not null,
  phone        text not null,
  purpose      text not null check (purpose in ('terms', 'share_with_physio', 'whatsapp_updates')),
  granted      boolean not null,
  version      text not null,
  wording      text not null,
  channel      text not null check (channel in ('web', 'app')),
  at           timestamptz not null default now()
);
create index if not exists consents_log_subject_idx on consents_log (subject_type, subject_id, at desc);
alter table consents_log enable row level security;
