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
import { DIALOG_STYLES, DIALOG_MARKUP, DIALOG_SCRIPT } from './dialog.js';

const PAGE_SCRIPT = `
(function () {
  var flash = document.getElementById('flash');
  var REOPEN_URL = (document.getElementById('reopenAllBtn') || {}).dataset
    ? document.getElementById('reopenAllBtn').dataset.url
    : ((document.getElementById('batchMeta') || {}).dataset || {}).reopenUrl;

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
      post('/api/decision/' + rid, { decision: value }).then(function (body) {
        document.querySelectorAll('[data-rid="' + rid + '"][data-decide]').forEach(function (b) {
          b.classList.toggle('on', b.dataset.decide === value);
        });
        // The message card above this row still shows text written for the
        // OLD decision. Saying only "saved" leaves a contradiction on screen
        // that looks approvable.
        if (body.staleDraft) {
          say('Decision saved — but the drafted message for this player was written for the ' +
              'old decision and is now out of date. Press "Rebuild drafts" to regenerate it. ' +
              'It cannot be approved until you do.', 'bad');
          setTimeout(function () { location.reload(); }, 2500);
        } else {
          say('Decision saved. Rebuild drafts to compose the message.', 'good');
        }
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
      window.tnConfirm({
        title: btn.dataset.title,
        lines: JSON.parse(btn.dataset.lines || '[]'),
        word: word,
        confirmLabel: btn.dataset.confirmLabel,
        danger: btn.dataset.danger === '1'
      }).then(function (ok) {
        if (!ok) return;
        btn.disabled = true;
        say('Working...', '');
        post(url).then(function (body) { done(body); })
          .catch(function (err) { btn.disabled = false; fail('Refused', err.message); });
      });
    });
  }

  var approveBtn = document.getElementById('approveBtn');
  if (approveBtn) confirmWord(approveBtn, 'APPROVE', approveBtn.dataset.url, function () {
    location.reload();
  });

  var reopenAllBtn = document.getElementById('reopenAllBtn');
  if (reopenAllBtn) confirmWord(reopenAllBtn, 'REOPEN', reopenAllBtn.dataset.url, function () {
    location.reload();
  });

  var picks = document.querySelectorAll('[data-pick]');
  var reopenPicked = document.getElementById('reopenPicked');

  function syncPicks() {
    var n = document.querySelectorAll('[data-pick]:checked').length;
    if (reopenPicked) {
      reopenPicked.disabled = n === 0;
      reopenPicked.textContent = n ? ('Reopen ' + n + ' selected for editing') : 'Reopen selected for editing';
    }
  }

  picks.forEach(function (cb) { cb.addEventListener('change', syncPicks); });

  var pickAll = document.getElementById('pickAll');
  if (pickAll) pickAll.addEventListener('click', function () {
    var all = document.querySelectorAll('[data-pick]');
    var target = document.querySelectorAll('[data-pick]:checked').length !== all.length;
    all.forEach(function (cb) { cb.checked = target; });
    syncPicks();
  });

  if (reopenPicked) reopenPicked.addEventListener('click', function () {
    var ids = Array.prototype.map.call(
      document.querySelectorAll('[data-pick]:checked'), function (cb) { return Number(cb.dataset.pick); });
    if (!ids.length) return;
    window.tnConfirm({
      title: 'Reopen ' + ids.length + ' message(s) for editing?',
      lines: [
        'They go back to draft so you can change them.',
        'Nothing has been sent, and they cannot send again until they are read and approved.'
      ],
      confirmLabel: 'Reopen them'
    }).then(function (ok) {
      if (!ok) return;
      post(REOPEN_URL, { message_ids: ids })
        .then(function () { location.reload(); })
        .catch(function (err) { fail('Could not reopen those', err.message); });
    });
  });

  var bulkBtn = document.getElementById('bulkBtn');
  var bulkBackdrop = document.getElementById('bulkBackdrop');
  var bulkFind = document.getElementById('bulkFind');
  var bulkReplace = document.getElementById('bulkReplace');
  var bulkResult = document.getElementById('bulkResult');
  var bulkPreview = document.getElementById('bulkPreview');
  var bulkApply = document.getElementById('bulkApply');
  var bulkClose = document.getElementById('bulkClose');

  function bulkUrl() {
    var meta = document.getElementById('batchMeta');
    return meta ? meta.dataset.replaceUrl : null;
  }

  function closeBulk() {
    if (!bulkBackdrop) return;
    bulkBackdrop.hidden = true;
    document.body.style.overflow = '';
  }

  if (bulkBtn) bulkBtn.addEventListener('click', function () {
    bulkResult.textContent = '';
    bulkApply.disabled = true;
    document.body.style.overflow = 'hidden';
    bulkBackdrop.hidden = false;
    bulkFind.focus();
  });

  if (bulkClose) bulkClose.addEventListener('click', closeBulk);
  if (bulkBackdrop) bulkBackdrop.addEventListener('mousedown', function (e) {
    if (e.target === bulkBackdrop) closeBulk();
  });

  // Preview before apply. A find string that matches more than intended is the
  // main way this goes wrong, and the count is what reveals it.
  if (bulkPreview) bulkPreview.addEventListener('click', function () {
    bulkResult.textContent = 'Checking...';
    bulkApply.disabled = true;
    post(bulkUrl(), { find: bulkFind.value, replace: bulkReplace.value, preview: true })
      .then(function (b) {
        // Built with DOM nodes and textContent, never innerHTML. These excerpts
        // are message content: coach prose and children's names, which is
        // exactly the kind of text that must never be interpreted as markup.
        bulkResult.textContent = '';
        var head = document.createElement('div');
        head.textContent = b.matched + ' of ' + b.of + ' drafts contain that text.';
        head.style.fontWeight = '700';
        bulkResult.appendChild(head);

        if (b.missed && b.missed.length) {
          var miss = document.createElement('div');
          miss.style.cssText = 'margin-top:8px;padding:8px;background:#fdf0dd;border-radius:6px';
          miss.textContent = 'These ' + b.missed.length + ' will NOT change, because their text ' +
            'differs (someone edited them): ' + b.missed.join(', ');
          bulkResult.appendChild(miss);
        }

        (b.samples || []).forEach(function (sm) {
          var wrap = document.createElement('div');
          wrap.style.marginTop = '10px';
          var who = document.createElement('div');
          who.style.cssText = 'color:var(--muted);font-size:12px';
          who.textContent = sm.player_name;
          var before = document.createElement('div');
          before.style.cssText = 'margin-top:3px;padding:7px;background:#f9e9e9;border-radius:6px;white-space:pre-wrap';
          before.textContent = sm.before;
          var after = document.createElement('div');
          after.style.cssText = 'margin-top:3px;padding:7px;background:#e4f3ea;border-radius:6px;white-space:pre-wrap';
          after.textContent = sm.after;
          wrap.appendChild(who); wrap.appendChild(before); wrap.appendChild(after);
          bulkResult.appendChild(wrap);
        });

        bulkApply.disabled = false;
        bulkApply.textContent = 'Apply to all ' + b.matched;
      })
      .catch(function (err) {
        bulkResult.textContent = err.message;
        bulkApply.disabled = true;
      });
  });

  if (bulkApply) bulkApply.addEventListener('click', function () {
    bulkApply.disabled = true;
    bulkResult.textContent = 'Applying...';
    post(bulkUrl(), { find: bulkFind.value, replace: bulkReplace.value })
      .then(function (b) {
        closeBulk();
        var note = 'Changed ' + b.changed + ' message(s). They must all be read again before approving.';
        if (b.missed && b.missed.length) {
          note += ' NOT changed (their text differs): ' + b.missed.join(', ') + '.';
        }
        say(note, b.missed && b.missed.length ? 'bad' : 'good');
        setTimeout(function () { location.reload(); }, 1500);
      })
      .catch(function (err) {
        bulkResult.textContent = err.message;
        bulkApply.disabled = false;
      });
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
      window.tnConfirm({
        title: 'Cancel ' + name + "'s spot at the evaluation?",
        lines: [
          'This releases their seat. The first family on that session\\'s waiting list is moved up automatically.',
          'The registration and the signed waiver are kept - only the spot is given up.',
          'This does not cancel the evaluation itself, and it affects no other player.'
        ],
        word: 'CANCEL',
        confirmLabel: 'Release their spot'
      }).then(function (ok) {
        if (!ok) return;
        post('/api/registration/' + btn.dataset.cancel + '/cancel', { reason: '' })
          .then(function () { location.reload(); })
          .catch(function (err) { fail('Could not cancel', err.message); });
      });
    });
  });

  document.querySelectorAll('[data-delete]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.dataset.name;
      window.tnConfirm({
        title: 'Permanently delete ' + name + '?',
        lines: [
          'This erases the registration, the signed waiver record, and every coach note about this player.',
          'It cannot be undone.',
          'Cancelling instead keeps the record and still frees the seat.'
        ],
        word: 'DELETE',
        confirmLabel: 'Delete permanently',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        post('/api/registration/' + btn.dataset.delete + '/delete')
          .then(function () { location.reload(); })
          .catch(function (err) { fail('Could not delete', err.message); });
      });
    });
  });
})();
`;

let cachedHash = null;

/** Dialog first: the page script calls window.tnConfirm, so it must exist. */
const FULL_SCRIPT = DIALOG_SCRIPT + PAGE_SCRIPT;

async function scriptCspHash() {
  if (cachedHash) return cachedHash;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(FULL_SCRIPT));
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

export const DECISION_STYLES = DIALOG_STYLES + `
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
  .msgcard.stale { border-left-color: var(--danger); }
  .msgcard.queued { border-left-color: var(--navy-soft); }
  .msgcard.queued textarea { background: #f7f9fc; color: var(--muted); }
  .pick { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
          text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .pick input { width: 18px; height: 18px; }
  .msgcard.stale textarea { background: #fdf7f7; color: var(--muted); }
  .stalebar { background: #f9e9e9; border-bottom: 1px solid #e5b9b9; color: var(--danger);
              padding: 11px 15px; font-size: 13px; font-weight: 600; }
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
  const queuedMsgs = messages.filter((m) => m.send_state === 'queued');
  const skipped = messages.filter((m) => m.send_state === 'skipped');
  const queued = messages.filter((m) => m.send_state === 'queued').length;
  const sentCount = messages.filter((m) => m.send_state === 'sent').length;
  const failed = messages.filter((m) => m.send_state === 'failed');
  const staleDrafts = drafts.filter((m) => {
    const row = rows.find((r) => Number(r.id) === Number(m.registration_id));
    return row && (m.composed_for_decision !== row.decision || m.stale_notes === 1);
  });
  // A stale draft counts as unread: its text contradicts the decision, so any
  // earlier read of it was a read of something that is no longer true.
  const unread = drafts.filter(
    (m) => !m.reviewed_at || staleDrafts.some((s) => s.id === m.id)
  ).length;

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
  // Name what is missing per player, not just that something is.
  // "no coach has written both" reads as "neither exists" when usually only one
  // is absent, which sends someone to the form looking for the wrong thing.
  const blockBar = blocked.length
    ? `<div class="blockbar"><strong>${blocked.length} player(s) cannot be sent anything yet.</strong>
       Every player needs a strength AND a growth area from at least one coach.
       <ul style="margin:8px 0 0;padding-left:20px">
       ${blocked
         .map((b) => {
           const missing = [];
           if (!(Number(b.with_strengths) > 0)) missing.push('a strength');
           if (!(Number(b.with_growth) > 0)) missing.push('a growth area');
           return `<li><a href="/eval/${b.id}">${esc(b.player_name)}</a> — needs ${missing.join(' and ')}</li>`;
         })
         .join('')}
       </ul></div>`
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
  // Queued messages were invisible once approved: the review column only
  // rendered drafts, so after approving, the screen showed "No drafts" and
  // there was no way to look at, let alone change, what was about to be sent.
  const queuedCards = queuedMsgs
    .map((m) => {
      const row = rows.find((r) => Number(r.id) === Number(m.registration_id));
      return `<div class="msgcard queued" id="msg-${m.id}">
        <div class="head">
          <label class="pick"><input type="checkbox" data-pick="${m.id}"> select</label>
          <span class="who">${esc(row ? row.player_name : '')}</span>
          <span class="to">to ${esc(row ? row.parent_email : '')}</span>
          <span class="rbadge on">approved — waiting to send</span>
        </div>
        <div class="subj">Subject: ${esc(m.subject)}</div>
        <textarea readonly>${esc(m.body_text)}</textarea>
      </div>`;
    })
    .join('');

  const reviewCards = drafts
    .map((m) => {
      const row = rows.find((r) => Number(r.id) === Number(m.registration_id));
      const stale = row && (m.composed_for_decision !== row.decision || m.stale_notes === 1);
      const reviewed = Boolean(m.reviewed_at) && !stale;
      return `<div class="msgcard${reviewed ? ' reviewed' : ''}${stale ? ' stale' : ''}" id="msg-${m.id}">
        <div class="head">
          <span class="who">${esc(row ? row.player_name : '')}</span>
          <span class="pill ${esc(row ? row.decision : '')}">${esc(row ? row.decision.replace('_', ' ') : '')}</span>
          <span class="to">to ${esc(row ? row.parent_email : '')}</span>
          <span class="rbadge${reviewed ? ' on' : ''}" id="state-${m.id}">${
            reviewed ? (m.edited_at ? 'edited &amp; read' : 'read') : 'unread'
          }</span>
        </div>
        ${
          stale
            ? `<div class="stalebar">This message was written for
               "<strong>${esc(String(m.composed_for_decision || 'no decision').replace('_', ' '))}</strong>"
               but the decision is now "<strong>${esc(row.decision.replace('_', ' '))}</strong>".
               ${m.stale_notes === 1 ? 'The coach notes have also changed since this was written.' : ''}
               The text below is out of date. Press <strong>Rebuild drafts</strong> to regenerate it —
               it cannot be approved until you do.</div>`
            : m.stale_notes === 1
            ? `<div class="stalebar">A coach has changed their notes since this was written, so the
               text below no longer reflects them. Press <strong>Rebuild drafts</strong> to regenerate it —
               it cannot be approved until you do.</div>`
            : ''
        }
        <div class="subj">Subject: ${esc(m.subject)}</div>
        <textarea id="body-${m.id}" spellcheck="true">${esc(m.body_text)}</textarea>
        <div class="foot">
          <button class="dbtn" data-save="${m.id}"${stale ? ' disabled' : ''}>Save changes</button>
          <button class="dbtn" data-read="${m.id}"${reviewed || stale ? ' disabled' : ''}>${
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
        <td data-label="Player"><strong>${esc(r.player_name)}</strong><br>
          <span style="font-size:12px;color:var(--muted)">${esc(r.session_time)} · ${esc(r.grade)}</span>
          ${
            incomplete
              ? `<br><a class="needs" href="/eval/${r.id}">needs ${
                  !(Number(r.with_strengths) > 0) && !(Number(r.with_growth) > 0)
                    ? 'a strength &amp; a growth area'
                    : !(Number(r.with_strengths) > 0)
                      ? 'a strength'
                      : 'a growth area'
                } →</a>`
              : ''
          }</td>
        <td data-label="Coaches">${Number(r.coach_count)}</td>
        <td data-label="Decision">
          <button class="dbtn${r.decision === 'accept' ? ' on' : ''}" data-rid="${r.id}" data-decide="accept"${lock}>Accept</button>
          <button class="dbtn${r.decision === 'not_yet' ? ' on' : ''}" data-rid="${r.id}" data-decide="not_yet"${lock}>Not yet</button>
        </td>
        <td data-label="Message">${msg ? esc(msg.send_state) : '<span style="color:var(--muted)">—</span>'}</td>
        <td data-label="Admin">
          <button class="dbtn" data-cancel="${r.id}" data-name="${esc(r.player_name)}"
            aria-label="Cancel ${esc(r.player_name)}'s spot"${lock}>Cancel spot</button>
          <button class="dbtn danger" data-delete="${r.id}" data-name="${esc(r.player_name)}"
            aria-label="Permanently delete ${esc(r.player_name)}"${lock}>Delete</button>
        </td>
      </tr>`;
    })
    .join('');

  const canApprove =
    built && !approved && unread === 0 && blocked.length === 0 &&
    staleDrafts.length === 0 && drafts.length > 0;

  return `
  <h1>Decisions &amp; sending</h1>
  <p class="sub">Nothing is emailed until every message has been read, approved, and then sent —
  three separate actions.</p>

  <div id="flash" class="flash" hidden></div>
  ${batch ? `<div id="batchMeta" hidden data-reopen-url="/api/batch/${esc(batch.id)}/reopen"
       data-replace-url="/api/batch/${esc(batch.id)}/replace"></div>` : ''}

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
             data-title="Approve ${drafts.length} message(s)?"
             data-lines='["This freezes the exact text you just read. Every message becomes read-only.", "It does NOT send anything yet \u2014 sending is a separate action."]'
             data-confirm-label="Approve and freeze"
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
      approved && queued
        ? `<button class="bigbtn" id="reopenAllBtn" data-url="/api/batch/${esc(batch.id)}/reopen"
             data-title="Reopen all ${queued} message(s) for editing?"
             data-lines='["Every approved message goes back to draft so you can change it.", "Nothing has been sent, and nothing will be until you approve and send again.", "Anything already sent stays sent."]'
             data-confirm-label="Reopen all" style="background:var(--navy-soft)">Reopen all</button>`
        : ''
    }
    ${
      approved && queued && canSend
        ? `<button class="bigbtn send" id="sendBtn" data-url="/api/batch/${esc(batch.id)}/send"
             data-title="Send ${Math.min(queued, 10)} message(s) now?"
             data-lines='["This sends real email to real families, up to 10 in this run.", "It cannot be recalled once sent."]'
             data-confirm-label="Send now" data-danger="1">Send now</button>`
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
           ${unread} of ${drafts.length} still unread</h2>
           <div style="padding:12px 16px;border-top:1px solid var(--line)">
             <button class="dbtn" id="bulkBtn">Change the same text in every draft…</button>
             <span style="font-size:13px;color:var(--muted);margin-left:8px">For a wrong footer,
             signature or reply-to address — anything that is the same in all of them.</span>
           </div>
         </div>${reviewCards}`
      : built && !queuedMsgs.length
        ? '<div class="panel"><div class="empty">No drafts. Every player is either blocked above or already sent.</div></div>'
        : ''
  }

  ${
    queuedMsgs.length
      ? `<div class="panel"><h2>Approved and waiting to send — ${queuedMsgs.length}</h2>
           <div style="padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
             <button class="dbtn" id="pickAll">Select all</button>
             <button class="dbtn" id="reopenPicked" disabled>Reopen selected for editing</button>
             <span style="font-size:13px;color:var(--muted)">Reopening returns a message to draft so you
             can change it. It must be read and approved again before it can send.</span>
           </div>
         </div>${queuedCards}`
      : ''
  }

  <div class="panel">
    <h2>Players — ${decided} of ${rows.length} decided</h2>
    <div class="scroll"><table class="stack">
      <thead><tr><th>Player</th><th>Coaches</th><th>Decision</th><th>Message</th><th>Admin</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="5" class="empty">No confirmed players yet.</td></tr>'}</tbody>
    </table></div>
  </div>

  <div class="dlg-backdrop" id="bulkBackdrop" hidden>
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="bulkTitle">
      <h2 id="bulkTitle">Change the same text in every draft</h2>
      <div class="body">
        <p>Type the exact text as it appears now, and what it should say instead.
        Nothing changes until you have seen how many messages match.</p>
        <label for="bulkFind" style="display:block;font-size:13px;font-weight:600;margin:12px 0 5px">Find this text</label>
        <textarea id="bulkFind" style="width:100%;min-height:70px;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:15px"></textarea>
        <label for="bulkReplace" style="display:block;font-size:13px;font-weight:600;margin:12px 0 5px">Replace it with</label>
        <textarea id="bulkReplace" style="width:100%;min-height:70px;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:15px"></textarea>
        <div id="bulkResult" style="margin-top:12px;font-size:13px"></div>
      </div>
      <div class="actions">
        <button type="button" id="bulkClose">Go back</button>
        <button type="button" id="bulkPreview">Show me what changes</button>
        <button type="button" class="go" id="bulkApply" disabled>Apply to all matches</button>
      </div>
    </div>
  </div>

  ${DIALOG_MARKUP}

  <script>${FULL_SCRIPT}</script>`;
}
