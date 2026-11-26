set search_path = app;

-- Push notifications: one row per device the app is signed in on (Firebase Cloud Messaging token).
-- A token moves to whoever signed in last on that device.
create table if not exists push_tokens (
  token        text primary key,
  subject_type text not null check (subject_type in ('patient', 'physio')),
  subject_id   text not null,
  platform     text not null check (platform in ('android', 'ios', 'web')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_tokens_subject_idx on push_tokens (subject_type, subject_id);
alter table push_tokens enable row level security;

-- Engagement nudges (health score, exercises): one row per nudge, so the same nudge is never sent twice and the
-- admin dashboard can count them. ref says what it was about (an assessment id, a plan id + period).
create table if not exists nudges (
  id           bigserial primary key,
  subject_type text not null check (subject_type in ('patient', 'physio')),
  subject_id   text not null,
  kind         text not null,
  ref          text not null,
  channels     text[] not null default '{}',   -- what actually went out: 'push', 'whatsapp'
  sent_at      timestamptz not null default now(),
  unique (subject_type, subject_id, kind, ref)
);
create index if not exists nudges_subject_idx on nudges (subject_type, subject_id, sent_at desc);
alter table nudges enable row level security;
