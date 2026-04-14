const PRINTFUL_BASE = 'https://api.printful.com';

function printfulHeaders(env) {
  return {
    Authorization: `Bearer ${env.PRINTFUL_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchProductDetails(id, env) {
  const res = await fetch(`${PRINTFUL_BASE}/store/products/${id}`, {
    headers: printfulHeaders(env),
  });
  if (!res.ok) return null;
  const { result } = await res.json();
  return result;
}

export async function fetchCatalog(env) {
  const listRes = await fetch(`${PRINTFUL_BASE}/store/products`, {
    headers: printfulHeaders(env),
  });
  if (!listRes.ok) {
    throw new Error(`Printful /store/products returned ${listRes.status}`);
  }
  const { result: productList } = await listRes.json();

  const details = await Promise.all(
    productList.map((p) => fetchProductDetails(p.id, env))
  );

  const products = details
    .filter(Boolean)
    .map((detail) => {
      const { sync_product, sync_variants } = detail;

      const variants = sync_variants
        .filter((sv) => sv.variant_id && sv.retail_price)
        .map((sv) => ({
          id: `pf-${sv.id}`,
          label: sv.name.replace(sync_product.name, '').replace(/^\s*[-–—/]\s*/, '').trim() || sv.name,
          price_cents: Math.round(parseFloat(sv.retail_price) * 100),
          printful_variant_id: sv.variant_id,
        }));

      if (variants.length === 0) return null;

      const previewFile = sync_variants
        .flatMap((sv) => sv.files || [])
        .find((f) => f.type === 'preview') || sync_variants
        .flatMap((sv) => sv.files || [])
        .find((f) => f.preview_url);

      const image = previewFile
        ? previewFile.preview_url || previewFile.thumbnail_url
        : sync_product.thumbnail_url;

      return {
        id: `sync-${sync_product.id}`,
        name: sync_product.name,
        images: image ? [image] : [],
        variants,
      };
    })
    .filter(Boolean);

  return { currency: 'USD', products };
}

export async function getCatalog(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://tnsaints-catalog/products');

  let response = await cache.match(cacheKey);
  if (response) {
    return await response.json();
  }

  const data = await fetchCatalog(env);
  const ttl = parseInt(env.CATALOG_TTL_SECONDS, 10) || 600;
  response = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `s-maxage=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return data;
}

export function resolveItems(catalog, items) {
  const productMap = {};
  for (const p of catalog.products) {
    const variantMap = {};
    for (const v of p.variants) {
      variantMap[v.id] = v;
    }
    productMap[p.id] = { name: p.name, variants: variantMap };
  }

  const resolved = [];
  let subtotalCents = 0;
  for (const item of items) {
    const product = productMap[item.productId];
    if (!product) throw new Error(`Unknown product: ${item.productId}`);
    const variant = product.variants[item.variantId];
    if (!variant) throw new Error(`Unknown variant: ${item.variantId}`);
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const lineCents = variant.price_cents * qty;
    subtotalCents += lineCents;
    resolved.push({
      productId: item.productId,
      variantId: item.variantId,
      printful_variant_id: variant.printful_variant_id,
      name: product.name,
      label: variant.label,
      quantity: qty,
      unit_cents: variant.price_cents,
      line_cents: lineCents,
    });
  }
  return { resolved, subtotalCents };
}
