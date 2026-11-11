-- Physio directory listings on betterhood.in, and every website assessment (not just pain) logged from the app.
set search_path = app;

-- One public listing per physio. The website pulls the live ones at build time and serves them at /physio/{slug}/.
-- `profile` holds the listing in the website's own profile shape (about, education, experience, practice...).
create table if not exists directory_profiles (
  physio_id     text primary key references physios (id) on delete cascade,
  slug          text not null unique,
  status        text not null default 'live' check (status in ('live', 'hidden')),
  profile       jsonb not null,
  photo         text,              -- small data URL; served from /public/directory/:slug/photo
  published_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table directory_profiles enable row level security;

-- The app now runs the website's assessments (pain, health level 2, longevity) inside the app.
alter table assessments add column if not exists kind text not null default 'pain' check (kind in ('pain', 'health', 'longevity'));
alter table assessments add column if not exists scores jsonb;   -- health/longevity: { overall, strength, balance, mobility } out of 10
alter table assessments add column if not exists source text not null default 'app';
