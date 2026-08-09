# Worker test suites

Three Python suites covering the registration API. Standard library only — no
`pip install`, no virtualenv, no test runner. They drive the Worker over HTTP
exactly as a browser would.

## Running them

Start a local Worker in one terminal:

```bash
cd worker
npm run dev
```

Then, in another:

```bash
npm run test:local
```

Or individually:

```bash
python tests/test_acceptance.py
python tests/test_cancellation.py
python tests/test_concurrency.py
```

Each suite assumes it starts against a clean database. Reset between runs:

```bash
npm run db:reset:local
```

## What each covers

| Suite | Checks |
|---|---|
| `test_acceptance.py` | Availability, filling a session to capacity, waitlist overflow, duplicate rejection, honeypot and timing bot signals, origin allow-list, Turnstile, rate limiting, field validation, waiver acknowledgements, admin export, and that exact spot counts never leak to the public |
| `test_cancellation.py` | Cancel tokens, that a GET lookup never mutates, cancelling frees the seat, idempotent double-cancel, re-registration after cancelling, bad-token handling, and automatic waitlist promotion in signup order |
| `test_concurrency.py` | Twelve simultaneous requests for one remaining seat. Exactly one wins, eleven are waitlisted, the session never oversells |

`test_concurrency.py` is the one to keep working. It is the only thing
protecting the atomic `INSERT … SELECT … WHERE COUNT < capacity` in
`claimSpot()`, and that failure mode is invisible until twenty-six children
turn up for twenty-five places.

## The guards in `_harness.py`

Both are executable checks, not documentation, because both failure modes are
silent and expensive.

**`require_local()`** — the suites refuse to run against anything but
localhost. Pointed at `api.tnsaints.com` they would create dozens of real
registrations under invented names, send real email from the production domain
to addresses that do not exist, and leave the roster unusable. Nobody would
notice until they opened the CSV.

**`require_email_disabled()`** — if `.dev.vars` holds a real `RESEND_API_KEY`,
`EMAIL_DAILY_LIMIT` must be `0`. One full acceptance run sends roughly eighty
emails. On the Resend free tier that is the entire daily budget, which means
the next genuine registration notifies nobody — and the failure looks like
nothing at all.

To deliberately test a real send, raise the limit, send, then set it back.

## Adding tests

Import the guards, then define assertions with `check(label, condition)`:

```python
from _harness import preflight
preflight(BASE)
```

Keep them stdlib-only. The value of these suites is that anyone can run them
with a Python install and nothing else.
