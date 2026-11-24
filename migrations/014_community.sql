set search_path = app;

-- Community (physio forum). Everyone talks in "General"; admins open more channels for focused discussions
-- (e.g. "ACL rehab", "Pricing your sessions"). A post can have replies one level deep.
-- Physios post as themselves; admins post as "Betterhood team" (author_physio_id is null).

create table if not exists community_channels (
  id          text primary key,
  name        text not null,
  description text not null default '',
  is_default  boolean not null default false,          -- "General": always there, can't be archived
  pinned      boolean not null default false,          -- shown first
  archived_at timestamptz,                             -- hidden from physios; posts are kept
  created_by  text,                                    -- admin phone
  created_at  timestamptz not null default now(),
  last_post_at timestamptz
);
create unique index if not exists community_channels_one_default on community_channels (is_default) where is_default;
alter table community_channels enable row level security;

insert into community_channels (id, name, description, is_default, pinned)
values ('cc_general00', 'General', 'Introduce yourself, ask anything, share what''s working in your practice.', true, true)
on conflict do nothing;

create table if not exists community_posts (
  id               text primary key,
  channel_id       text not null references community_channels (id) on delete cascade,
  parent_id        text references community_posts (id) on delete cascade,  -- null = top-level post
  author_physio_id text references physios (id) on delete set null,
  author_admin     text,                                                    -- admin phone when posted as the team
  body             text not null,
  status           text not null default 'visible' check (status in ('visible', 'removed')),
  removed_reason   text,
  removed_at       timestamptz,
  edited_at        timestamptz,
  created_at       timestamptz not null default now(),
  last_reply_at    timestamptz,                                             -- top-level posts: bumps the thread
  reply_count      int not null default 0
);
create index if not exists community_posts_channel on community_posts (channel_id, created_at desc) where parent_id is null;
create index if not exists community_posts_parent on community_posts (parent_id, created_at);
alter table community_posts enable row level security;

-- "Helpful" reactions, one per physio per post.
create table if not exists community_reactions (
  post_id    text not null references community_posts (id) on delete cascade,
  physio_id  text not null references physios (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, physio_id)
);
alter table community_reactions enable row level security;

-- Unread badges: when each physio last opened each channel.
create table if not exists community_reads (
  channel_id   text not null references community_channels (id) on delete cascade,
  physio_id    text not null references physios (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, physio_id)
);
alter table community_reads enable row level security;

-- Physios flag posts; admins review them on the dashboard. physio_id is null when the system filed it
-- (the safety check couldn't run, so the post went out unchecked).
create table if not exists community_reports (
  id          text primary key,
  post_id     text not null references community_posts (id) on delete cascade,
  physio_id   text references physios (id) on delete cascade,
  reason      text not null default '',
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolution  text check (resolution in ('removed', 'kept'))
);
create unique index if not exists community_reports_once on community_reports (post_id, physio_id);
alter table community_reports enable row level security;

-- Posts the safety check stopped (never published), so admins can see how often it fires and why.
-- The text itself is NOT stored: a post blocked for patient details must not be kept anywhere.
create table if not exists community_blocked (
  id         text primary key,
  physio_id  text references physios (id) on delete set null,
  channel_id text,
  reason     text not null,
  engine     text not null,
  created_at timestamptz not null default now()
);
alter table community_blocked enable row level security;
