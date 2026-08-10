# Staff admin setup — `admin.tnsaints.com`

One-time setup for the staff dashboard. Roughly 20–30 minutes.

Do this **before August 18**, so there is time for the coach dry run while it
still matters. Nothing here touches the public registration form — that is the
whole point of putting the dashboard on its own hostname.

---

## Where each step happens

Every step below is tagged with one of these three places. Check the tag before
you start looking for a menu.

| Tag | What it means |
|---|---|
| 💻 **TERMINAL** | The VS Code terminal on your PC (PowerShell), in `c:\Dev\TNSaints\tnsaints\worker` |
| ☁️ **CLOUDFLARE** | Browser → <https://dash.cloudflare.com> → pick your account → **Zero Trust** in the left sidebar |
| 🪟 **ENTRA** | Browser → <https://entra.microsoft.com> (sign in with your M365 admin account) |

For every 💻 TERMINAL step, be in the `worker` folder first:

```powershell
cd c:\Dev\TNSaints\tnsaints\worker
```

Running wrangler from the repo root fails with "Worker name missing" — it needs
the folder containing `wrangler.toml`.

---

## What you are building

```
  parent  ──►  tnsaints.com              (GitHub Pages, unchanged)
               api.tnsaints.com          (Worker — public, no login, unchanged)

  coach   ──►  admin.tnsaints.com        (same Worker)
                    │
                    ├─ Cloudflare Access ── Entra ID (every coach has an
                    │                                 @tnsaints.com mailbox)
                    │
                    └─ `staff` table in D1 ── decides what they can actually see
```

Two locks in series, on purpose. Access decides **who comes through the door**.
The `staff` table decides **what they may do inside**. If someone later widens
the Access policy to "anyone with an @tnsaints.com address", that person still
gets a 403, because they are not in `staff`.

Every coach signs in the same way — Entra, with whatever MFA your M365 tenant
already enforces. One login path, one place to revoke someone.

---

## Step 1 — Deploy, so the hostname exists

💻 **TERMINAL**

Access applications attach to a hostname, so the hostname has to exist first.

```powershell
cd c:\Dev\TNSaints\tnsaints\worker
npm run deploy
```

This creates `admin.tnsaints.com`, its DNS record, and its certificate.

**Right now that hostname returns 401 to everyone, including you.** That is
correct and deliberate: `ACCESS_AUD` is still empty, and the code treats a
missing Access configuration as "refuse everything" rather than "skip the
check". A deployment mistake must never produce an open admin panel.

Confirm it — 💻 **TERMINAL**:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://admin.tnsaints.com/
```

Expect `401`. Use `curl.exe`, not `curl` — in PowerShell, bare `curl` is an
alias for `Invoke-WebRequest`, which takes different flags and will error.

> Certificate provisioning can take a couple of minutes. If you get `404` at
> first, wait 2–3 minutes and try again — that is the domain still coming up,
> not a misconfiguration.

---

## Step 2 — Find your team domain

☁️ **CLOUDFLARE** → **Zero Trust** → **Settings** → **General** → **Team name**

Your team domain is that team name plus `.cloudflareaccess.com`. If the team
name is `tnsaints`, the team domain is:

```
tnsaints.cloudflareaccess.com
```

Write it down — you need it twice: once in Entra (Step 3) and once to confirm
`wrangler.toml` (Step 6).

If no team name is set yet, set one here. It becomes part of the login URL your
coaches see, so pick something recognisable.

---

## Step 3 — Register the app in Entra

🪟 **ENTRA** → <https://entra.microsoft.com>

Navigate: **Applications** → **Enterprise applications** → **New application**
→ **Create your own application**.

- Name: `Cloudflare Access`
- Choose: **Register an application to integrate with Microsoft Entra ID (App
  you're developing)**
- Select **Create**

On the registration screen, set the **Redirect URI**:

- Platform: **Web**
- URI: `https://tnsaints.cloudflareaccess.com/cdn-cgi/access/callback`
  *(substitute your team domain from Step 2)*
- Supported account types: **Single tenant**

Select **Register**.

### Collect three values

🪟 **ENTRA** → **Applications** → **App registrations** → **All applications** →
select `Cloudflare Access`

| Value you need | Where it is |
|---|---|
| **Application (client) ID** | **Overview** tab |
| **Directory (tenant) ID** | **Overview** tab |
| **Client secret** | **Certificates & secrets** → **New client secret** → copy the **Value** column |

> Copy the client secret's **Value**, not its **Secret ID** — they sit next to
> each other and only one works. Copy it the moment Entra shows it; it is masked
> permanently once you navigate away.
>
> It also **expires**. Put the expiry date in your calendar now, because when it
> lapses every coach is locked out at once, with no warning and no obvious
> cause.

### Grant API permissions

🪟 **ENTRA** → same app → **API permissions** → **Add a permission** →
**Microsoft Graph** → **Delegated permissions**

Add exactly these five:

```
email    offline_access    openid    profile    User.Read
```

Then select **Grant admin consent for <your org>**. Without the consent step the
login loop fails with a generic error that does not mention consent.

> Cloudflare's docs also list `Directory.Read.All` and `GroupMember.Read.All`.
> **Skip both.** Those exist so Access can read your Entra group memberships,
> and we deliberately do not use groups — authorization lives in the `staff`
> table instead. Granting directory-wide read for a feature we do not use would
> hand Cloudflare a readable copy of your whole M365 directory for no benefit.
>
> If you later decide you *do* want group-based policies, add them then. Adding
> a permission is a two-minute job; un-granting one after it has been in place
> for a year is a conversation about what was read in the meantime.

---

## Step 4 — Add the login method in Cloudflare

☁️ **CLOUDFLARE** → **Zero Trust** → **Integrations** → **Identity providers** →
**Add new identity provider**

Choose **Azure AD** (Cloudflare still uses the old label; it is Entra ID).

| Field | Paste from Step 3 |
|---|---|
| Application ID | Application (client) ID |
| Application secret | Client secret **Value** |
| Directory ID | Directory (tenant) ID |

**Save**, then use the **Test** button on the provider. It must report success
before you go on — testing here isolates an Entra problem from an Access policy
problem, and debugging both at once is miserable.

That is the only login method to add. **Do not enable One-time PIN.**

Every coach, Brandon included, has an `@tnsaints.com` mailbox and signs in
through Entra. One-time PIN exists for people who do not, and enabling it
anyway would actively weaken this setup:

- With OTP enabled, anyone whose address is in the Access policy can get in by
  receiving a six-digit code **in email**. That skips Entra entirely — and with
  it, whatever MFA and conditional-access rules your M365 tenant enforces.
- Enabling both methods does not give you the stronger of the two. It gives an
  attacker the weaker one. Someone who compromises a coach's mailbox but not
  their Entra credentials is stopped by Entra-only, and let straight through by
  Entra-plus-OTP.

**You are not locking yourself out by leaving it off.** If the Entra client
secret expires and every coach is blocked, your Cloudflare dashboard login is a
separate credential that still works — you can add One-time PIN back from this
same screen in about a minute. Keeping the weaker path permanently open to
avoid a one-minute fix is a bad trade.

---

## Step 5 — Create the Access application

☁️ **CLOUDFLARE** → **Zero Trust** → **Access controls** → **Applications** →
**Create new application** → **Self-hosted and private** → **Add public
hostname**

| Field | Value |
|---|---|
| Application name | `TN Saints Admin` |
| Subdomain | `admin` |
| Domain | `tnsaints.com` (from the dropdown) |
| Path | **leave empty** |
| Session duration | `24 hours` |

Leaving the path empty is the point: the whole hostname is covered, so any admin
route added later is protected the moment it exists rather than the moment
someone remembers to extend a rule.

### Add one policy

| Field | Value |
|---|---|
| Policy name | `Academy staff` |
| Action | `Allow` |
| Include → selector | **Emails** |
| Value | every staff address, **listed individually** |

List addresses individually — including Brandon's `@tnsaints.com` address —
rather than using **Emails ending in** → `@tnsaints.com`. It is tempting, since
every coach is now on the domain, but the domain rule silently admits every
*future* mailbox on it: an assistant, a shared inbox, a departing coach whose
account has not been closed yet. Since `staff` is a second gate anyway this is
belt and braces, but the belt is free.

Under **Login methods**, enable **Azure AD only**. Leave One-time PIN off — see
Step 4 for why.

---

## Step 6 — Copy the AUD tag into the Worker

☁️ **CLOUDFLARE** → **Zero Trust** → **Access controls** → **Applications** →
**Configure** on `TN Saints Admin` → **Additional settings** → copy the
**Application Audience (AUD) Tag**

It is a long hex string.

💻 **TERMINAL** — open `c:\Dev\TNSaints\tnsaints\worker\wrangler.toml` in VS Code
and set:

```toml
ACCESS_AUD = "paste-the-aud-tag-here"
ACCESS_TEAM_DOMAIN = "tnsaints.cloudflareaccess.com"
```

`ACCESS_TEAM_DOMAIN` should already be correct — confirm it matches Step 2.

The AUD tag is not a secret, so it belongs in version control alongside the
route it protects. It is, however, load-bearing: every Access application in
your account is signed by the same team keys, so without an audience check a
token minted for *any* other app would verify here perfectly and be accepted.
The AUD tag is what ties a valid token to *this* application.

The tag never changes unless the application is deleted and recreated — if you
ever rebuild the Access app, come back and update this value or everyone is
locked out.

Then redeploy — 💻 **TERMINAL**:

```powershell
cd c:\Dev\TNSaints\tnsaints\worker
npm run deploy
```

---

## Step 7 — Add yourself to `staff`, then sign in

💻 **TERMINAL**

Access will now let you through the door, but the app still refuses you until
you are on the list. Add yourself — use the address you actually sign in with,
lowercase:

```powershell
cd c:\Dev\TNSaints\tnsaints\worker
npx wrangler d1 execute tnsaints --remote --command "INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) VALUES ('you@tnsaints.com', 'Your Name', 'Coach Yourname', 'admin', 1, datetime('now'), datetime('now'))"
```

`author_label` is how you are credited to parents in feedback emails later —
the label parents see, not the email address.

🌐 **BROWSER** — open <https://admin.tnsaints.com>. You should get the Microsoft
login, then the roster.

Add the other coaches — 💻 **TERMINAL**:

```powershell
npx wrangler d1 execute tnsaints --remote --command "INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) VALUES ('coach@tnsaints.com', 'Coach Name', 'Coach Lastname', 'coach', 1, datetime('now'), datetime('now'))"
```

Check who is on the list at any time — 💻 **TERMINAL**:

```powershell
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
is nothing in the response for a view-source, a screenshot, a browser extension,
or a future template bug to expose.

Medical notes are a genuine safety need on event day, so they are resolved by
*access path* rather than by widening the coach role: the coach view shows
"medical note — see Jacob", and an admin opens the note through an endpoint that
writes an audit row naming who read whose.

To revoke someone — 💻 **TERMINAL**:

```powershell
npx wrangler d1 execute tnsaints --remote --command "UPDATE staff SET active=0 WHERE email_norm='someone@example.com'"
```

Set `active=0` rather than deleting the row — deleting orphans any notes they
authored, while `active=0` ends access immediately and keeps attribution intact.

Review who accessed what — 💻 **TERMINAL**:

```powershell
npm run audit:tail
```

---

## Step 8 — The dry run, on a coach's own phone

**Do not skip this, and do not substitute your own account.** You are the
account most likely to work — you set all of this up, you are already signed
into M365 on this machine, and you are an `admin` rather than a `coach`. Testing
with yourself proves the least.

Three distinct things can go wrong, and from the coach's side they look the
same — "it didn't work" — while the fixes are in three different systems:

1. **Access refuses them** — their address is not in the policy. ☁️ Cloudflare.
2. **Access admits them, `staff` does not** — they see "signed in but not yet
   authorised". Their login is fine; the row is missing. 💻 Terminal.
3. **Entra refuses them** — no M365 licence on the mailbox, MFA not yet
   enrolled, or the account is in a different tenant. 🪟 Entra.

Number 3 is the new one now that everyone is on Entra, and it is the one most
likely to surface on a phone rather than a desktop: a coach who has only ever
read `@tnsaints.com` mail in the Outlook app may never have completed MFA
enrolment in a browser, and the first time they are asked will be here.

🌐 **BROWSER — the coach's own phone**, the one they will actually have in the
gym on August 29. Ask them to open <https://admin.tnsaints.com> and tell you
which of these they see:

| What they see | What it means | Fix |
|---|---|---|
| Microsoft login, then the roster | Working | — |
| "Signed in but not yet authorised" | Access fine, `staff` row missing or wrong address | 💻 TERMINAL — add the exact address the page displays |
| "Access denied" from Cloudflare | Address not in the policy | ☁️ CLOUDFLARE — add it in Step 5 |
| Microsoft error, or an MFA setup prompt they cannot finish | Entra account or licence problem | 🪟 ENTRA — check the mailbox is licensed and MFA enrolment is complete |
| The roster loads, but with no phone numbers | **Correct** — that is the `coach` role | Nothing. See Roles above |

The "not yet authorised" page deliberately shows the address they authenticated
as. That is the exact string to paste into the `staff` insert — no guessing
whether it is `firstname@` or `flastname@`.

Have them confirm the last row too. A coach who thinks the roster is broken
because contact details are missing will call you on event morning, and that is
a worse time to explain the design than now.

---

## Troubleshooting

**Everything returns 401, including you.**
`ACCESS_AUD` is empty or wrong. This is the fail-closed default, not a bug.
☁️ Re-copy the AUD tag (Step 6), 💻 redeploy.

**401, and you want to know why.** 💻 **TERMINAL**:

```powershell
cd c:\Dev\TNSaints\tnsaints\worker
npm run tail
```

Then load the page in a browser and watch the log. Look for
`access_jwt_rejected` and read its `code`:

| `code` | Meaning |
|---|---|
| `ERR_JWT_CLAIM_VALIDATION_FAILED` | Wrong `ACCESS_AUD` or wrong team domain |
| `ERR_JWKS_NO_MATCHING_KEY` | Wrong `ACCESS_TEAM_DOMAIN` |
| `ERR_JWT_EXPIRED` | Stale session — sign out and back in |

**403 "not yet authorised".**
Working as designed — Access admitted them, the `staff` table did not.
💻 Add the row (Step 7).

**A coach says the roster is missing phone numbers.**
Also working as designed. Their role does not include contact details, and the
data is not in the page at all. Change the role if that is genuinely wanted, but
consider whether the task needs it.

**Login loops back to Microsoft forever.**
🪟 ENTRA — the redirect URI does not match. It must be exactly
`https://<your-team-domain>/cdn-cgi/access/callback`, with no trailing slash.

**Everyone locked out, and nothing changed on our side.**
🪟 ENTRA — check whether the client secret expired. That is the most common
cause of a sudden org-wide lockout, it hits every coach at the same moment, and
Entra gives no warning.

Entra is the only login method, so this locks out all staff at once. It does
**not** lock you out of Cloudflare — that is a separate credential. Recovery,
in order:

1. 🪟 ENTRA — issue a new client secret (Step 3), 
   ☁️ CLOUDFLARE — paste it into the Azure AD provider (Step 4a). This is the
   real fix and takes a few minutes.
2. If you need someone in *right now* and cannot reach Entra: ☁️ CLOUDFLARE →
   **Zero Trust** → **Integrations** → **Identity providers** → add
   **One-time PIN**, and enable it on the application. Anyone in the Access
   policy can then sign in with an emailed code. **Turn it back off once Entra
   is fixed** — leaving it on permanently is the weaker-auth problem described
   in Step 4.

This is worth rehearsing mentally before August 29, because the failure is
silent until someone tries to sign in.

**Registration broke after all this.**
It should not have — the public API is a different hostname and none of the
above touches it. 💻 Verify:

```powershell
curl.exe -s https://api.tnsaints.com/api/availability
```

If that returns `"registration_open": true`, families can still sign up
regardless of what the dashboard is doing.

---

## Sources

Dashboard navigation verified August 2026 against:

- [Microsoft Entra ID integration](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/entra-id/)
- [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Self-hosted public app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

Cloudflare moves these menus periodically. If a path here does not match what
you see, the doc links above are authoritative.
