/**
 * Brand tokens shared by every server-rendered surface (admin, parent portal).
 *
 * Lifted verbatim from index.html's custom properties so the dashboards and the
 * public site cannot drift apart. Same names, same values.
 *
 * One deliberate distinction: --gold (#f5cf00) is a bright accent that works
 * on the dark blue header and fails WCAG badly as text on white — roughly
 * 1.7:1. So gold is used for marks and accents on dark, and --gold-ink
 * (#8a6f00) carries any gold-flavoured TEXT on a light background, where it
 * clears AA. Reaching for --gold on a white card is the mistake to avoid.
 */
export const BRAND_TOKENS = `
  :root {
    --navy: #06255c;        /* --saints-blue-dark */
    --navy-soft: #0b3a8d;   /* --saints-blue */
    --gold: #f5cf00;        /* --saints-gold — accents on dark only */
    --gold-soft: #ffe873;   /* legible nav links on the navy header */
    --gold-ink: #8a6f00;    /* gold-toned text on light backgrounds */
    --ink: #13233d;         /* --saints-text */
    --muted: #5a6b85;
    --line: #dfe3ea;        /* --saints-gray */
    --bg: #f3f5f9;          /* --saints-light */
    --ok: #1c7c4a; --warn: #a8620d; --danger: #a32020;
  }`;
