(function () {
  // TODO: change back to 'https://api.tnsaints.com' for production
  const WORKER_BASE = 'http://localhost:8787';
  const STORAGE_KEY = 'tnsaints_cart_v1';

  function read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function write(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    updateBadge();
    document.dispatchEvent(new CustomEvent('cart:changed'));
  }

  function add(productId, variantId, quantity = 1) {
    const items = read();
    const existing = items.find(
      (i) => i.productId === productId && i.variantId === variantId
    );
    if (existing) {
      existing.quantity += quantity;
    } else {
      items.push({ productId, variantId, quantity });
    }
    write(items);
  }

  function update(productId, variantId, quantity) {
    let items = read();
    if (quantity <= 0) {
      items = items.filter(
        (i) => !(i.productId === productId && i.variantId === variantId)
      );
    } else {
      const match = items.find(
        (i) => i.productId === productId && i.variantId === variantId
      );
      if (match) match.quantity = quantity;
    }
    write(items);
  }

  function remove(productId, variantId) {
    update(productId, variantId, 0);
  }

  function clear() {
    write([]);
  }

  function totalCount() {
    return read().reduce((sum, i) => sum + i.quantity, 0);
  }

  async function loadCatalog() {
    if (loadCatalog._cache) return loadCatalog._cache;
    const res = await fetch(`${WORKER_BASE}/products`);
    const data = await res.json();
    loadCatalog._cache = data;
    return data;
  }

  function findVariant(catalog, productId, variantId) {
    const product = catalog.products.find((p) => p.id === productId);
    if (!product) return null;
    const variant = product.variants.find((v) => v.id === variantId);
    if (!variant) return null;
    return { product, variant };
  }

  async function hydratedItems() {
    const items = read();
    const catalog = await loadCatalog();
    return items
      .map((item) => {
        const match = findVariant(catalog, item.productId, item.variantId);
        if (!match) return null;
        return {
          ...item,
          product: match.product,
          variant: match.variant,
          linePriceCents: match.variant.price_cents * item.quantity,
        };
      })
      .filter(Boolean);
  }

  function formatMoney(cents, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(cents / 100);
  }

  function updateBadge() {
    const badges = document.querySelectorAll('[data-cart-count]');
    const count = totalCount();
    badges.forEach((el) => {
      el.textContent = count;
      el.style.display = count > 0 ? '' : 'none';
    });
  }

  document.addEventListener('DOMContentLoaded', updateBadge);

  window.TNCart = {
    read,
    add,
    update,
    remove,
    clear,
    totalCount,
    loadCatalog,
    hydratedItems,
    formatMoney,
  };
})();
