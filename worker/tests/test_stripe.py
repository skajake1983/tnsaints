"""Stripe, end to end against a stand-in (src/payments/stripe*.js, portal/pay.js).

A small Stripe stand-in runs on 127.0.0.1:8798 (the Worker is pointed at it by
STRIPE_API_BASE, honoured for loopback only). It answers the calls the Worker
makes, records what it was sent, and has test-only controls to play the part
of the family on Stripe's page and of Stripe's billing. Webhook events are
signed exactly as Stripe signs them.

Asserted:
  - New payments use Stripe only once Admin -> Billing says so.
  - A child in a group starting later: a trial to the 1st after the start,
    the setup fee and the partial month as one-time lines, no child's name
    sent, card and bank offered, the API version pinned; the place is
    confirmed when the family comes back (checked with Stripe), and the first
    invoice is recorded as setup fee + tuition.
  - A sibling in a running group: anchored on the next 1st, 10% off through a
    coupon limited to the academy's product, confirmed by webhook alone.
  - Webhooks: forged, stale, duplicate and other-mode events change nothing.
  - Past due, recovered and cancelled follow Stripe; when the first child's
    place ends, the sibling discount comes off the other subscription.
  - Moving from PayPal: asked only once staff record the paid-through day;
    nothing charged up front and no setup fee; staff then see it in "cancel
    in PayPal" (and the daily brief) until marked done.
  - A scholarship combines with the sibling discount.
  - Manage billing opens Stripe's portal, configured to cancel at period end.
  - A camp is one payment (payment mode); a refund is recorded against the family.
  - Coaches and viewers cannot reach any of the billing pages.
"""
import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, P, Checker, get, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
settings = require_portal()
MOCK = "http://127.0.0.1:8798"
KEY = "sk_test_mockstandin000000"
WHSEC = "whsec_mockstandin000000"
if (settings.get("STRIPE_API_BASE") != MOCK or settings.get("STRIPE_SECRET_KEY_SANDBOX") != KEY
        or settings.get("STRIPE_WEBHOOK_SECRET_SANDBOX") != WHSEC or settings.get("STRIPE_WEBHOOK_ENABLED") != "true"):
    sys.exit("\nREFUSING TO RUN.\n  Put the Stripe stand-in settings in .dev.vars (see .dev.vars.example) and restart wrangler dev.\n")
check = Checker()
ME = staff_email()
A = "/__admin"


# --- the stand-in -----------------------------------------------------------------------
class State:
    lock = threading.Lock()
    seq = 0
    customers, products, coupons, sessions, subs, invoices, charges = {}, {}, {}, {}, {}, {}, {}
    idem = {}
    log = []          # (method, path, params, version)
    portal_configs = []

    @classmethod
    def new_id(cls, prefix):
        with cls.lock:
            cls.seq += 1
            return f"{prefix}{cls.seq:012d}TNS{uuid.uuid4().hex[:6]}"


def nested(params, prefix):
    """{'a[0][b]': 'x'} -> values under prefix as a flat dict of the rest of the key."""
    return {k[len(prefix):]: v for k, v in params.items() if k.startswith(prefix)}


def lines_of(params):
    out = {}
    for k, v in params.items():
        m = re.match(r"line_items\[(\d+)\]\[(.+)$", k)
        if m:
            out.setdefault(int(m.group(1)), {})[m.group(2)] = v
    return [out[i] for i in sorted(out)]


class Stripe(BaseHTTPRequestHandler):
    # As the PayPal stand-in: HTTP/1.1 with Connection: close, which workerd's
    # fetch needs (an HTTP/1.0 reply shows up as "Network connection lost").
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except Exception as exc:  # a stand-in bug must show, not look like Stripe dropping the line
            print(f"  [stand-in error] {exc.__class__.__name__}: {exc}", flush=True)
            raise

    def _auth(self):
        return self.headers.get("Authorization") == f"Bearer {KEY}"

    def _params(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        return dict(urllib.parse.parse_qsl(raw, keep_blank_values=True))

    def do_GET(self):
        if not self._auth():
            return self._send(401, {"error": {"type": "invalid_request_error", "code": "api_key"}})
        path = urllib.parse.urlparse(self.path).path
        State.log.append(("GET", path, {}, self.headers.get("Stripe-Version")))
        for prefix, store in (("/v1/checkout/sessions/", State.sessions), ("/v1/subscriptions/", State.subs),
                              ("/v1/invoices/", State.invoices), ("/v1/charges/", State.charges)):
            if path.startswith(prefix):
                obj = store.get(path[len(prefix):])
                return self._send(200, obj) if obj else self._send(404, {"error": {"code": "resource_missing"}})
        return self._send(404, {"error": {"code": "resource_missing"}})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        params = self._params()
        if path.startswith("/_test/"):
            return self._test(path, params)
        if not self._auth():
            return self._send(401, {"error": {"type": "invalid_request_error", "code": "api_key"}})
        State.log.append(("POST", path, params, self.headers.get("Stripe-Version")))
        key = self.headers.get("Idempotency-Key")
        if key and key in State.idem:
            return self._send(200, State.idem[key])
        obj = self._create(path, params)
        if isinstance(obj, tuple):
            return self._send(*obj)
        if key:
            State.idem[key] = obj
        return self._send(200, obj)

    def _create(self, path, p):
        if path == "/v1/customers":
            c = {"id": State.new_id("cus_"), "object": "customer", "email": p.get("email"), "name": p.get("name"),
                 "metadata": nested(p, "metadata")}
            State.customers[c["id"]] = c
            return c
        if path == "/v1/products":
            pr = {"id": State.new_id("prod_"), "object": "product", "name": p.get("name")}
            State.products[pr["id"]] = pr
            return pr
        if path == "/v1/coupons":
            if p["id"] in State.coupons:
                return (400, {"error": {"type": "invalid_request_error", "code": "resource_already_exists"}})
            State.coupons[p["id"]] = {"id": p["id"], "percent_off": float(p["percent_off"]), "duration": p.get("duration"),
                                      "applies_to": [v for k, v in p.items() if k.startswith("applies_to[products]")]}
            return State.coupons[p["id"]]
        if path == "/v1/checkout/sessions":
            sid = State.new_id("cs_test_")
            s = {"id": sid, "object": "checkout.session", "status": "open", "mode": p["mode"], "customer": p.get("customer"),
                 "client_reference_id": p.get("client_reference_id"), "url": f"https://checkout.stripe.com/c/pay/{sid}",
                 "payment_status": "unpaid", "subscription": None, "payment_intent": None, "amount_total": None,
                 "currency": "usd", "_params": p}
            State.sessions[sid] = s
            return s
        m = re.match(r"^/v1/subscriptions/(sub_\w+)$", path)
        if m and m.group(1) in State.subs:
            sub = State.subs[m.group(1)]
            if "discounts" in p:
                sub["discounts"] = []
                sub["_coupon"] = None
            if "discounts[0][coupon]" in p:
                sub["discounts"] = [State.new_id("di_")]
                sub["_coupon"] = p["discounts[0][coupon]"]
            return sub
        if path == "/v1/billing_portal/configurations":
            c = {"id": State.new_id("bpc_"), "_params": p}
            State.portal_configs.append(c)
            return c
        if path == "/v1/billing_portal/sessions":
            return {"id": State.new_id("bps_"), "url": f"https://billing.stripe.com/p/session/test_{uuid.uuid4().hex[:10]}",
                    "customer": p.get("customer"), "configuration": p.get("configuration"), "return_url": p.get("return_url")}
        return (404, {"error": {"code": "resource_missing"}})

    def _test(self, path, p):
        """Test-only controls: the family on Stripe's page; Stripe's billing."""
        m = re.match(r"^/_test/complete/(cs_test_\w+)$", path)
        if m:
            s = State.sessions[m.group(1)]
            q = s["_params"]
            lines = lines_of(q)
            product = lambda ln: ln.get("price_data][product]") or f"prod_onetime_{abs(hash(ln.get('price_data][product_data][name]', ''))) % 10**8}"
            if s["mode"] == "payment":
                s["payment_intent"] = State.new_id("pi_")
                s["amount_total"] = sum(int(ln["price_data][unit_amount]"]) for ln in lines)
                s["payment_status"] = "unpaid" if p.get("async") else "paid"
            else:
                trial = q.get("subscription_data[trial_end]")
                anchor = q.get("subscription_data[billing_cycle_anchor]")
                sub_id = State.new_id("sub_")
                end = int(trial or anchor or time.time() + 30 * 86400)
                coupon = q.get("discounts[0][coupon]")
                State.subs[sub_id] = {
                    "id": sub_id, "object": "subscription", "status": "trialing" if trial else "active",
                    "customer": s["customer"], "cancel_at_period_end": False,
                    "metadata": nested(q, "subscription_data[metadata]["),
                    "items": {"data": [{"id": State.new_id("si_"), "current_period_end": end}]},
                    "discounts": [State.new_id("di_")] if coupon else [], "_coupon": coupon,
                    "_params": {k: v for k, v in q.items() if k.startswith("subscription_data")},
                }
                for k in list(State.subs[sub_id]["metadata"]):
                    State.subs[sub_id]["metadata"][k.rstrip("]")] = State.subs[sub_id]["metadata"].pop(k)
                one_time = [ln for ln in lines if "price_data][recurring][interval]" not in ln]
                inv_lines = [{"amount": int(ln["price_data][unit_amount]"]), "pricing": {"price_details": {"product": product(ln)}}}
                             for ln in one_time]
                prorated = 0 if trial else int(p.get("prorated", "5000"))
                if prorated:
                    inv_lines.append({"amount": prorated, "pricing": {"price_details": {"product": product(lines[0])}}})
                inv_id = State.new_id("in_")
                State.invoices[inv_id] = {"id": inv_id, "object": "invoice", "status": "paid", "billing_reason": "subscription_create",
                                          "amount_paid": sum(l["amount"] for l in inv_lines), "currency": "usd",
                                          "status_transitions": {"paid_at": int(time.time())},
                                          "parent": {"subscription_details": {"subscription": sub_id}}, "lines": {"data": inv_lines}}
                s["subscription"] = sub_id
                s["_invoice"] = inv_id
                s["payment_status"] = "paid"
            s["status"] = "complete"
            return self._send(200, s)
        m = re.match(r"^/_test/subscription/(sub_\w+)$", path)
        if m:
            sub = State.subs[m.group(1)]
            if "status" in p:
                sub["status"] = p["status"]
            if "cancel_at_period_end" in p:
                sub["cancel_at_period_end"] = p["cancel_at_period_end"] == "true"
            return self._send(200, sub)
        if path == "/_test/charge":
            ch = {"id": State.new_id("ch_"), "object": "charge", "customer": p["customer"], "amount": int(p["amount"]),
                  "amount_refunded": int(p["refunded"]), "currency": "usd"}
            State.charges[ch["id"]] = ch
            return self._send(200, ch)
        return self._send(404, {})


server = ThreadingHTTPServer(("127.0.0.1", 8798), Stripe)
threading.Thread(target=server.serve_forever, daemon=True).start()


def mock(path, fields=None):
    req = urllib.request.Request(MOCK + path, data=urllib.parse.urlencode(fields or {}).encode(), method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def sent(path):
    return [p for m, pa, p, v in State.log if m == "POST" and pa == path]


# --- the Worker -------------------------------------------------------------------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8", "replace")


def webhook(event, *, secret=WHSEC, t=None, raw=None):
    body = raw if raw is not None else json.dumps(event)
    t = int(time.time()) if t is None else t
    sig = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(BASE + "/api/stripe/webhook", data=body.encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Stripe-Signature", f"t={t},v1={sig}")
    try:
        r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), r.read().decode()


def event(etype, obj_id, livemode=False):
    return {"id": f"evt_{uuid.uuid4().hex[:24]}", "object": "event", "type": etype, "livemode": livemode,
            "data": {"object": {"id": obj_id}}}


def one(q):
    rows = sql(q)
    return rows[0] if rows else None


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


def loc(h):
    return h.get("Location") or h.get("location") or ""


# --- setup ---------------------------------------------------------------------------------
for t in ["stripe_events", "stripe_checkouts", "stripe_subscriptions", "stripe_customers", "payments", "billing_subscriptions",
          "enrollments", "consent_records", "program_groups", "player_medical", "household_emergency_contacts",
          "household_invites", "household_members", "sessions", "account_identities", "households", "accounts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players WHERE household_id IS NOT NULL")
sql("DELETE FROM programs WHERE id = 'fall-camp'")
sql("DELETE FROM app_settings WHERE key LIKE 'payments.%' OR key LIKE 'stripe.%'")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
# An open program needs a waiver (a CHECK in migration 009).
WAIVER = "STRIPE TEST WAIVER."
sql("UPDATE programs SET status='draft', waiver_version_id=NULL WHERE id='academy'")
sql("DELETE FROM waiver_versions WHERE id='stripe-test-v1'")
sql("INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) VALUES "
    f"('stripe-test-v1', 'Test entity', 'Test waiver', '{WAIVER}', '{hashlib.sha256(WAIVER.encode()).hexdigest()}', datetime('now'), datetime('now'))")
sql("UPDATE programs SET status='open', price_cents=20000, setup_fee_cents=4000, stripe_product_sandbox=NULL, "
    "waiver_version_id='stripe-test-v1' WHERE id='academy'")
assert one("SELECT status, price_cents FROM programs WHERE id='academy'") == {"status": "open", "price_cents": 20000}, "academy setup failed"

today = datetime.date.fromtimestamp(time.time() - 5 * 3600)  # near enough to Central for choosing dates
future = today + datetime.timedelta(days=12)
if future.day == 1:
    future += datetime.timedelta(days=1)
sql("INSERT INTO program_groups (program_id, name, schedule_summary, capacity, starts_on, created_at, updated_at) VALUES "
    f"('academy', 'Later group', 'Tuesdays', 10, '{future.isoformat()}', datetime('now'), datetime('now')), "
    "('academy', 'Running group', 'Saturdays', 10, '2026-01-10', datetime('now'), datetime('now'))")
LATER = one("SELECT id FROM program_groups WHERE name='Later group'")["id"]
RUNNING = one("SELECT id FROM program_groups WHERE name='Running group'")["id"]

ACCOUNT = make_account("stripe-fam@example.com", name="Pat Payer")
S = session_cookies(mint_session(ACCOUNT))
post(P + "/family/setup", {"guardian_name": "Pat Payer", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=S)
kids = {}
for child in ("Ava Payer", "Ben Payer", "Cal Payer"):
    post(P + "/children", {"child_name": child, "date_of_birth": "2016-04-04", "grade": "4", "school": "Test School", "shirt_size": "YM"},
         cookies=S)
    kids[child] = one(f"SELECT id FROM players WHERE display_name='{child}'")["id"]
HH = one("SELECT id FROM households")["id"]
OTHER = session_cookies(mint_session(make_account("stranger@example.com")))


def offer(child, group, ref):
    sql("INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status, offer_expires_at, applied_at, created_by, "
        f"created_at, updated_at) VALUES ('{ref}', {kids[child]}, {HH}, 'academy', {group}, 'offered', "
        "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 days'), datetime('now'), 'test', datetime('now'), datetime('now'))")
    return one(f"SELECT id FROM enrollments WHERE ref='{ref}'")["id"]


REF_A = "stripeRefOne0000000001"
REF_B = "stripeRefTwo0000000002"
E_A = offer("Ava Payer", LATER, REF_A)

try:
    print("\n=== Stripe only once Billing says so ===")
    st, _, _, html = get(P + f"/pay/{REF_A}", cookies=S)
    check("with PayPal still chosen, the pay page is PayPal's", st in (200, 503) and "checkout.stripe.com" not in html
          and "Continue to secure payment" not in html, st)
    st, h, _ = admin("POST", "/billing/provider", {"provider": "bitcoin"})
    check("only PayPal or Stripe", "msg=provider-invalid" in loc(h), loc(h))
    st, h, _ = admin("POST", "/billing/provider", {"provider": "stripe"})
    check("an admin switches new payments to Stripe", "msg=provider" in loc(h)
          and one("SELECT value FROM app_settings WHERE key='payments.provider'")["value"] == "stripe", loc(h))

    print("\n=== a child in a group starting later ===")
    st, h, _, html = get(P + f"/pay/{REF_A}", cookies=S)
    csp = h.get("Content-Security-Policy", "")
    days = (datetime.date(future.year + (future.month // 12), future.month % 12 + 1, 1) - future).days
    dim = (datetime.date(future.year + (future.month // 12), future.month % 12 + 1, 1) - future.replace(day=1)).days
    partial = int(20000 * days / dim + 0.5)
    check("the pay page says what is charged when: setup fee and the partial month today, $200 from the 1st",
          st == 200 and "Today: the $40 setup fee and" in html and f"${partial / 100:.2f}" in html and "Then $200 on the 1st" in html, st)
    check("its form may go on to Stripe's checkout page (and nowhere else)", "form-action 'self' https://checkout.stripe.com" in csp, csp)
    st, h, _, html = get(P + f"/pay/{REF_A}", cookies=OTHER)
    check("another family cannot see it", st in (303, 404) and "Accept the place" not in html, st)
    st, h, _, _ = post(P + f"/pay/{REF_A}/checkout", {}, cookies=S)
    check("Continue sends the family to Stripe's checkout page", st == 303 and loc(h).startswith("https://checkout.stripe.com/c/pay/cs_test_"), (st, loc(h)))
    sess = sent("/v1/checkout/sessions")[-1]
    lines = lines_of(sess)
    trial = int(sess.get("subscription_data[trial_end]", 0))
    trial_at = datetime.datetime.fromtimestamp(trial, datetime.timezone.utc)
    check("a subscription with a trial to midnight on the 1st after the start (Central)", sess["mode"] == "subscription"
          and trial_at.day == 1 and trial_at.hour in (5, 6) and "subscription_data[billing_cycle_anchor]" not in sess, (sess.get("mode"), trial_at))
    check("lines: $200 a month for the academy's product, the $40 setup fee, and the partial month",
          lines[0].get("price_data][unit_amount]") == "20000" and lines[0].get("price_data][recurring][interval]") == "month"
          and lines[0].get("price_data][product]", "").startswith("prod_")
          and any(l.get("price_data][unit_amount]") == "4000" and "Setup fee" in l.get("price_data][product_data][name]", "") for l in lines)
          and any(l.get("price_data][unit_amount]") == str(partial) for l in lines), lines)
    check("no discount for the first child", "discounts[0][coupon]" not in sess)
    check("tied to the place by its ref; card and bank offered; the family's own Stripe customer",
          sess.get("client_reference_id") == REF_A and sess.get("subscription_data[metadata][ref]") == REF_A
          and sess.get("payment_method_types[0]") == "card" and sess.get("payment_method_types[1]") == "us_bank_account"
          and sess.get("customer", "").startswith("cus_"))
    check("the way back carries Stripe's session id; Cancel returns to the pay page",
          sess.get("success_url", "").endswith(f"/pay/{REF_A}/done?session_id={{CHECKOUT_SESSION_ID}}")
          and sess.get("cancel_url", "").endswith(f"/pay/{REF_A}"))
    everything = json.dumps(State.log)
    check("no child's name was sent to Stripe", "Ava" not in everything and "Ben" not in everything and "Cal" not in everything)
    check("every call pinned the API version", all(v == "2026-09-30.endive" for _, _, _, v in State.log), {v for *_, v in State.log})
    cust = State.customers[sess["customer"]]
    check("the Stripe customer is the guardian (name, email), not the child", cust["email"] == "stripe-fam@example.com"
          and cust["name"] == "Pat Payer", cust)
    SID_A = State.sessions[next(reversed(State.sessions))]["id"]
    st, h, _, html = get(P + f"/pay/{REF_A}/done?session_id={SID_A}", cookies=S)
    check("back before Stripe has finished: 'confirming', nothing changes", st == 202
          and one(f"SELECT status FROM enrollments WHERE id={E_A}")["status"] == "offered", st)
    mock(f"/_test/complete/{SID_A}")
    st, h, _, _ = get(P + f"/pay/{REF_A}/done?session_id={SID_A}", cookies=OTHER)
    check("another family's session id does nothing", st in (303, 404) and one(f"SELECT status FROM enrollments WHERE id={E_A}")["status"] == "offered", st)
    st, h, _, _ = get(P + f"/pay/{REF_A}/done?session_id={SID_A}", cookies=S)
    check("back after paying: checked with Stripe, the place is confirmed", st == 303 and "notice=paid" in loc(h)
          and one(f"SELECT status FROM enrollments WHERE id={E_A}")["status"] == "active", (st, loc(h)))
    sub_a = one(f"SELECT subscription_id, status, enrollment_id FROM stripe_subscriptions WHERE enrollment_id={E_A}")
    check("its subscription is recorded against the place (trialing until the 1st)", sub_a and sub_a["status"] == "trialing", sub_a)
    SUB_A = sub_a["subscription_id"]
    st, _, _, html = get(P + "/", cookies=S)
    check("the family page offers Manage billing", "/billing/manage" in html and "Manage billing" in html)
    check("and still asks for the waiver alongside it", "Action needed: sign the waiver" in html)

    print("\n=== the webhook ===")
    INV_A = State.sessions[SID_A]["_invoice"]
    st, text = webhook(event("invoice.paid", INV_A))
    pays = sql(f"SELECT amount_cents, kind, provider FROM payments WHERE enrollment_id={E_A} ORDER BY kind")
    check("the first invoice is recorded as the $40 setup fee and the partial month's tuition", st == 200
          and pays == [{"amount_cents": partial, "kind": "recurring", "provider": "stripe"},
                       {"amount_cents": 4000, "kind": "setup_fee", "provider": "stripe"}], (st, text, pays))
    ev = event("invoice.paid", INV_A)
    webhook(ev)
    st, text = webhook(ev)
    check("the same event twice: recorded once", text == "duplicate" and len(sql(f"SELECT 1 FROM payments WHERE enrollment_id={E_A}")) == 2, text)
    st, _ = webhook(event("invoice.paid", INV_A), secret="whsec_forged")
    check("a forged signature is refused", st == 400, st)
    st, _ = webhook(event("invoice.paid", INV_A), t=int(time.time()) - 600)
    check("an event older than five minutes is refused", st == 400, st)
    st, text = webhook(event("customer.subscription.deleted", SUB_A, livemode=True))
    check("a live-mode event at the test endpoint is acknowledged and ignored", st == 200 and text == "other mode"
          and one(f"SELECT status FROM enrollments WHERE id={E_A}")["status"] == "active", text)

    print("\n=== a sibling in a running group ===")
    E_B = offer("Ben Payer", RUNNING, REF_B)
    st, _, _, html = get(P + f"/pay/{REF_B}", cookies=S)
    check("the pay page says 10% off: $180 a month", "Then $180 on the 1st" in html and "10% off" in html and "about $" in html)
    st, h, _, _ = post(P + f"/pay/{REF_B}/checkout", {}, cookies=S)
    sess = sent("/v1/checkout/sessions")[-1]
    anchor = int(sess.get("subscription_data[billing_cycle_anchor]", 0))
    anchor_at = datetime.datetime.fromtimestamp(anchor, datetime.timezone.utc)
    check("anchored on the next 1st (Stripe prorates the rest of this month), no trial", anchor_at.day == 1
          and anchor_at.hour in (5, 6) and "subscription_data[trial_end]" not in sess, anchor_at)
    coupon_id = sess.get("discounts[0][coupon]", "")
    coupon = State.coupons.get(coupon_id, {})
    product = lines_of(sess)[0]["price_data][product]"]
    check("10% off through a coupon that applies only to the academy's product (never the setup fee)",
          coupon.get("percent_off") == 10.0 and coupon.get("duration") == "forever" and coupon.get("applies_to") == [product], coupon)
    SID_B = State.sessions[next(reversed(State.sessions))]["id"]
    mock(f"/_test/complete/{SID_B}")
    st, text = webhook(event("checkout.session.completed", SID_B))
    check("the family never came back, but Stripe's webhook confirms the place", st == 200
          and one(f"SELECT status FROM enrollments WHERE id={E_B}")["status"] == "active", text)
    SUB_B = one(f"SELECT subscription_id FROM stripe_subscriptions WHERE enrollment_id={E_B}")["subscription_id"]

    print("\n=== Stripe moves the place ===")
    mock(f"/_test/subscription/{SUB_B}", {"status": "past_due"})
    webhook(event("customer.subscription.updated", SUB_B))
    check("a failed payment: past due", one(f"SELECT status FROM enrollments WHERE id={E_B}")["status"] == "past_due")
    mock(f"/_test/subscription/{SUB_B}", {"status": "active"})
    webhook(event("customer.subscription.updated", SUB_B))
    check("paid again: active", one(f"SELECT status FROM enrollments WHERE id={E_B}")["status"] == "active")
    mock(f"/_test/subscription/{SUB_A}", {"cancel_at_period_end": "true"})
    webhook(event("customer.subscription.updated", SUB_A))
    check("cancelled in Stripe's portal: the place runs to the end of the paid month",
          one(f"SELECT status FROM enrollments WHERE id={E_A}")["status"] == "active"
          and one(f"SELECT cancel_at_period_end AS c FROM stripe_subscriptions WHERE subscription_id='{SUB_A}'")["c"] == 1)
    mock(f"/_test/subscription/{SUB_A}", {"status": "canceled"})
    webhook(event("customer.subscription.deleted", SUB_A))
    check("then ends", one(f"SELECT status, ended_at IS NOT NULL AS e FROM enrollments WHERE id={E_A}") == {"status": "ended", "e": 1})
    check("and the sibling, now the family's only academy child, pays full price", State.subs[SUB_B]["_coupon"] is None, State.subs[SUB_B]["_coupon"])

    print("\n=== a scholarship ===")
    st, h, _ = admin("POST", f"/billing/places/{E_B}", {"scholarship_percent": "150"})
    check("a scholarship over 100% is refused", "msg=invalid" in loc(h), loc(h))
    st, h, _ = admin("POST", f"/billing/places/{E_B}", {"scholarship_percent": "50"})
    check("50% off is applied to the subscription from its next charge", "msg=saved" in loc(h)
          and State.subs[SUB_B]["_coupon"] == f"tns_{product}_50pct", State.subs[SUB_B]["_coupon"])

    print("\n=== moving from PayPal ===")
    st, h, _ = admin("POST", f"/families/children/{kids['Cal Payer']}/place", {"group_id": str(RUNNING), "billed_outside": "paypal_join",
                                                                              "outside_reference": "I-CALPAYPAL0001"})
    E_C = one(f"SELECT id FROM enrollments WHERE player_id={kids['Cal Payer']}")["id"]
    REF_C = one(f"SELECT ref FROM enrollments WHERE id={E_C}")["ref"]
    st, _, _, html = get(P + "/", cookies=S)
    check("not asked to move until staff record the day PayPal covers to", "move your monthly payment" not in html)
    paid_through = (today + datetime.timedelta(days=20)).isoformat()
    admin("POST", f"/billing/places/{E_C}", {"outside_paid_through": paid_through})
    st, _, _, html = get(P + "/", cookies=S)
    check("then the family page asks them to move it, alongside the waiver it also needs",
          "Action needed: move your monthly payment from PayPal" in html and f"/pay/{REF_C}/move" in html
          and html.count("Action needed: sign the waiver") >= 1)
    st, _, _, html = get(P + f"/pay/{REF_C}/move", cookies=S)
    check("nothing today and no setup fee; the sibling 10% applies", st == 200 and "Nothing today." in html and "Then $180 on the 1st" in html
          and "one-time $40 setup fee" not in html and "only once we offer" not in html, st)
    st, h, _, _ = post(P + f"/pay/{REF_C}/move", {}, cookies=S)
    sess = sent("/v1/checkout/sessions")[-1]
    trial_at = datetime.datetime.fromtimestamp(int(sess.get("subscription_data[trial_end]", 0)), datetime.timezone.utc)
    first = (datetime.date.fromisoformat(paid_through).replace(day=1) + datetime.timedelta(days=32)).replace(day=1)
    check("a trial to the 1st after PayPal's last day, and only the monthly line", st == 303 and trial_at.date() == first
          and len(lines_of(sess)) == 1 and sess.get("metadata[purpose]") == "move", (trial_at, first, lines_of(sess)))
    SID_C = State.sessions[next(reversed(State.sessions))]["id"]
    mock(f"/_test/complete/{SID_C}")
    st, h, _, _ = get(P + f"/pay/{REF_C}/done?session_id={SID_C}", cookies=S)
    check("done: the place stays as it was, now paid through Stripe", "notice=paid" in loc(h)
          and one(f"SELECT status FROM enrollments WHERE id={E_C}")["status"] == "active"
          and one(f"SELECT COUNT(*) AS n FROM stripe_subscriptions WHERE enrollment_id={E_C}")["n"] == 1, loc(h))
    st, _, html = admin("GET", "/billing")
    check("staff are told to cancel the PayPal subscription", "I-CALPAYPAL0001" in html and "Done: cancelled in PayPal" in html)
    st, _, html = admin("GET", "/brief")
    check("and the daily brief says so", "moved to the new payments — cancel their PayPal subscription" in html)
    st, h, _ = admin("POST", f"/billing/places/{E_C}/paypal-cancelled")
    st, _, html = admin("GET", "/billing")
    check("marked done, it leaves the list", "msg=cancelled" in loc(h) and "I-CALPAYPAL0001" not in html, loc(h))

    print("\n=== Manage billing ===")
    st, h, _, _ = get(P + "/billing/manage", cookies=S)
    conf = State.portal_configs[-1]["_params"] if State.portal_configs else {}
    check("opens Stripe's billing page for this family", st == 303 and loc(h).startswith("https://billing.stripe.com/p/session/"), (st, loc(h)))
    check("which lets them change card or bank, see receipts, and cancel at the end of the paid month",
          conf.get("features[subscription_cancel][mode]") == "at_period_end" and conf.get("features[payment_method_update][enabled]") == "true"
          and conf.get("features[invoice_history][enabled]") == "true" and conf.get("features[subscription_update][enabled]") == "false", conf)
    get(P + "/billing/manage", cookies=S)
    check("its configuration is made once", len(State.portal_configs) == 1, len(State.portal_configs))
    st, h, _, _ = get(P + "/billing/manage", cookies=OTHER)
    check("a family with no Stripe payments gets no billing page", st in (303, 404) and "stripe.com" not in loc(h), (st, loc(h)))

    print("\n=== a camp: one payment ===")
    sql("INSERT INTO programs (id, kind, name, status, enrollment_mode, billing, currency, price_cents, public, waitlist_enabled, "
        "waiver_version_id, created_at, updated_at) SELECT 'fall-camp', 'camp', 'Fall Camp', 'open', 'self_serve', 'one_time', 'USD', 15000, 1, 1, "
        "waiver_version_id, datetime('now'), datetime('now') FROM programs WHERE id='academy'")
    sql("INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at) "
        "VALUES ('fall-camp', 'Week 1', 'Mon-Fri', 10, datetime('now'), datetime('now'))")
    CAMP_G = one("SELECT id FROM program_groups WHERE program_id='fall-camp'")["id"]
    sql("INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status, offer_expires_at, applied_at, created_by, "
        f"created_at, updated_at) VALUES ('stripeRefCamp000000003', {kids['Cal Payer']}, {HH}, 'fall-camp', {CAMP_G}, 'offered', "
        "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes'), datetime('now'), 'test', datetime('now'), datetime('now'))")
    st, _, _, html = get(P + "/pay/stripeRefCamp000000003", cookies=S)
    check("the pay page says one payment of $150", "One payment of $150." in html, st)
    st, h, _, _ = post(P + "/pay/stripeRefCamp000000003/checkout", {}, cookies=S)
    sess = sent("/v1/checkout/sessions")[-1]
    exp = int(sess.get("expires_at", 0)) - int(time.time())
    check("payment mode, $150, and the session lives at least Stripe's 30 minutes", sess["mode"] == "payment"
          and lines_of(sess)[0]["price_data][unit_amount]"] == "15000" and 30 * 60 <= exp <= 32 * 60, (sess.get("mode"), exp))
    SID_D = State.sessions[next(reversed(State.sessions))]["id"]
    mock(f"/_test/complete/{SID_D}")
    st, h, _, _ = get(P + f"/pay/stripeRefCamp000000003/done?session_id={SID_D}", cookies=S)
    camp = one("SELECT e.status, p.amount_cents, p.kind FROM enrollments e JOIN payments p ON p.enrollment_id = e.id WHERE e.ref='stripeRefCamp000000003'")
    check("paid: the place is confirmed and the payment recorded", camp == {"status": "active", "amount_cents": 15000, "kind": "one_time"}, camp)

    print("\n=== a refund ===")
    ch = mock("/_test/charge", {"customer": cust["id"], "amount": "15000", "refunded": "15000"})
    st, _ = webhook(event("charge.refunded", ch["id"]))
    r = one(f"SELECT amount_cents, kind, household_id FROM payments WHERE kind='refund'")
    check("recorded as a negative payment against the family", st == 200 and r == {"amount_cents": -15000, "kind": "refund", "household_id": HH}, r)

    print("\n=== who may ===")
    for rr in ("coach", "viewer"):
        role(rr)
        codes = [admin("GET", "/billing")[0], admin("GET", f"/billing/places/{E_B}")[0], admin("POST", "/billing/provider", {"provider": "paypal"})[0],
                 admin("POST", f"/billing/places/{E_B}", {"scholarship_percent": "100"})[0]]
        check(f"a {rr} reaches none of the billing pages", codes == [403, 403, 403, 403], codes)
    role("admin")
    audit = sql("SELECT action, detail FROM audit_log WHERE action LIKE 'billing.%' OR action LIKE 'portal.%stripe%' OR action LIKE 'portal.move%'")
    check("the audit log carries identifiers only (no names, no amounts)", "Payer" not in json.dumps(audit) and "15000" not in json.dumps(audit), audit[-3:])
finally:
    sql("DELETE FROM app_settings WHERE key LIKE 'payments.%' OR key LIKE 'stripe.%'")
    server.shutdown()

check.finish()
