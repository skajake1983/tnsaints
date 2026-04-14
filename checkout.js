(function () {
  // Replace with your Stripe publishable key. Safe to expose.
  const STRIPE_PUBLISHABLE_KEY = 'pk_test_REPLACE_ME';
  // Worker base URL. Local dev: http://localhost:8787
  const WORKER_BASE = 'https://api.tnsaints.com';

  let stripe = null;
  let elements = null;
  let paymentElement = null;
  let clientSecret = null;

  async function init() {
    if (!window.Stripe) {
      console.error('Stripe.js not loaded');
      return;
    }
    stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
    await renderCart();
  }

  function getShippingFromForm() {
    return {
      name: document.getElementById('ship-name').value.trim(),
      email: document.getElementById('ship-email').value.trim(),
      address1: document.getElementById('ship-address1').value.trim(),
      address2: document.getElementById('ship-address2').value.trim(),
      city: document.getElementById('ship-city').value.trim(),
      state: document.getElementById('ship-state').value.trim(),
      zip: document.getElementById('ship-zip').value.trim(),
      country: 'US',
    };
  }

  async function renderCart() {
    const itemsEl = document.getElementById('cart-items-list');
    const summaryEl = document.getElementById('cart-summary');
    const checkoutBox = document.getElementById('checkout-box');

    const items = await TNCart.hydratedItems();

    if (!items.length) {
      itemsEl.innerHTML = `
        <div class="empty-state">
          <p>Your cart is empty.</p>
          <button type="button" data-drawer-close data-scroll-shop>Browse the shop &rarr;</button>
        </div>
      `;
      const browseBtn = itemsEl.querySelector('[data-scroll-shop]');
      if (browseBtn) {
        browseBtn.addEventListener('click', () => {
          const shop = document.getElementById('shop');
          if (shop) shop.scrollIntoView({ behavior: 'smooth' });
        });
      }
      summaryEl.innerHTML = '';
      checkoutBox.style.display = 'none';
      return;
    }

    const catalog = await TNCart.loadCatalog();

    itemsEl.innerHTML = items.map((item) => `
      <div class="cart-item" data-product="${item.productId}" data-variant="${item.variantId}">
        <div class="thumb"><img src="${item.product.images[0]}" alt="${item.product.name}" /></div>
        <div class="details">
          <h4>${item.product.name}</h4>
          <div class="variant-label">${item.variant.label}</div>
          <div class="qty">
            <button data-action="dec">−</button>
            <span>${item.quantity}</span>
            <button data-action="inc">+</button>
          </div>
          <button class="remove" data-action="remove">Remove</button>
        </div>
        <div class="line-total">${TNCart.formatMoney(item.linePriceCents, catalog.currency)}</div>
      </div>
    `).join('');

    itemsEl.querySelectorAll('.cart-item').forEach((row) => {
      const productId = row.dataset.product;
      const variantId = row.dataset.variant;
      row.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = TNCart.read().find(
            (i) => i.productId === productId && i.variantId === variantId
          );
          if (!existing) return;
          if (btn.dataset.action === 'inc') {
            TNCart.update(productId, variantId, existing.quantity + 1);
          } else if (btn.dataset.action === 'dec') {
            TNCart.update(productId, variantId, existing.quantity - 1);
          } else if (btn.dataset.action === 'remove') {
            TNCart.remove(productId, variantId);
          }
          renderCart();
        });
      });
    });

    const subtotal = items.reduce((s, i) => s + i.linePriceCents, 0);
    summaryEl.innerHTML = `
      <div class="summary-row"><span>Subtotal</span><span>${TNCart.formatMoney(subtotal, catalog.currency)}</span></div>
      <div class="summary-row"><span>Shipping</span><span>Calculated at payment</span></div>
      <div class="summary-row total"><span>Total</span><span>${TNCart.formatMoney(subtotal, catalog.currency)}</span></div>
    `;
    checkoutBox.style.display = '';
  }

  async function createPaymentIntent() {
    const items = TNCart.read();
    const shipping = getShippingFromForm();

    const res = await fetch(`${WORKER_BASE}/payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, shipping }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to create payment intent');
    }
    const data = await res.json();
    return data.clientSecret;
  }

  async function mountPaymentElement() {
    const errorEl = document.getElementById('checkout-error');
    errorEl.textContent = '';
    try {
      clientSecret = await createPaymentIntent();
      elements = stripe.elements({ clientSecret });
      paymentElement = elements.create('payment');
      paymentElement.mount('#payment-element');
      document.getElementById('pay-btn').disabled = false;
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  async function submitPayment(e) {
    e.preventDefault();
    const errorEl = document.getElementById('checkout-error');
    errorEl.textContent = '';

    if (!clientSecret) {
      await mountPaymentElement();
      if (!clientSecret) return;
    }

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${location.origin}${location.pathname}?checkout=complete`,
      },
    });

    if (error) {
      errorEl.textContent = error.message || 'Payment failed';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    init();

    const form = document.getElementById('checkout-form');
    const prepareBtn = document.getElementById('prepare-payment');
    if (prepareBtn) prepareBtn.addEventListener('click', mountPaymentElement);
    if (form) form.addEventListener('submit', submitPayment);

    // Re-render when the cart mutates from anywhere on the page.
    document.addEventListener('cart:changed', () => {
      // Reset any in-flight Stripe session since line items changed.
      clientSecret = null;
      if (paymentElement) {
        try { paymentElement.unmount(); } catch {}
        paymentElement = null;
      }
      const payBtn = document.getElementById('pay-btn');
      if (payBtn) payBtn.disabled = true;
      renderCart();
    });

    const params = new URLSearchParams(location.search);
    if (params.get('checkout') === 'complete') {
      const layout = document.getElementById('cart-layout');
      if (layout) {
        layout.innerHTML = `
          <div class="checkout-success">
            <i class="fas fa-check-circle" style="font-size:3rem;color:var(--saints-gold);margin-bottom:0.8rem;"></i>
            <h3 style="margin:0 0 0.4rem;color:var(--saints-blue-dark);">Thanks for your order!</h3>
            <p style="margin:0 0 1.2rem;color:#555;">Your payment was received. You'll get an email confirmation shortly.</p>
            <button type="button" class="btn btn-secondary" data-drawer-close>Keep shopping</button>
          </div>
        `;
      }
      TNCart.clear();
      if (window.TNDrawer) window.TNDrawer.open();
      history.replaceState({}, '', location.pathname + location.hash);
    }
  });
})();
