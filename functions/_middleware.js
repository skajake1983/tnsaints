/**
 * Shareable-link preview: evergreen by default, eval-aware by date.
 *
 * index.html carries EVERGREEN preview tags (the academy, no dates) as the safe
 * default, so a shared link can never get stuck showing a past event. While an
 * evaluation is upcoming (see EVAL_PREVIEW.activeUntil below), this middleware
 * rewrites those Open Graph / Twitter tags to the eval card + copy FOR CRAWLERS,
 * server-side — social scrapers (Facebook, iMessage, LinkedIn) do not run
 * JavaScript, so the swap has to happen in the response, not on the page. The
 * instant activeUntil passes, this stops and the evergreen tags stand again —
 * no edit, no cleanup.
 *
 * ── TO RUN A NEW EVALUATION ──────────────────────────────────────────────
 *   1. Cut a new eval card and upload it to the site root. Bump its filename
 *      (e.g. social-card-v5.jpg) — Facebook caches preview images by URL.
 *   2. Set the four fields below: activeUntil = the eval DATE at end of day
 *      Central, image = the new card's URL, and the title/description/alt copy.
 *   3. Commit + push. The eval preview shows until that date, then the site
 *      reverts to the evergreen card on its own.
 * Leaving a past activeUntil here is harmless — an expired date is simply inert.
 *
 * Fail-safe by construction: only text/html responses are touched, only these
 * eight meta tags are changed, every other request passes straight through, and
 * any error serves the page unchanged (i.e. the evergreen tags).
 */
const EVAL_PREVIEW = {
  // Past date → inert; the evergreen card shows. This is the concluded 8/29
  // evaluation, kept as a worked example of the shape a future eval fills in.
  activeUntil: '2026-08-29T23:59:59-05:00',
  image: 'https://tnsaints.com/social-card-v4.jpg',
  title: 'Free Academy Evaluation — Sat, Aug 29 | Tennessee Saints',
  description:
    '9–11 AM at Grassland Heights Baptist Church, Franklin TN. 3rd–6th grade, ' +
    'spots are limited, register by 8/27.',
  alt:
    'Free Academy Evaluation, Saturday August 29, 9 to 11 AM, Grassland Heights ' +
    'Baptist Church, Franklin TN. Register by August 27 at tnsaints.com.',
};

export async function onRequest(context) {
  const response = await context.next();
  try {
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return response;

    const until = EVAL_PREVIEW && EVAL_PREVIEW.activeUntil
      ? new Date(EVAL_PREVIEW.activeUntil)
      : null;
    const evalActive =
      until && !Number.isNaN(until.getTime()) && new Date() <= until;

    // Evergreen: pass the page through unchanged, tagged so the mode is
    // observable in production (the output is otherwise identical to the
    // static HTML, so this header is the only way to confirm the function ran).
    if (!evalActive) {
      const passthrough = new Response(response.body, response);
      passthrough.headers.set('x-tns-preview', 'evergreen');
      return passthrough;
    }

    const p = EVAL_PREVIEW;
    const content = (value) => ({
      element(el) {
        el.setAttribute('content', value);
      },
    });
    const rewritten = new HTMLRewriter()
      .on('meta[property="og:title"]', content(p.title))
      .on('meta[property="og:description"]', content(p.description))
      .on('meta[property="og:image"]', content(p.image))
      .on('meta[property="og:image:alt"]', content(p.alt))
      .on('meta[name="twitter:title"]', content(p.title))
      .on('meta[name="twitter:description"]', content(p.description))
      .on('meta[name="twitter:image"]', content(p.image))
      .on('meta[name="twitter:image:alt"]', content(p.alt))
      .transform(response);
    rewritten.headers.set('x-tns-preview', 'eval');
    return rewritten;
  } catch (err) {
    return response; // fail-safe: serve the page unchanged
  }
}
