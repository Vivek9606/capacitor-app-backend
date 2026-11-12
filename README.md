# Betterhood API

Backend for the Betterhood physio + patient app ([capacitor-app](https://github.com/Vivek9606/capacitor-app)).
Node 22 · Fastify 5 · Postgres (Supabase) · WhatsApp Cloud API.

- Physio login: WhatsApp OTP. A new number goes through quick sign-up.
- Patient login:
  - The first time, they tap the WhatsApp plan link (`/plan/:token`), confirm the last 4 digits of their number and give consent once.
  - After that, they log in with a WhatsApp OTP.
- Sessions are 30-day JWTs, sent as `Authorization: Bearer …`.
- Every query is scoped to the signed-in physio or patient.

## Run locally

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL + JWT_SECRET (see below)
npm run migrate             # creates the "app" schema and tables (safe to re-run)
npm run seed:exercises      # starter exercise library (34 exercises)
npm run seed:demo           # optional demo physio/patient (9876543210 / 9845011223, link /plan/riya-3wk)
npm run dev                 # http://localhost:8080  (GET /health)
```

For local testing, set `OTP_DEV_CODE=123456` and `WHATSAPP_PROVIDER=log`. Messages are then printed to the console instead of being sent.

Run the web app against it with `VITE_API_URL=http://localhost:8080 npm run dev` in `capacitor-app`. Include `http://localhost:5173` in `CORS_ORIGINS`.

## Database (Supabase)

Use the **session pooler** connection string, not `db.<ref>.supabase.co`. That direct host is IPv6-only, and DigitalOcean App Platform can't reach it.

```
postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

You'll find it in Supabase → Project Settings → Database → Connection string → **Session pooler**. URL-encode special characters in the password (`@` → `%40`).

Tables live in their own `app` schema with row-level security on and no policies. Supabase's public REST API therefore can't read them; only this server can.

## Deploy on DigitalOcean (App Platform)

1. **Create the app.**
   - In App Platform, create an app from GitHub → `Vivek9606/capacitor-app-backend`, branch `main`. The Dockerfile is detected automatically.
   - Or run `doctl apps create --spec .do/app.yaml`.
   - Pick region **Singapore** (closest to the Supabase project in Tokyo and to users in India).
2. **Set environment variables** (mark secrets as *Encrypted*):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Supabase session-pooler URL |
   | `JWT_SECRET` | 48+ random characters (`openssl rand -base64 48`) |
   | `NODE_ENV` | `production` |
   | `CORS_ORIGINS` | `https://your-web-domain` (comma-separated) |
   | `PUBLIC_WEB_URL` | where the web app is hosted. Used in WhatsApp links. |
   | `WHATSAPP_PROVIDER` | `log` until WhatsApp is set up, then `meta` |
   | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | from Meta for `meta` |
   | `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | for the webhook |

   **Do not set `OTP_DEV_CODE` in production.** With it set, anyone can log in as any number.
3. **Migrations and exercises** run automatically every time the container starts (both are safe to repeat). No extra jobs needed.
4. **Point the web app at the API.** Use the app URL (or a custom domain such as `api.betterhood.in`) as `VITE_API_URL` when building the web app.

You can also deploy to a Droplet with Docker: `docker build -t betterhood-api . && docker run -p 8080:8080 --env-file .env betterhood-api`.

## Physio directory (betterhood.in)

Physios list themselves at `betterhood.in/physio-directory/join/`. The app opens that same page for signed-in physios.

- `POST /directory/signup`: new number (OTP sign-up token) → physio account + live listing. It's the same account the app uses, so the physio logs in to the app with the same number.
- `GET` / `PUT /directory/me` (physio session): their listing, or a prefill from their app profile. The URL (`/physio/{slug}/`) is fixed once published. Qualification, experience, photo and registration number are copied to the app profile. A registration number puts the physio in the admin verification queue.
- `GET /public/directory`: every live listing in the website's profile shape. The website build pulls this (`scripts/sync-directory.mjs`). `GET /public/directory/:slug/photo` serves the photo.
- `POST /admin/directory/:physioId/status` `{status: live|hidden}`: listings go live without review. This takes one down.
- Slugs never clash with the profiles carried over from WordPress: the server reads `{PUBLIC_SITE_URL}/physios-index.json`.
- Going live: with `SITE_REBUILD_REPO` + `SITE_REBUILD_TOKEN` set, each save sends a `repository_dispatch` (`directory-updated`) to the website repo, batched over 20 s. The site rebuilds and deploys in a few minutes, and the form shows when the page is live.
- Add the website's origin to `CORS_ORIGINS`. Set `PUBLIC_APP_URL` to where the app's web build runs, so the website's "Book a session" button lands on the booking page.

## Admin dashboard (journeys)

The web app's `/admin` page (numbers in `ADMIN_PHONES`) shows the consumer journey and the physio journey.

- `GET /admin/journeys`: one row per consumer and per physio with their stage, milestones and last activity; a daily series for the last 180 days (sign-ups, sessions, bookings, plans, money collected, website submissions); retention by the week a care plan was sent; and what came in from the website. The dashboard works out period comparisons, funnels and insights from this.
- `GET /admin/timeline/:type/:id` (`patient` | `physio` | `lead`): everything that happened for one of them, plus the admins' notes and tags. Message text is never included.
- `POST /admin/notes`, `DELETE /admin/notes/:id`, `PUT /admin/tags`: internal notes and follow-up tags. These are the only things an admin can write here.
- `POST /public/web/submissions`: the website sends every lead form and every assessment result taken outside the app (`web_submissions`). A phone number, when the visitor gave one, links it to an app account.
- `last_seen_at` on physios and patients is set by `/me/bootstrap` (at most every 5 minutes).
- "Active" means something happened in the last 7 days, "slipping" 8 to 21 days, "inactive" longer.

## Video consults (LiveKit)

Bookings with visit type `teleconsult` become 1:1 video calls between the physio and patient inside the app.

- `POST /bookings/:id/call` (physio or patient session) returns a LiveKit token for room `bk_<bookingId>`.
  - Only that booking's physio and patient can get one.
  - The call opens 15 min before the start time and closes 30 min after the booked end.
- Set `LIVEKIT_URL` (`wss://<project>.livekit.cloud`), `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from LiveKit Cloud → Settings → Keys. Without them the endpoint returns `503 video_disabled`.
- Local testing: run `livekit-server --dev`, then use `ws://localhost:7880` with key `devkey` and secret `secret`.
- Nothing is recorded.

## WhatsApp via KwikEngage (current)

The business number is connected through KwikEngage (GoKwik), so don't register it again on Meta's developer dashboard.

- Set `WHATSAPP_PROVIDER=kwikengage` and `KWIKENGAGE_API_KEY`. The API takes the raw key in the `Authorization` header.
- Request: `POST https://api.kwikengage.ai/send-message/v2` with `{ to: "91XXXXXXXXXX", channel: "whatsapp", type: "template", content: { type: "template", template: { template_id: "<name>", language: "en", components: [<Meta-format components>] } } }`.
- KwikEngage returns `201 success` even when it ignores fields, so check the phone or KwikEngage's logs when testing a new template.
- Verified: `care_plan_shared` (body variables). Button templates (bookings, `auth_otp`) are untested.
- `WHATSAPP_TEMPLATES` lists the templates allowed to send. Add a template only after it's approved and tested.
- `WHATSAPP_ALLOWLIST` limits sends to test numbers. Clear it only when going live.

## WhatsApp (Meta Cloud API)

Create these templates in Meta Business Manager, language `en`. The body variables are in order:

| Template | Variables | Buttons |
|---|---|---|
| `auth_otp` (Authentication) | code | copy-code / one-tap |
| `care_plan_shared` | patient name, physio name, plan summary, link | — |
| `rx_shared` | patient name, physio name, link | — |
| `booking_confirmation` | patient name, physio name, date/time, place | quick replies: Confirm, Reschedule |
| `booking_reminder` | patient name, physio name, date/time, place | quick replies: Confirm, Reschedule |
| `physio_reply` | patient name, physio name, message, link | — |
| `consent_request` | patient name, physio name, form title, link | — |
| `invoice_shared` | patient name, physio name, invoice number, amount, link | — |

Set the webhook URL to `https://<api>/webhooks/whatsapp` with your `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`. Taps on Confirm and Reschedule update the booking. Signatures are checked with `WHATSAPP_APP_SECRET`.

Reminders are sent automatically about 2 hours before each booking (the job runs every 5 minutes inside the server).

## API overview

| | |
|---|---|
| `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/signup` | WhatsApp OTP login and physio sign-up |
| `GET /public/plan-link/:token`, `POST /auth/plan-link/verify` | patient entry from WhatsApp |
| `GET /me/bootstrap` | everything the signed-in user can see |
| `PATCH /physio/me` · `POST/PATCH /physio/patients` · `POST /physio/plans` · `POST /physio/templates` · `POST/PATCH /physio/bookings` · `POST /physio/messages` · `POST /physio/referrals` | physio actions |
| `POST /physio/blocks` · `DELETE /physio/blocks/:id` | blocked time (leave, rounds, lunch) |
| `POST/PATCH /physio/groups` · `POST /physio/groups/:id/participants` · `PATCH /physio/groups/:gid/participants/:pid` | group therapy sessions, seats and attendance |
| `POST/PATCH /physio/invoices` | invoices (server assigns `PREFIX-YYYY-0001` numbers and recomputes totals) |
| `POST /physio/consents` · `POST /physio/consents/:id/sign` · `PATCH /physio/consents/:id` | treatment consent forms (sign in clinic or send to the patient) |
| `POST /patient/consent` · `PUT /patient/sessions` · `POST/PATCH /patient/bookings` · `POST /patient/messages` · `POST /patient/consents/:id/sign` · `PATCH /patient/consents/:id` · `POST /patient/groups/:id/join` | patient actions |
| `GET /public/physios/:slug` · `POST /public/physios/:slug/booking-requests` · `POST /public/physios/:slug/groups/:id/join` | public profile, Calendly-style booking page (`/dr/:slug/book`) and group classes |
| `GET/POST /webhooks/whatsapp` | Meta webhook |
| `GET /health` | health check (also pings the DB) |
