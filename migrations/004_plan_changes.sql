-- Physios can edit an active care plan in place. Each edit is logged with the physio's reason.
set search_path = app;
alter table plans add column if not exists changes jsonb not null default '[]';
alter table plans add column if not exists updated_at timestamptz;

-- Plans the patient already worked on were "opened", even if the app never recorded it.
update plans p set opened_at = coalesce(
  (select min(s.date)::timestamptz from session_logs s where s.plan_id = p.id), now())
 where opened_at is null and exists (select 1 from session_logs s where s.plan_id = p.id);
