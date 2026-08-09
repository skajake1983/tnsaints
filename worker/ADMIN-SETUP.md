# Staff admin setup — `admin.tnsaints.com`

One-time setup for the staff dashboard. Roughly 20 minutes, all in the
Cloudflare dashboard except two commands.

Do this **before August 18**, so there is time for the Brandon dry run while it
still matters. Nothing here touches the public registration form — that is the
whole point of putting the dashboard on its own hostname.

---

## What you are building

```
  parent  ──►  tnsaints.com              (GitHub Pages, unchanged)
               api.tnsaints.com          (Worker — public, no login, unchanged)

  coach   ──►  admin.tnsaints.com        (same Worker)
                    │
                    ├─ Cloudflare Access ── Entra ID  (@tnsaints.com mailboxes)
                    │                    └─ One-time PIN (Brandon, external)
                    │
                    └─ `staff` table in D1 ── decides what they can actually see
```

Two locks in series, on purpose. Access decides **who comes through the door**.
The `staff` table decides **what they may do inside**. If someone later widens
the Access policy to "anyone with an @tnsaints.com address", that person still
gets a 403, because they are not in `staff`.

---

## Step 1 — Deploy, so the hostname exists

Access applications attach to a hostname, so the hostname has to exist first.

```bash
cd worker
npm run deploy
```

This creates `admin.tnsaints.com`, its DNS record, and its certificate.

**Right now that hostname returns 401 to everyone, including you.** That is
correct and deliberate: `ACCESS_AUD` is still empty, and the code treats a
missing Access configuration as "refuse everything" rather than "skip the
check". A deployment mistake must never produce an open admin panel.

Confirm it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://admin.tnsaints.com/
# expect 401
```

---

## Step 2 — Add Microsoft Entra ID as a login method

**Zero Trust dashboard → Settings → Authentication → Login methods → Add new →
Azure AD** (Cloudflare still labels it Azure AD; it is Entra ID).

You need three values from the Azure/Entra side. In the
[Entra admin center](https://entra.microsoft.com) → **App registrations → New
registration**:

- Name: `Cloudflare Access`
- Supported account types: **Single tenant**
- Redirect URI: **Web** →
  `https://tnsaints.cloudflareaccess.com/cdn-cgi/access/callback`

Then collect:

| Cloudflare field | Where it comes from |
|---|---|
| Application ID | Entra app → Overview → **Application (client) ID** |
| Application secret | Entra app → **Certificates & secrets** → New client secret → copy the **Value**, not the Secret ID |
| Directory ID | Entra app → Overview → **Directory (tenant) ID** |

In Entra, under **API permissions**, add Microsoft Graph delegated
`email`, `openid`, `profile`, `offline_access`, `User.Read` and click
**Grant admin consent**. Without the consent step the login loop fails with a
generic error.

Back in Cloudflare, click **Save** then **Test** — it must say success before
you continue.

> Copy the client secret the moment Entra shows it. It is never displayed
> again, and it expires: note the expiry date somewhere you will see it, because
> when it lapses every coach is locked out at once with no warning.

**Also enable One-time PIN** in the same Login methods list. That is how
Brandon signs in — he has no `@tnsaints.com` mailbox, and Cloudflare emails him
a six-digit code instead. This is why authorization lives in D1 rather than
leaning on identity-provider group claims: Brandon arrives carrying no group
claims at all.

---

## Step 3 — Create the Access application

**Zero Trust → Access → Applications → Add an application → Self-hosted.**

| Field | Value |
|---|---|
| Application name | `TN Saints Admin` |
| Session duration | `24 hours` |
| Subdomain | `admin` |
| Domain | `tnsaints.com` |
| Path | *leave empty* |

Leaving the path empty is the point: the whole hostname is covered, so any
admin route added later is protected the moment it exists rather than the
moment someone remembers to extend a rule.

Then add **one policy**:

| Field | Value |
|---|---|
| Policy name | `Academy staff` |
| Action | `Allow` |
| Include → Emails | every staff address, listed individually |

List addresses individually rather than using "Emails ending in @tnsaints.com".
The domain rule silently admits every future mailbox on the domain — an
assistant, a shared inbox, a departing coach whose account has not been closed
yet. Since `staff` is a second gate anyway, this is belt and braces, but the
belt is free.

Include Brandon's real personal address here. With One-time PIN enabled, Access
emails him a code.

---

## Step 4 — Copy the AUD tag into the Worker

On the application's **Overview** tab, copy the **Application Audience (AUD)
Tag** — a long hex string.

Put it in `worker/wrangler.toml`:

```toml
ACCESS_AUD = "paste-the-aud-tag-here"
```

It is not a secret, so it belongs in version control alongside the route it
protects.

It is, however, load-bearing. Every Access application in your account is signed
by the same team keys, so without an audience check a token minted for *any*
other application would verify here perfectly and be accepted. The AUD tag is
what ties a valid token to *this* app.

Also confirm the team domain matches yours:

```toml
ACCESS_TEAM_DOMAIN = "tnsaints.cloudflareaccess.com"
```

(Zero Trust → Settings → Custom Pages shows your team domain if unsure.)

Deploy again:

```bash
npm run deploy
```

---

## Step 5 — Add yourself to `staff`, then sign in

Access will now let you through the door, but the app will still refuse you
until you are on the list. Add yourself:

```bash
npx wrangler d1 execute tnsaints --remote --command "INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) VALUES ('jacob@tnsaints.com', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))"
```

Use the address you actually sign in with. `email_norm` must be lowercase.

Now open <https://admin.tnsaints.com> — you should get the Microsoft login, then
the roster.

Add the rest of the coaches:

```bash
npx wrangler d1 execute tnsaints --remote --command "INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) VALUES ('brandon@example.com', 'Brandon Turner', 'Coach Turner', 'coach', 1, datetime('now'), datetime('now'))"
```

Check who is on the list at any time:

```bash
npm run staff:list
```

---

## Roles

| Role | Sees | Does not see |
|---|---|---|
| `admin` | Everything, including contact details; medical notes through an audited click | — |
| `coach` | Players, grade, experience, school, notes, and a flag that a medical note exists | Parent email, phone, emergency contacts, medical note text, signatures |
| `viewer` | Same as coach | Same as coach |

Coaches evaluate basketball. Contact details are not an input to that job, so
the coach roster does not merely hide them — **it never contains them**. There
is nothing in the response for a view-source, a screenshot, a browser
extension, or a future template bug to expose.

Medical notes are a genuine safety need on event day, so they are resolved by
*access path* rather than by widening the coach role: the coach view shows
"medical note — see Jacob", and an admin opens the note through an endpoint that
writes an audit row naming who read whose. To revoke someone:

```bash
npx wrangler d1 execute tnsaints --remote --command "UPDATE staff SET active=0 WHERE email_norm='someone@example.com'"
```

Set `active=0` rather than deleting the row — deleting orphans any notes they
authored, while `active=0` ends access immediately and keeps attribution intact.

Review access at any time:

```bash
npm run audit:tail
```

---

## Step 6 — The dry run, with Brandon's real address

**Do not skip this, and do not substitute a test account.** Two distinct things
can go wrong and they look identical from Brandon's side:

1. **Access refuses him** — his One-time PIN email lands in spam, or his address
   is missing from the policy. He never reaches the app.
2. **Access admits him, `staff` does not** — he sees "you are signed in but not
   yet authorised". His login is fine; the row is missing.

A test account exercises neither: it will not reproduce his spam filter and it
will not catch a typo in *his* address.

Ask him to open <https://admin.tnsaints.com> on the phone he will actually use
on August 29, and report which of these he sees:

| What he sees | What it means | Fix |
|---|---|---|
| Microsoft login, then the roster | Working | — |
| "Signed in but not yet authorised" | Access fine, `staff` row missing or wrong address | Add the exact address the page shows |
| A code request that never arrives | One-time PIN in spam | Have him check junk; allow-list `noreply@notify.cloudflare.com` |
| "Access denied" from Cloudflare | Address not in the policy | Add it in Step 3 |

The "not yet authorised" page deliberately shows the address he authenticated
as — that is the exact string to paste into the `staff` insert, which removes
the guesswork.

---

## Troubleshooting

**Everything returns 401, including you.** `ACCESS_AUD` is empty or wrong.
This is the fail-closed default, not a bug. Re-copy the AUD tag and redeploy.

**401 with `access_jwt_rejected` in `npm run tail`.** The AUD tag or team domain
does not match. `code` in the log narrows it: `ERR_JWT_CLAIM_VALIDATION_FAILED`
is a wrong AUD or issuer, `ERR_JWKS_NO_MATCHING_KEY` a wrong team domain.

**403 "not yet authorised".** Working as designed — Access admitted them, the
`staff` table did not. Add the row.

**A coach says the roster is missing phone numbers.** Also working as designed.
Their role does not include contact details, and the data is not in the page at
all. Change the role if that is genuinely wanted, but consider whether the task
needs it.

**Registration broke after all this.** It should not have — the public API is a
different hostname and none of the above touches it. Verify:

```bash
curl -s https://api.tnsaints.com/api/availability
```

If that is healthy, families can still sign up regardless of what the dashboard
is doing.
