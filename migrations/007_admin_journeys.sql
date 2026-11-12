-- Master admin dashboard: last-active tracking, what the website collects, and the admins' own notes and tags.
set search_path = app;

-- When the person last opened the app (set on /me/bootstrap, at most once every few minutes).
alter table physios add column if not exists last_seen_at timestamptz;
alter table patients add column if not exists last_seen_at timestamptz;

-- Everything a visitor submits on betterhood.in: lead forms and assessment results taken outside the app.
-- Contact details are only there when the visitor typed them into the form. `phone` (10 digits) is what
-- links a submission to an app account later.
create table if not exists web_submissions (
  id          text primary key,
  kind        text not null check (kind in ('form', 'assessment')),
  form        text not null,        -- form name (contact, newsletter...) or the assessment slug
  page        text,                 -- path it was sent from
  name        text,
  phone       text,
  email       text,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists web_submissions_created_idx on web_submissions (created_at desc);
create index if not exists web_submissions_phone_idx on web_submissions (phone) where phone is not null;
alter table web_submissions enable row level security;

-- Internal notes on a consumer, a physio or a website lead. Never shown to the person.
create table if not exists admin_notes (
  id            text primary key,
  subject_type  text not null check (subject_type in ('patient', 'physio', 'lead')),
  subject_id    text not null,
  text          text not null,
  author        text not null,      -- the admin's phone
  created_at    timestamptz not null default now()
);
create index if not exists admin_notes_subject_idx on admin_notes (subject_type, subject_id, created_at desc);
alter table admin_notes enable row level security;

-- Follow-up tags on the same subjects (e.g. "call back", "high intent").
create table if not exists admin_tags (
  subject_type  text not null check (subject_type in ('patient', 'physio', 'lead')),
  subject_id    text not null,
  tags          text[] not null default '{}',
  updated_at    timestamptz not null default now(),
  primary key (subject_type, subject_id)
);
alter table admin_tags enable row level security;
