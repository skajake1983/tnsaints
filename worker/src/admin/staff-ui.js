/**
 * The Users screen: add, re-role, and deactivate staff from the site itself.
 *
 * WHAT THIS DOES AND DELIBERATELY DOES NOT DO
 *
 * It manages the D1 `staff` table — the role gate. It does NOT manage Cloudflare
 * Access, which is the door in front of the site. Whether a person added here
 * can actually reach the login at all depends on the Access policy: if that
 * policy admits the whole @tnsaints.com domain, this table is the sole
 * authority and adding a row is enough; if it lists individuals, they must also
 * be added to the Access app in the Cloudflare dashboard. ADMIN-SETUP.md carries
 * that decision. The welcome email tells the person to sign in with their M365
 * login — true only once Access admits them.
 */

import { esc } from './ui.js';
import { DIALOG_STYLES, DIALOG_MARKUP, DIALOG_SCRIPT } from './dialog.js';

const BODY_SCRIPT = `
(function () {
  var flash = document.getElementById('flash');
  // Tap to dismiss. The toast is position:fixed, so showing or hiding it never
  // moves anything on the page — the form stays exactly where it was.
  if (flash) flash.addEventListener('click', function () { flash.hidden = true; });
  function say(msg, cls) {
    if (!flash) return;
    flash.textContent = msg;
    flash.className = 'flash ' + (cls || '');
    flash.hidden = false;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.text().then(function (raw) {
        var b = null;
        try { b = JSON.parse(raw); } catch (e) {}
        if (!b) throw new Error('Server returned ' + r.status);
        if (!r.ok || !b.ok) throw new Error(b.error || ('HTTP ' + r.status));
        return b;
      });
    });
  }

  var addForm = document.getElementById('addForm');
  if (addForm) addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = document.getElementById('addBtn');
    btn.disabled = true;
    say('Adding...', '');
    post('/api/staff', {
      email: document.getElementById('newEmail').value,
      display_name: document.getElementById('newName').value,
      author_label: document.getElementById('newLabel').value,
      role: document.getElementById('newRole').value,
      send_invite: document.getElementById('newInvite').checked
    }).then(function (b) {
      var note = b.created ? 'Added ' + b.email + '.' : 'Updated ' + b.email + '.';
      if (b.invited === true) note += ' Welcome email sent.';
      else if (b.invited === false) note += ' Welcome email could NOT be sent — tell them the site address yourself.';
      say(note, b.invited === false ? 'bad' : 'good');
      setTimeout(function () { location.reload(); }, 1200);
    }).catch(function (err) { btn.disabled = false; say(err.message, 'bad'); });
  });

  document.querySelectorAll('[data-role-for]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var email = sel.dataset.roleFor;
      post('/api/staff', {
        email: email,
        display_name: sel.dataset.name,
        author_label: sel.dataset.label,
        role: sel.value,
        send_invite: false
      }).then(function () { say('Role updated for ' + email + '.', 'good'); })
        .catch(function (err) { say(err.message, 'bad'); sel.value = sel.dataset.was; });
    });
  });

  document.querySelectorAll('[data-deactivate]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var email = btn.dataset.deactivate;
      window.tnConfirm({
        title: 'Remove ' + email + "'s access?",
        lines: [
          'They will no longer be able to sign in. Any evaluations they wrote are kept, with their name.',
          'You can restore their access later without re-entering anything.'
        ],
        confirmLabel: 'Remove access'
      }).then(function (ok) {
        if (!ok) return;
        post('/api/staff/deactivate', { email: email })
          .then(function () { location.reload(); })
          .catch(function (err) { say(err.message, 'bad'); });
      });
    });
  });

  document.querySelectorAll('[data-activate]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      post('/api/staff/activate', { email: btn.dataset.activate })
        .then(function () { location.reload(); })
        .catch(function (err) { say(err.message, 'bad'); });
    });
  });

  document.querySelectorAll('[data-reinvite]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      post('/api/staff/reinvite', { email: btn.dataset.reinvite })
        .then(function () { say('Welcome email re-sent to ' + btn.dataset.reinvite + '.', 'good'); })
        .catch(function (err) { say(err.message, 'bad'); })
        .then(function () { btn.disabled = false; });
    });
  });
})();
`;

const PAGE_SCRIPT = DIALOG_SCRIPT + BODY_SCRIPT;

let cachedHash = null;
async function scriptCspHash() {
  if (cachedHash) return cachedHash;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PAGE_SCRIPT));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  cachedHash = `'sha256-${btoa(binary)}'`;
  return cachedHash;
}

export async function usersCsp() {
  const hash = await scriptCspHash();
  return (
    "default-src 'none'; " +
    `script-src ${hash}; ` +
    "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
}

export const USERS_STYLES =
  DIALOG_STYLES +
  `
  /* Transient action feedback ("Added…", "Role updated…") is a FIXED toast, not
     an in-flow element. It overlays the page and is removed from layout entirely,
     so appearing or disappearing never resizes or pushes the form. */
  .flash { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
           width: min(560px, calc(100% - 32px)); padding: 12px 16px; border-radius: 10px;
           font-size: 14px; z-index: 200; background: #06255c; color: #fff; border: 0;
           box-shadow: 0 12px 34px rgba(6, 37, 92, .3); cursor: pointer; }
  .flash.good { background: #1c7c4a; }
  .flash.bad { background: #a32020; }
  /* The permanent access banner stays in normal flow — it is not feedback and
     never appears or disappears, so it cannot cause a shift. */
  .notice { padding: 12px 14px; border-radius: 8px; margin-bottom: 20px; font-size: 14px;
            background: #eef2f8; border: 1px solid var(--line); }
  .notice.good { background: #e4f3ea; border-color: #b6ddc6; }
  .notice.warn { background: #fdf0dd; border-color: #e8c893; }
  .addcard { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 22px; }
  .addcard h2 { font-size: 15px; margin: 0 0 12px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
  .fld label { display: block; font-size: 12px; font-weight: 700; text-transform: uppercase;
               letter-spacing: .05em; color: var(--muted); margin-bottom: 5px; }
  .fld input, .fld select {
    width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
    font: inherit; font-size: 15px; background: #fff; color: var(--ink);
  }
  .addrow { display: flex; align-items: center; gap: 14px; margin-top: 12px; flex-wrap: wrap; }
  .addrow label { font-size: 14px; display: flex; align-items: center; gap: 7px; }
  .btn { background: var(--navy); color: #fff; border: 0; border-radius: 8px; padding: 11px 22px;
         font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
  .rolesel { padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; font: inherit; font-size: 14px; }
  .abtn { border: 1px solid var(--line); background: #fff; border-radius: 7px; padding: 7px 11px;
          font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .abtn.danger { color: var(--danger); border-color: #e5b9b9; }
  .who2 { font-size: 12px; color: var(--muted); }
  .inactive td { opacity: .55; }
  .badge { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
           padding: 2px 8px; border-radius: 99px; }
  .badge.on { background: #e4f3ea; color: var(--ok); }
  .badge.off { background: #f6e5e5; color: var(--danger); }
`;

function roleOptions(current) {
  return ['admin', 'coach', 'viewer']
    .map((r) => `<option value="${r}"${r === current ? ' selected' : ''}>${r}</option>`)
    .join('');
}

export function usersBody({ staff, me, accessMode }) {
  const rows = staff
    .map((s) => {
      const inactive = s.active !== 1;
      const isMe = s.email_norm === me;
      return `<tr${inactive ? ' class="inactive"' : ''}>
        <td data-label="Person">
          <strong>${esc(s.display_name)}</strong>${isMe ? ' <span class="who2">(you)</span>' : ''}<br>
          <span class="who2">${esc(s.email_norm)} · shown to parents as ${esc(s.author_label)}</span>
        </td>
        <td data-label="Role">
          <select class="rolesel" data-role-for="${esc(s.email_norm)}" data-was="${esc(s.role)}"
            data-name="${esc(s.display_name)}" data-label="${esc(s.author_label)}"${inactive ? ' disabled' : ''}>
            ${roleOptions(s.role)}
          </select>
        </td>
        <td data-label="Status">
          <span class="badge ${inactive ? 'off' : 'on'}">${inactive ? 'no access' : 'active'}</span>
        </td>
        <td data-label="Actions">
          ${
            inactive
              ? `<button class="abtn" data-activate="${esc(s.email_norm)}">Restore access</button>`
              : `<button class="abtn" data-reinvite="${esc(s.email_norm)}">Re-send email</button>
                 <button class="abtn danger" data-deactivate="${esc(s.email_norm)}">Remove access</button>`
          }
        </td>
      </tr>`;
    })
    .join('');

  // The Access-model banner: this is the one thing that decides whether adding
  // a row is enough, or whether the Cloudflare dashboard also needs a touch.
  const accessNote =
    accessMode === 'domain'
      ? `<div class="notice good">Anyone you add here with an
         <strong>@tnsaints.com</strong> address can sign in immediately — no Cloudflare step needed.</div>`
      : `<div class="notice warn">
         <strong>One extra step per person:</strong> after adding someone here, also add their email to
         the Cloudflare Access policy (Zero Trust → Access → Applications → TN Saints Admin), or they will
         be turned away at the login before this list is ever consulted. Ask about switching to
         "anyone @tnsaints.com" to remove this step.</div>`;

  return `
  <h1>Users</h1>
  <p class="sub">Who can sign in to the staff site, and what they can do.</p>

  <div id="flash" class="flash" hidden></div>
  ${accessNote}

  <div class="addcard">
    <h2>Add someone</h2>
    <form id="addForm">
      <div class="grid">
        <div class="fld"><label for="newEmail">Work email (@tnsaints.com)</label>
          <input id="newEmail" type="email" autocomplete="off" placeholder="name@tnsaints.com" required></div>
        <div class="fld"><label for="newName">Full name</label>
          <input id="newName" type="text" autocomplete="off" placeholder="Jane Coach" required></div>
        <div class="fld"><label for="newLabel">Shown to parents as</label>
          <input id="newLabel" type="text" autocomplete="off" placeholder="Coach Jane" required></div>
        <div class="fld"><label for="newRole">Role</label>
          <select id="newRole">
            <option value="coach">coach — evaluate players; no contacts, no medical, no sending</option>
            <option value="admin">admin — full access, decisions, sending, user management</option>
            <option value="viewer">viewer — read the basketball roster only</option>
          </select></div>
      </div>
      <div class="addrow">
        <button class="btn" id="addBtn" type="submit">Add user</button>
        <label><input type="checkbox" id="newInvite" checked> email them the sign-in link</label>
      </div>
    </form>
  </div>

  <div class="panel">
    <h2>Staff</h2>
    <div class="scroll"><table class="stack">
      <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty">No staff yet.</td></tr>'}</tbody>
    </table></div>
  </div>

  ${DIALOG_MARKUP}

  <script>${PAGE_SCRIPT}</script>`;
}
