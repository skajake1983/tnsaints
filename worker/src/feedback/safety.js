/**
 * Content safety checks for a message body a HUMAN has edited.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM compose.js
 *
 * compose.js is forbidden from being able to read eval_notes_internal — that is
 * asserted by a committed test against its source, and it is what makes the
 * two-table split a structural guarantee rather than a convention. These checks
 * genuinely need to read internal notes in order to detect them, so they live
 * here instead. Nothing in compose.js imports this module.
 *
 * WHAT THESE GUARD AGAINST
 *
 * Adding an edit box closed one hole and opened two. The composer can only
 * assemble parent-facing fields, so before editing existed, an internal note
 * physically could not reach a message. Now a person types free text into the
 * body, and the same person is looking at a page that displays every coach's
 * staff-only notes.
 *
 *   1. INTERNAL CONTENT. The workflow actively invites it: the blocked-player
 *      links on /decisions lead to /eval/:id, which renders other coaches'
 *      internal notes verbatim under "Staff-only notes". Copying a coach's
 *      blunter phrasing because it says the thing well is a natural act, and
 *      nothing was checking.
 *
 *   2. ANOTHER CHILD'S MESSAGE. Fifty drafts render as fifty textareas on one
 *      page, so copy-paste between them is the obvious way to reuse a paragraph
 *      that reads well. Paste Marcus's message into Ava's box, change the
 *      greeting, and every existing check passes: the decision still matches,
 *      the notes fingerprint is untouched, the child's name appears. Ava's
 *      family receives Marcus's evaluation.
 *
 * Both are checked on edit, again at approve, and again at the drain — the same
 * belt-and-braces as the staleness checks, because edit is not the last writer
 * and approve can be days before the send.
 */

/** Normalise for comparison: collapse whitespace, drop case and punctuation. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Length of the shingle used to detect a copied passage.
 *
 * Long enough that ordinary shared phrasing does not trip it — "he needs to
 * work on his left hand" is 30 characters and could legitimately appear in both
 * an internal note and a parent message, because a coach often says the same
 * thing twice. Short enough that a genuinely copied sentence cannot slip under
 * it.
 */
const SHINGLE = 45;

/**
 * Does `body` contain a substantial verbatim run from any of `sources`?
 *
 * Compared on the normalised forms, so retyping with different punctuation or
 * capitalisation does not evade it. Returns the offending source text so the
 * refusal can quote it back — an error that says only "this looks like an
 * internal note" sends someone hunting through five coaches' notes.
 */
function containsPassageFrom(body, sources) {
  const haystack = normalise(body);
  if (!haystack) return null;

  for (const source of sources) {
    const needle = normalise(source);
    if (needle.length < SHINGLE) continue;

    for (let i = 0; i + SHINGLE <= needle.length; i += 1) {
      if (haystack.includes(needle.slice(i, i + SHINGLE))) {
        return source;
      }
    }
  }

  return null;
}

/**
 * Load everything the checks need, ONCE.
 *
 * checkEditedBody runs two queries per call, which is fine for one message and
 * ruinous for fifty: a bulk edit was issuing 3N+1 D1 calls, and D1 calls count
 * against the Workers per-request subrequest cap (50 on the free plan). The
 * operation would have died partway through writing, leaving some messages
 * changed and some not — while its own documentation promised the opposite.
 */
export async function loadSafetySources(env) {
  const [internal, players] = await Promise.all([
    env.DB.prepare(
      `SELECT n.registration_id, n.body
         FROM eval_notes_internal n
         JOIN registrations r ON r.id = n.registration_id
        WHERE r.event_id = ?1`
    )
      .bind(env.EVENT_ID)
      .all(),
    env.DB.prepare(
      `SELECT id, player_name FROM registrations
        WHERE event_id = ?1 AND status = 'confirmed'`
    )
      .bind(env.EVENT_ID)
      .all(),
  ]);

  const internalByRegistration = new Map();
  for (const row of internal.results || []) {
    const key = Number(row.registration_id);
    if (!internalByRegistration.has(key)) internalByRegistration.set(key, []);
    internalByRegistration.get(key).push(row.body);
  }

  return {
    internalByRegistration,
    allInternal: (internal.results || []).map((r) => r.body),
    players: (players.results || []).map((r) => ({ id: Number(r.id), name: r.player_name })),
  };
}

/**
 * Does a string being inserted into MANY messages carry staff-only content?
 *
 * The per-recipient check is the wrong shape for a bulk edit. It compares each
 * message against ITS OWN child's notes, so a paragraph lifted from one child's
 * internal note — the compassionate closing line an admin just read on the
 * evaluation page — passes for all the OTHER children, because it is not their
 * note. One comparison against every internal note in the event closes that,
 * and a bulk insertion is by definition not about one child.
 */
export function checkBulkInsertion(sources, replacementText) {
  const leaked = containsPassageFrom(replacementText, sources.allInternal);
  if (leaked) {
    return {
      ok: false,
      error:
        'That replacement contains text from a staff-only note, which families must never see. ' +
        `The matching note begins: "${String(leaked).slice(0, 60)}…"`,
    };
  }
  return { ok: true };
}

/**
 * Full safety check for one edited message body.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function checkEditedBody(env, { registrationId, bodyText, playerName }) {
  const sources = await loadSafetySources(env);
  return checkAgainstSources(sources, { registrationId, bodyText, playerName });
}

/** The same checks, against sources already in memory. */
export function checkAgainstSources(sources, { registrationId, bodyText, playerName }) {
  // --- 1. Staff-only notes must not appear ---------------------------------
  const leaked = containsPassageFrom(
    bodyText,
    sources.internalByRegistration.get(Number(registrationId)) || []
  );

  if (leaked) {
    return {
      ok: false,
      error:
        'This message contains text from a staff-only note, which families must never see. ' +
        `The matching note begins: "${String(leaked).slice(0, 60)}…"`,
    };
  }

  // --- 2. No other child may be named --------------------------------------
  //
  // Only names that are unambiguous. If two children in the event share a first
  // name, that name cannot distinguish them, and refusing on it would block a
  // legitimate message to one of them. Full names are always checked.
  const otherNames = sources.players
    .filter((pl) => pl.id !== Number(registrationId))
    .map((pl) => pl.name);
  const mineFirst = normalise(String(playerName || '').split(/\s+/)[0]);

  const firstCounts = new Map();
  for (const name of otherNames) {
    const first = normalise(String(name).split(/\s+/)[0]);
    firstCounts.set(first, (firstCounts.get(first) || 0) + 1);
  }

  const haystack = ` ${normalise(bodyText)} `;

  for (const name of otherNames) {
    // Full name: unambiguous, so matched case-insensitively.
    const full = normalise(name);
    if (full && haystack.includes(` ${full} `)) {
      return {
        ok: false,
        error: `This message names another player (${name}). Check you have not pasted the wrong child's message.`,
      };
    }

    const firstRaw = String(name).trim().split(/\s+/)[0] || '';
    const first = normalise(firstRaw);

    // A first name shared with the recipient, or with another player in the
    // event, identifies nobody — checking it could only produce false refusals.
    if (!first || first === mineFirst || firstCounts.get(first) > 1) continue;

    if (usedAsAName(bodyText, firstRaw)) {
      return {
        ok: false,
        error: `This message names another player (${name}). Check you have not pasted the wrong child's message.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Is `first` being used as somebody's NAME in this text, rather than as an
 * ordinary word that happens to be spelled the same?
 *
 * Children are called Will, Grace, Chase, Hope, Mark, Drew and Faith. A blunt
 * case-insensitive search refused "he played with real grace under pressure"
 * because another child in the event was called Grace — a correct message
 * blocked, on the evening fifty of them are being reviewed, which reads as the
 * system being broken and invites someone to work around it.
 *
 * Two signals separate a name from a word:
 *
 *   1. CAPITALISATION. Matching is case-sensitive: "Grace" is a name, "grace"
 *      is a quality. This alone resolves nearly every case, because the
 *      composed message capitalises the child's name and prose does not
 *      capitalise the common noun.
 *
 *   2. REPETITION or POSITION. The one thing capitalisation cannot distinguish
 *      is a sentence opening — "Will improve his left hand" starts with a
 *      capital W and means nothing about a child called Will. But a message
 *      genuinely about another child names them repeatedly (the template uses
 *      the first name four to six times), so a single sentence-initial
 *      occurrence is treated as a word and anything else as a name.
 */
function usedAsAName(bodyText, first) {
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // No `i` flag: capitalisation is the signal.
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const text = String(bodyText || '');

  const hits = [...text.matchAll(re)];
  if (hits.length === 0) return false;
  if (hits.length > 1) return true;

  const before = text.slice(0, hits[0].index).replace(/\s+$/, '');
  const sentenceInitial = before === '' || /[.!?:]$/.test(before);
  return !sentenceInitial;
}
