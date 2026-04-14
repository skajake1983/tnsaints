# TN Saints Shop Worker

Cloudflare Worker that handles Stripe payment intents and Printful order creation for the Tennessee Saints shop. The static site (GitHub Pages) calls this Worker; the Worker holds all secrets.

## One-time setup

### 1. Accounts

- **Stripe** — https://dashboard.stripe.com/register. Grab the test **publishable** and **secret** keys from the API keys page.
- **Printful** — https://www.printful.com/dashboard/store. Create a store (choose "Manual platform / API"). Generate an API key under Settings → API.
- **Cloudflare** — https://dash.cloudflare.com/sign-up (free plan is enough).

### 2. Install tooling

```bash
cd worker
npm install
npx wrangler login
```

### 3. Set Worker secrets

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # fill after step 5
npx wrangler secret put PRINTFUL_API_KEY
```

### 4. Deploy

```bash
npx wrangler deploy
```

The first deploy puts the Worker on `tnsaints-shop.<your-subdomain>.workers.dev`. Copy that URL — you need it for the next step.

### 5. Stripe webhook

In the Stripe dashboard → Developers → Webhooks → **Add endpoint**:
- URL: `https://tnsaints-shop.<your-subdomain>.workers.dev/stripe-webhook`
- Events: `payment_intent.succeeded`

Copy the **signing secret** it gives you and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`, then `npx wrangler deploy` again.

### 6. Custom domain (optional but recommended)

1. Add `tnsaints.com` as a site in Cloudflare (free plan). If you don't want to move nameservers off your current DNS host, skip this and use the `*.workers.dev` URL in `checkout.js` instead.
2. In Cloudflare Workers → your Worker → Triggers → **Add custom domain**: `api.tnsaints.com`.
3. Uncomment the `routes = [...]` block in `wrangler.toml` and redeploy.
4. Update the Stripe webhook URL to `https://api.tnsaints.com/stripe-webhook`.

### 7. Wire the frontend

In [../checkout.js](../checkout.js):
- Replace `STRIPE_PUBLISHABLE_KEY` with your Stripe **publishable** key (`pk_test_...` during testing).
- Replace `WORKER_BASE` with your Worker URL (`https://api.tnsaints.com` or the `*.workers.dev` URL).

## Local development

```bash
cd worker
npx wrangler dev        # starts on http://localhost:8787
```

Put secrets in `worker/.dev.vars` (gitignored):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
PRINTFUL_API_KEY=...
```

Then in [../checkout.js](../checkout.js) temporarily set `WORKER_BASE = 'http://localhost:8787'` and serve the static site locally (`python -m http.server 8000` from the `tnsaints/` folder).

To test the webhook locally, use the Stripe CLI:

```bash
stripe listen --forward-to localhost:8787/stripe-webhook
```

## Test checklist

1. `wrangler dev` running; static site served on localhost:8000.
2. Visit `/` → scroll to the Shop section → products load in the carousel.
3. Pick a size, choose quantity, click "Add to cart".
4. Click the cart icon in the nav → drawer slides out → fill shipping form → "Continue to payment".
5. Stripe Elements mounts. Use test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
6. "Pay now" → Stripe confirms → redirect back with `?checkout=complete` → drawer shows success state and cart clears.
7. Stripe dashboard (test mode) shows a successful PaymentIntent.
8. Stripe CLI shows the webhook firing.
9. Printful dashboard shows a **draft** order (because `confirm=false` in [src/index.js](src/index.js)).

When you're confident everything works end-to-end, flip `confirm=false` → `confirm=true` in `src/index.js` for real fulfillment, and swap Stripe keys from test to live mode.

## Product catalog

The catalog is auto-synced from your Printful store. The Worker fetches from `GET /store/products` + `GET /store/products/{id}` and caches the result at the edge for 10 minutes (configurable via `CATALOG_TTL_SECONDS` in `wrangler.toml`).

To add a product: publish it in the Printful dashboard. It will appear on the site within 10 minutes — no code changes needed.

The Worker validates prices server-side using the same cached catalog data. Client-supplied prices are never trusted.

## Costs

- Cloudflare Workers free tier: 100,000 requests/day, 10ms CPU per request. A small shop will stay in the free tier indefinitely.
- Stripe: 2.9% + $0.30 per successful card charge. No monthly fee.
- Printful: wholesale cost per fulfilled item; no monthly fee.
