set search_path = app;

-- Slouch Catcher (betterhood.in/slouch-catcher/): catch a friend slouching, share it, earn points, swap 1000 points
-- for a shop coupon. People are betterhood accounts; points belong to the phone number (one person, whether they
-- are signed in as a patient or a physio). Photos are never stored, only results.

-- A catch: who snapped whom. The WhatsApp link is betterhood.in/slouch-catcher/c/?code=<code>.
create table if not exists slouch_catches (
  id            text primary key,
  code          text not null unique,
  analysis_id   text not null unique,           -- one catch per photo analysis
  catcher_phone text not null,
  catcher_name  text,
  target_name   text not null,
  target_phone  text,                           -- set when the caught person signs in from the link
  persona       text not null,
  verdict       text not null check (verdict in ('good', 'bad')),
  score         numeric(3, 1) not null check (score between 0 and 10),
  zones         jsonb,
  summary       text,
  issues        jsonb,
  created_at    timestamptz not null default now(),
  joined_at     timestamptz
);
create index if not exists slouch_catches_catcher_idx on slouch_catches (catcher_phone, created_at desc);

create table if not exists slouch_coupons (
  id            text primary key,
  phone         text not null,
  code          text not null,
  value_inr     int not null,
  points_spent  int not null,
  source        text not null check (source in ('shopify', 'pool', 'test')),
  created_at    timestamptz not null default now()
);
create index if not exists slouch_coupons_phone_idx on slouch_coupons (phone);
create unique index if not exists slouch_coupons_code_uniq on slouch_coupons (code) where source <> 'test';

-- Points ledger: every change is a row, the balance is the sum. dedupe_key stops a reward being paid twice
-- (e.g. 'join:<catcher>:<target>' pays once per pair of people, ever).
create table if not exists slouch_points (
  id          bigint generated always as identity primary key,
  phone       text not null,
  delta       int not null,
  reason      text not null check (reason in ('welcome', 'snap', 'join', 'redeem', 'adjust')),
  dedupe_key  text not null unique,
  catch_id    text references slouch_catches(id),
  coupon_id   text references slouch_coupons(id),
  created_at  timestamptz not null default now()
);
create index if not exists slouch_points_phone_idx on slouch_points (phone, created_at desc);

-- Ready-made coupon codes (made by hand in Shopify), used when there is no Shopify API token.
create table if not exists slouch_coupon_pool (
  code        text primary key,
  value_inr   int not null,
  added_at    timestamptz not null default now(),
  claimed_by  text,
  claimed_at  timestamptz
);

-- One row per photo analysed (the result only, never the photo or who took it), for the admin numbers.
create table if not exists slouch_analyses (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  persona     text,
  verdict     text not null,
  score       numeric(3, 1),
  setting     text,
  test        boolean not null default false
);
create index if not exists slouch_analyses_created_idx on slouch_analyses (created_at);

alter table slouch_catches enable row level security;
alter table slouch_coupons enable row level security;
alter table slouch_points enable row level security;
alter table slouch_coupon_pool enable row level security;
alter table slouch_analyses enable row level security;
