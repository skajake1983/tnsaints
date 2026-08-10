/**
 * Composing the message a family actually receives.
 *
 * This file imports exactly ONE data accessor — parentFacingFeedback() — and
 * that constraint is the feature, not an implementation detail. There is no
 * import here that can reach eval_notes_internal, no parameter that widens the
 * query, and no join that would pull one in. A committed test reads this file's
 * source and fails if that ever changes.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO LLM IN HERE
 * ---------------------------------------------------------------------------
 * Merging four coaches' notes into one warm paragraph is the obvious job for a
 * language model, and it is the wrong call here specifically.
 *
 * The entire value of this message is that a family can tell a human watched
 * their child. One hallucinated specific — "great left hand" for a kid who has
 * none — destroys exactly that, under the academy's name, against a promise
 * made personally, to a parent who will read it three times. The downside is
 * not a bad sentence; it is the parent concluding the whole thing was
 * automated, which is worse than sending nothing.
 *
 * So composeDraft() concatenates and dedupes deterministically into a STARTING
 * DRAFT. A human edits it into one voice, and the edit is what gets snapshotted
 * and sent. The machine does the assembling; the person does the writing.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH MESSAGES SHARE A SUBJECT LINE
 * ---------------------------------------------------------------------------
 * "Feedback on Marcus from Saturday's evaluation" — identical for accept and
 * not_yet. Families compare notes in the parking lot and in group chats. A
 * subject line that reveals the verdict turns fifty individual messages into a
 * public tier list, and a child learns they were not selected from someone
 * else's phone.
 */

import { parentFacingFeedback } from './notes.js';

const MAX_LINE = 600;

/** Collapse whitespace and trim to something safe to concatenate. */
function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Dedupe near-identical lines from different coaches.
 *
 * Two coaches writing "good motor" and "Good motor." is the common case, and
 * showing both makes the message read like a form. Compared on a normalised
 * key, but the ORIGINAL text is kept — the first coach's phrasing survives.
 */
function dedupe(lines) {
  const seen = new Set();
  const out = [];

  for (const line of lines) {
    const text = clean(line);
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text.slice(0, MAX_LINE));
  }

  return out;
}

/** Mean of the ratings that were actually given, or null if none were. */
function averageRatings(rows) {
  const keys = ['rating_skill', 'rating_effort', 'rating_coachability', 'rating_decisions'];
  const out = {};

  for (const key of keys) {
    const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number');
    out[key] = values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
      : null;
  }

  return out;
}

/**
 * Build the editable starting draft for one player.
 *
 * Returns the raw material — strengths, growth areas, the coaches who watched —
 * assembled but not polished. The admin rewrites it into one voice before it is
 * approved, because parents should hear the academy, not a committee.
 *
 * Three attributed blocks would read as a panel verdict and invite "can I talk
 * to Coach Turner about why he said X". Attribution stays admin-visible, which
 * is where it is actually useful.
 */
export async function composeDraft(env, registrationId, decision) {
  const rows = await parentFacingFeedback(env, registrationId);

  const strengths = dedupe(rows.map((r) => r.strengths));
  const growth = dedupe(rows.map((r) => r.growth_area));
  const extra = dedupe(rows.map((r) => r.parent_note));
  const coaches = [...new Set(rows.map((r) => r.author_label).filter(Boolean))];

  return {
    decision,
    coaches,
    strengths,
    growth,
    extra,
    ratings: averageRatings(rows),
    coachCount: rows.length,
  };
}

/**
 * The subject line. Identical for both outcomes — see the header.
 */
export function subjectFor(playerFirstName, env) {
  const label = String(env.EVENT_SHORT_LABEL || "Saturday's evaluation");
  return `Feedback on ${playerFirstName} from ${label}`;
}

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'your player';
}

/**
 * Join several coaches' observations into one readable run of sentences.
 *
 * Ends each fragment with a full stop so concatenation does not produce
 * "kept his head up in transition Left hand needs work" — coaches type
 * fragments, not sentences, and the draft has to survive that.
 */
function joinObservations(lines) {
  return lines
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .join(' ')
    .trim();
}

/**
 * Default body text for a draft, which the admin then edits.
 *
 * The "not yet" shape, in order, and each part is load-bearing:
 *
 *   1. Something specific the player actually did. This is the whole ballgame.
 *      A family that reads one true, particular sentence about their child
 *      knows a person watched them, and everything after it is heard
 *      differently.
 *   2. The honest thing, framed as the next step rather than a verdict.
 *   3. A concrete open door — a date, a named track — not "we'll be in touch",
 *      which reads as a polite ending.
 *   4. A real human name and a working reply-to.
 *
 * The words "not selected", "rejected", and "unsuccessful" never appear. Not
 * as euphemism — the message is clear that they are not in the program right
 * now — but because those words describe the child rather than the moment.
 */
export function defaultBodyText(draft, playerName, env) {
  const name = firstName(playerName);
  const contact = env.NOTIFY_EMAIL_TO || 'info@tnsaints.com';
  const who = draft.coaches.length ? draft.coaches.join(', ') : 'Your evaluation team';

  // Every coach's observation, not just the first.
  //
  // This used to take strengths[0] and drop the rest, which threw away a second
  // coach's distinct observation BEFORE any human saw it. Wrong direction: the
  // draft exists to be trimmed, and a person cutting a redundant sentence is a
  // two-second edit, while material silently discarded upstream is gone. Note
  // dedupe() has already collapsed the "good motor" / "Good motor." case.
  const strength = joinObservations(draft.strengths);
  const growth = joinObservations(draft.growth);

  // NO FALLBACK SENTENCES.
  //
  // These slots used to degrade to "Our coaches enjoyed working with {name}."
  // and "There are a few areas we would want to build on next." when nothing
  // was written. That was the most dangerous line in the file: it made an
  // absence look like content, so neither the gate nor a human skimming the
  // preview could see that nobody had written a word about this child.
  //
  // A missing observation now renders as a conspicuous placeholder. The gate
  // blocks it from sending anyway, but the draft has to LOOK broken to the
  // person reading it, not merely be rejected by a machine.
  const MISSING = '[NO COACH WROTE THIS YET — this message cannot be sent]';

  if (draft.decision === 'accept') {
    return [
      `Thank you for bringing ${name} out on Saturday. We loved having them in the gym.`,
      '',
      strength ? `What stood out to us: ${strength}` : MISSING,
      '',
      growth ? `What we want to build on next: ${growth}` : MISSING,
      '',
      draft.extra.length ? draft.extra.join(' ') : '',
      '',
      `We would like to invite ${name} to join the Tennessee Saints Academy. We will follow`,
      `up with details on enrolling and getting started.`,
      '',
      `If you have any questions at all, just reply to this email.`,
      '',
      `— ${who}`,
      `Tennessee Saints Basketball Academy · ${contact}`,
    ]
      .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
      .join('\n');
  }

  return [
    `Thank you for bringing ${name} out on Saturday. We are glad we got to watch them play.`,
    '',
    strength ? `Something our coaches noticed: ${strength}` : MISSING,
    '',
    growth
      ? `The area we would want to build on next: ${growth} That is very normal at this age, ` +
        `and it is the kind of thing that changes quickly with reps.`
      : MISSING,
    '',
    draft.extra.length ? draft.extra.join(' ') : '',
    '',
    `We are not able to offer ${name} a spot in the academy this season. We keep the roster`,
    `small so every player gets real coaching time, which means turning away players we`,
    `genuinely enjoyed watching — and ${name} is one of them.`,
    '',
    `We would like to see them again. We run evaluations regularly and would welcome`,
    `${name} back at the next one, and we are happy to point you toward what to work on`,
    `between now and then if that would help.`,
    '',
    `If you would like to talk it through, just reply to this email — a real person reads it.`,
    '',
    `— ${who}`,
    `Tennessee Saints Basketball Academy · ${contact}`,
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
}

/** Minimal HTML rendering of the edited text. */
export function textToHtml(text) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    font-size:16px;line-height:1.6;color:#10151c;max-width:600px">${paragraphs}</div>`;
}

/**
 * Did a human actually write anything about this child?
 *
 * Both a strength and a growth area are required, for every decision. That is
 * the owner's rule, and it matches what the evaluation form asks for and what
 * the message has slots for.
 *
 * This is the ONLY honest readiness test, and it has to look at the draft
 * rather than the rendered message — see gateMessage() below for why.
 */
export function draftHasProse(draft) {
  return Boolean(draft && draft.strengths.length > 0 && draft.growth.length > 0);
}

/**
 * Quality gate for one message, run at build AND again at approve.
 *
 * THIS IS WHERE QUALITY IS ENFORCED, deliberately not at capture time. A coach
 * with thirty seconds between drills should be able to save four ratings and
 * nothing else; what must never happen is that incompleteness reaching a
 * family. Capture is permissive precisely because this is strict — so if this
 * is wrong, the permissiveness upstream becomes a liability rather than a
 * kindness.
 *
 * IT WAS WRONG. The original version took only the rendered `bodyText` and
 * refused a "not yet" under 400 characters, on the theory that a rushed
 * form-letter no would be short. Measured by executing the module: the
 * template's own fixed scaffolding is 869 characters with EMPTY inputs, and the
 * shortest body it can emit for any name is 844. The floor could never fire.
 * Worse, `accept` had no floor at all, and the name check passed
 * unconditionally because the template always interpolates the name.
 *
 * The lesson is general enough to state: LENGTH IS A PROXY FOR EFFORT, AND THE
 * TEMPLATE SATISFIES THE PROXY WITHOUT THE EFFORT. A gate that inspects its own
 * output measures the generator, not the human. So it now takes the DRAFT — the
 * coach-authored source — and asks whether anyone wrote anything.
 */
export function gateMessage({ decision, draft, bodyText, parentEmail, playerName }) {
  const problems = [];

  if (decision !== 'accept' && decision !== 'not_yet') {
    problems.push('No decision has been made yet.');
  }

  if (!parentEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parentEmail)) {
    problems.push('The parent email address is missing or invalid.');
  }

  const body = clean(bodyText);
  if (!body) {
    problems.push('The message body is empty.');
  }

  // The load-bearing check. Applied to accept and not_yet alike: the promise of
  // written feedback was made to every family, not only the ones turned away.
  if (draft && !draftHasProse(draft)) {
    const missing = [];
    if (!draft.strengths.length) missing.push('a strength');
    if (!draft.growth.length) missing.push('a growth area');
    problems.push(
      `No coach has written ${missing.join(' or ')} for this player. ` +
        'Nothing can be sent about a child nobody wrote about.'
    );
  }

  if (playerName && body && !mentionsPlayer(body, playerName)) {
    problems.push('The message never uses the player’s name.');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Does the body genuinely name the child?
 *
 * Word-anchored, and with the signature block removed first. A plain substring
 * test matched names hiding inside the sign-off — "Cade" is inside "Academy",
 * "Al" inside "Basketball", "Ten" inside "Tennessee" — so the check passed for
 * a message that never mentioned the child at all. It only starts to matter now
 * that bodies are editable, which is exactly when it would have been trusted.
 */
function mentionsPlayer(body, playerName) {
  const name = firstName(playerName);
  if (!name) return true;

  const withoutSignature = body.split('Tennessee Saints Basketball Academy')[0] || '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(withoutSignature);
}
