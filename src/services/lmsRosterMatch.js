/**
 * Matches an LMS course roster against BiocBot accounts.
 *
 * Grade snapshots are stored against a BiocBot `localUserId`, so before any
 * grades can be imported the two systems have to agree on who is who. Only two
 * keys are trusted, in this order: Canvas's integration_id (the CWL PUID at
 * UBC), then the email address. Weaker keys — usernames, the part of an email
 * before the @, display names — are never used: each can pair a real student
 * with somebody else's account and file their grades there. Anyone who cannot
 * be matched is reported back so the instructor can fix it at the source
 * instead of guessing.
 */

const { normalizeEmail } = require('./authorization');

const SUPPORTED_PROVIDERS = Object.freeze(['canvas', 'moodle']);

function normalizeKey(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized || null;
}

/**
 * Matching rules, strongest evidence first. Each rule names the key to read
 * from the LMS roster entry and the key to read from the BiocBot account; a
 * rule only fires when both sides produce the same non-empty value and the
 * rule's `conflicts` check (if any) does not veto the pair.
 */
const MATCH_STRATEGIES = Object.freeze([
    {
        id: 'integration',
        label: 'integration id',
        // At UBC Canvas integration_id is the PUID supplied by CWL.
        lmsKey: (entry) => normalizeKey(entry.integrationId),
        localKeys: (user) => [normalizeKey(user.puid)]
    },
    {
        id: 'email',
        label: 'email address',
        lmsKey: (entry) => normalizeEmail(entry.email),
        localKeys: (user) => [normalizeEmail(user.email)],
        // Two different PUIDs are two different people, whatever the email
        // says, and an account whose PUID is on another roster row belongs to
        // that row. The email fallback is only for rows where a PUID is missing.
        conflicts: (entry, user, rosterPuids) => {
            const integrationId = normalizeKey(entry.integrationId);
            const puid = normalizeKey(user.puid);
            if (!puid) return false;
            return integrationId ? integrationId !== puid : rosterPuids.has(puid);
        }
    }
]);

function loadRosterToolkit() {
    try {
        return require('@ubc/ubc-genai-toolkit-lms-integration');
    } catch (error) {
        const wrapped = new Error('LMS roster matching requires @ubc/ubc-genai-toolkit-lms-integration 1.0.4 or newer');
        wrapped.code = 'LMS_TOOLKIT_MISSING';
        wrapped.cause = error;
        throw wrapped;
    }
}

function externalUserId(entry) {
    return String(entry.id ?? entry.externalUserId);
}

/**
 * The BiocBot accounts eligible to be matched: everyone whose active course is
 * this one, plus anyone carried on the course's enrollment overrides. This
 * mirrors the set the Student Hub lists, so the two views cannot disagree about
 * who exists.
 */
async function listLocalCandidates(db, course) {
    const enrollmentIds = Object.keys(course.studentEnrollment || {});
    const users = await db.collection('users').find({
        isActive: { $ne: false },
        isPreview: { $ne: true },
        $or: [
            { role: 'student', 'preferences.courseId': course.courseId },
            ...(enrollmentIds.length ? [{ userId: { $in: enrollmentIds } }] : [])
        ]
    }).project({
        _id: 0,
        userId: 1,
        username: 1,
        email: 1,
        displayName: 1,
        puid: 1
    }).toArray();

    return users.map((user) => ({
        localUserId: String(user.userId),
        username: user.username || '',
        email: user.email || '',
        puid: user.puid || '',
        displayName: user.displayName || user.username || String(user.userId)
    }));
}

/** Builds one lookup table per matching strategy over the BiocBot accounts. */
function indexLocalCandidates(localUsers) {
    const indexes = new Map(MATCH_STRATEGIES.map((strategy) => [strategy.id, new Map()]));
    const ambiguous = new Map(MATCH_STRATEGIES.map((strategy) => [strategy.id, new Set()]));

    for (const strategy of MATCH_STRATEGIES) {
        const index = indexes.get(strategy.id);
        for (const user of localUsers) {
            for (const key of strategy.localKeys(user)) {
                if (!key) continue;
                // A key held by two accounts proves nothing about either, so it
                // is dropped rather than attaching grades to whichever account
                // happened to be read first.
                if (index.has(key) && index.get(key).localUserId !== user.localUserId) {
                    ambiguous.get(strategy.id).add(key);
                }
                index.set(key, user);
            }
        }
    }

    for (const [strategyId, keys] of ambiguous) {
        for (const key of keys) indexes.get(strategyId).delete(key);
    }
    return indexes;
}

/**
 * Pairs roster rows with accounts one strategy at a time across the whole
 * roster, so a PUID match anywhere wins over an email match anywhere. Matching
 * row by row instead would let an earlier row take an account by email before
 * the row carrying that account's PUID was reached.
 *
 * The mapping collection holds one row per local user, so a later row that
 * reaches an already-claimed account is a data problem in the LMS (a duplicate
 * account) and is reported rather than silently overwriting the first.
 * @returns {Array<{ localUser: Object, matchedBy: string } | { duplicate: true } | null>}
 *   One result per roster entry, in roster order.
 */
function matchRosterEntries(entries, indexes) {
    const rosterPuids = new Set(entries.map((entry) => normalizeKey(entry.integrationId)).filter(Boolean));
    const results = entries.map(() => null);
    const claimedLocalUserIds = new Set();

    for (const strategy of MATCH_STRATEGIES) {
        entries.forEach((entry, index) => {
            if (results[index]) return;
            const key = strategy.lmsKey(entry);
            const localUser = key ? indexes.get(strategy.id).get(key) : null;
            if (!localUser) return;
            if (claimedLocalUserIds.has(localUser.localUserId)) {
                results[index] = { duplicate: true };
                return;
            }
            if (strategy.conflicts?.(entry, localUser, rosterPuids)) return;
            claimedLocalUserIds.add(localUser.localUserId);
            results[index] = { localUser, matchedBy: strategy.id };
        });
    }
    return results;
}

/**
 * Reconciles the LMS roster with BiocBot accounts and rewrites this course's
 * identity mappings to the result. Returns a report of who matched, how, and
 * who did not — the unmatched lists are the actionable part for an instructor.
 */
async function matchCourseRoster({ db, course, provider, roster, matchedBy }) {
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
        throw new Error(`Unsupported LMS provider: ${provider}`);
    }

    const externalCourseId = String(roster.externalCourseId);
    const localUsers = await listLocalCandidates(db, course);
    const indexes = indexLocalCandidates(localUsers);
    const now = new Date();

    const matched = [];
    const unmatchedLmsStudents = [];
    const claimedLocalUserIds = new Set();

    matchRosterEntries(roster.entries, indexes).forEach((match, index) => {
        const entry = roster.entries[index];
        if (!match?.localUser) {
            unmatchedLmsStudents.push({
                externalUserId: externalUserId(entry),
                name: entry.name,
                email: entry.email,
                reason: match?.duplicate ? 'duplicate-biocbot-account' : 'no-biocbot-account'
            });
            return;
        }
        claimedLocalUserIds.add(match.localUser.localUserId);
        matched.push({ entry, ...match });
    });

    // Clear every row this sync does not reproduce exactly — students who left
    // the LMS course, and accounts now paired with a different LMS user —
    // before writing. Upserting first would collide with the unique
    // local-user index whenever an account moves to a new LMS user id.
    const mappings = db.collection('lms_identity_mappings');
    const pairs = new Map(matched.map(({ entry, localUser }) => [externalUserId(entry), localUser.localUserId]));
    const existingMappings = await mappings.find({ courseId: course.courseId, provider, externalCourseId }).toArray();
    const staleExternalIds = existingMappings
        .filter((mapping) => pairs.get(String(mapping.externalUserId)) !== String(mapping.localUserId))
        .map((mapping) => String(mapping.externalUserId));
    if (staleExternalIds.length) {
        await mappings.deleteMany({
            courseId: course.courseId,
            provider,
            externalCourseId,
            externalUserId: { $in: staleExternalIds }
        });
    }

    if (matched.length) {
        await mappings.bulkWrite(matched.map(({ entry, localUser, matchedBy: strategy }) => ({
            updateOne: {
                filter: {
                    courseId: course.courseId,
                    provider,
                    externalCourseId,
                    externalUserId: externalUserId(entry)
                },
                update: {
                    $set: {
                        localUserId: localUser.localUserId,
                        externalLabel: entry.name,
                        externalEmail: entry.email,
                        matchedBy: strategy,
                        mappedAt: now,
                        mappedBy: String(matchedBy)
                    }
                },
                upsert: true
            }
        })));
    }

    return {
        provider,
        externalCourseId,
        matchedAt: now,
        rosterSize: roster.entries.length,
        matchedCount: matched.length,
        matchedBy: Object.fromEntries(MATCH_STRATEGIES.map((strategy) => [
            strategy.id,
            matched.filter((match) => match.matchedBy === strategy.id).length
        ])),
        unmatchedLmsStudents,
        unmatchedBiocBotStudents: localUsers
            .filter((user) => !claimedLocalUserIds.has(user.localUserId))
            .map((user) => ({
                localUserId: user.localUserId,
                displayName: user.displayName,
                email: user.email
            }))
    };
}

/** Fetches the roster and reconciles it in one step. */
async function syncCourseRoster({ db, course, provider, client, externalCourseId, matchedBy, toolkit: injectedToolkit }) {
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
        throw new Error(`Unsupported LMS provider: ${provider}`);
    }

    // Injection keeps unit tests deterministic when the optional GitHub
    // Packages dependency is intentionally unavailable in CI. Production
    // callers omit it and use the installed toolkit package.
    const toolkit = injectedToolkit || loadRosterToolkit();
    const entries = await toolkit[provider].getCourseUsers(client, externalCourseId);
    const coverage = toolkit.rosterFieldCoverage(entries);
    if (entries.length && !entries.some((entry) => entry.integrationId || entry.email)) {
        console.warn(
            `⚠️ ${provider} roster for course ${externalCourseId} exposed no integration id or email — nothing can be matched.`
        );
    }
    const report = await matchCourseRoster({
        db,
        course,
        provider,
        roster: { externalCourseId, entries },
        matchedBy
    });
    return { ...report, coverage };
}

const CANVAS_ENROLLMENT_CHECK_CONCURRENCY = 4;

/**
 * Which of these Canvas users Canvas confirms have no active or invited
 * student enrollment left in the course, in any section.
 *
 * Absence from a roster read proves nothing on its own: Canvas filters roster
 * reads to the reader's sections, so to a teacher limited to one section a
 * student who moved to another section looks exactly like one who left. Asking
 * for one user's enrollments in the course (user_id=...) is answered from all
 * of that user's enrollments without the section filter, for anyone who can
 * read the roster.
 *
 * Fails safe: a user whose lookup errors is never reported as having left.
 * @returns {Promise<Set<string>>}
 */
async function confirmLeftCanvasCourse(client, externalCourseId, externalUserIds) {
    const path = `/courses/${encodeURIComponent(String(externalCourseId))}/enrollments`;
    const pending = [...new Set(externalUserIds.map(String))];
    const left = new Set();

    async function worker() {
        while (pending.length) {
            const userId = pending.shift();
            try {
                const enrollments = await client.getAll(path, {
                    user_id: userId,
                    type: ['StudentEnrollment'],
                    state: ['active', 'invited']
                });
                if (!enrollments.length) left.add(userId);
            } catch (error) {
                console.warn(`⚠️ Could not confirm Canvas enrollment for user ${userId} in course ${externalCourseId}: ${error.message}`);
            }
        }
    }

    await Promise.all(Array.from({ length: CANVAS_ENROLLMENT_CHECK_CONCURRENCY }, worker));
    return left;
}

module.exports = {
    MATCH_STRATEGIES,
    SUPPORTED_PROVIDERS,
    confirmLeftCanvasCourse,
    indexLocalCandidates,
    listLocalCandidates,
    matchCourseRoster,
    matchRosterEntries,
    syncCourseRoster
};
