-- Practice modes, availability, walk-ins & attendance, blocked time, group sessions,
-- invoices and treatment consent forms.
set search_path = app;

-- ---------- physio profile ----------
alter table physios
  add column if not exists practice        jsonb,                    -- { modes: [clinic|home|individual], serviceArea, travelBufferMin, locations[] }
  add column if not exists availability    jsonb,                    -- { weekly: { Mon: [{start,end}] }, slotStepMin, bufferMin, minNoticeHours, maxDaysAhead }
  add column if not exists billing         jsonb,                    -- { upiId, gstin, invoicePrefix, taxPct, footer }
  add column if not exists course_progress text[] not null default '{}';

-- ---------- bookings: walk-ins, check-in, no-shows, visit length, home address ----------
alter table bookings
  add column if not exists minutes       int check (minutes between 5 and 480),
  add column if not exists address       text,
  add column if not exists checked_in_at timestamptz;

alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('requested', 'awaiting', 'confirmed', 'reminder_sent', 'reschedule', 'checked_in', 'no_show', 'cancelled', 'done'));
alter table bookings drop constraint if exists bookings_source_check;
alter table bookings add constraint bookings_source_check
  check (source in ('physio', 'public_profile', 'walk_in'));

-- ---------- blocked time (whole day when start/end are null) ----------
create table if not exists blocks (
  id         text primary key,
  physio_id  text not null references physios (id) on delete cascade,
  date       date not null,
  start_time text check (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  end_time   text check (end_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  reason     text,
  created_at timestamptz not null default now(),
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or start_time < end_time)
);
create index if not exists blocks_physio_date_idx on blocks (physio_id, date);

-- ---------- group therapy sessions ----------
create table if not exists group_sessions (
  id             text primary key,
  physio_id      text not null references physios (id) on delete cascade,
  series_id      text,
  title          text not null,
  description    text,
  date           date not null,
  time           text not null check (time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  minutes        int not null check (minutes between 10 and 480),
  capacity       int not null check (capacity between 1 and 200),
  fee            int not null default 0 check (fee >= 0),
  location       text not null,
  public_booking boolean not null default true,
  status         text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'done')),
  -- [{ id, patientId?, name, phone, status: booked|attended|no_show|cancelled, joinedAt }]
  participants   jsonb not null default '[]',
  created_at     timestamptz not null default now()
);
create index if not exists group_sessions_physio_date_idx on group_sessions (physio_id, date);

-- ---------- invoices ----------
create table if not exists invoices (
  id               text primary key,
  physio_id        text not null references physios (id) on delete cascade,
  patient_id       text references patients (id) on delete set null,
  patient_name     text not null,
  patient_phone    text not null,
  number           text not null,
  date             date not null,
  items            jsonb not null,                -- [{ description, qty, rate }]
  discount         int not null default 0 check (discount >= 0),
  tax_pct          numeric(5, 2) not null default 0 check (tax_pct between 0 and 28),
  total            int not null check (total >= 0),
  status           text not null check (status in ('unpaid', 'paid', 'void')),
  method           text check (method in ('cash', 'upi', 'card', 'bank', 'other')),
  paid_at          timestamptz,
  notes            text,
  booking_id       text references bookings (id) on delete set null,
  group_session_id text references group_sessions (id) on delete set null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (physio_id, number)
);
create index if not exists invoices_physio_idx on invoices (physio_id, date);
create index if not exists invoices_patient_idx on invoices (patient_id);

-- ---------- treatment consent forms ----------
create table if not exists consents (
  id           text primary key,
  physio_id    text not null references physios (id) on delete cascade,
  patient_id   text not null references patients (id) on delete cascade,
  form_id      text not null,
  title        text not null,
  body         text not null,                     -- the exact text the patient agreed to
  status       text not null check (status in ('pending', 'signed', 'declined', 'revoked')),
  method       text not null check (method in ('in_clinic', 'remote')),
  signed_name  text,
  signature    text,                              -- PNG data URL
  guardian     text,
  requested_at timestamptz not null default now(),
  signed_at    timestamptz
);
create index if not exists consents_patient_idx on consents (patient_id);

alter table blocks enable row level security;
alter table group_sessions enable row level security;
alter table invoices enable row level security;
alter table consents enable row level security;
