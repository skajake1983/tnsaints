/**
 * The decisions screen: where a human authorises fifty emails.
 *
 * Four separate, deliberate steps, and the separation is the whole point:
 *
 *   1. DECIDE   accept / not yet, per player
 *   2. BUILD    compose drafts and run the quality gate over all of them
 *   3. APPROVE  freeze the exact bytes that will send
 *   4. SEND     actually mail them, ten at a time
 *
 * Nothing here happens on a timer. The cron does not drain batches. There is no
 * path from "a coach saved a note" to "a family received an email" that does not
 * pass through a person clicking Approve and then, separately, clicking Send.
 *
 * Approve and Send are two actions rather than one because they answer two
 * different questions — "are these right?" and "send them now?" — and merging
 * them removes the last moment where someone can stop. Both require typing a
 * word to confirm, because a misplaced click at the end of a long review
 * session is exactly how the wrong thing gets sent.
 */

import { esc } from './ui.js';

const PAGE_SCRIPT = `
(function () {
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, body: b }; });
    });
  }

  function say(msg, cls) {
    var el = document.getElementById('flash');
    if (!el) return;
    el.textContent = msg;
    el.className = 'flash ' + (cls || '');
    el.hidden = false;
  }

  // Decision buttons
  document.querySelectorAll('[data-decide]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var rid = btn.dataset.rid;
      var value = btn.dataset.decide;
      post('/api/decision/' + rid, { decision: value }).then(function (res) {
        if (!res.ok || !res.body.ok) { say(res.body.error || 'Could not save.', 'bad'); return; }
        document.querySelectorAll('[data-rid="' + rid + '"][data-decide]').forEach(function (b) {
          b.classList.toggle('on', b.dataset.decide === value);
        });
        var row = document.getElementById('row-' + rid);
        if (row) row.dataset.decision = value;
        say('Saved.', 'good');
      });
    });
  });

  var buildBtn = document.getElementById('buildBtn');
  if (buildBtn) buildBtn.addEventListener('click', function () {
    buildBtn.disabled = true;
    say('Composing drafts...', '');
    post('/api/batch/build').then(function (res) {
      buildBtn.disabled = false;
      if (!res.ok || !res.body.ok) { say(res.body.error || 'Could not build.', 'bad'); return; }
      location.reload();
    });
  });

  // Approve and Send both require typing a word. A stray click at the end of a
  // long review is precisely how fifty families get the wrong thing.
  function confirmWord(btn, word, url, done) {
    btn.addEventListener('click', function () {
      var typed = prompt(btn.dataset.prompt + '\\n\\nType ' + word + ' to confirm:');
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== word) { say('Not confirmed - nothing happened.', ''); return; }
      btn.disabled = true;
      say('Working...', '');
      post(url).then(function (res) {
        btn.disabled = false;
        if (!res.ok || !res.body.ok) {
          say(res.body.error || 'Refused.', 'bad');
          if (res.body.problems) {
            say((res.body.error || 'Refused.') + ' ' +
                res.body.problems.map(function (p) {
                  return (p.player_name || '') + ': ' + (p.problems || []).join(' ');
                }).join(' | '), 'bad');
          }
          return;
        }
        done(res.body);
      });
    });
  }

  var approveBtn = document.getElementById('approveBtn');
  if (approveBtn) confirmWord(approveBtn, 'APPROVE', approveBtn.dataset.url, function () {
    location.reload();
  });

  var sendBtn = document.getElementById('sendBtn');
  if (sendBtn) confirmWord(sendBtn, 'SEND', sendBtn.dataset.url, function (body) {
    say('Sent ' + body.sent + '. Remaining in queue: ' + body.queued +
        (body.failed ? '. Failed: ' + body.failed : '') +
        (body.budgetStopped ? '. Stopped on the daily email budget - run Send again tomorrow.' : ''),
        body.failed ? 'bad' : 'good');
    setTimeout(function () { location.reload(); }, 2500);
  });

  // Preview opens the frozen snapshot, not a fresh render.
  document.querySelectorAll('[data-preview]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      fetch('/api/message/' + btn.dataset.preview + '/preview')
        .then(function (r) { return r.json(); })
        .then(function (m) {
          if (!m.ok) { say(m.error || 'No preview.', 'bad'); return; }
          var box = document.getElementById('previewBox');
          document.getElementById('pvTo').textContent = m.player_name + '  ->  ' + m.to;
          document.getElementById('pvSubject').textContent = m.subject;
          document.getElementById('pvDecision').textContent = m.decision;
          document.getElementById('pvBody').innerHTML = m.body_html;
          box.hidden = false;
          box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
  });

  var closePv = document.getElementById('pvClose');
  if (closePv) closePv.addEventListener('click', function () {
    document.getElementById('previewBox').hidden = true;
  });

  // Cancel / delete, each with its own typed confirmation.
  document.querySelectorAll('[data-cancel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.dataset.name;
      var reason = prompt('Cancel ' + name + "'s place?\\n\\nThis frees the seat and the first family " +
        'on that session\\'s waiting list is moved up automatically.\\n\\nReason (optional):');
      if (reason === null) return;
      post('/api/registration/' + btn.dataset.cancel + '/cancel', { reason: reason }).then(function (res) {
        if (!res.ok || !res.body.ok) { say(res.body.error || 'Could not cancel.', 'bad'); return; }
        location.reload();
      });
    });
  });

  document.querySelectorAll('[data-delete]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.dataset.name;
      var typed = prompt('PERMANENTLY DELETE ' + name + '?\\n\\nThis erases the registration, the signed ' +
        'waiver record, and every coach note about this player. It cannot be undone.\\n\\n' +
        'Cancelling instead keeps the record and still frees the seat.\\n\\nType DELETE to confirm:');
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== 'DELETE') { say('Not confirmed - nothing happened.', ''); return; }
      post('/api/registration/' + btn.dataset.delete + '/delete').then(function (res) {
        if (!res.ok || !res.body.ok) { say(res.body.error || 'Could not delete.', 'bad'); return; }
        location.reload();
      });
    });
  });
})();
`;

let cachedHash = null;

async function scriptCspHash() {
  if (cachedHash) return cachedHash;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PAGE_SCRIPT));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  cachedHash = `'sha256-${btoa(binary)}'`;
  return cachedHash;
}

export async function decisionsCsp() {
  const hash = await scriptCspHash();
  return (
    "default-src 'none'; " +
    `script-src ${hash}; ` +
    "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
}

export const DECISION_STYLES = `
  .flash { padding: 11px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 14px;
           background: #eef2f8; border: 1px solid var(--line); }
  .flash.good { background: #e4f3ea; border-color: #b6ddc6; color: var(--ok); font-weight: 600; }
  .flash.bad { background: #f9e9e9; border-color: #e5b9b9; color: var(--danger); font-weight: 600; }
  .steps { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin-bottom: 20px; }
  .step { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 13px 15px; }
  .step .n { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .step .t { font-weight: 700; margin: 3px 0 4px; }
  .step .d { font-size: 13px; color: var(--muted); }
  .step.done { border-color: #b6ddc6; background: #f2faf5; }
  .step.now { border-color: var(--navy-soft); box-shadow: 0 0 0 2px rgba(11,58,141,.12); }
  .dbtn { border: 1px solid var(--line); background: #fff; border-radius: 7px; padding: 7px 12px;
          font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .dbtn.on[data-decide="accept"] { background: var(--ok); border-color: var(--ok); color: #fff; }
  .dbtn.on[data-decide="not_yet"] { background: var(--warn); border-color: var(--warn); color: #fff; }
  .dbtn.danger { color: var(--danger); border-color: #e5b9b9; }
  .dbtn:disabled { opacity: .5; cursor: default; }
  .bigbtn { background: var(--navy); color: #fff; border: 0; border-radius: 8px; padding: 13px 22px;
            font-size: 15px; font-weight: 700; cursor: pointer; }
  .bigbtn.send { background: var(--danger); }
  .bigbtn:disabled { opacity: .45; cursor: default; }
  .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  .warnbar { background: #fdf0dd; border: 1px solid #e8c893; border-radius: 8px; padding: 12px 14px;
             font-size: 14px; margin-bottom: 16px; }
  .preview { background: #fff; border: 2px solid var(--navy); border-radius: 10px; margin-bottom: 22px; }
  .preview header { background: var(--navy); border-bottom: 0; padding: 12px 16px; }
  .preview .pvmeta { padding: 12px 16px; border-bottom: 1px solid var(--line); font-size: 14px; background: #fafbfd; }
  .preview .pvmeta b { display: inline-block; min-width: 84px; color: var(--muted); font-weight: 600; }
  .preview .pvbody { padding: 18px 16px; }
  .needs { color: var(--danger); font-size: 12px; font-weight: 600; }
`;

function stepCard(n, title, detail, state) {
  return `<div class="step ${state}"><div class="n">Step ${n}</div>
    <div class="t">${esc(title)}</div><div class="d">${esc(detail)}</div></div>`;
}

export function decisionsBody({ rows, batch, messages, pre, canSend }) {
  const decided = rows.filter((r) => r.decision !== 'undecided').length;
  const ready = rows.filter((r) => Number(r.with_strengths) > 0 && Number(r.with_growth) > 0).length;

  const built = Boolean(batch);
  const approved = batch && ['approved', 'sending', 'sent', 'partial'].includes(batch.state);
  const queued = messages.filter((m) => m.send_state === 'queued').length;
  const sentCount = messages.filter((m) => m.send_state === 'sent').length;

  const steps = [
    stepCard(1, 'Decide', `${decided} of ${rows.length} decided`,
      decided === rows.length && rows.length ? 'done' : 'now'),
    stepCard(2, 'Build drafts', built ? `${messages.length} composed` : 'Not built yet',
      built ? 'done' : decided === rows.length && rows.length ? 'now' : ''),
    stepCard(3, 'Review & approve', approved ? 'Approved and frozen' : 'Not approved',
      approved ? 'done' : built ? 'now' : ''),
    stepCard(4, 'Send', sentCount ? `${sentCount} sent, ${queued} queued` : `${queued} queued`,
      approved && queued ? 'now' : sentCount && !queued ? 'done' : ''),
  ].join('');

  const rowsHtml = rows
    .map((r) => {
      const msg = messages.find((m) => m.registration_id === r.id);
      const incomplete = !(Number(r.with_strengths) > 0 && Number(r.with_growth) > 0);
      const lock = approved ? ' disabled' : '';
      return `<tr id="row-${r.id}" data-decision="${esc(r.decision)}">
        <td><strong>${esc(r.player_name)}</strong><br>
          <span class="sub" style="font-size:12px;color:var(--muted)">${esc(r.session_time)} · ${esc(r.grade)}</span>
          ${incomplete ? '<br><span class="needs">needs a strength &amp; growth area</span>' : ''}</td>
        <td>${Number(r.coach_count)}</td>
        <td>
          <button class="dbtn${r.decision === 'accept' ? ' on' : ''}" data-rid="${r.id}" data-decide="accept"${lock}>Accept</button>
          <button class="dbtn${r.decision === 'not_yet' ? ' on' : ''}" data-rid="${r.id}" data-decide="not_yet"${lock}>Not yet</button>
        </td>
        <td>${msg ? `<button class="dbtn" data-preview="${msg.id}">Preview</button>` : '<span style="color:var(--muted)">—</span>'}</td>
        <td>${msg ? esc(msg.send_state) : ''}</td>
        <td>
          <button class="dbtn" data-cancel="${r.id}" data-name="${esc(r.player_name)}">Cancel</button>
          <button class="dbtn danger" data-delete="${r.id}" data-name="${esc(r.player_name)}">Delete</button>
        </td>
      </tr>`;
    })
    .join('');

  const budgetWarning =
    approved && pre && !pre.enough
      ? `<div class="warnbar"><strong>Not enough email budget today.</strong>
         ${pre.to_send} to send, ${pre.budget_remaining} left of ${pre.budget_limit}.
         Sending will deliver what it can and stop; the rest stay queued and go out on the next
         Send. Nothing is lost and nothing is sent twice.</div>`
      : '';

  return `
  <h1>Decisions &amp; sending</h1>
  <p class="sub">Nothing is emailed to a family until you approve, and then separately press Send.</p>

  <div id="flash" class="flash" hidden></div>

  <div class="steps">${steps}</div>

  ${budgetWarning}

  <div class="toolbar">
    ${
      !approved
        ? `<button class="bigbtn" id="buildBtn">${built ? 'Rebuild drafts' : 'Build drafts'}</button>`
        : ''
    }
    ${
      built && !approved
        ? `<button class="bigbtn" id="approveBtn" data-url="/api/batch/${esc(batch.id)}/approve"
             data-prompt="Approve ${messages.length} message(s)? This freezes the exact text that will send. It does NOT send anything yet.">Approve</button>`
        : ''
    }
    ${
      approved && queued && canSend
        ? `<button class="bigbtn send" id="sendBtn" data-url="/api/batch/${esc(batch.id)}/send"
             data-prompt="Send up to 10 messages now to real families. This cannot be recalled.">Send now</button>`
        : ''
    }
    ${
      pre
        ? `<span style="font-size:13px;color:var(--muted)">${pre.to_send} queued ·
           ${pre.budget_remaining} of ${pre.budget_limit} email credits left today</span>`
        : ''
    }
  </div>

  <div class="preview" id="previewBox" hidden>
    <header><div class="mark">Exactly what the family receives</div></header>
    <div class="pvmeta">
      <div><b>To</b> <span id="pvTo"></span></div>
      <div><b>Subject</b> <span id="pvSubject"></span></div>
      <div><b>Decision</b> <span id="pvDecision"></span></div>
    </div>
    <div class="pvbody" id="pvBody"></div>
    <div style="padding:0 16px 16px"><button class="dbtn" id="pvClose">Close preview</button></div>
  </div>

  <div class="panel">
    <h2>Players — ${decided} of ${rows.length} decided, ${ready} with complete feedback</h2>
    <div class="scroll"><table>
      <thead><tr><th>Player</th><th>Coaches</th><th>Decision</th><th>Message</th><th>State</th><th>Admin</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="6" class="empty">No confirmed players yet.</td></tr>'}</tbody>
    </table></div>
  </div>

  <script>${PAGE_SCRIPT}</script>`;
}
