/**
 * Coach evaluation capture.
 *
 * Designed for one situation and no other: a coach standing in a church gym on
 * August 29, on their own phone, with 25 children in front of them and about
 * thirty seconds per player. Everything here follows from that.
 *
 *   - Ratings are TAPS, not typing. Four rows of five buttons can be filled in
 *     while still watching the floor. Prose can be written on Sunday; a rating
 *     recorded three days later is a memory, not an observation.
 *   - Nothing is required to save. The approve gate before SENDING enforces
 *     completeness, which is the right place for it. Requiring prose at capture
 *     time produces "good kid" fifty times, which is worse than an empty field
 *     because it looks finished.
 *   - Every keystroke goes to localStorage. Church gyms have bad signal. A save
 *     that fails must never cost a coach an hour of typing, so the draft
 *     survives a dead connection, a locked screen, and a closed tab.
 *   - The internal block is visually unmistakable and says, in words, that
 *     families never see it. A coach who is unsure which box is which will
 *     write nothing useful in either.
 */

import { esc } from './ui.js';
import { DIALOG_STYLES, DIALOG_MARKUP, DIALOG_SCRIPT } from './dialog.js';

/**
 * The inline script, hashed for CSP rather than allowed with 'unsafe-inline'.
 *
 * This page renders coach-authored text and player names. If the escaping in
 * this module ever has a hole, 'unsafe-inline' would let injected script run
 * against a session that can read every child's medical note. A hash costs a
 * few lines and removes that escalation entirely: even a successful injection
 * cannot execute, because its hash will not match.
 */
const BODY_SCRIPT = `
(function () {
  var form = document.getElementById('evalForm');
  if (!form) return;
  var key = 'tnsaints:eval:' + form.dataset.registrationId;
  var status = document.getElementById('saveStatus');
  var banner = document.getElementById('draftBanner');
  var saveTimer = null;

  function fields() {
    return Array.prototype.slice.call(form.querySelectorAll('[name]'));
  }

  function collect() {
    var out = {};
    fields().forEach(function (el) {
      if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    });
    return out;
  }

  function apply(data) {
    fields().forEach(function (el) {
      if (!(el.name in data)) return;
      if (el.type === 'radio') {
        if (el.value === String(data[el.name])) { el.checked = true; paint(el.name); }
      } else {
        el.value = data[el.name];
      }
    });
  }

  // Ratings are labels wrapping hidden radios, so the visual state has to be
  // repainted by hand when a value is restored rather than clicked.
  function paint(name) {
    form.querySelectorAll('[data-rating="' + name + '"]').forEach(function (label) {
      var input = label.querySelector('input');
      label.classList.toggle('on', input && input.checked);
    });
  }

  function setStatus(text, cls) {
    if (!status) return;
    status.textContent = text;
    status.className = 'savestate ' + (cls || '');
  }

  function saveDraft() {
    try {
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), data: collect() }));
    } catch (e) { /* private mode or full: the server save still works */ }
    setStatus('Unsaved changes', 'dirty');
  }

  var raw = null;
  try { raw = localStorage.getItem(key); } catch (e) {}
  if (raw) {
    try {
      var draft = JSON.parse(raw);
      if (draft && draft.data && banner) {
        var when = new Date(draft.at);
        banner.querySelector('[data-when]').textContent = when.toLocaleString();
        banner.hidden = false;
        banner.querySelector('[data-restore]').addEventListener('click', function () {
          apply(draft.data);
          banner.hidden = true;
          setStatus('Unsaved changes', 'dirty');
        });
        banner.querySelector('[data-discard]').addEventListener('click', function () {
          try { localStorage.removeItem(key); } catch (e) {}
          banner.hidden = true;
        });
      }
    } catch (e) {}
  }

  form.addEventListener('input', function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 200);
  });
  form.addEventListener('change', function (e) {
    if (e.target && e.target.type === 'radio') paint(e.target.name);
    saveDraft();
  });

  document.querySelectorAll('[data-remove]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var label = btn.dataset.label;
      window.tnConfirm({
        title: 'Remove ' + label + "'s evaluation of this player?",
        lines: [
          'This deletes their ratings, their parent-facing feedback and their staff-only note for this player.',
          'You cannot edit or rewrite another coach's evaluation - only remove it. The audit log records that you did.',
          label + ' can enter a new one themselves afterwards.'
        ],
        word: 'REMOVE',
        confirmLabel: 'Remove it',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        fetch('/api/eval/' + form.dataset.registrationId + '/author/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author_email: btn.dataset.remove })
        }).then(function (r) { return r.json(); }).then(function (b) {
          if (!b.ok) { setStatus(b.error || 'Could not remove it', 'warn'); return; }
          location.reload();
        }).catch(function () { setStatus('Could not remove it - no signal?', 'warn'); });
      });
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    setStatus('Saving...', '');
    var payload = collect();
    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      if (!res.ok || !res.body.ok) throw new Error((res.body && res.body.error) || 'save failed');
      try { localStorage.removeItem(key); } catch (e) {}
      setStatus('Saved', 'ok');
    }).catch(function () {
      // Deliberately NOT "error". The coach's work is safe on the phone, and
      // telling them it failed without telling them that invites a retype.
      setStatus('No signal - kept on this phone, try Save again', 'warn');
    });
  });
})();
`;

/** Dialog first: the body script calls window.tnConfirm. */
const PAGE_SCRIPT = DIALOG_SCRIPT + BODY_SCRIPT;

let cachedHash = null;

/** SHA-256 of the inline script, base64, for the CSP script-src directive. */
async function scriptCspHash() {
  if (cachedHash) return cachedHash;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PAGE_SCRIPT));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  cachedHash = `'sha256-${btoa(binary)}'`;
  return cachedHash;
}

export async function evalCsp() {
  const hash = await scriptCspHash();
  return (
    "default-src 'none'; " +
    `script-src ${hash}; ` +
    "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
}

export const EVAL_STYLES = DIALOG_STYLES + `
  .backlink { display: inline-block; margin-bottom: 14px; color: var(--muted); text-decoration: none; font-size: 14px; }
  .backlink:hover { color: var(--ink); }
  .playerhead { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
  .playerhead h1 { margin: 0 0 4px; }
  .playerhead .meta { color: var(--muted); font-size: 14px; }
  .ratings { display: grid; gap: 14px; margin: 4px 0 20px; }
  .rating-row .lbl { font-size: 13px; font-weight: 600; margin-bottom: 6px; display: block; }
  .rating-row .hint { font-weight: 400; color: var(--muted); }
  .scale { display: flex; gap: 8px; }
  .scale label {
    flex: 1; text-align: center; padding: 14px 0; border: 1px solid var(--line);
    border-radius: 8px; background: #fff; font-weight: 600; cursor: pointer;
    -webkit-tap-highlight-color: transparent; user-select: none;
  }
  .scale label.on { background: var(--navy); border-color: var(--navy); color: #fff; }
  .scale label:focus-within { outline: 2px solid var(--navy-soft); outline-offset: 2px; }
  .scale input { position: absolute; opacity: 0; pointer-events: none; }
  .field { margin-bottom: 18px; }
  .field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .field .help { font-weight: 400; color: var(--muted); display: block; margin-top: 2px; }
  textarea {
    width: 100%; min-height: 88px; padding: 11px 12px; border: 1px solid var(--line);
    border-radius: 8px; font: inherit; font-size: 16px; resize: vertical; background: #fff; color: var(--ink);
  }
  textarea:focus { outline: 2px solid var(--navy-soft); outline-offset: 1px; }
  .internal {
    background: #f3f0e6; border: 1px solid #ddd3b4; border-left: 4px solid var(--gold);
    border-radius: 8px; padding: 14px 16px; margin: 4px 0 20px;
  }
  .internal .tag { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #6b5a24; margin-bottom: 6px; }
  .internal textarea { background: #fffdf6; border-color: #ddd3b4; }
  .actions { position: sticky; bottom: 0; background: var(--bg); padding: 12px 0 4px; border-top: 1px solid var(--line); display: flex; align-items: center; gap: 12px; }
  .btn { background: var(--navy); color: #fff; border: 0; border-radius: 8px; padding: 14px 26px; font-size: 16px; font-weight: 600; cursor: pointer; }
  .btn:active { background: var(--navy-soft); }
  .savestate { font-size: 13px; color: var(--muted); }
  .savestate.dirty { color: var(--warn); font-weight: 600; }
  .savestate.ok { color: var(--ok); font-weight: 600; }
  .savestate.warn { color: var(--warn); font-weight: 600; }
  .draftbar { background: #fdf0dd; border: 1px solid #e8c893; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 14px; }
  .draftbar button { margin-right: 8px; margin-top: 8px; border: 1px solid var(--line); background: #fff; border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
  .removebtn { margin-top: 10px; border: 1px solid #e5b9b9; background: #fff; color: var(--danger);
               border-radius: 7px; padding: 8px 12px; font: inherit; font-size: 13px;
               font-weight: 600; cursor: pointer; }
  .others { margin-top: 26px; }
  .others h2 { font-size: 15px; margin: 0 0 10px; }
  .other { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; font-size: 14px; }
  .other .who { font-weight: 600; margin-bottom: 4px; }
  .other .r { color: var(--muted); font-size: 13px; }
  .plist { list-style: none; margin: 0; padding: 0; }
  .plist li { border-bottom: 1px solid var(--line); }
  .plist li:last-child { border-bottom: 0; }
  .plist a { display: flex; align-items: center; gap: 12px; padding: 15px 16px; text-decoration: none; color: inherit; }
  .plist a:hover { background: #fafbfd; }
  .plist .nm { font-weight: 600; }
  .plist .sub { color: var(--muted); font-size: 13px; }
  .plist .state { margin-left: auto; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 99px; white-space: nowrap; }
  .state.none { background: #f6e5e5; color: var(--danger); }
  .state.mine { background: #e4f3ea; color: var(--ok); }
  .state.other { background: #fdf0dd; color: var(--warn); }
  .bar { height: 8px; background: var(--line); border-radius: 99px; overflow: hidden; margin-top: 10px; }
  .bar span { display: block; height: 100%; background: var(--ok); }
`;

const SCALES = [
  ['rating_skill', 'Skill', 'ball handling, shooting, footwork'],
  ['rating_effort', 'Effort', 'motor, hustle, how they compete'],
  ['rating_coachability', 'Coachability', 'listens, applies, responds to correction'],
  ['rating_decisions', 'Decisions', 'reads the floor, passes, shot selection'],
];

function scaleRow(name, label, hint, value) {
  const buttons = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<label data-rating="${name}"${Number(value) === n ? ' class="on"' : ''}>` +
        `<input type="radio" name="${name}" value="${n}"${Number(value) === n ? ' checked' : ''}>${n}</label>`
    )
    .join('');

  return `<div class="rating-row">
    <span class="lbl">${esc(label)} <span class="hint">— ${esc(hint)}</span></span>
    <div class="scale">${buttons}</div>
  </div>`;
}

/** The evaluation form for one player. */
export function evalFormBody({ registration, mine, others, internalOthers, canDelete }) {
  const ratings = SCALES.map(([name, label, hint]) => scaleRow(name, label, hint, mine?.[name])).join('');

  const otherBlocks = others.length
    ? others
        .map((o) => {
          const r = SCALES.map(([n, l]) => `${esc(l)} ${o[n] ?? '–'}`).join(' · ');
          const parts = [];
          if (o.strengths) parts.push(`<div><strong>Strengths:</strong> ${esc(o.strengths)}</div>`);
          if (o.growth_area) parts.push(`<div><strong>Growth:</strong> ${esc(o.growth_area)}</div>`);
          if (o.parent_note) parts.push(`<div><strong>To family:</strong> ${esc(o.parent_note)}</div>`);
          const remove = canDelete
            ? `<button type="button" class="removebtn" data-remove="${esc(o.author_email)}"
                 data-label="${esc(o.author_label)}">Remove this evaluation</button>`
            : '';
          return `<div class="other"><div class="who">${esc(o.author_label)}</div>
            <div class="r">${r}</div>${parts.join('')}${remove}</div>`;
        })
        .join('')
    : '<p class="sub">No other coach has written about this player yet.</p>';

  const internalBlocks = internalOthers.length
    ? internalOthers
        .map(
          (n) =>
            `<div class="other" style="background:#f3f0e6;border-color:#ddd3b4">
               <div class="who">${esc(n.author_email)} · staff only</div>${esc(n.body)}</div>`
        )
        .join('')
    : '';

  // There is deliberately no "entering on behalf of" control here.
  //
  // It existed as a paper-transcription fallback and was removed on the owner's
  // instruction: an evaluation has to be attributable to the person who typed
  // it, or it is not evidence of anything. A coach who writes on paper types it
  // in themselves later. An admin who needs to act on someone else's entry can
  // REMOVE it — which leaves an audit row — but can never author or alter one
  // under their name.

  return `
  <a class="backlink" href="/eval">← All players</a>

  <div class="playerhead">
    <h1>${esc(registration.player_name)}</h1>
    <div class="meta">${esc(registration.session_time)} · Grade ${esc(registration.grade)} ·
      ${registration.years_experience ?? '?'} yrs · ${esc(registration.school)}</div>
    ${
      registration.has_medical_notes
        ? '<div class="med" style="margin-top:8px">Medical note on file — see Jacob</div>'
        : ''
    }
  </div>

  <div class="draftbar" id="draftBanner" hidden>
    You have unsaved changes on this phone from <strong data-when></strong>.
    <div><button type="button" data-restore>Restore them</button>
    <button type="button" data-discard>Discard</button></div>
  </div>

  <form id="evalForm" action="/api/eval/${registration.id}" method="post"
        data-registration-id="${registration.id}">

    <div class="ratings">${ratings}</div>

    <div class="field">
      <label for="strengths">Strengths — the family will read this
        <span class="help">Name something specific this player actually did. This is the line that
        tells a parent a human watched their child.</span></label>
      <textarea id="strengths" name="strengths" placeholder="Kept his head up in transition and found the trailer twice.">${esc(mine?.strengths || '')}</textarea>
    </div>

    <div class="field">
      <label for="growth_area">Growth area — the family will read this
        <span class="help">The honest thing, framed as the next step rather than a verdict.</span></label>
      <textarea id="growth_area" name="growth_area" placeholder="Left hand under pressure — everything goes right at the moment.">${esc(mine?.growth_area || '')}</textarea>
    </div>

    <div class="field">
      <label for="parent_note">Anything else for the family <span class="help">Optional.</span></label>
      <textarea id="parent_note" name="parent_note">${esc(mine?.parent_note || '')}</textarea>
    </div>

    <div class="internal">
      <div class="tag">🔒 Only staff see this. Never sent to families.</div>
      <textarea id="internal_note" name="internal_note"
        placeholder="Candid assessment, fit, anything you would say out loud in the coaches' meeting.">${esc(mine?.internal_note || '')}</textarea>
    </div>

    <div class="actions">
      <button class="btn" type="submit">Save</button>
      <span class="savestate" id="saveStatus"></span>
    </div>
  </form>

  <div class="others">
    <h2>What other coaches wrote</h2>
    ${otherBlocks}
    ${internalBlocks ? `<h2 style="margin-top:18px">Staff-only notes</h2>${internalBlocks}` : ''}
  </div>

  ${DIALOG_MARKUP}

  <script>${PAGE_SCRIPT}</script>`;
}

/** The player list, ordered so the ones nobody has written about come first. */
export function evalListBody({ summary, mineByRegistration }) {
  const pct = summary.total ? Math.round((summary.readyToSend / summary.total) * 100) : 0;

  const items = summary.players
    .map((p) => {
      const mine = mineByRegistration.has(p.registration_id);
      const n = Number(p.coach_count);
      const state = mine
        ? ['mine', 'your note saved']
        : n > 0
          ? ['other', `${n} coach${n > 1 ? 'es' : ''}, not you`]
          : ['none', 'no notes'];

      return `<li><a href="/eval/${p.registration_id}">
        <span>
          <span class="nm">${esc(p.player_name)}</span><br>
          <span class="sub">${esc(p.session_time)} · Grade ${esc(p.grade)}</span>
        </span>
        <span class="state ${state[0]}">${esc(state[1])}</span>
      </a></li>`;
    })
    .join('');

  return `
  <h1>Evaluations</h1>
  <p class="sub">Tap a player to record ratings and feedback. Nothing is required — save what you have.</p>

  <div class="cards">
    <div class="card"><div class="n">${summary.total}</div><div class="l">Players</div></div>
    <div class="card"><div class="n">${summary.none}</div><div class="l">No notes yet</div></div>
    <div class="card"><div class="n">${summary.one}</div><div class="l">One coach only</div></div>
    <div class="card"><div class="n">${summary.twoPlus}</div><div class="l">Two or more</div></div>
  </div>

  <div class="panel">
    <h2>Ready to send</h2>
    <div style="padding:14px 16px">
      <strong>${summary.readyToSend} of ${summary.total}</strong> have both a strength and a growth area written.
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>
  </div>

  <div class="panel">
    <h2>Players</h2>
    ${summary.total ? `<ul class="plist">${items}</ul>` : '<div class="empty">No confirmed registrations yet.</div>'}
  </div>`;
}
