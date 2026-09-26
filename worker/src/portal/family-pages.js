/**
 * Family pages: setup, the dashboard, a child's profile and medical answer,
 * and emergency contacts. Markup only; data comes from portal/data.js.
 */

import {
  esc, portalPage, portalResponse, field, errorSummary, selectField, textareaField, radioGroup,
} from './ui.js';
import { googleButton } from './auth-pages.js';
import { currentGrade, gradeLabel } from '../lib/grades.js';
import { SHIRT_SIZES, RELATIONSHIPS } from './forms.js';

const NAV = [{ href: '/', label: 'Family' }, { href: '/account', label: 'Account' }];
const errorFor = (errors, id) => errors.find((e) => e.id === id)?.message || '';
const GRADE_OPTIONS = Array.from({ length: 13 }, (_, g) => [String(g), g === 0 ? 'Kindergarten' : gradeLabel(g)]);
const shirtLabel = (v) => (SHIRT_SIZES.find(([k]) => k === v) || [null, ''])[1];

function page(rc, title, body, { status = 200, current = '/' } = {}) {
  return portalResponse(portalPage({ rc, title, body, nav: NAV, current, signedIn: true }), { status });
}

// --- setup -------------------------------------------------------------------

export function setupPage(rc, session, { values = {}, errors = [], status = 200 } = {}) {
  const body = `<h1>Set up your family</h1>
<p class="lede">A few details about you first. Next you'll add your children.</p>
${errorSummary(errors)}
<form method="post" action="${esc(rc.url('/family/setup'))}" novalidate>
  ${field({ id: 'guardian_name', label: 'Your full name', value: values.guardianName ?? session.displayName ?? '',
    required: true, autocomplete: 'name', error: errorFor(errors, 'guardian_name') })}
  ${field({ id: 'phone', label: 'Your mobile number', type: 'tel', value: values.phone || '', required: true,
    autocomplete: 'tel', inputmode: 'tel', hint: 'So coaches can reach you at practice.', error: errorFor(errors, 'phone') })}
  ${selectField({ id: 'relationship', label: 'Your relationship to the children', value: values.relationship || '',
    options: RELATIONSHIPS.map((r) => [r, r]), required: true, error: errorFor(errors, 'relationship') })}
  ${field({ id: 'family_name', label: 'Family name', value: values.displayName || '',
    hint: 'How we refer to your family, like "The Adams family". Leave blank and we will use your surname.' })}
  <button class="btn" type="submit">Continue</button>
</form>`;
  return page(rc, 'Set up your family', body, { status });
}

// --- dashboard -----------------------------------------------------------------

function medicalBadge(status) {
  if (status === 'declared') return '<span class="badge ok">Medical info on file</span>';
  if (status === 'none_declared') return '<span class="badge ok">Nothing to declare</span>';
  return '<span class="badge warn">Medical answer needed</span>';
}

/** One line per child about the academy: where the application stands, or how to apply. */
function academyLine(rc, child, enrollments, academy) {
  const e = enrollments.find((x) => Number(x.player_id) === Number(child.id) && x.program_id === 'academy'
    && ['applied', 'waitlist', 'offered', 'active', 'past_due'].includes(x.status));
  if (!e) {
    return academy ? `<a href="${esc(rc.url(`/children/${child.id}/apply/academy`))}">Apply to the academy</a>` : '';
  }
  const until = e.offer_expires_at ? new Date(e.offer_expires_at).toLocaleDateString('en-US',
    { timeZone: 'America/Chicago', month: 'long', day: 'numeric' }) : '';
  if (e.status === 'applied') return '<span class="badge ok">Academy: application received</span>';
  if (e.status === 'waitlist') return '<span class="badge warn">Academy: on the waiting list</span>';
  if (e.status === 'offered') {
    return `<span class="badge ok">Place offered: ${esc(e.group_name)} (${esc(e.schedule_summary)}), accept by ${esc(until)}</span>`;
  }
  if (e.status === 'past_due') return '<span class="badge warn">Academy: payment needed</span>';
  return `<span class="badge ok">Academy: ${esc(e.group_name)} (${esc(e.schedule_summary)})</span>`;
}

export function dashboardPage(rc, { household, guardians, children, contacts, claimable, enrollments = [],
  academy = null, notice = '' }) {
  const kids = children.length
    ? `<ul class="cards-list">${children
        .map((c) => {
          const grade = currentGrade(c.grade_level, c.grade_school_year);
          const details = [grade !== null ? gradeLabel(grade) : '', c.shirt_size ? `Shirt ${shirtLabel(c.shirt_size)}` : '']
            .filter(Boolean)
            .join(' · ');
          return `<li class="item">
  <div><a class="item-title" href="${esc(rc.url(`/children/${c.id}`))}">${esc(c.display_name)}</a>
  ${details ? `<div class="item-sub">${esc(details)}</div>` : ''}
  <div class="item-sub">${academyLine(rc, c, enrollments, academy)}</div></div>
  ${medicalBadge(c.medical_status)}
</li>`;
        })
        .join('')}</ul>`
    : '<p>No children added yet.</p>';

  const claim = claimable.length
    ? `<div class="notice" role="note">
  <h2 style="margin-top:0">We found ${claimable.length === 1 ? 'a child' : `${claimable.length} children`} from past evaluations</h2>
  <p>Registered under your email address. Add them to your family to keep their history together.</p>
  <ul class="cards-list">${claimable
    .map((c) => `<li class="item"><div><span class="item-title">${esc(c.player_name)}</span>
  <div class="item-sub">${esc(c.grade || '')}${c.school ? ` · ${esc(c.school)}` : ''}</div></div>
  <form method="post" action="${esc(rc.url('/children/claim'))}">
    <input type="hidden" name="registration_id" value="${esc(c.registration_id)}">
    <button class="btn secondary" type="submit">Add to my family</button>
  </form></li>`)
    .join('')}</ul>
</div>`
    : '';

  const ec = contacts.length
    ? `<ol class="plain">${contacts
        .map((c) => `<li>${esc(c.name)}${c.relationship ? ` (${esc(c.relationship)})` : ''} · ${esc(c.phone)}</li>`)
        .join('')}</ol>`
    : '<p><span class="badge warn">Needed</span> Add at least one person we can call if we cannot reach you.</p>';

  const body = `${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ''}
<h1>${esc(household.display_name || 'Your family')}</h1>
<p class="lede">Keep your children's details current here. Everything on this page is visible to every guardian in your family.</p>
${claim}
<section class="panel" aria-labelledby="kids-h">
  <h2 id="kids-h" style="margin-top:0">Children</h2>
  ${kids}
  <p style="margin-bottom:0"><a class="btn" href="${esc(rc.url('/children/new'))}">Add a child</a></p>
</section>
<section class="panel" aria-labelledby="ec-h">
  <h2 id="ec-h" style="margin-top:0">Emergency contacts</h2>
  ${ec}
  <p style="margin-bottom:0"><a class="btn secondary" href="${esc(rc.url('/contacts'))}">${contacts.length ? 'Edit' : 'Add'} emergency contacts</a></p>
</section>
<section class="panel" aria-labelledby="g-h">
  <h2 id="g-h" style="margin-top:0">Guardians</h2>
  <ul class="plain">${guardians
    .map((g) => `<li>${esc(g.display_name || g.email)}${g.relationship ? ` (${esc(g.relationship)})` : ''}${g.role === 'owner' ? ' · owner' : ''}</li>`)
    .join('')}</ul>
  <p style="margin-bottom:0"><a class="btn secondary" href="${esc(rc.url('/guardians'))}">Manage guardians</a></p>
</section>`;
  return page(rc, 'Your family', body);
}

// --- a child -----------------------------------------------------------------------

export function childPage(rc, { child = null, values = {}, errors = [], medical = null, medicalValues = {},
  medicalErrors = [], status = 200, saved = '' }) {
  const isNew = !child;
  const v = {
    child_name: values.name ?? child?.display_name ?? '',
    date_of_birth: values.dateOfBirth ?? child?.date_of_birth ?? '',
    grade: values.gradeLevel ?? (child ? currentGrade(child.grade_level, child.grade_school_year) : ''),
    school: values.school ?? child?.school ?? '',
    shirt_size: values.shirtSize ?? child?.shirt_size ?? '',
  };
  const action = isNew ? rc.url('/children') : rc.url(`/children/${child.id}`);
  const profile = `${errorSummary(errors)}
<form method="post" action="${esc(action)}" novalidate>
  ${field({ id: 'child_name', label: "Child's full name", value: v.child_name, required: true, error: errorFor(errors, 'child_name') })}
  ${field({ id: 'date_of_birth', label: 'Date of birth', type: 'date', value: v.date_of_birth, required: true,
    error: errorFor(errors, 'date_of_birth') })}
  ${selectField({ id: 'grade', label: 'Grade this school year', value: v.grade === null ? '' : v.grade, options: GRADE_OPTIONS,
    required: true, hint: 'We move it up automatically every July.', error: errorFor(errors, 'grade') })}
  ${field({ id: 'school', label: 'School', value: v.school, required: true, error: errorFor(errors, 'school') })}
  ${selectField({ id: 'shirt_size', label: 'Practice shirt size', value: v.shirt_size, options: SHIRT_SIZES,
    required: true, hint: 'Included in the $40 setup fee.', error: errorFor(errors, 'shirt_size') })}
  <button class="btn" type="submit">${isNew ? 'Add child' : 'Save changes'}</button>
</form>`;

  const medStatus = medicalValues.status ?? medical?.status ?? '';
  const medNotes = medicalValues.notes ?? medical?.notes ?? '';
  const medicalSection = isNew
    ? ''
    : `<section class="panel" aria-labelledby="med-h" id="medical">
  <h2 id="med-h" style="margin-top:0">Medical information</h2>
  <p>Coaches see only that there is something to know. The details are kept private and read only when needed.</p>
  ${errorSummary(medicalErrors)}
  <form method="post" action="${esc(rc.url(`/children/${child.id}/medical`))}" novalidate>
    ${radioGroup({ id: 'medical_status', legend: 'Allergies, conditions or medication we should know about?',
      value: medStatus, required: true, error: errorFor(medicalErrors, 'medical_status'),
      options: [['none_declared', 'No, nothing to declare'], ['declared', 'Yes']] })}
    ${textareaField({ id: 'medical_notes', label: 'Details', value: medNotes,
      hint: 'Only if you answered yes. Include what to do in an emergency.', error: errorFor(medicalErrors, 'medical_notes') })}
    <button class="btn" type="submit">Save medical answer</button>
  </form>
</section>`;

  const body = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
${saved ? `<div class="notice" role="status">${esc(saved)}</div>` : ''}
<h1>${isNew ? 'Add a child' : esc(child.display_name)}</h1>
<section class="panel" aria-label="Profile">${profile}</section>
${medicalSection}`;
  return page(rc, isNew ? 'Add a child' : child.display_name, body, { status });
}

// --- emergency contacts ------------------------------------------------------------

export function contactsPage(rc, { contacts = [], values = null, errors = [], status = 200 }) {
  const rows = [1, 2, 3]
    .map((i) => {
      const c = (values || contacts)[i - 1] || {};
      return `<fieldset class="field">
  <legend>Contact ${i}${i === 1 ? ' <span class="req">(required)</span>' : ' <span class="opt">(optional)</span>'}</legend>
  ${field({ id: `ec${i}_name`, label: 'Name', value: c.name || '', required: i === 1, autocomplete: 'off', error: errorFor(errors, `ec${i}_name`) })}
  ${field({ id: `ec${i}_phone`, label: 'Phone', type: 'tel', value: c.phone || '', required: i === 1, inputmode: 'tel',
    error: errorFor(errors, `ec${i}_phone`) })}
  ${field({ id: `ec${i}_relationship`, label: 'Relationship', value: c.relationship || '', hint: 'For example: aunt, neighbour.' })}
</fieldset>`;
    })
    .join('');
  const body = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>Emergency contacts</h1>
<p class="lede">People we can call, in this order, if we can't reach you. Ideally not someone who will be at practice with you.</p>
${errorSummary(errors)}
<form method="post" action="${esc(rc.url('/contacts'))}" novalidate>
  ${rows}
  <button class="btn" type="submit">Save contacts</button>
</form>`;
  return page(rc, 'Emergency contacts', body, { status });
}

// --- account --------------------------------------------------------------------------

export function accountPage(rc, session, { google = false, googleLinked = false, sessions = [], notice = '' }) {
  const body = `${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ''}
<h1>Account</h1>
<p class="lede">Signed in as <strong>${esc(session.email)}</strong>.</p>
${devicesSection(rc, sessions, session.idHash)}
${google ? `<section class="panel" aria-labelledby="so-h">
  <h2 id="so-h" style="margin-top:0">Sign-in options</h2>
  ${googleLinked
    ? '<p style="margin:0">Google is connected. You can sign in with Google or an email link.</p>'
    : `<p>Connect Google to sign in with one tap next time.</p>${googleButton(rc, { mode: 'link', label: 'Connect Google' })}`}
</section>` : ''}
<form method="post" action="${esc(rc.url('/auth/signout'))}">
  <button class="btn secondary" type="submit">Sign out</button>
</form>`;
  return page(rc, 'Account', body, { current: '/account' });
}

// --- guardians ----------------------------------------------------------------------

export function guardiansPage(rc, session, { household, guardians, invites, values = {}, errors = [], notice = '', status = 200 }) {
  const isOwner = household.role === 'owner';
  const people = guardians
    .map((g) => {
      const me = Number(g.account_id) === session.accountId;
      const name = `${esc(g.display_name || g.email)}${g.relationship ? ` (${esc(g.relationship)})` : ''}`;
      const remove = isOwner && !me && g.role !== 'owner'
        ? `<form method="post" action="${esc(rc.url('/guardians/remove'))}">
    <input type="hidden" name="account_id" value="${esc(g.account_id)}">
    <button class="btn secondary" type="submit">Remove</button></form>`
        : '';
      return `<li class="item"><div><span class="item-title">${name}</span>
  <div class="item-sub">${esc(g.email)}${g.role === 'owner' ? ' · owner' : ' · guardian'}${me ? ' · you' : ''}</div></div>${remove}</li>`;
    })
    .join('');

  const pending = invites.length
    ? `<h3>Waiting to accept</h3><ul class="cards-list">${invites
        .map((i) => `<li class="item"><div><span class="item-title">${esc(i.invited_email_norm)}</span>
  <div class="item-sub">Invited ${esc(String(i.created_at).slice(0, 10))}</div></div>
  <form method="post" action="${esc(rc.url('/guardians/invite/cancel'))}">
    <input type="hidden" name="email" value="${esc(i.invited_email_norm)}">
    <button class="btn secondary" type="submit">Cancel invitation</button></form></li>`)
        .join('')}</ul>`
    : '';

  const invite = isOwner
    ? `<section class="panel" aria-labelledby="inv-h">
  <h2 id="inv-h" style="margin-top:0">Invite another guardian</h2>
  <p><strong>A guardian can see and change everything about your children</strong> — their details, medical
  information, emergency contacts and program sign-ups. Only invite someone you would trust with all of it.</p>
  ${errorSummary(errors)}
  <form method="post" action="${esc(rc.url('/guardians/invite'))}" novalidate>
    ${field({ id: 'invite_email', label: 'Their email address', type: 'email', value: values.email || '', required: true,
      autocomplete: 'off', inputmode: 'email', error: errorFor(errors, 'invite_email') })}
    <button class="btn" type="submit">Send invitation</button>
  </form>
  ${pending}
</section>`
    : `<section class="panel"><h2 style="margin-top:0">Leave this family</h2>
  <p>You will no longer see or change these children's details. The owner can invite you again.</p>
  <form method="post" action="${esc(rc.url('/guardians/leave'))}"><button class="btn secondary" type="submit">Leave this family</button></form>
</section>`;

  const body = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ''}
<h1>Guardians</h1>
<p class="lede">Everyone here can see and update your children's details.</p>
<section class="panel" aria-label="Guardians"><ul class="cards-list">${people}</ul></section>
${invite}`;
  return page(rc, 'Guardians', body, { status });
}

/**
 * An invitation's landing page. Inert like the sign-in landing page: the token
 * rides in the URL fragment and is only ever sent when the person presses the
 * button, so a mail scanner opening the link accepts nothing.
 */
export const INVITE_SCRIPT = `(function () {
  var form = document.getElementById('accept');
  var missing = document.getElementById('missing');
  var m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  if (!m) { form.hidden = true; missing.hidden = false; return; }
  form.elements.t.value = m[1];
  if (window.history && history.replaceState) history.replaceState(null, '', location.pathname);
})();`;

export function inviteLandingBody(rc) {
  return `<h1>You've been invited</h1>
<form id="accept" method="post" action="${esc(rc.url('/invite/accept'))}">
  <input type="hidden" name="t" value="">
  <p class="lede">You've been invited to join a family on the Tennessee Saints parent portal.</p>
  <p><strong>As a guardian you'll see and be able to change everything about the family's children</strong>:
  their details, medical information, emergency contacts and program sign-ups.</p>
  <button class="btn" type="submit">Accept the invitation</button>
</form>
<div id="missing" hidden>
  <p class="lede">This invitation link is incomplete. Links sometimes get cut off when copied; open it again from the email.</p>
</div>
<noscript><div class="notice">This page needs JavaScript turned on. Turn it on and reload.</div></noscript>
<script>${INVITE_SCRIPT}</script>`;
}

export function inviteMessagePage(rc, { title, text, status = 400, action = '' }) {
  const body = `<h1>${esc(title)}</h1><p class="lede">${esc(text)}</p>${action}
<p><a class="btn" href="${esc(rc.url('/'))}">Go to the parent portal</a></p>`;
  return portalResponse(portalPage({ rc, title, body }), { status });
}

// --- devices ------------------------------------------------------------------------

export function devicesSection(rc, sessions, currentIdHash) {
  const rows = sessions
    .map((s) => `<li class="item"><div><span class="item-title">${esc(s.device_label || 'Unknown device')}</span>
  <div class="item-sub">${s.id_hash === currentIdHash ? 'This device · ' : ''}signed in ${esc(String(s.created_at).slice(0, 10))}
  · last used ${esc(String(s.last_seen_at).slice(0, 10))}</div></div></li>`)
    .join('');
  const others = sessions.filter((s) => s.id_hash !== currentIdHash).length;
  return `<section class="panel" aria-labelledby="dev-h">
  <h2 id="dev-h" style="margin-top:0">Where you're signed in</h2>
  <ul class="cards-list">${rows}</ul>
  ${others ? `<form method="post" action="${esc(rc.url('/account/signout-others'))}">
    <button class="btn secondary" type="submit">Sign out everywhere else</button></form>` : ''}
</section>`;
}
