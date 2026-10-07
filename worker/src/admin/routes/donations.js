/**
 * Donations (donations:manage for admins; the board TREASURER may read).
 * Receipts are issued only after the IRS determination letter — see
 * donations/donations.js. Audit rows carry ids and counts, never amounts or
 * donors' names.
 */

import { can, audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { page, htmlResponse } from '../ui.js';
import { donationsBody, donationBody, summaryBody, DONATION_STYLES } from '../donations-ui.js';
import {
  donationsEnabled, donationSettings, saveDonationSettings, validateDonation, recordDonation, listDonations, getDonation,
  receiptText, issueReceipt, voidDonation, annualSummary,
} from '../../donations/donations.js';
import { memberFor } from '../../governance/board.js';
import { NAV, denyHtml, seeOther, notFoundPage } from '../nav.js';

const denyRead = denyHtml('Donations', 'Donations are for academy admins and the board treasurer.');
const denyManage = denyHtml('Donations', 'Only academy admins change donation records.');

async function mayRead(rc) {
  if (can(rc.principal, 'donations:manage')) return true;
  return (await memberFor(rc.env, rc.principal.email))?.office === 'treasurer';
}

function donationPage(rc, title, body, status = 200) {
  return htmlResponse(page({ title, principal: rc.principal, nav: NAV, current: '/donations', body, extraStyles: DONATION_STYLES }), { status });
}

const thisYear = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date()));

async function listPage(rc, extra = {}, status = 200) {
  const wanted = Number(rc.url.searchParams.get('year'));
  const year = Number.isInteger(wanted) && wanted >= 2020 && wanted <= 2100 ? wanted : thisYear();
  const [rows, settings] = await Promise.all([listDonations(rc.env, year), donationSettings(rc.env)]);
  return donationPage(rc, 'Donations', donationsBody({ year, rows, enabled: donationsEnabled(rc.env), settings,
    canManage: can(rc.principal, 'donations:manage'), base: rc.base, message: rc.url.searchParams.get('msg'), ...extra }), status);
}

async function formOf(request) {
  try { return await readForm(request); } catch { return null; }
}

export const routes = [
  {
    method: 'GET', path: '/donations', cap: 'board:view', deny: denyRead,
    handler: async (rc) => ((await mayRead(rc)) ? listPage(rc) : denyRead(rc)),
  },
  {
    method: 'POST', path: '/donations', cap: 'donations:manage', deny: denyManage,
    handler: async (rc) => {
      const form = await formOf(rc.request);
      if (!form) return seeOther(rc.base, '/donations?msg=invalid');
      const { value, errors } = validateDonation(form);
      if (Object.keys(errors).length) return listPage(rc, { values: value, errors }, 400);
      const id = await recordDonation(rc.env, value, rc.principal.email);
      rc.ctx.waitUntil(audit(rc.env, { actor: rc.principal.email, action: 'donation.record', subjectType: 'donation', subjectId: id }));
      return seeOther(rc.base, `/donations/${id}?msg=recorded`);
    },
  },
  {
    method: 'POST', path: '/donations/settings', cap: 'donations:manage', deny: denyManage,
    handler: async (rc) => {
      const form = await formOf(rc.request);
      const result = form ? await saveDonationSettings(rc.env, form, rc.principal.email) : 'invalid';
      if (result === 'saved') rc.ctx.waitUntil(audit(rc.env, { actor: rc.principal.email, action: 'donation.settings' }));
      return seeOther(rc.base, `/donations?msg=${result}`);
    },
  },
  {
    method: 'GET', path: /^\/donations\/(\d{1,12})$/, cap: 'board:view', deny: denyRead,
    handler: async (rc, m) => {
      if (!(await mayRead(rc))) return denyRead(rc);
      const [d, settings] = await Promise.all([getDonation(rc.env, Number(m[1])), donationSettings(rc.env)]);
      if (!d) return notFoundPage(rc.principal, 'No such donation');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const preview = !d.receipt_issued_at && settings.complete ? receiptText(d, settings, { number: '(to be numbered)', issuedOn: today }) : '';
      return donationPage(rc, d.donor_name, donationBody({ d, preview, canManage: can(rc.principal, 'donations:manage'), base: rc.base,
        message: rc.url.searchParams.get('msg'), receiptsReady: donationsEnabled(rc.env) && settings.complete }));
    },
  },
  {
    method: 'POST', path: /^\/donations\/(\d{1,12})\/(receipt|void)$/, cap: 'donations:manage', deny: denyManage,
    handler: async (rc, m) => {
      const id = Number(m[1]);
      if (m[2] === 'receipt') {
        const { result } = await issueReceipt(rc.env, id, rc.principal.email);
        if (result === 'issued') rc.ctx.waitUntil(audit(rc.env, { actor: rc.principal.email, action: 'donation.receipt', subjectType: 'donation', subjectId: id }));
        return seeOther(rc.base, `/donations/${id}?msg=${result}`);
      }
      const form = await formOf(rc.request);
      const done = form ? await voidDonation(rc.env, id, form.get('reason'), rc.principal.email) : false;
      if (done) rc.ctx.waitUntil(audit(rc.env, { actor: rc.principal.email, action: 'donation.void', subjectType: 'donation', subjectId: id }));
      return seeOther(rc.base, `/donations/${id}?msg=${done ? 'voided' : 'invalid'}`);
    },
  },
  {
    method: 'GET', path: '/donations/summary', cap: 'board:view', deny: denyRead,
    handler: async (rc) => {
      if (!(await mayRead(rc))) return denyRead(rc);
      const year = Number(rc.url.searchParams.get('year')) || thisYear();
      const donorName = String(rc.url.searchParams.get('donor') || '').slice(0, 120);
      const summary = await annualSummary(rc.env, { year, donorName });
      return donationPage(rc, `${year} giving`, summaryBody({ year, donorName, summary, base: rc.base }));
    },
  },
];
