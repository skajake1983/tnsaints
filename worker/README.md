# Tennessee Saints — Evaluation Registration API

Cloudflare Worker + D1 backing the free academy evaluation signup.

Its whole reason to exist is the capacity limit. A static site plus an email
relay cannot know that 25 people already took the 9:00 AM session, so it cannot
close that session or divert the 26th family to a waiting list. This can.

## What it enforces

Everything below is decided on the server. The browser is untrusted input.

| Rule | Where |
|---|---|
| 25 per session, 50 total | atomic `INSERT … WHERE (SELECT COUNT(*) …) < capacity` |
| Overflow becomes waitlist, never a rejection | `claimSpot()` |
| Registration closes 11:59 PM CT on 8/22 | `registrationWindow()` |
| One registration per player | `UNIQUE(event_id, parent_email_norm, player_name_norm)` |
| Human check | Turnstile `siteverify`, server-side |
| Required acknowledgements | `CHECK (assumption_of_risk = 1)` in the schema |
| Abuse throttling | 3 registrations per IP hash per 10 minutes |
| Email alert on every signup | `sendRegistrationEmails()` via Resend |
| Self-service cancellation | 32-byte token per registration, `cancel.html` |
| Waitlist promoted in signup order | `promoteFirstWaitlisted()` on cancel |

Capacity is **never** a stored counter. It is always `COUNT(*)` of confirmed
rows, so deleting a bogus registration reopens that spot automatically.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/availability` | open/full per session — never exact counts |
| POST | `/api/register` | claim a spot or join the waitlist |
| GET | `/api/cancel/lookup?t=` | read-only; what a cancel link resolves to |
| POST | `/api/cancel` | release a spot, promote the next in line |
| GET | `/api/admin/registrations` | roster JSON (`?format=csv` for CSV), Bearer token |

**The GET/POST split on cancellation is load-bearing.** Mail scanners such as
Outlook Safe Links fetch every URL in an inbound message. If a click were what
cancelled a registration, those scanners would silently cancel families the
moment the email arrived. Lookup is read-only; the mutation is a POST the
visitor triggers from the page.

## Local development

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars      # already present locally; do not commit it
npm run db:init:local               # create the table
npm run dev                         # http://127.0.0.1:8787
```

`.dev.vars` ships with Cloudflare's published "always passes" Turnstile test
secret, so local registration works without real keys.

Useful during testing:

```bash
npm run db:dump:local     # show every row
npm run db:reset:local    # wipe registrations, keep the schema
```

## Phase 1 — deploy the API (site stays on GitHub Pages)

This adds capacity enforcement with **zero risk to the live site**. Nothing about
tnsaints.com changes until Phase 2.

1. **Create the database** and paste the returned `database_id` into
   `wrangler.toml`:

   ```bash
   npx wrangler d1 create tnsaints
   npm run db:init:remote
   ```

2. **Create a Turnstile widget** at Cloudflare dashboard → Turnstile.
   Hostname `tnsaints.com`, mode **Managed**. Keep the site key and secret key.

3. **Set up Resend** so signups actually notify someone (see
   [Email](#email) below for the DNS records and the daily-cap caveat).

4. **Set secrets** (never in `wrangler.toml`):

   ```bash
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put ADMIN_TOKEN      # 32 random bytes, hex
   npx wrangler secret put IP_HASH_SALT     # 32 random bytes, hex
   npx wrangler secret put RESEND_API_KEY
   ```

   Generate the two random values with a **cryptographic** RNG. On Windows
   PowerShell:

   ```powershell
   $b = New-Object byte[] 32
   [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   ($b | ForEach-Object { '{0:x2}' -f $_ }) -join ''
   ```

   Not `Get-Random` — it is not cryptographically secure, and `ADMIN_TOKEN`
   guards an endpoint that returns children's medical notes and home phone
   numbers. Use different values from the local `.dev.vars` ones.

4. **Deploy** and give it a hostname:

   ```bash
   npm run deploy
   ```

   Then in the dashboard add a custom domain of `api.tnsaints.com` to the
   Worker. DNS is already on Cloudflare, so this is one record.

5. **Point the site at it.** In `index.html`, set:

   ```js
   const REGISTRATION_API  = 'https://api.tnsaints.com';
   const TURNSTILE_SITE_KEY = '0x4AAA…';   // site key from step 2
   ```

   Commit and push. Evaluation requests now go to the Worker; every other form
   purpose keeps using Formspree.

6. **Verify before announcing.** Register once yourself, confirm the row lands
   in the export, then delete it:

   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.tnsaints.com/api/admin/registrations
   npx wrangler d1 execute tnsaints --remote --command "DELETE FROM registrations"
   ```

### Rolling back Phase 1

Set `REGISTRATION_API = ''` and push. The form falls straight back to
Formspree. No DNS change, no data loss.

## Phase 2 — move the site off GitHub Pages (optional, not urgent)

Cloudflare now recommends **Workers with static assets** over Pages for new
projects, and it means one deployment serving both the site and the API with no
CORS involved.

1. Move the static files (`index.html`, `privacy-policy.html`, `404.html`,
   images, `robots.txt`, `sitemap.xml`, `CNAME`) into `worker/public/`.
2. Uncomment the `[assets]` block in `wrangler.toml`.
3. `npm run deploy`, then add `tnsaints.com` as a custom domain on the Worker.
4. Set `REGISTRATION_API = ''` — same origin means relative `/api/...` paths
   work, so update the two fetch calls to drop the prefix.
5. Turn off GitHub Pages **only after** the Worker serves the domain correctly.

Do this after 8/29. There is no reason to change how the site is served during
the registration window.

## Operations

**Get the roster:**

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.tnsaints.com/api/admin/registrations?format=csv" -o roster.csv
```

**Someone cancels.** Normally you do nothing — every confirmation email links to
`cancel.html`, and the family releases the spot themselves. That path also
promotes the longest-waiting family in that session and emails them.

If you have to do it on their behalf, **use the API, not SQL**:

```bash
# token comes from the cancel_token column in the roster export
curl -X POST https://api.tnsaints.com/api/cancel \
  -H "Content-Type: application/json" \
  -H "Origin: https://tnsaints.com" \
  -d '{"token":"<cancel_token>","reason":"Cancelled by phone"}'
```

> **Do not cancel with `DELETE`.** Deleting the row frees the seat but bypasses
> promotion entirely, so the waitlisted family is never moved up and never
> emailed — the spot silently goes to nobody. `DELETE` is only for scrubbing a
> bogus or test registration that should never have existed.

**Take one extra kid beyond the cap** — a deliberate override, since the capacity
check only guards `INSERT`:

```bash
npx wrangler d1 execute tnsaints --remote \
  --command "UPDATE registrations SET status='confirmed' WHERE id = 57"
```

**Read the cancellations and why people dropped:**

```bash
npx wrangler d1 execute tnsaints --remote \
  --command "SELECT player_name, session_time, cancelled_at, cancel_reason FROM registrations WHERE status='cancelled' ORDER BY cancelled_at"
```

**Add a second evaluation date:** change `EVENT_ID` and `EVENT_LABEL` in
`wrangler.toml`, update `REGISTRATION_CLOSES_AT`, and redeploy. Old rows stay
under the old `EVENT_ID`, so capacity counts start clean and last event's roster
is still exportable.

## Email

Two messages per registration: an alert to the academy (reply-to is set to the
parent, so replying reaches them directly) and a receipt to the parent carrying
their cancel link. Both are sent through `ctx.waitUntil()` **after** the spot is
committed to D1, so a provider outage costs a notification, never a registration.

A cancellation sends up to two more: "you're in" to whoever is promoted off the
waiting list, and an alert to the academy naming them. A daily roster digest
goes out on the cron.

### Resend domain setup

Resend puts its records on the `send` subdomain, so **the root MX is untouched**
and existing mail on `tnsaints.com` keeps working. Add in Cloudflare DNS
(values come from the Resend dashboard; the MX host is region-specific):

| Type | Name | Value | Proxy |
|---|---|---|---|
| MX | `send` | `feedback-smtp.<region>.amazonses.com` (priority 10) | n/a |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | DNS only |
| TXT | `resend._domainkey` | the DKIM key from Resend | DNS only |

Enter `send`, not `send.tnsaints.com` — Cloudflare appends the zone.

**Do not add Resend's include to the root SPF record.** Two SPF records on one
host is a permanent error that breaks *all* mail for the domain. It is also
unnecessary: SPF is checked against the envelope sender, which lives on
`send.tnsaints.com` and has its own record.

Recommended while you are in there — there is currently no DMARC record:

| Type | Name | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:info@tnsaints.com; fo=1` |

### The daily cap, and why the Worker meters itself

Resend's free plan allows **100 emails per day** (3,000/month). At two per
registration, a full 50-seat day lands *exactly* on that ceiling — and the
failure is silent: the parent sees success, the row saves, nobody is told.

So the Worker tracks its own spend in the `email_budget` table. Alerts may use
the entire budget; parent receipts stop once fewer than `EMAIL_ALERT_RESERVE`
(default 25) credits remain. Losing a receipt is a minor annoyance; losing an
alert means a family signs up and is never contacted.

Raise `EMAIL_DAILY_LIMIT` in `wrangler.toml` if the Resend plan is upgraded.
Set it to `0` to disable sending entirely — useful when running the test suite
against a real API key.

### Deliverability check before launch

The alert is `noreply@mail.tnsaints.com` → `info@tnsaints.com`. `info@` is on
**Microsoft 365**, whose spoof intelligence scrutinises mail arriving from
outside the tenant that claims the org's own domain family, even when SPF and
DKIM pass. Sending from the `mail.` subdomain rather than the root is partly
why this passes — see the domain setup above.

**Send one real test registration and confirm the alert reaches the inbox, not
Quarantine or Junk.** If it is filtered, add a Tenant Allow/Block List spoof
entry in the Microsoft Defender portal — clicking "not junk" will not hold.
This is the single most likely reason a registration would go unnoticed.

## Cost

Comfortably inside the Cloudflare free tier: Workers 100k requests/day, D1 5M
rows read and 100k rows written per day. Peak expected load is roughly 50
registrations plus one availability check per form render.

Two things keep it there, both deliberate:

- `idx_registrations_avail` is ordered `(event_id, status, session_time)` so the
  availability query seeks only confirmed rows — capped at 50 — instead of
  scanning the whole table including the waitlist. Without it, daily rows-read
  scales as `page_views × total_rows` and a locally viral post could exhaust the
  5M/day limit and take registration down.
- Availability is fetched **once per form render, never polled**. Do not add a
  polling interval to the spots-remaining counter.

The binding constraint is not Cloudflare — it is Resend's 100 emails/day.

## Files

```
worker/
  wrangler.toml        config, capacity, deadline, allowed origins
  schema.sql           D1 schema + constraints
  src/index.js         router, admin export, error handling
  src/registration.js  capacity, waitlist, window, rate limit
  src/validate.js      server-side validation + bot signals
  src/turnstile.js     siteverify
  src/email.js         Resend alerts + receipts, daily budget metering
  src/http.js          CORS, JSON, IP hashing
```
