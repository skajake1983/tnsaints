/**
 * In-page confirmation dialog, replacing window.prompt().
 *
 * prompt() was doing real work — it is the typed-confirmation gate in front of
 * Approve, Send, Cancel and Delete — but it is the wrong instrument:
 *
 *   - It renders as "admin.tnsaints.com says", which reads like a browser
 *     warning about the site rather than a decision the site is asking you to
 *     make. For the action that mails fifty families, that framing matters.
 *   - It cannot be styled, so the most consequential moment in the product is
 *     the only part that looks like it belongs to a different application.
 *   - On a phone it is a system sheet that covers the page, so the context you
 *     were confirming against disappears while you confirm it.
 *   - It blocks the main thread and swallows keyboard handling entirely.
 *   - Some browsers offer "prevent this page from creating more dialogs" after
 *     a few in a row — which would silently disable the confirmation step on
 *     exactly the screen where fifty of them get used.
 *
 * The replacement keeps the property that mattered: you must type the word, and
 * the confirm button stays disabled until you do.
 *
 * Shipped as source strings rather than a separate file the browser fetches,
 * because each admin page carries a single CSP script hash — the page appends
 * this to its own script and hashes the whole thing.
 */

export const DIALOG_STYLES = `
  .dlg-backdrop {
    position: fixed; inset: 0; background: rgba(6, 37, 92, .55);
    display: flex; align-items: center; justify-content: center;
    padding: 20px; z-index: 100; overflow-y: auto;
  }
  .dlg-backdrop[hidden] { display: none; }
  .dlg {
    background: #fff; border-radius: 12px; width: 100%; max-width: 460px;
    box-shadow: 0 18px 50px rgba(6, 37, 92, .3); overflow: hidden;
    margin: auto;
  }
  .dlg h2 { font-size: 17px; margin: 0; padding: 16px 20px; border-bottom: 1px solid var(--line); }
  .dlg.danger h2 { background: #f9e9e9; color: var(--danger); border-bottom-color: #e5b9b9; }
  .dlg .body { padding: 16px 20px; font-size: 14px; line-height: 1.55; }
  .dlg .body p { margin: 0 0 10px; }
  .dlg .body p:last-child { margin-bottom: 0; }
  .dlg .confirm { padding: 0 20px 16px; }
  .dlg .confirm label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .dlg .confirm input {
    width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 8px;
    font: inherit; font-size: 16px; letter-spacing: .08em; text-transform: uppercase;
  }
  .dlg .confirm input:focus { outline: 2px solid var(--navy-soft); outline-offset: 1px; }
  .dlg .actions {
    display: flex; gap: 10px; justify-content: flex-end; padding: 14px 20px;
    background: #fafbfd; border-top: 1px solid var(--line); flex-wrap: wrap;
  }
  .dlg .actions button {
    border-radius: 8px; padding: 11px 20px; font: inherit; font-size: 15px;
    font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: #fff;
  }
  .dlg .actions .go { background: var(--navy); border-color: var(--navy); color: #fff; }
  .dlg.danger .actions .go { background: var(--danger); border-color: var(--danger); }
  .dlg .actions .go:disabled { opacity: .4; cursor: not-allowed; }
  @media (max-width: 520px) {
    .dlg-backdrop { padding: 0; align-items: flex-end; }
    .dlg { max-width: none; border-radius: 12px 12px 0 0; }
    .dlg .actions { flex-direction: column-reverse; }
    .dlg .actions button { width: 100%; }
  }
`;

export const DIALOG_MARKUP = `
<div class="dlg-backdrop" id="dlgBackdrop" hidden>
  <div class="dlg" id="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
    <h2 id="dlgTitle"></h2>
    <div class="body" id="dlgBody"></div>
    <div class="confirm" id="dlgConfirmWrap" hidden>
      <label for="dlgInput">Type <strong id="dlgWord"></strong> to confirm</label>
      <input id="dlgInput" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false">
    </div>
    <div class="actions">
      <!--
        "Go back", not "Cancel".

        This app has a domain action called cancelling — releasing a player's
        spot — so a dismiss button labelled "Cancel" sat next to a confirm
        button labelled "Cancel their place". Two buttons starting with the same
        word, one doing nothing and one releasing a child's place. Unambiguous
        beats conventional here.
      -->
      <button type="button" id="dlgCancel">Go back</button>
      <button type="button" class="go" id="dlgGo">Confirm</button>
    </div>
  </div>
</div>`;

/**
 * Defines window.tnConfirm(opts) -> Promise<boolean>.
 *
 * Resolves true only if the dialog was confirmed, and — when a word is required
 * — only if that word was typed. Resolves false on Cancel, Escape, or a
 * backdrop click; dismissing is always safe because nothing has happened yet.
 */
export const DIALOG_SCRIPT = `
(function () {
  var backdrop = document.getElementById('dlgBackdrop');
  if (!backdrop) return;
  var dlg = document.getElementById('dlg');
  var titleEl = document.getElementById('dlgTitle');
  var bodyEl = document.getElementById('dlgBody');
  var wrap = document.getElementById('dlgConfirmWrap');
  var wordEl = document.getElementById('dlgWord');
  var input = document.getElementById('dlgInput');
  var goBtn = document.getElementById('dlgGo');
  var cancelBtn = document.getElementById('dlgCancel');
  var settle = null;
  var lastFocus = null;
  var needWord = '';

  function close(result) {
    backdrop.hidden = true;
    document.body.style.overflow = '';
    var fn = settle;
    settle = null;
    // Focus goes back where it came from, so keyboard and screen-reader users
    // are not dumped at the top of a fifty-row page after every confirmation.
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    if (fn) fn(result);
  }

  function sync() {
    if (!needWord) { goBtn.disabled = false; return; }
    goBtn.disabled = input.value.trim().toUpperCase() !== needWord;
  }

  input.addEventListener('input', sync);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !goBtn.disabled) { e.preventDefault(); close(true); }
  });

  goBtn.addEventListener('click', function () { if (!goBtn.disabled) close(true); });
  cancelBtn.addEventListener('click', function () { close(false); });
  backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(false); });

  document.addEventListener('keydown', function (e) {
    if (backdrop.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
    if (e.key !== 'Tab') return;
    // Keep focus inside the dialog. Without this, tabbing walks onto the page
    // behind it and a confirmation can be answered while looking at something
    // else entirely.
    var f = dlg.querySelectorAll('button, input');
    var list = Array.prototype.filter.call(f, function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  window.tnConfirm = function (opts) {
    return new Promise(function (resolve) {
      settle = resolve;
      lastFocus = document.activeElement;
      needWord = (opts.word || '').toUpperCase();

      titleEl.textContent = opts.title || 'Are you sure?';
      bodyEl.innerHTML = '';
      (opts.lines || []).forEach(function (line) {
        var p = document.createElement('p');
        // textContent, never innerHTML: these carry player names, which are
        // user-supplied.
        p.textContent = line;
        bodyEl.appendChild(p);
      });

      dlg.className = 'dlg' + (opts.danger ? ' danger' : '');
      goBtn.textContent = opts.confirmLabel || 'Confirm';
      wrap.hidden = !needWord;
      wordEl.textContent = needWord;
      input.value = '';
      sync();

      document.body.style.overflow = 'hidden';
      backdrop.hidden = false;
      (needWord ? input : goBtn).focus();
    });
  };
})();
`;
