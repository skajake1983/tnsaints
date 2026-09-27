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
   `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`. Copy the webhook ID →
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

## 11. When something goes wrong

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
