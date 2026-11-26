-- Where a self sign-up account was made, e.g. 'assessment:assessment-lower-back-pain' (the website creates the account
-- when someone finishes an assessment). Null: the app, the website's account page, or older accounts.
set search_path = app;
alter table patients add column if not exists signup_via text;
