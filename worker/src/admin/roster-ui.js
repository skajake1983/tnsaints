/**
 * Medical-note reveal on the roster.
 *
 * The note text is the single most sensitive field in the system, so viewing it
 * is deliberately not just "render it in the page". An admin clicks a button,
 * which fetches GET /api/roster/:id/medical — and that endpoint is where the
 * real control lives: it re-checks the roster:medical capability server-side
 * and writes an audit row on every read (and every refused read). The button is
 * only rendered for admins as a convenience; the endpoint is the gate.
 *
 * The note is shown in a modal via textContent, never innerHTML — it is
 * free-typed parent text and must never be interpreted as markup.
 */

import { esc } from './ui.js';

const BODY_SCRIPT = `
(function () {
  var backdrop = document.getElementById('medBackdrop');
  if (!backdrop) return;
  var titleEl = document.getElementById('medTitle');
  var bodyEl = document.getElementById('medBody');
  var closeBtn = document.getElementById('medClose');
  var lastFocus = null;

  function close() {
    backdrop.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function (e) {
    if (!backdrop.hidden && e.key === 'Escape') { e.preventDefault(); close(); }
  });

  document.querySelectorAll('[data-medical]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      lastFocus = btn;
      titleEl.textContent = 'Medical note — ' + btn.dataset.name;
      bodyEl.textContent = 'Loading…';
      document.body.style.overflow = 'hidden';
      backdrop.hidden = false;
      closeBtn.focus();
      fetch('/api/roster/' + btn.dataset.medical + '/medical', {
        headers: { 'Accept': 'application/json' }
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
        .then(function (res) {
          if (!res.ok || !res.b.ok) {
            bodyEl.textContent = (res.b && res.b.error) || 'Could not load the note.';
            return;
          }
          // textContent, never innerHTML — this is parent-typed text.
          bodyEl.textContent = res.b.medical_notes || '(No medical note text on file.)';
        })
        .catch(function () {
          bodyEl.textContent = 'Could not load the note — check your connection and try again.';
        });
    });
  });
})();
`;

let cachedHash = null;
async function scriptCspHash() {
  if (cachedHash) return cachedHash;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BODY_SCRIPT));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  cachedHash = `'sha256-${btoa(binary)}'`;
  return cachedHash;
}

export async function rosterCsp() {
  const hash = await scriptCspHash();
  return (
    "default-src 'none'; " +
    `script-src ${hash}; ` +
    "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
}

export const ROSTER_STYLES = `
  .medbtn { border: 1px solid #e5b9b9; background: #fff; color: var(--danger);
            border-radius: 7px; padding: 6px 11px; font: inherit; font-size: 13px;
            font-weight: 600; cursor: pointer; }
  .medbtn:hover { background: #f9e9e9; }
  .med-backdrop { position: fixed; inset: 0; background: rgba(6, 37, 92, .55);
                  display: flex; align-items: center; justify-content: center;
                  padding: 20px; z-index: 100; }
  .med-backdrop[hidden] { display: none; }
  .med-modal { background: #fff; border-radius: 12px; width: 100%; max-width: 480px;
               box-shadow: 0 18px 50px rgba(6, 37, 92, .3); overflow: hidden; }
  .med-modal h2 { font-size: 16px; margin: 0; padding: 15px 18px; background: #f9e9e9;
                  color: var(--danger); border-bottom: 1px solid #e5b9b9; }
  .med-modal .note { padding: 16px 18px; font-size: 15px; line-height: 1.5; color: var(--ink);
                     white-space: pre-wrap; max-height: 50vh; overflow-y: auto; }
  .med-modal .foot { padding: 12px 18px; background: #fafbfd; border-top: 1px solid var(--line);
                     display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .med-modal .foot .logged { font-size: 12px; color: var(--muted); }
  .med-modal .foot button { background: var(--navy); color: #fff; border: 0; border-radius: 8px;
                            padding: 10px 20px; font: inherit; font-weight: 600; cursor: pointer; }
`;

export const ROSTER_MARKUP = `
<div class="med-backdrop" id="medBackdrop" hidden>
  <div class="med-modal" role="dialog" aria-modal="true" aria-labelledby="medTitle">
    <h2 id="medTitle">Medical note</h2>
    <div class="note" id="medBody"></div>
    <div class="foot">
      <span class="logged">Opening this is recorded in the audit log.</span>
      <button type="button" id="medClose">Close</button>
    </div>
  </div>
</div>`;

/**
 * The Flags cell for one registration. An admin gets a button that reveals the
 * note through the audited endpoint; everyone else gets the static flag.
 */
export function medicalFlag(row, canReadMedical) {
  if (!row.has_medical_notes) return '';
  if (canReadMedical) {
    return `<button class="medbtn" data-medical="${row.id}" data-name="${esc(row.player_name)}">medical note — view</button>`;
  }
  return '<span class="med">medical note — see Jacob</span>';
}

export const ROSTER_SCRIPT = BODY_SCRIPT;
