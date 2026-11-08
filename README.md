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

Set the webhook URL to `https://<api>/webhooks/whatsapp` with your `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`. Taps on Confirm and Reschedule update the booking. Signatures are checked with `WHATSAPP_APP_SECRET`.

Reminders are sent automatically about 2 hours before each booking (the job runs every 5 minutes inside the server).

## API overview

| | |
|---|---|
| `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/signup` | WhatsApp OTP login and physio sign-up |
| `GET /public/plan-link/:token`, `POST /auth/plan-link/verify` | patient entry from WhatsApp |
| `GET /me/bootstrap` | everything the signed-in user can see |
| `PATCH /physio/me` · `POST/PATCH /physio/patients` · `POST /physio/plans` · `POST /physio/templates` · `POST/PATCH /physio/bookings` · `POST /physio/messages` · `POST /physio/referrals` | physio actions |
| `POST /patient/consent` · `PUT /patient/sessions` · `POST/PATCH /patient/bookings` · `POST /patient/messages` | patient actions |
| `GET /public/physios/:slug` · `POST /public/physios/:slug/booking-requests` | public profile and booking |
| `GET/POST /webhooks/whatsapp` | Meta webhook |
| `GET /health` | health check (also pings the DB) |
