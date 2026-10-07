# Parent portal: setup, launch and running it

The parent portal (`portal.tnsaints.com`) runs on the same Cloudflare Worker and
database as the admin (`admin.tnsaints.com`) and the public API
(`api.tnsaints.com`). Nothing here costs money on the free plans; the limits
that matter are in "Email budget" below.

Everything ships **switched off**. Each step below turns one thing on, and each
switch can be turned off again without losing anything.

---

## 1. Switches (wrangler.toml `[vars]`)

A switch is on only when it says exactly `"true"`. Anything else — missing,
misspelled, `"True"` — is off.

| Switch | Off means | Safe to turn off any time? |
|---|---|---|
| `PORTAL_ENABLED` | every portal page shows "not open right now" (503) | yes |
| `PORTAL_SIGNUP_ENABLED` | only invited families (and co-guardians they invite) can sign in | yes |
| `MAGIC_LINK_ENABLED` | email sign-in links paused; existing sessions keep working | yes |
| `GOOGLE_SIGNIN_ENABLED` | the Google button disappears | yes |
| `ENROLLMENT_ENABLED` | families can't apply or start paying; staff can't offer seats. Still works: confirming a payment already made, signing a waiver for an existing place, waitlist, decline | yes — offers already sent keep their pay-by date and lapse on it |
| `PAYPAL_WEBHOOK_ENABLED` | the webhook answers 503; PayPal retries for 3 days, nothing lost | yes |
| `LEADS_ENABLED` | website forms fall back to Formspree | yes |
| `STAFF_BRIEF_ENABLED` | no daily staff email | yes |
| `ADMIN_CSRF_MODE` | `"report"` logs cross-site admin posts with no Sec-Fetch-Site; `"enforce"` refuses them | — |
| `RETENTION_MODE` | `"report"` counts what the retention rules would remove; `"enforce"` removes it (section 10) | yes — back to `"report"` stops removal |
| `DONATIONS_ENABLED` | gifts can still be recorded, but no receipt saying a gift is tax-deductible can be issued (section 19) | yes — keep it `"false"` until the IRS determination letter |

`PAYPAL_ENV` is `"sandbox"` (test money, TEST MODE banner on the portal) or
`"live"`.

`PAYPAL_WEBHOOK_VERIFY` is how a webhook's signature is checked: `"self"`
(default — checked here against PayPal's certificate, no call to PayPal) or
`"postback"` (PayPal's verify API is asked, one call per event). Both check the
signature; no value turns checking off, and anything else reads as `"self"`.

Changing a switch = edit `wrangler.toml`, commit, `npx wrangler deploy`.

## 2. Secrets (never in the repo)

Set each with `npx wrangler secret put NAME` from the `worker` folder. The
value is typed or pasted at the prompt; nobody else needs to see it.

| Secret | What | How to make one |
|---|---|---|
| `AUTH_PEPPER` | signs every sign-in link, session and invite | 32+ random characters: `python -c "import secrets; print(secrets.token_urlsafe(36))"` |
| `GOOGLE_CLIENT_SECRET` | Google sign-in | from the Google OAuth client (step 4) |
| `PAYPAL_CLIENT_SECRET_SANDBOX` | PayPal test app | from the PayPal developer dashboard (step 5) |
| `PAYPAL_CLIENT_SECRET_LIVE` | PayPal live app | same, live tab — only when going live |

**Emergency lever:** putting a new `AUTH_PEPPER` signs every parent out and
kills every outstanding sign-in link and invitation at once.

## 3. Deploy order (every time the database changes)

1. Apply new migrations to production, in number order, **before** deploying
   code that reads them:
   `npx wrangler d1 execute tnsaints --remote --file=./migrations/0NN_name.sql`
   (An ALTER-only migration re-run says "duplicate column name": already applied.)
2. `npx wrangler deploy`
3. Check: `https://api.tnsaints.com/api/health` answers `{"ok":true}`, and the
   admin still signs in.

Rollback: `npx wrangler rollback` returns to the previous version. Migrations
only ever add tables and columns, so the older code runs fine against them.

**First deploy of the portal and admin work:** production has migrations
001–006. Before that deploy, apply 007 to 018 in order. Rehearse it on a
local copy of production first
(`npx wrangler d1 export tnsaints --remote --output=prod.sql`, import it
locally, apply the migrations there and run the suites). Then apply them to
production:

| # | File | Adds |
|---|---|---|
| 007 | `identity_households.sql` | parent accounts, sign-in, households, contacts, medical |
| 008 | `player_profile.sql` | date of birth, grade, school, shirt size on players |
| 009 | `programs_enrollment.sql` | waivers, programs, groups, consents, enrollments |
| 010 | `billing.sql` | PayPal subscriptions, events, payments |
| 011 | `platform.sql` | settings, job runs |
| 012 | `crm_intake.sql` | website inquiries and contacts |
| 013 | `crm_screens.sql` | CRM activities and owners |
| 014 | `privacy_safety.sql` | legal holds, clearances |
| 015 | `programs_teams.sql` | one-time PayPal orders, team coaches and events, calendar links |
| 016 | `governance.sql` | board, meetings, motions, votes, documents, disclosures, compliance calendar |
| 017 | `donations.sql` | donations and receipts |
| 018 | `staff_board_role.sql` | the `board` staff role (rebuilds the `staff` table; export it first, as the file says) |

All of them are safe to re-run except 008 and 015 (018 re-runs harmlessly). Those end in ALTERs, so a
re-run fails with "duplicate column name", which means the file was already
applied.

## 4. Google sign-in (plan item O6)

1. Google Cloud Console → APIs & Services → OAuth consent screen: External;
   app name "Tennessee Saints"; scopes **openid, email, profile only** (no
   Google review needed for these).
2. Credentials → Create OAuth client ID → Web application. Authorised redirect
   URI: `https://portal.tnsaints.com/auth/google/callback`
3. Put the client ID in `wrangler.toml` (`GOOGLE_CLIENT_ID`) and the secret via
   `wrangler secret put GOOGLE_CLIENT_SECRET`.
4. `GOOGLE_SIGNIN_ENABLED = "true"`, deploy.

Google is trusted to vouch for an email address only for `@gmail.com` and for
Workspace accounts on their own domain. Anyone else signs in by email link
once, then connects Google from their Account page.

## 5. PayPal (plan items O4, O5)

Sandbox first. Go live only after a full sandbox run and PayPal's answer about
moving the account to the non-profit's EIN.

1. developer.paypal.com → Apps & Credentials → **Sandbox** → Create App.
   Client ID → `PAYPAL_CLIENT_ID_SANDBOX` in `wrangler.toml`; secret →
   `wrangler secret put PAYPAL_CLIENT_SECRET_SANDBOX`.
2. In the sandbox business account, create a subscription plan matching the
   real one: the monthly price, and the $40 setup fee in PayPal's **setup fee**
   field (charged once, at signup).
3. Admin → Enrollments → *Price, groups and waiver*: enter the monthly price
   (must match the plan exactly) and paste the sandbox plan ID.
4. App → Webhooks → Add webhook: URL
   `https://api.tnsaints.com/api/paypal/webhook`; events:
   all `BILLING.SUBSCRIPTION.*` and `PAYMENT.SALE.COMPLETED`,
   `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`. Camps, clinics and other
   one-time programs need `CHECKOUT.ORDER.APPROVED`,
   `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED`. Copy the webhook ID →
   `PAYPAL_WEBHOOK_ID_SANDBOX`. Then `PAYPAL_WEBHOOK_ENABLED = "true"`, deploy.
5. Sandbox run: apply for a test child, offer a seat from the admin, pay with a
   sandbox buyer, and check the place shows *Enrolled*, the payment appears,
   and cancelling in PayPal ends the place. Note what the setup-fee payment
   looks like (it is recorded as the setup fee when it equals the program's fee).
6. Going live repeats 1–4 on the **Live** tab with the `_LIVE` names, the live
   plan ID in the admin, and `PAYPAL_ENV = "live"`.

Families who already pay through the old Join page are matched by hand:
Admin → Billing → paste their `I-…` subscription ID → record → link to their
child. The family is then asked to sign the waiver on the portal.

## 6. Turnstile (plan item O7)

Cloudflare dashboard → Turnstile → the existing widget → add hostname
`portal.tnsaints.com`. Without it, the sign-in page's check fails.

## 7. The academy (plan items O5, O8, O9)

Admin → Enrollments → *Price, groups and waiver*:

- **Waiver**: paste the approved text, with the exact legal name of who
  families agree with. A saved version can never be edited; to change wording,
  save a new version and choose it.
- **Groups**: one per scheduled group — day, times, place, first session
  (monthly billing starts there), seats, grades.
- **Open to families**: refused until price, PayPal plan and waiver exist.

## 8. Email budget

Resend's free plan: 100 emails a day, 3,000 a month, counted per recipient.
Sign-in links use the `auth` lane, which may use the whole day. Before launch,
raise `EMAIL_AUTH_RESERVE` from `"0"` to `"15"` so staff alerts and decision
batches can never use the last 15 credits a parent might need to sign in
(plan item O11). Onboard families in waves of about 35 a day; Google sign-in
costs no email at all.

## 9. Launch, in stages (plan item P1.14)

1. **Staff only, sandbox.** Add the portal route in `wrangler.toml` (the
   commented `portal.tnsaints.com` line), `PORTAL_ENABLED = "true"`, leave
   `PORTAL_SIGNUP_ENABLED = "false"`, `ENROLLMENT_ENABLED = "true"`. Deploy. Invite staff from Admin → Families →
   *Invite a family*, and run the whole journey as a family would.
2. **Live payments, 3–5 invited families.** Switch PayPal to live (step 5.6).
   Invite each family from Admin → Families → *Invite a family*.
3. **Waves of ~35 families a day**, watching the Billing page and the email
   budget.
4. **Signup on** (`PORTAL_SIGNUP_ENABLED = "true"`), and the website's Join
   page and contact forms point at the portal and `/api/lead`
   (`LEADS_ENABLED = "true"`).
5. After two quiet weeks of `admin_csrf_would_block` logs, set
   `ADMIN_CSRF_MODE = "enforce"`.

## 10. Privacy requests

Families download their own data from their Account page (recorded as a
completed request). Deletion requests land in Admin → Privacy and in the daily
brief. To act on one:

1. Reply by email to confirm it is really them (the request came from a
   signed-in guardian, so this is a courtesy check).
2. End any academy place and make sure their PayPal subscription is cancelled.
3. Delete the family's children's details, medical answers, emergency contacts,
   invitations, sessions and accounts. **Keep** signed waivers
   (`consent_records`) and payment records (`payments`) until their retention
   period ends — ask the accountant/attorney for the periods (plan item O15).
4. Mark the request completed in Admin → Privacy, and email the family.

### Retention and legal holds

The daily job counts what each retention rule would remove and shows it on
Admin → Privacy → Retention. With `RETENTION_MODE = "report"` (the default)
**nothing is removed**. The periods are defaults pending the attorney (plan
item O15), each a setting in `wrangler.toml`:

| Rule | Default | Setting |
|---|---|---|
| A child's medical answer, after their last place ended | 90 days | `RETENTION_MEDICAL_DAYS` |
| An evaluation registration's medical note, after the evaluation | 90 days | `RETENTION_MEDICAL_DAYS` |
| A contact never converted and untouched (anonymized) | 24 months | `RETENTION_LEAD_MONTHS` |
| A signed waiver: both this long AND the child this old | 7 years, age 21 | `RETENTION_WAIVER_YEARS`, `RETENTION_WAIVER_MIN_AGE` |
| A payment record | 7 years | `RETENTION_PAYMENT_YEARS` |

To start removing: approve the periods, watch two weeks of reports, then set
`RETENTION_MODE = "enforce"` and deploy. It removes up to 200 rows per rule
per day, re-checking each rule as it removes, and audits counts only.

**Legal hold** (Admin → Privacy → Legal holds): keeps everything about a
family, child, CRM contact or evaluation registration out of every rule until
released — for a dispute, an insurance claim or a safeguarding concern. Use the
number from the record's page address. Keep the reason short and free of
medical or safeguarding detail.

## 11. The CRM

Admin → CRM. Website inquiries arrive in the Inbox and as cards and tasks;
parents who sign up for the portal are matched to their inquiry by email
every day (and whenever a contact or family page is opened), and their copy of
the lead's details is cleared — the family's own record is the one kept.

- **First time:** CRM → Import brings in families from past evaluations (one
  contact per parent email, one card per child). Running it twice adds nothing.
- **Owners:** set who looks after each contact or family; their open cards follow.
- **Email** families from your own mail program (the email links); log the
  call, email or meeting on the timeline. The site's email allowance is never
  used for one-to-one mail.
- **Downloading the contact list** is recorded in the audit log.
- **Merge** two contacts for the same person, or **anonymize** someone who asks
  to be forgotten: CRM administrators only, and neither can be undone.

## 12. Clearances

Admin → Clearances. Everyone who works with children needs a current background
check, abuse-prevention training and concussion training (the providers and
how long each lasts are the academy's policy — plan item O14; Tennessee's
concussion-training rule is to be confirmed with the attorney). Record each
from its certificate, with its expiry date. The daily brief lists anyone lapsed
or lapsing within 30 days, and a coach who is not fully cleared cannot be put
on a team.

## 13. Scheduled jobs

The cron fires every hour; the job runner decides what is due (Central time)
and keeps each run inside D1's per-invocation query limit. Each job's last run
is in the `job_runs` table (counts only):

    npx wrangler d1 execute tnsaints --remote --command "SELECT job, run_key, status, detail FROM job_runs ORDER BY started_at DESC LIMIT 20"

A job that ran out of room is `partial` and continues next hour; one that
failed is retried next hour.

## 14. When something goes wrong

- **A family paid but had no seat** (their offer lapsed and the group filled):
  listed on Admin → Billing and in the daily brief. Offer them a seat from the
  queue, or refund in PayPal.
- **Webhook errors**: PayPal retries for 3 days. Turning
  `PAYPAL_WEBHOOK_ENABLED` off is safe; turning it back on catches up.
- **Every webhook rejected** (`paypal_webhook_rejected` in the logs with
  reason `signature` or `cert-unavailable`, after PayPal changed something):
  set `PAYPAL_WEBHOOK_VERIFY = "postback"` and deploy, so PayPal checks its own
  signatures; then find out what changed.
- **Something wrong with enrollment** (offers, the pay page):
  `ENROLLMENT_ENABLED = "false"` stops new applications, payments and offers
  while payments already made are still recorded.
- **Someone draining sign-in emails**: `MAGIC_LINK_ENABLED = "false"`; Google
  sign-in and existing sessions keep working.
- **A leaked session or link**: rotate `AUTH_PEPPER` (signs everyone out).

## 15. Programs: camps, clinics, tournaments, teams, evaluations

Admin → Programs → *New program*. A program's id, kind and billing are fixed
when it is created; everything else can be changed later.

- **Details**: the name and description families see, whether it is listed
  (on the portal's Programs page and the website's `/api/programs`), the
  waiting list, how families join, and when sign-up opens and closes
  (Central time).
- **How families join**:
  - **By application**: staff offer a seat, as for the academy. The academy
    always works this way.
  - **Sign up and pay**: the family picks a group with room. The seat is held
    for 30 minutes while they pay. If they don't finish, the hold lapses and
    the seat returns. When a group is full, families can join the waiting
    list, if the program keeps one.
- **Billing**: `subscription` (a PayPal plan, as for the academy),
  `one_time` (a PayPal order this Worker creates for the program's price, then
  checks once paid; no child's name is sent to PayPal), or `free` (the place
  is confirmed at once).
- **Opening** is refused until it has what it needs: a waiver, and a price (and
  for a subscription, a PayPal plan).
- One-time payments use the order webhooks in section 5. If a family closes
  the tab mid-payment, an hourly job asks PayPal about unfinished orders from
  the last two days, three at a time.

## 16. Teams

A team is a group of a `team` program (Admin → Teams).

- **Roster**: the children with a place in that group. Coaches see names,
  grades, shirt sizes and whether a medical note exists; nothing else (plan
  item O16).
- **Coaches**: only someone whose clearances are all current can be assigned
  (section 12).
- **Schedule**: practices, games and tournaments. Families see the next few
  on their family page.
- **Calendar link**: each team has a subscribe link (Google, Apple, Outlook).
  It carries the team's schedule only, never a child. Anyone with the link
  can read the schedule. If it gets out, *Replace the link*: the old one stops
  working and families get the new one from their family page.

## 17. Evaluations as programs

The 8/29 evaluation ran from `EVENT_*` settings in `wrangler.toml`. The next
one can instead be a program of kind `evaluation`:

1. Admin → Programs → *New program*, kind *Evaluation* (always free, by
   application). Add one group per session: the session time as the group's
   name, its date, and its seats.
2. Set the grade range and the sign-up close time, and add a waiver.
3. Open it, then *Make this the current evaluation*. From then on the
   registration form, coach notes, decisions and feedback emails all use it.
   The admin roster says "Running from the evaluation program". *Stop: go
   back to the settings in wrangler.toml* does what it says.
4. **Link preview**: on the program's details, give it a preview title and an
   image address on `https://tnsaints.com/` (put the image on the website
   first; a new file name makes Facebook fetch it again). While sign-up is
   open, the website's hourly link-preview job shows that card when someone
   shares tnsaints.com. This needs the website change on the
   `launch/site-portal` branch.

## 18. The board

Board members sign in like staff. Two steps for each person:

1. Cloudflare Access must let their email in (plan item O13). Then Admin →
   Users → add them with role **board**. The board role sees the board's
   records and its own disclosures, and **no children's data**: every roster,
   family and CRM page refuses it.
2. Admin → Board → Members: their office, whether they vote, and their term.
   The **secretary** may also take attendance, record motions and votes, and
   draft and circulate minutes.

- **Meetings**: agenda, then attendance. Quorum is worked out when attendance
  is taken: a majority of the voting members serving. A motion cannot be
  decided without quorum. A motion carries when more members vote yes than
  no. Both rules are defaults until the bylaws say otherwise.
- **Votes and minutes**: a recusal needs a reason. Votes on a decided motion,
  and approved minutes, are locked by the database and cannot be edited.
- **Documents** stay in SharePoint. The admin keeps links only, and only to
  `sharepoint.com`. To allow other hosts, set `BOARD_DOC_HOSTS` (comma-separated).
- **Disclosures**: each member files their annual conflict-of-interest
  disclosure on Board → Disclosures.
- **Compliance calendar** (Board → Compliance) comes seeded with the 990,
  the Tennessee annual report, charitable solicitation registration,
  insurance renewals, 1099s, the disclosures and clearance reviews. The
  seeded items have **no dates**. Set each date with the accountant (plan
  item O15): the daily brief lists items due within 30 days or overdue, so an
  item with no date never reaches it. Marking a recurring item done schedules
  the next one.

## 19. Donations (after the IRS determination letter)

Admin → Donations. Gifts can be recorded at any time; only academy admins
record them, and only admins and the board treasurer can see them. Program
fees are never recorded as donations.

**Receipts** say a gift is tax-deductible, which is only true after the
letter. They are off (`DONATIONS_ENABLED = "false"`) until:

1. The IRS determination letter has arrived, and the Tennessee charitable
   solicitation registration is done.
2. On Admin → Donations, enter the organisation's legal name, EIN,
   determination date, and who signs receipts.
3. The accountant has reviewed the receipt wording (plan item O15). It follows
   IRS Publication 1771. A gift of $250 or more needs one for the donor to
   deduct it. If anything was given in return, the receipt says what, and its
   value.
4. Set `DONATIONS_ENABLED = "true"` and deploy.

An issued receipt and its gift's details cannot be changed. If something is
wrong, void it with a reason and record the gift again. Print a receipt, or
save it as a PDF, and send it from your own email. A donor's yearly summary
lists all their gifts that year, for their tax records.
