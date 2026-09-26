/**
 * Applying a child to a program (the academy first).
 *
 * GET  /children/:id/apply/:program   the application: program, groups, waiver
 * POST /children/:id/apply/:program   signed waiver + application, together
 *
 * Nothing here takes money. Applying puts the child in line; staff offer a
 * seat in a specific group when one is free; paying is only possible against
 * that offer (P1.9). So a family can never pay for a place that has no
 * schedule — the rule the owner set.
 */

import { esc, portalPage, portalResponse, errorSummary, field, selectField, radioGroup, notFoundResponse } from './ui.js';
import { redirect } from './auth-pages.js';
import { RELATIONSHIPS } from './forms.js';
import { getChild } from './data.js';
import {
  getProgram, listGroups, currentWaiver, programOpen, applicationBlockers, liveEnrollment, apply, priceLine,
} from '../programs/enrollment.js';
import { hashIp, clientIp } from '../http.js';
import { audit } from '../auth/staff.js';
import { currentGrade, gradeLabel } from '../lib/grades.js';

const NAV = [{ href: '/', label: 'Family' }, { href: '/account', label: 'Account' }];
const errorFor = (errors, id) => errors.find((e) => e.id === id)?.message || '';
function page(rc, title, body, status = 200) {
  return portalResponse(portalPage({ rc, title, body, nav: NAV, current: '/', signedIn: true }), { status });
}

function groupChoices(groups, chosen) {
  if (!groups.length) return '<p>Groups for this season are being scheduled. Apply now and we will be in touch.</p>';
  return `<fieldset class="field"><legend>Which groups would work for your family? <span class="opt">(optional)</span></legend>
  <span class="hint">Choose every group you could make. We place children by grade and space.</span>
  ${groups
    .filter((g) => g.status === 'active')
    .map((g) => {
      const full = Number(g.taken) >= Number(g.capacity);
      return `<label class="choice"><input type="checkbox" name="groups" value="${esc(g.id)}"${chosen.includes(String(g.id)) ? ' checked' : ''}>
  <span><strong>${esc(g.name)}</strong> — ${esc(g.schedule_summary)}${g.location ? `, ${esc(g.location)}` : ''}${
    g.starts_on ? `, starting ${esc(g.starts_on)}` : ''}${full ? ' <span class="badge warn">Full right now — waiting list</span>' : ''}</span></label>`;
    })
    .join('')}
</fieldset>`;
}

export function applyPage(rc, { child, program, groups, waiver, blockers = [], existing = null, values = {}, errors = [], status = 200 }) {
  const grade = currentGrade(child.grade_level, child.grade_school_year);
  const head = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>Apply: ${esc(program.name)}</h1>
<p class="lede">For ${esc(child.display_name)}${grade !== null ? `, ${esc(gradeLabel(grade))}` : ''}. ${esc(priceLine(program))}</p>`;

  if (existing) {
    return page(rc, program.name, `${head}<div class="notice" role="status">${esc(child.display_name)} already has an
application in progress. You can see where it stands on your family page.</div>`, status);
  }
  if (blockers.length) {
    return page(rc, program.name, `${head}<section class="panel"><h2 style="margin-top:0">Before you apply</h2>
<p>We need a few details first:</p><ul>${blockers
      .map((b) => `<li>${b.href ? `<a href="${esc(rc.url(b.href))}">${esc(b.message)}</a>` : esc(b.message)}</li>`)
      .join('')}</ul></section>`, status);
  }

  const chosen = (values.groups || []).map(String);
  const body = `${head}
${errorSummary(errors)}
<form method="post" action="${esc(rc.url(`/children/${child.id}/apply/${program.id}`))}" novalidate>
  <input type="hidden" name="waiver_version" value="${esc(waiver.id)}">
  <section class="panel">${groupChoices(groups, chosen)}</section>
  <section class="panel" aria-labelledby="w-h">
    <h2 id="w-h" style="margin-top:0">${esc(waiver.title)}</h2>
    <p class="hint">Between you and ${esc(waiver.legal_entity)}. Please read it before signing.</p>
    <div class="waiver" role="region" aria-label="${esc(waiver.title)}" tabindex="0">${esc(waiver.body_text).replace(/\n/g, '<br>')}</div>
    <fieldset class="field${errorFor(errors, 'agree_risk') || errorFor(errors, 'agree_medical') || errorFor(errors, 'agree_esign') ? ' has-error' : ''}">
      <legend>Agreements <span class="req">(required)</span></legend>
      ${['agree_risk', 'agree_medical', 'agree_esign'].map((k) => errorFor(errors, k) ? `<span class="error">${esc(errorFor(errors, k))}</span>` : '').join('')}
      <label class="choice"><input type="checkbox" name="agree_risk" id="agree_risk"${values.agree_risk ? ' checked' : ''}>
        I understand basketball involves risk of injury, and I accept that risk for my child.</label>
      <label class="choice"><input type="checkbox" name="agree_medical" id="agree_medical"${values.agree_medical ? ' checked' : ''}>
        I authorise emergency medical care for my child if I cannot be reached.</label>
      <label class="choice"><input type="checkbox" name="agree_esign" id="agree_esign"${values.agree_esign ? ' checked' : ''}>
        I agree that typing my name below is my signature on this waiver.</label>
    </fieldset>
    ${radioGroup({ id: 'photo_release', legend: 'May we use photos and video of your child on our website and social media?',
      value: values.photo_release || '', required: true, error: errorFor(errors, 'photo_release'),
      hint: 'Either answer is fine, and you can change it later.',
      options: [['yes', 'Yes'], ['no', 'No']] })}
    ${field({ id: 'signature', label: 'Type your full name to sign', value: values.signature || '', required: true,
      autocomplete: 'name', error: errorFor(errors, 'signature') })}
    ${selectField({ id: 'relationship', label: 'Your relationship to the child', value: values.relationship || '',
      options: RELATIONSHIPS.map((r) => [r, r]), required: true, error: errorFor(errors, 'relationship') })}
  </section>
  <button class="btn" type="submit">Sign and apply</button>
</form>`;
  return page(rc, program.name, body, status);
}

export function validateApplication(form, groups) {
  const errors = [];
  const values = {
    agree_risk: form.get('agree_risk') === 'on',
    agree_medical: form.get('agree_medical') === 'on',
    agree_esign: form.get('agree_esign') === 'on',
    photo_release: String(form.get('photo_release') || ''),
    signature: String(form.get('signature') || '').trim().replace(/\s+/g, ' ').slice(0, 81),
    relationship: String(form.get('relationship') || ''),
    groups: form.getAll('groups').map(String),
  };
  if (!values.agree_risk) errors.push({ id: 'agree_risk', message: 'Tick to accept the risk of injury' });
  if (!values.agree_medical) errors.push({ id: 'agree_medical', message: 'Tick to authorise emergency medical care' });
  if (!values.agree_esign) errors.push({ id: 'agree_esign', message: 'Tick to agree that your typed name is your signature' });
  if (!['yes', 'no'].includes(values.photo_release)) errors.push({ id: 'photo_release', message: 'Choose yes or no for photos' });
  if (!values.signature) errors.push({ id: 'signature', message: 'Type your full name to sign' });
  else if (values.signature.length > 80) errors.push({ id: 'signature', message: 'Your name must be 80 characters or fewer' });
  if (!RELATIONSHIPS.includes(values.relationship)) errors.push({ id: 'relationship', message: 'Choose your relationship to the child' });
  const valid = new Set(groups.filter((g) => g.status === 'active').map((g) => String(g.id)));
  values.groups = [...new Set(values.groups.filter((g) => valid.has(g)))];
  return { values, errors };
}

/**
 * @returns {Promise<Response|null>} null if the path is not an application route
 */
export async function applyRoutes({ env, ctx, request, rc, session, pathname, method, readForm }) {
  const m = /^\/children\/(\d{1,12})\/apply\/([a-z0-9-]{1,40})$/.exec(pathname);
  if (!m) return null;
  const child = await getChild(env, session.accountId, Number(m[1]));
  const program = await getProgram(env, m[2]);
  if (!child || !program) return notFoundResponse(rc);

  if (!programOpen(program)) {
    return page(rc, program.name, `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>${esc(program.name)}</h1><p class="lede">Applications aren't open right now. We'll email families when they open.</p>`);
  }
  const waiver = await currentWaiver(env, program);
  if (!waiver) {
    return page(rc, program.name, `<h1>${esc(program.name)}</h1>
<p class="lede">Applications are paused for a moment. Please try again later, or email info@tnsaints.com.</p>`, 503);
  }
  const [groups, existing, blockers] = await Promise.all([
    listGroups(env, program.id),
    liveEnrollment(env, session.accountId, child.id, program.id),
    applicationBlockers(env, session.accountId, child, program),
  ]);

  if (method === 'GET') return applyPage(rc, { child, program, groups, waiver, blockers, existing });
  if (method !== 'POST') return null;
  if (existing || blockers.length) return applyPage(rc, { child, program, groups, waiver, blockers, existing, status: 409 });

  return readForm(async (form) => {
    // The waiver on the page must be the waiver in force now; if it changed
    // while the page was open, show the new words rather than record a
    // signature against text the parent never saw.
    if (String(form.get('waiver_version') || '') !== waiver.id) {
      return applyPage(rc, { child, program, groups, waiver, status: 409,
        errors: [{ id: 'agree_risk', message: 'The waiver was updated while you were reading. Please read it again and sign.' }] });
    }
    const { values, errors } = validateApplication(form, groups);
    if (errors.length) return applyPage(rc, { child, program, groups, waiver, values, errors, status: 400 });

    const result = await apply(env, session.accountId, {
      playerId: child.id, program, waiver,
      signature: values.signature, relationship: values.relationship, photoRelease: values.photo_release === 'yes',
      preferredGroupIds: values.groups.map(Number),
      ipHash: await hashIp(clientIp(request), env.IP_HASH_SALT),
    });
    if (!result.ok && result.reason === 'duplicate') {
      return applyPage(rc, { child, program, groups, waiver, existing: true, status: 409 });
    }
    if (!result.ok) return notFoundResponse(rc);
    ctx.waitUntil(audit(env, {
      actor: `account:${session.accountId}`, action: 'portal.apply', subjectType: 'player', subjectId: child.id,
      detail: { program: program.id, waiver: waiver.id },
    }));
    return redirect(rc.url('/?notice=applied'));
  });
}
