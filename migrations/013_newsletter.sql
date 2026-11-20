set search_path = app;

-- Email newsletter. People subscribe on the website (or are added by admin), confirm by clicking a link
-- in the confirmation email (double opt-in), get the welcome email, then every issue admin sends.
-- Sending goes through Resend (see src/email.ts).

create table if not exists newsletter_subscribers (
  id              text primary key,
  email           text not null,                      -- always stored lower-case
  name            text,
  status          text not null default 'pending'
                  check (status in ('pending', 'subscribed', 'unsubscribed', 'bounced', 'complained')),
  source          text,                                -- where they signed up: website form name, 'admin', ...
  page            text,                                -- website path of the form
  confirm_token   text not null,
  unsub_token     text not null,
  created_at      timestamptz not null default now(),
  confirm_sent_at timestamptz,
  confirmed_at    timestamptz,                         -- when they clicked the confirmation link (their consent)
  welcome_sent_at timestamptz,
  unsubscribed_at timestamptz,
  last_sent_at    timestamptz
);
create unique index if not exists newsletter_subscribers_email on newsletter_subscribers (email);
create unique index if not exists newsletter_subscribers_confirm on newsletter_subscribers (confirm_token);
create unique index if not exists newsletter_subscribers_unsub on newsletter_subscribers (unsub_token);
alter table newsletter_subscribers enable row level security;

-- An issue is one newsletter. kind 'welcome' is the single welcome email, edited in admin like an issue.
create table if not exists newsletter_issues (
  id          text primary key,
  kind        text not null default 'issue' check (kind in ('issue', 'welcome')),
  subject     text not null default '',
  preheader   text not null default '',
  content     jsonb not null default '{}'::jsonb,     -- { headline, intro, blocks: [...], signoff }
  status      text not null default 'draft' check (status in ('draft', 'sending', 'sent')),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  test_sent_at timestamptz,
  send_started_at timestamptz,
  sent_at     timestamptz
);
create unique index if not exists newsletter_issues_one_welcome on newsletter_issues (kind) where kind = 'welcome';
alter table newsletter_issues enable row level security;

-- Every email sent: confirmations, welcomes, issues and tests. Status is updated from Resend's webhook.
create table if not exists newsletter_sends (
  id            text primary key,
  kind          text not null check (kind in ('confirm', 'welcome', 'issue', 'test')),
  issue_id      text references newsletter_issues (id) on delete set null,
  subscriber_id text references newsletter_subscribers (id) on delete set null,
  email         text not null,
  provider_id   text,                                  -- Resend's email id
  status        text not null default 'sent'
                check (status in ('sent', 'skipped', 'failed', 'delivered', 'delayed', 'bounced', 'complained')),
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists newsletter_sends_issue on newsletter_sends (issue_id, kind);
create index if not exists newsletter_sends_provider on newsletter_sends (provider_id);
create index if not exists newsletter_sends_subscriber on newsletter_sends (subscriber_id);
-- One issue email per subscriber, so a send that stops halfway can be resumed without doubles.
create unique index if not exists newsletter_sends_once on newsletter_sends (issue_id, subscriber_id) where kind = 'issue';
alter table newsletter_sends enable row level security;
