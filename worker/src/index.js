import Stripe from 'stripe';
import { getCatalog, resolveItems } from './products.js';

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const allow = allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, init = {}, cors = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
      ...(init.headers || {}),
    },
  });
}

function errText(message, status, cors) {
  return new Response(message, { status, headers: cors });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/products' && request.method === 'GET') {
        const catalog = await getCatalog(env, ctx);
        return json(catalog, {}, cors);
      }
      if (url.pathname === '/payment-intent' && request.method === 'POST') {
        return await handlePaymentIntent(request, env, ctx, cors);
      }
      if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
        return await handleStripeWebhook(request, env, cors);
      }
      if (url.pathname === '/health') {
        return json({ ok: true }, {}, cors);
      }
      return errText('Not found', 404, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return errText(err.message || 'Server error', 500, cors);
    }
  },
};

async function handlePaymentIntent(request, env, ctx, cors) {
  const body = await request.json();
  const { items = [], shipping = {} } = body;

  if (!Array.isArray(items) || items.length === 0) {
    return errText('Cart is empty', 400, cors);
  }

  const catalog = await getCatalog(env, ctx);
  const { resolved, subtotalCents } = resolveItems(catalog, items);

  // TODO: call Printful /shipping/rates for real shipping calc.
  // For now: flat $5 shipping.
  const shippingCents = 500;
  const totalCents = subtotalCents + shippingCents;

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  const intent = await stripe.paymentIntents.create({
    amount: totalCents,
    currency: 'usd',
    automatic_payment_methods: { enabled: true },
    receipt_email: shipping.email || undefined,
    metadata: {
      cart: JSON.stringify(resolved),
      shipping: JSON.stringify(shipping),
      shipping_cents: String(shippingCents),
      subtotal_cents: String(subtotalCents),
    },
  });

  return json(
    { clientSecret: intent.client_secret, amount: totalCents },
    {},
    cors
  );
}

async function handleStripeWebhook(request, env, cors) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  const signature = request.headers.get('Stripe-Signature');
  const payload = await request.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return errText(`Webhook signature verification failed: ${err.message}`, 400, cors);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const cart = JSON.parse(intent.metadata.cart || '[]');
    const shipping = JSON.parse(intent.metadata.shipping || '{}');

    const printfulOrder = {
      external_id: intent.id,
      recipient: {
        name: shipping.name,
        address1: shipping.address1,
        address2: shipping.address2 || '',
        city: shipping.city,
        state_code: shipping.state,
        country_code: shipping.country || 'US',
        zip: shipping.zip,
        email: shipping.email,
      },
      items: cart.map((line) => ({
        variant_id: line.printful_variant_id,
        quantity: line.quantity,
        retail_price: (line.unit_cents / 100).toFixed(2),
      })),
    };

    const pfRes = await fetch('https://api.printful.com/orders?confirm=false', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(printfulOrder),
    });

    if (!pfRes.ok) {
      const text = await pfRes.text();
      console.error('Printful order failed:', text);
      return errText('Printful order failed', 500, cors);
    }
  }

  return json({ received: true }, {}, cors);
}
