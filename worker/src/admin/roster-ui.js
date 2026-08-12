/**
 * Roster interactions: the medical-note reveal and the full-registration detail.
 *
 * The roster table is deliberately narrow — name, grade, session, parent,
 * registration date — so it never needs a horizontal scrollbar. Everything else
 * about a registration lives behind a "View registration" button that opens a
 * vertical detail modal, mirroring the layout of the registration email an admin
 * already receives.
 *
 * Two rules the modals never break:
 *   1. The medical note text is the single most sensitive field, so it is never
 *      rendered into the page. It is fetched on demand from GET
 *      /api/roster/:id/medical, which re-checks the roster:medical capability
 *      server-side and audits every read. The reveal is shown via textContent,
 *      never innerHTML — it is free-typed parent text.
 *   2. The detail modal shows only what the viewer's role may see. The server
 *      builds each row's detail from the same minimised projection as the table,
 *      so a coach's page never carries a parent email or medical text at all —
 *      not hidden, absent from the bytes.
 */

import { esc } from './ui.js';

const BODY_SCRIPT = `
(function () {
  function wireModal(backdrop) {
    if (!backdrop) return null;
    var closeBtn = backdrop.querySelector('[data-close]');
    var lastFocus = null;
    function close() {
      backdrop.hidden = true;
      document.body.style.overflow = '';
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    }
    function open(trigger) {
      lastFocus = trigger || null;
      document.body.style.overflow = 'hidden';
      backdrop.hidden = false;
      if (closeBtn) closeBtn.focus();
    }
    if (closeBtn) closeBtn.addEventListener('click', close);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function (e) {
      if (!backdrop.hidden && e.key === 'Escape') { e.preventDefault(); close(); }
    });
    return { open: open, close: close };
  }

  // Medical-note reveal — the note text is fetched, never in the page.
  var med = wireModal(document.getElementById('medBackdrop'));
  if (med) {
    var medTitle = document.getElementById('medTitle');
    var medBody = document.getElementById('medBody');
    document.querySelectorAll('[data-medical]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        medTitle.textContent = 'Medical note — ' + btn.dataset.name;
        medBody.textContent = 'Loading…';
        med.open(btn);
        fetch('/api/roster/' + btn.dataset.medical + '/medical', {
          headers: { 'Accept': 'application/json' }
        })
          .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
          .then(function (res) {
            if (!res.ok || !res.b.ok) {
              medBody.textContent = (res.b && res.b.error) || 'Could not load the note.';
              return;
            }
            // textContent, never innerHTML — this is parent-typed text.
            medBody.textContent = res.b.medical_notes || '(No medical note text on file.)';
          })
          .catch(function () {
            medBody.textContent = 'Could not load the note — check your connection and try again.';
          });
      });
    });
  }

  // Full-registration detail — the row's detail is server-rendered into a hidden
  // <template> and cloned in on demand, so the modal shows exactly what the role
  // is allowed to see and nothing is duplicated as strings.
  var reg = wireModal(document.getElementById('regBackdrop'));
  if (reg) {
    var regTitle = document.getElementById('regTitle');
    var regBody = document.getElementById('regBody');
    document.querySelectorAll('[data-detail]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tpl = document.getElementById('reg-' + btn.dataset.detail);
        regTitle.textContent = btn.dataset.name || 'Registration';
        while (regBody.firstChild) regBody.removeChild(regBody.firstChild);
        if (tpl && tpl.content) regBody.appendChild(tpl.content.cloneNode(true));
        reg.open(btn);
      });
    });
  }
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
  .rowacts { display: flex; gap: 8px; flex-wrap: wrap; }
  .medbtn, .viewbtn { border-radius: 7px; padding: 6px 11px; font: inherit; font-size: 13px;
                      font-weight: 600; cursor: pointer; white-space: nowrap; }
  .medbtn { border: 1px solid #e5b9b9; background: #fff; color: var(--danger); }
  .medbtn:hover { background: #f9e9e9; }
  .viewbtn { border: 1px solid var(--line); background: #fff; color: var(--navy); }
  .viewbtn:hover { background: #f1f5fd; }

  .med-backdrop { position: fixed; inset: 0; background: rgba(6, 37, 92, .55);
                  display: flex; align-items: center; justify-content: center;
                  padding: 20px; z-index: 100; }
  .med-backdrop[hidden] { display: none; }

  .med-modal, .reg-modal { background: #fff; border-radius: 12px; width: 100%;
               box-shadow: 0 18px 50px rgba(6, 37, 92, .3); overflow: hidden;
               display: flex; flex-direction: column; max-height: 86vh; }
  .med-modal { max-width: 480px; }
  .reg-modal { max-width: 560px; }
  .med-modal h2 { font-size: 16px; margin: 0; padding: 15px 18px; background: #f9e9e9;
                  color: var(--danger); border-bottom: 1px solid #e5b9b9; }
  .reg-modal h2 { font-size: 16px; margin: 0; padding: 15px 18px; background: var(--navy);
                  color: #fff; }
  .med-modal .note { padding: 16px 18px; font-size: 15px; line-height: 1.5; color: var(--ink);
                     white-space: pre-wrap; overflow-y: auto; }
  .reg-body { padding: 6px 18px 14px; overflow-y: auto; }

  .reg-dl { margin: 0; }
  .reg-dl > div { display: flex; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .reg-dl dt { flex: 0 0 116px; color: var(--muted); font-size: 13px; }
  .reg-dl dd { flex: 1; margin: 0; font-size: 14px; color: var(--ink); word-break: break-word; }
  .reg-dl dd a { color: var(--navy-soft); }
  .reg-dl .warn { color: var(--danger); font-weight: 600; }
  .reg-notes { margin-top: 14px; font-size: 13px; color: var(--muted); }
  .reg-notes p { margin: 6px 0 0; color: var(--ink); white-space: pre-wrap; line-height: 1.5; }

  .med-modal .foot, .reg-modal .foot { padding: 12px 18px; background: #fafbfd;
                     border-top: 1px solid var(--line); display: flex; align-items: center;
                     justify-content: space-between; gap: 12px; }
  .med-modal .foot .logged, .reg-modal .foot .logged { font-size: 12px; color: var(--muted); }
  .med-modal .foot button, .reg-modal .foot button { background: var(--navy); color: #fff;
                     border: 0; border-radius: 8px; padding: 10px 20px; font: inherit;
                     font-weight: 600; cursor: pointer; }
`;

export const ROSTER_MARKUP = `
<div class="med-backdrop" id="medBackdrop" hidden>
  <div class="med-modal" role="dialog" aria-modal="true" aria-labelledby="medTitle">
    <h2 id="medTitle">Medical note</h2>
    <div class="note" id="medBody"></div>
    <div class="foot">
      <span class="logged">Opening this is recorded in the audit log.</span>
      <button type="button" data-close>Close</button>
    </div>
  </div>
</div>

<div class="med-backdrop" id="regBackdrop" hidden>
  <div class="reg-modal" role="dialog" aria-modal="true" aria-labelledby="regTitle">
    <h2 id="regTitle">Registration</h2>
    <div class="reg-body" id="regBody"></div>
    <div class="foot">
      <span class="logged"></span>
      <button type="button" data-close>Close</button>
    </div>
  </div>
</div>`;

export const ROSTER_SCRIPT = BODY_SCRIPT;

// --- helpers used by the roster table -------------------------------------

function fmtCentral(iso, opts) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', Object.assign({ timeZone: 'America/Chicago' }, opts));
}

/** Short date for the roster column: "Aug 11, 2026". */
export function fmtRegDate(iso) {
  return fmtCentral(iso, { month: 'short', day: 'numeric', year: 'numeric' }) || '—';
}

/** Date and time for the detail modal: "Aug 11, 2026, 3:14 PM". */
function fmtRegDateTime(iso) {
  return fmtCentral(iso, { dateStyle: 'medium', timeStyle: 'short' });
}

function cap(s) {
  const v = String(s || '');
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
}

/**
 * The medical flag for a row. An admin gets a reveal button wired to the audited
 * endpoint; everyone else gets the static "see Jacob" flag. Empty when there is
 * no note on file.
 */
export function medicalFlag(row, canReadMedical) {
  if (!row.has_medical_notes) return '';
  if (canReadMedical) {
    return `<button class="medbtn" data-medical="${row.id}" data-name="${esc(row.player_name)}">medical note — view</button>`;
  }
  return '<span class="med">medical note — see Jacob</span>';
}

/** The Actions cell: the medical flag (if any) plus the View-registration button. */
export function rowActions(row, canReadMedical) {
  const med = medicalFlag(row, canReadMedical);
  const view = `<button class="viewbtn" data-detail="${row.id}" data-name="${esc(row.player_name)}">View registration</button>`;
  return `<div class="rowacts">${med}${view}</div>`;
}

function field(label, text) {
  if (text === null || text === undefined || String(text).trim() === '') return '';
  return `<div><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`;
}

function fieldHtml(label, html) {
  if (!html) return '';
  return `<div><dt>${esc(label)}</dt><dd>${html}</dd></div>`;
}

function linkOrText(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  // Only http(s) becomes a link; anything else is shown as plain, escaped text
  // so a javascript: or data: URL can never become a clickable target.
  if (/^https?:\/\//i.test(u)) {
    return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`;
  }
  return esc(u);
}

/**
 * The hidden per-row detail, cloned into the modal on "View registration". Built
 * from the same role-minimised projection as the table: a coach's page carries
 * no parent contact or medical text, because those columns are not in their
 * projection to begin with. The note text is never here for anyone — the modal
 * reports only that a note exists.
 */
export function registrationTemplate(row, showsContact, canReadMedical) {
  const parts = [
    field('Status', cap(row.status)),
    field('Session', row.session_time),
    field('Grade', row.grade),
    field('Years playing', row.years_experience),
    field('School', row.school),
    field('Parent', row.parent_name),
    field('Registered', fmtRegDateTime(row.created_at)),
    fieldHtml('Highlight link', linkOrText(row.highlight_link)),
    field(
      'Medical note',
      row.has_medical_notes
        ? canReadMedical
          ? 'On file — use the "medical note — view" button'
          : 'On file — see Jacob'
        : 'None on file'
    ),
  ];

  if (showsContact) {
    parts.push(
      field('Parent email', row.parent_email),
      field('Parent phone', row.phone),
      field(
        'Emergency contact',
        [row.emergency_contact_name, row.emergency_contact_phone].filter(Boolean).join(' — ')
      ),
      field('Assumption of risk', row.assumption_of_risk ? 'Agreed' : 'Not agreed'),
      field('Medical release', row.medical_release ? 'Granted' : 'Not granted'),
      fieldHtml(
        'Photo release',
        row.photo_release
          ? 'Granted'
          : '<span class="warn">DECLINED — do not photograph</span>'
      ),
      field('Signed by', row.signature),
      field('Signed at', fmtRegDateTime(row.signed_at))
    );
    if (row.status === 'cancelled') {
      parts.push(
        field('Cancelled at', fmtRegDateTime(row.cancelled_at)),
        field('Cancel reason', row.cancel_reason)
      );
    }
  }

  const notes = String(row.player_notes || '').trim()
    ? `<div class="reg-notes"><strong>Player notes</strong><p>${esc(row.player_notes)}</p></div>`
    : '';

  return `<template id="reg-${row.id}"><dl class="reg-dl">${parts.join('')}</dl>${notes}</template>`;
}
