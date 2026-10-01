# MedAssist Hospital Appointment System

## Run locally

Copy `backend/.env.example` to `backend/.env` and fill it in (at least `DATABASE_URL`,
`JWT_SECRET`, `GEMINI_API_KEY`). Then open two terminals from the project folder:

### Backend
```powershell
cd backend
npm install
npm run dev
```
Backend: `http://localhost:3000`

### Dashboard
```powershell
cd dashboard
npm install
npm run dev
```
Dashboard: `http://localhost:5173`

## Routes
- Landing / choose sign-in: `http://localhost:5173/`
- Patient booking: `http://localhost:5173/citizen`
- Staff login: `http://localhost:5173/login`
- Reception dashboard: `http://localhost:5173/reception`
- Doctor dashboard: `http://localhost:5173/doctor`
- Appointments (staff): `http://localhost:5173/appointments`
- Patients (staff): `http://localhost:5173/patients`
- Admin: `http://localhost:5173/admin`

Staff routes require login; opening them directly without a session redirects to `/login`.

## Demo staff
- Admin: `admin` / `admin123`
- Reception: `reception` / `doctor123`
- Doctors: `dr<doctor-id>` / `doctor123`

## Database
Run `database/schema.sql` in Neon SQL Editor. It contains the base schema and demo seed/migration statements.

## Included functionality
- Doctor directory with multiple doctors per specialization.
- Individual doctor logins and doctor-only appointment visibility.
- Reception dashboard with appointment actions and date-based doctor calendar.
- Reception/admin doctor search by name or specialization.
- Admin calendar slot management.
- Deleted-doctor archive: deleting a doctor from the admin panel now archives them instead of
  wiping the database. Their appointments, chat summaries and patient feedback are kept, their
  login is switched off and their unbooked slots cleared. Admin gets a **Deleted Doctors**
  button on the Doctors tab to review the kept history and restore a doctor. There is no
  "erase for good" action — the history is never destroyed.
- Patient mobile-number identification and previous appointment/chat-summary history.
- AI symptom-to-specialization routing and available slot selection.
- Appointment chat summary visible to reception and assigned doctor.
- Arrived / No-show / Attended workflow.
- Patient feedback (star rating + comment) submitted from the citizen chat after a visit.
- WhatsApp booking-confirmation message sent to the patient's own number the moment their
  appointment is booked (see "WhatsApp notifications" below to switch it on).
- WhatsApp pre-visit reminder sent automatically before each appointment (see "WhatsApp
  appointment reminders" below).
- Landing page to choose Patient / Staff / Doctor sign-in.
- Dedicated Appointments and Patients sections in the staff sidebar, on top of the
  Dashboard overview.

## WhatsApp notifications

The code already calls `sendWhatsAppMessage(...)` the instant a booking is confirmed
(both from the reception "Add appointment" flow and from the AI chat), sending an
`appointment_confirmation` template with the patient's name, date and time. It currently
does nothing in a fresh checkout because `backend/.env` has placeholder values — no real
WhatsApp Business account is connected yet. To switch it on:

1. **Get a WhatsApp Business API provider.** The code is written for Interakt's request
   shape (`WHATSAPP_API_URL=https://api.interakt.ai/v1/public/message/`) — sign up at
   interakt.ai, or swap `backend/whatsapp.js`'s fetch body to match another provider
   (Gupshup, or Meta's official WhatsApp Cloud API) if you'd rather use that.
2. **Get your WhatsApp Business number verified** with that provider (they'll walk you
   through Meta's business verification).
3. **Create and get approval for a message template** named exactly `appointment_confirmation`
   with 4 body variables, in this order: `{{1}}` patient name, `{{2}}` doctor name,
   `{{3}}` date (e.g. "4 Sep 2026"), `{{4}}` time (e.g. "2:30 PM") — the same order as the
   reminder template below.
   Template approval is done by Meta/the provider and can take a few hours to a couple of days.
4. **Fill in the real values** in `backend/.env` (copy `backend/.env.example` first). The
   `Authorization` header is sent as `Basic <key>` for Interakt automatically; set
   `WHATSAPP_AUTH_SCHEME=Bearer` for providers that need Bearer:
   ```
   WHATSAPP_API_KEY=<your real API key>
   WHATSAPP_API_URL=https://api.interakt.ai/v1/public/message/
   ```
5. **Restart the backend.** On startup it now logs a warning if these are still missing —
   once they're filled in, that warning goes away and booking confirmations will start
   sending. Check the backend logs after a test booking: you'll see either
   `[whatsapp] Sent "appointment_confirmation" to <phone>` or a `[whatsapp] Send failed (...)`
   line with the provider's exact error, which is the fastest way to debug a bad template
   name/ID or an unverified number.

No-show and feedback-request WhatsApp messages use the same mechanism (templates
`no_show_rebook` and `feedback_request`) — get those approved too if you want them live.

## WhatsApp appointment reminders

On top of the instant booking confirmation, the backend now also sends a one-time
**pre-visit reminder** to the patient shortly before their appointment (template
`appointment_reminder`, variables in order: `{{1}}` patient name, `{{2}}` doctor name,
`{{3}}` date, `{{4}}` time).

- It runs as a background loop inside `backend/server.js` (`sendDueReminders`) — no extra
  cron service needed.
- `REMINDER_LEAD_MINUTES` (default `60`) controls how long before the appointment the
  reminder goes out.
- `REMINDER_POLL_MINUTES` (default `5`) controls how often the backend checks for
  reminders that just became due.
- Each appointment has a `reminder_sent` flag (see `database/schema.sql`), so a patient
  is never reminded twice even though the loop keeps polling.
- Just like the other messages, create and get approval for an `appointment_reminder`
  template with your WhatsApp provider, then it'll start sending automatically once
  `WHATSAPP_API_KEY` / `WHATSAPP_API_URL` are filled in — no extra code change needed.

## Landing page (choose how to sign in)

Opening `http://localhost:5173/` now shows a landing page with three options — **Patient**,
**Reception / Staff**, and **Doctor** — instead of going straight into the staff dashboard.
Patient goes to the mobile-OTP citizen login; Staff and Doctor both go to the same staff
username/password login (`/login`), which already routes each role to the right dashboard
after signing in. Anyone already signed in who revisits `/` is bounced straight to their
dashboard automatically.

## Staff console — Dashboard / Appointments / Patients

The staff sidebar now has three working sections instead of one:
- **Dashboard** — a quick overview: today's stats and the first 5 appointments.
- **Appointments** — the full doctor calendar (reception/admin) and the complete
  appointments table with Arrived / No-show / Attended actions. For a doctor this is
  titled **"My Appointments"**.
- **Patients** — search any patient by mobile number to see their full visit history.

The doctor-schedule calendar also got a few usability upgrades: **Today/Tomorrow** quick-jump
buttons, doctors sorted alphabetically with their slots sorted by time, a booked-load bar per
doctor, and a small legend for the Available/Booked colours.

## Bug fixes

See `BUGFIXES.md` for the list of bugs found and fixed in this version.

## Database note
The backend automatically runs `database/schema.sql` on startup. This includes the
`appointments.chat_summary` migration and demo staff/doctor seed. If the database is
reachable through `backend/.env`, simply restarting the backend is enough after updating
this version.
