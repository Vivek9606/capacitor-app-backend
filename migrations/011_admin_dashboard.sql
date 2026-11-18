set search_path = app;

-- Phone numbers the team uses for testing. Marking a number only hides it from the admin dashboard's numbers;
-- nothing about the person is changed or deleted.
create table if not exists test_contacts (
  phone     text primary key,
  note      text,
  marked_by text,
  marked_at timestamptz not null default now()
);
alter table test_contacts enable row level security;

-- When the consumer got their physio (any route: added by the physio, invite link, admin, pain chat, sign-up).
alter table patients add column if not exists matched_at timestamptz;
update patients set matched_at = coalesce(since::timestamptz, created_at) where physio_id is not null and matched_at is null;

create or replace function app.set_matched_at() returns trigger language plpgsql as $$
begin
  if new.physio_id is null then
    new.matched_at := null;
  elsif tg_op = 'INSERT' or old.physio_id is distinct from new.physio_id then
    new.matched_at := now();
  end if;
  return new;
end $$;

drop trigger if exists patients_matched_at on patients;
create trigger patients_matched_at before insert or update of physio_id on patients
  for each row execute function app.set_matched_at();
