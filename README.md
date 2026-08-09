# Cleaner Payouts - Alexandria

Weekly cleaner payroll tool for MaidThis Alexandria, powered by ConvertLabs booking data.
No login and no cleaner roster page in this version, see notes below.

## Running locally

Copy `.env.example` to `.env` and fill in `CONVERTLABS_TOKEN`, `DATABASE_URL` (Postgres/Neon),
and `PUBLIC_BASE_URL`.

```
npm install
npm run dev
```

Open `http://localhost:3000`, which redirects to `/payroll`.

## Adding a cleaner

There is no admin UI yet. Add a row directly to the `cleaners` table (name, email) so payroll
can look up their email and offer them in "Add a cleaner to this week" for room turns/touch-ups
that never reach ConvertLabs.

## What's intentionally left out (for now)

- No login/auth - every page and API route is public.
- No cleaner roster/availability page.
- No admin panel, pricing tools, ops console, dashboard, or SOP library.
- No phone numbers on the pay statement email footer, pending confirmation of what to show there.

These can be layered back in later, following the pattern in the source app
(`maidthis-nwsa-app`), once the owner has used this version and knows what he wants.
