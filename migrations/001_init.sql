-- Betterhood core schema.
-- Lives in its own schema ("app") so Supabase's auto-generated REST API (which exposes "public")
-- never serves it, and RLS is enabled with no policies as a second lock. Only this backend
-- (connecting as the database owner) can read or write these tables.

create schema if not exists app;
set search_path = app;

create table physios (
  id                 text primary key,
  phone              text not null unique,
  name               text not null,
  email              text,
  qualification      text,
  experience_yrs     int,
  council_reg_no     text,
  verification       text not null default 'none' check (verification in ('none', 'pending', 'verified')),
  photo              text,
  focus_areas        text[] not null default '{}',
  practice_settings  text[] not null default '{}',
  slug               text not null unique,
  clinic             jsonb,
  consult            jsonb not null,
  working_days       text[] not null default '{Mon,Tue,Wed,Thu,Fri,Sat}',
  hours              jsonb,
  invite_code        text not null unique,
  referred_by        text references physios (id),
  partner_opt_ins    text[] not null default '{}',
  community_waitlist boolean not null default false,
  community_topics   text[] not null default '{}',
  created_at         timestamptz not null default now()
);

create table patients (
  id          text primary key,
  physio_id   text not null references physios (id) on delete cascade,
  phone       text not null,
  name        text not null,
  age         int,
  sex         text check (sex in ('F', 'M', 'O')),
  condition   text,
  since       date,
  tags        text[] not null default '{}',
  visits      int not null default 0,
  link_token  text not null unique,
  consent_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (physio_id, phone)
);
create index patients_phone_idx on patients (phone);

create table exercises (
  id         text primary key,
  name       text not null,
  region     text not null,
  category   text not null,
  dose       jsonb not null,
  cues       text[] not null default '{}',
  video_url  text,
  active     boolean not null default true
);

create table plans (
  id             text primary key,
  patient_id     text not null references patients (id) on delete cascade,
  physio_id      text not null references physios (id) on delete cascade,
  title          text not null,
  items          jsonb not null default '[]',
  days_per_week  int not null check (days_per_week between 1 and 7),
  weeks          int not null check (weeks between 1 and 52),
  start_date     date not null,
  status         text not null check (status in ('active', 'completed', 'replaced')),
  sent_at        timestamptz not null default now(),
  opened_at      timestamptz,
  rx             jsonb
);
create index plans_patient_idx on plans (patient_id);
create index plans_physio_idx on plans (physio_id);

create table session_logs (
  id       text primary key,
  plan_id  text not null references plans (id) on delete cascade,
  date     date not null,
  status   text not null check (status in ('done', 'skipped')),
  pain     int check (pain between 0 and 10),
  note     text,
  unique (plan_id, date)
);

create table bookings (
  id                text primary key,
  physio_id         text not null references physios (id) on delete cascade,
  patient_id        text references patients (id) on delete set null,
  patient_name      text not null,
  patient_phone     text not null,
  date              date not null,
  time              text not null check (time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  visit_type        text not null check (visit_type in ('in_clinic', 'home_visit', 'teleconsult')),
  reason            text,
  is_new_patient    boolean not null default false,
  status            text not null check (status in ('requested', 'awaiting', 'confirmed', 'reminder_sent', 'reschedule', 'cancelled', 'done')),
  send_confirmation boolean not null default true,
  reminder          boolean not null default true,
  reminder_sent_at  timestamptz,
  source            text not null check (source in ('physio', 'public_profile')),
  created_at        timestamptz not null default now()
);
create index bookings_physio_date_idx on bookings (physio_id, date);
create index bookings_patient_idx on bookings (patient_id);

create table messages (
  id          text primary key,
  physio_id   text not null references physios (id) on delete cascade,
  patient_id  text not null references patients (id) on delete cascade,
  sender      text not null check (sender in ('physio', 'patient')),
  text        text not null,
  at          timestamptz not null default now(),
  read        boolean not null default false
);
create index messages_patient_idx on messages (patient_id, at);

create table referrals (
  id           text primary key,
  referrer_id  text not null references physios (id) on delete cascade,
  referred_id  text references physios (id) on delete set null,
  name         text not null,
  status       text not null check (status in ('pending', 'joined', 'activated')),
  at           timestamptz not null default now()
);
create index referrals_referrer_idx on referrals (referrer_id);

create table plan_templates (
  id             text primary key,
  physio_id      text not null references physios (id) on delete cascade,
  title          text not null,
  items          jsonb not null,
  days_per_week  int not null,
  weeks          int not null,
  created_at     timestamptz not null default now()
);

-- One-time codes (hashed). Old rows are pruned by the server.
create table otp_codes (
  id          bigserial primary key,
  phone       text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index otp_codes_phone_idx on otp_codes (phone, created_at desc);

-- Brute-force guard for the "last 4 digits" plan-link check.
create table link_attempts (
  link_token  text primary key,
  attempts    int not null default 0,
  locked_until timestamptz,
  updated_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;
