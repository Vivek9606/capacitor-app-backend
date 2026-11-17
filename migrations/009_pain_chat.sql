-- Pain chat: a signed-in consumer describes their pain to an assistant, which assesses it over a few turns and then
-- offers a free video consult with a matched physio, sponsored by Betterhood.
set search_path = app;

create table if not exists pain_chats (
  id          text primary key,
  patient_id  text not null references patients (id) on delete cascade,
  -- [{ role: 'user' | 'assistant', text, at }]
  messages    jsonb not null default '[]',
  -- What the assistant has worked out so far (area, duration, severity, stage, red flags, summary for the physio, ...)
  assessment  jsonb not null default '{}',
  status      text not null default 'open' check (status in ('open', 'ready', 'red_flag', 'booked', 'closed')),
  -- 'claude' or 'scripted' (the fixed-question fallback used when no Anthropic key is configured)
  engine      text not null default 'claude',
  physio_id   text references physios (id) on delete set null,
  booking_id  text references bookings (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pain_chats_patient_idx on pain_chats (patient_id, created_at desc);

-- A sponsored booking is the free consult (one per phone number while it isn't cancelled). Done sponsored bookings
-- are what Betterhood pays physios for. brief = the chat summary the physio reads before the call.
alter table bookings add column if not exists sponsored boolean not null default false;
alter table bookings add column if not exists brief text;
create index if not exists bookings_sponsored_idx on bookings (patient_phone) where sponsored;
