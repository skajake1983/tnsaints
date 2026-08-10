/**
 * The decisions screen: where a human authorises fifty emails.
 *
 * Four steps, deliberately separate:
 *
 *   1. DECIDE   accept / not yet, per player
 *   2. BUILD    compose drafts and run the quality gate over all of them
 *   3. REVIEW   read every message, edit any of them
 *   4. APPROVE  freeze the exact bytes, then SEND as a fifth explicit act
 *
 * Nothing happens on a timer. There is no path from "a coach saved a note" to
 * "a family received an email" that does not pass through a person reading the
 * message and then pressing two different buttons.
 *
 * WHAT THIS SCREEN GOT WRONG THE FIRST TIME
 *
 * Approve rendered on the single condition "a batch was built". Preview was one
 * optional button per row that painted a shared box at the top of the page and
 * scrolled you away from your place in the list. Nothing recorded that anything
 * had been read, and the server asked for no such evidence. So fifty messages
 * could be frozen for sending having been seen by nobody — which is exactly what
 * the owner reported, and exactly what a batch is supposed to prevent.
 *
 * Worse, there was no way to EDIT a draft at all, so what would have sent was
 * machine-assembled text verbatim: fifty families receiving the same eight
 * paragraphs differing only in a first name.
 *
 * Now every draft is rendered inline, in a textarea, in decision order. Reading
 * is tracked per message and the server refuses approval while any is unread.
 */

import { esc } from './ui.js';

const PAGE_SCRIPT = `
(function () {
  var flash = document.getElementById('flash');

  function say(msg, cls) {
    if (!flash) return;
    flash.textContent = msg;
    flash.className = 'flash ' + (cls || '');
    flash.hidden = false;
    if (cls === 'bad') flash.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Every failure path funnels through here. Errors used to be shown for 2.5
  // seconds and then lost to a page reload, or swallowed entirely when a fetch
  // rejected -- so a batch could half-fail and look fine.
  function fail(context, detail) {
    var text = context;
    if (detail) text += ' - ' + detail;
    say(text, 'bad');
    try { console.error('[tnsaints]', context, detail); } catch (e) {}
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.text().then(function (raw) {
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (!parsed) {
          // A non-JSON response means the Worker threw or Access bounced us to
          // a login page. Saying "could not save" would hide that.
          throw new Error('Server returned ' + r.status + ' (' + raw.slice(0, 120) + ')');
        }
        if (!r.ok || !parsed.ok) {
          var msg = parsed.error || ('HTTP ' + r.status);
          if (parsed.problems && parsed.problems.length) {
            msg += ' -- ' + parsed.problems.map(function (p) {
              return (p.player_name || '') + ': ' + (p.problems || []).join(' ');
            }).join(' | ');
          }
          throw new Error(msg);
        }
        return parsed;
      });
    });
  }

  // Anything that escapes a handler still reaches the screen rather than only
  // the console, which nobody has open at 11pm.
  window.addEventListener('error', function (e) {
    fail('Something broke on this page', e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    fail('A request failed', e.reason && e.reason.message ? e.reason.message : String(e.reason));
  });

  document.querySelectorAll('[data-decide]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var rid = btn.dataset.rid;
      var value = btn.dataset.decide;
      post('/api/decision/' + rid, { decision: value }).then(function () {
        document.querySelectorAll('[data-rid="' + rid + '"][data-decide]').forEach(function (b) {
          b.classList.toggle('on', b.dataset.decide === value);
        });
        say('Decision saved. Rebuild drafts to refresh the messages.', 'good');
      }).catch(function (err) { fail('Could not save that decision', err.message); });
    });
  });

  var buildBtn = document.getElementById('buildBtn');
  if (buildBtn) buildBtn.addEventListener('click', function () {
    buildBtn.disabled = true;
    say('Composing drafts...', '');
    post('/api/batch/build').then(function (body) {
      // Blocked players used to be returned and silently ignored here, so the
      // screen said nothing while families were dropped from the batch.
      if (body.problems && body.problems.length) {
        say(body.composed + ' composed, ' + body.problems.length +
            ' blocked: ' + body.problems.map(function (p) { return p.player_name; }).join(', ') +
            '. They are listed below and must be fixed before approving.', 'bad');
        setTimeout(function () { location.reload(); }, 4000);
        return;
      }
      location.reload();
    }).catch(function (err) {
      buildBtn.disabled = false;
      fail('Could not build drafts', err.message);
    });
  });

  document.querySelectorAll('[data-save]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.dataset.save;
      var box = document.getElementById('body-' + id);
      btn.disabled = true;
      post('/api/message/' + id + '/edit', { body_text: box.value }).then(function () {
        markRead(id, 'edited');
        say('Message saved and marked read.', 'good');
      }).catch(function (err) { fail('Could not save that message', err.message); })
        .then(function () { btn.disabled = false; });
    });
  });

  document.querySelectorAll('[data-read]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.dataset.read;
      btn.disabled = true;
      post('/api/message/' + id + '/review').then(function () {
        markRead(id, 'read');
      }).catch(function (err) {
        btn.disabled = false;
        fail('Could not mark that read', err.message);
      });
    });
  });

  function markRead(id, how) {
    var card = document.getElementById('msg-' + id);
    if (card) card.classList.add('reviewed');
    var badge = document.getElementById('state-' + id);
    if (badge) { badge.textContent = how === 'edited' ? 'edited & read' : 'read'; badge.className = 'rbadge on'; }
    var btn = document.querySelector('[data-read="' + id + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Read'; }
    var left = document.querySelectorAll('.msgcard:not(.reviewed)').length;
    var counter = document.getElementById('unreadCount');
    if (counter) counter.textContent = String(left);
    var approve = document.getElementById('approveBtn');
    if (approve) {
      approve.disabled = left > 0;
      approve.textContent = left > 0 ? ('Approve (' + left + ' unread)') : 'Approve all';
    }
  }

  function confirmWord(btn, word, url, done) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      var typed = prompt(btn.dataset.prompt + '\\n\\nType ' + word + ' to confirm:');
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== word) { say('Not confirmed - nothing happened.', ''); return; }
      btn.disabled = true;
      say('Working...', '');
      post(url).then(function (body) { done(body); })
        .catch(function (err) { btn.disabled = false; fail('Refused', err.message); });
    });
  }

  var approveBtn = document.getElementById('approveBtn');
  if (approveBtn) confirmWord(approveBtn, 'APPROVE', approveBtn.dataset.url, function () {
    location.reload();
  });

  var sendBtn = document.getElementById('sendBtn');
  if (sendBtn) confirmWord(sendBtn, 'SEND', sendBtn.dataset.url, function (body) {
    say('Sent ' + body.sent + '. Remaining: ' + body.queued +
        (body.failed ? '. FAILED: ' + body.failed + ' - see the table.' : '') +
        (body.budgetStopped ? '. Stopped on the daily email budget; run Send again tomorrow.' : ''),
        body.failed ? 'bad' : 'good');
    setTimeout(function () { location.reload(); }, body.failed ? 8000 : 3000);
  });

  document.querySelectorAll('[data-cancel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.dataset.name;
      var typed = prompt('Cancel ' + name + "'s place?\\n\\nThis frees the seat and the first family " +
        'on that waiting list moves up.\\n\\nType CANCEL to confirm:');
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== 'CANCEL') { say('Not confirmed - nothing happened.', ''); return; }
      post('/api/registration/' + btn.dataset.cancel + '/cancel', { reason: '' })
        .then(function () { location.reload(); })
        .catch(function (err) { fail('Could not cancel', err.message); });
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
      post('/api/registration/' + btn.dataset.delete + '/delete')
        .then(function () { location.reload(); })
        .catch(function (err) { fail('Could not delete', err.message); });
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
  .steps { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: 20px; }
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
  .bigbtn:disabled { opacity: .4; cursor: not-allowed; }
  .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  .warnbar { background: #fdf0dd; border: 1px solid #e8c893; border-radius: 8px; padding: 12px 14px;
             font-size: 14px; margin-bottom: 16px; }
  .blockbar { background: #f9e9e9; border: 1px solid #e5b9b9; border-radius: 8px; padding: 12px 14px;
              font-size: 14px; margin-bottom: 16px; }
  .blockbar a { color: var(--danger); font-weight: 700; }
  .msgcard { background: #fff; border: 1px solid var(--line); border-left: 4px solid var(--warn);
             border-radius: 10px; margin-bottom: 14px; }
  .msgcard.reviewed { border-left-color: var(--ok); }
  .msgcard .head { padding: 11px 15px; border-bottom: 1px solid var(--line); background: #fafbfd;
                   display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .msgcard .who { font-weight: 700; }
  .msgcard .to { color: var(--muted); font-size: 13px; }
  .rbadge { margin-left: auto; font-size: 11px; font-weight: 700; text-transform: uppercase;
            letter-spacing: .05em; padding: 3px 9px; border-radius: 99px; background: #fdf0dd; color: var(--warn); }
  .rbadge.on { background: #e4f3ea; color: var(--ok); }
  .pill.accept { background: #e4f3ea; color: var(--ok); }
  .pill.not_yet { background: #fdf0dd; color: var(--warn); }
  .msgcard .subj { padding: 9px 15px; font-size: 13px; color: var(--muted); border-bottom: 1px solid var(--line); }
  .msgcard textarea { width: 100%; border: 0; border-radius: 0; padding: 14px 15px; font: inherit;
                      font-size: 15px; line-height: 1.55; min-height: 300px; resize: vertical;
                      background: #fff; color: var(--ink); }
  .msgcard textarea:focus { outline: 2px solid var(--navy-soft); outline-offset: -2px; }
  .msgcard .foot { padding: 10px 15px; border-top: 1px solid var(--line); display: flex; gap: 10px;
                   align-items: center; flex-wrap: wrap; background: #fafbfd; }
  .needs { color: var(--danger); font-size: 12px; font-weight: 600; }
`;

function stepCard(n, title, detail, state) {
  return `<div class="step ${state}"><div class="n">Step ${n}</div>
    <div class="t">${esc(title)}</div><div class="d">${esc(detail)}</div></div>`;
}

export function decisionsBody({ rows, batch, messages, pre, canSend }) {
  const decided = rows.filter((r) => r.decision !== 'undecided').length;
  const blocked = rows.filter((r) => !(Number(r.with_strengths) > 0 && Number(r.with_growth) > 0));

  const built = Boolean(batch);
  const approved = batch && ['approved', 'sending', 'sent', 'partial'].includes(batch.state);
  const drafts = messages.filter((m) => m.send_state === 'draft');
  const skipped = messages.filter((m) => m.send_state === 'skipped');
  const queued = messages.filter((m) => m.send_state === 'queued').length;
  const sentCount = messages.filter((m) => m.send_state === 'sent').length;
  const failed = messages.filter((m) => m.send_state === 'failed');
  const unread = drafts.filter((m) => !m.reviewed_at).length;

  const byRegistration = new Map(messages.map((m) => [Number(m.registration_id), m]));

  const steps = [
    stepCard(1, 'Decide', `${decided} of ${rows.length} decided`,
      rows.length && decided === rows.length ? 'done' : 'now'),
    stepCard(2, 'Build drafts',
      built ? `${drafts.length} composed${skipped.length ? `, ${skipped.length} blocked` : ''}` : 'Not built',
      built && !skipped.length ? 'done' : rows.length && decided === rows.length && !built ? 'now' : ''),
    stepCard(3, 'Read every message', approved ? 'Reviewed' : `${unread} still unread`,
      approved || (built && unread === 0) ? 'done' : built ? 'now' : ''),
    stepCard(4, approved ? 'Send' : 'Approve',
      sentCount ? `${sentCount} sent, ${queued} queued` : approved ? `${queued} queued` : 'Not approved',
      approved && queued ? 'now' : sentCount && !queued ? 'done' : ''),
  ].join('');

  // Blocked players are named with a link straight to the form that fixes them.
  // "3 players are blocked" without saying who is a puzzle, not a warning.
  const blockBar = blocked.length
    ? `<div class="blockbar"><strong>${blocked.length} player(s) cannot be sent anything yet</strong> —
       no coach has written both a strength and a growth area:
       ${blocked
         .map((b) => `<a href="/eval/${b.id}">${esc(b.player_name)}</a>`)
         .join(', ')}.
       Nothing can be approved until every player has both.</div>`
    : '';

  const budgetWarning =
    approved && pre && !pre.enough
      ? `<div class="warnbar"><strong>Not enough email budget today.</strong>
         ${pre.to_send} to send, ${pre.budget_remaining} left of ${pre.budget_limit}.
         Send will deliver what it can and stop; the rest stay queued for the next Send.
         Nothing is lost and nobody is sent twice.</div>`
      : '';

  const failedBar = failed.length
    ? `<div class="blockbar"><strong>${failed.length} message(s) failed to send.</strong>
       ${failed.map((f) => esc(String(f.last_error || '').slice(0, 120))).join(' | ')}</div>`
    : '';

  // The review column: every draft, in full, editable.
  const reviewCards = drafts
    .map((m) => {
      const row = rows.find((r) => Number(r.id) === Number(m.registration_id));
      const reviewed = Boolean(m.reviewed_at);
      return `<div class="msgcard${reviewed ? ' reviewed' : ''}" id="msg-${m.id}">
        <div class="head">
          <span class="who">${esc(row ? row.player_name : '')}</span>
          <span class="pill ${esc(row ? row.decision : '')}">${esc(row ? row.decision.replace('_', ' ') : '')}</span>
          <span class="to">to ${esc(row ? row.parent_email : '')}</span>
          <span class="rbadge${reviewed ? ' on' : ''}" id="state-${m.id}">${
            reviewed ? (m.edited_at ? 'edited &amp; read' : 'read') : 'unread'
          }</span>
        </div>
        <div class="subj">Subject: ${esc(m.subject)}</div>
        <textarea id="body-${m.id}" spellcheck="true">${esc(m.body_text)}</textarea>
        <div class="foot">
          <button class="dbtn" data-save="${m.id}">Save changes</button>
          <button class="dbtn" data-read="${m.id}"${reviewed ? ' disabled' : ''}>${
            reviewed ? 'Read' : 'Mark as read'
          }</button>
          <span style="font-size:12px;color:var(--muted)">Edit freely — this exact text is what sends.</span>
        </div>
      </div>`;
    })
    .join('');

  const rowsHtml = rows
    .map((r) => {
      const msg = byRegistration.get(Number(r.id));
      const incomplete = !(Number(r.with_strengths) > 0 && Number(r.with_growth) > 0);
      const lock = approved ? ' disabled' : '';
      return `<tr>
        <td><strong>${esc(r.player_name)}</strong><br>
          <span style="font-size:12px;color:var(--muted)">${esc(r.session_time)} · ${esc(r.grade)}</span>
          ${incomplete ? `<br><a class="needs" href="/eval/${r.id}">needs a strength &amp; growth area →</a>` : ''}</td>
        <td>${Number(r.coach_count)}</td>
        <td>
          <button class="dbtn${r.decision === 'accept' ? ' on' : ''}" data-rid="${r.id}" data-decide="accept"${lock}>Accept</button>
          <button class="dbtn${r.decision === 'not_yet' ? ' on' : ''}" data-rid="${r.id}" data-decide="not_yet"${lock}>Not yet</button>
        </td>
        <td>${msg ? esc(msg.send_state) : '<span style="color:var(--muted)">—</span>'}</td>
        <td>
          <button class="dbtn" data-cancel="${r.id}" data-name="${esc(r.player_name)}"${lock}>Cancel</button>
          <button class="dbtn danger" data-delete="${r.id}" data-name="${esc(r.player_name)}"${lock}>Delete</button>
        </td>
      </tr>`;
    })
    .join('');

  const canApprove = built && !approved && unread === 0 && blocked.length === 0 && drafts.length > 0;

  return `
  <h1>Decisions &amp; sending</h1>
  <p class="sub">Nothing is emailed until every message has been read, approved, and then sent —
  three separate actions.</p>

  <div id="flash" class="flash" hidden></div>

  <div class="steps">${steps}</div>

  ${blockBar}
  ${failedBar}
  ${budgetWarning}

  <div class="toolbar">
    ${!approved ? `<button class="bigbtn" id="buildBtn">${built ? 'Rebuild drafts' : 'Build drafts'}</button>` : ''}
    ${
      built && !approved
        ? `<button class="bigbtn" id="approveBtn"${canApprove ? '' : ' disabled'}
             data-url="/api/batch/${esc(batch.id)}/approve"
             data-prompt="Approve ${drafts.length} message(s)? This freezes the exact text you just read. It does NOT send anything yet."
             >${
               blocked.length
                 ? `Approve (${blocked.length} blocked)`
                 : unread > 0
                   ? `Approve (<span id="unreadCount">${unread}</span> unread)`
                   : 'Approve all'
             }</button>`
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

  ${
    drafts.length
      ? `<div class="panel"><h2>Read every message before approving —
         ${unread} of ${drafts.length} still unread</h2></div>${reviewCards}`
      : built
        ? '<div class="panel"><div class="empty">No drafts. Every player is either blocked above or already sent.</div></div>'
        : ''
  }

  <div class="panel">
    <h2>Players — ${decided} of ${rows.length} decided</h2>
    <div class="scroll"><table>
      <thead><tr><th>Player</th><th>Coaches</th><th>Decision</th><th>Message</th><th>Admin</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="5" class="empty">No confirmed players yet.</td></tr>'}</tbody>
    </table></div>
  </div>

  <script>${PAGE_SCRIPT}</script>`;
}
