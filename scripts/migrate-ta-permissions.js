#!/usr/bin/env node
'use strict';

/**
 * One-time backfill migrating every course's TA permissions from the old
 * two-boolean shape ({canAccessCourses, canAccessFlags}) to the new
 * six-flag shape (materials/questions/flags/roster/transcripts/settings).
 *
 * This is a hard requirement for correctness, not just hygiene: until a
 * course is marked migrated, getTAPermissions() treats an absent record as
 * the old fail-open default (full access) so pre-existing TAs aren't locked
 * out on deploy. Once this script marks a course `taPermissionsMigrated:
 * true`, an absent record means fail-closed instead - which is exactly what
 * addTAToCourse now writes explicitly for every TA added from that point
 * on. Marking the course (not just the TAs) is what makes a re-run
 * idempotent: without it, a second run would see "no record" for any TA
 * added after the first run and incorrectly grant them the old fail-open
 * default too.
 *
 * Deploy order matters: ship the code with addTAToCourse's explicit write,
 * getTAPermissions's migrated-aware default, and the new 6-key PUT route
 * BEFORE running this with --apply, so a race between this script and a
 * live instructor edit self-heals on next read either way.
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const CourseModel = require('../src/models/Course');

const { TA_PERMISSION_KEYS, isLegacyTAPermissions, migrateLegacyTAPermissions } = CourseModel;

function parseArgs(argv) {
    const options = { apply: false, pruneOrphaned: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--prune-orphaned') {
            options.pruneOrphaned = true;
        } else if (arg === '--course-id') {
            options.courseId = argv[++index];
        } else if (arg === '--backup-file') {
            options.backupFile = argv[++index];
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    for (const key of ['courseId', 'backupFile']) {
        const flag = `--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
        if (options[key] === undefined && argv.includes(flag)) {
            throw new Error(`Missing value for ${flag}`);
        }
    }
    return options;
}

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Decide what a single TA's migrated permissions should be, and whether
 * the stored record actually needs to change.
 * @param {Object|undefined} stored - course.taPermissions[taId], if present
 * @returns {{ next: Object, changedFields: string[], skippedReason: string|null, source: string }}
 */
function planTAMigration(stored) {
    if (!stored) {
        // No record at all: this TA's actual current access is today's
        // fail-open default, not the new fail-closed default - migrate
        // that synthesized default, don't silently revoke access.
        const next = migrateLegacyTAPermissions({ canAccessCourses: true, canAccessFlags: true });
        return { next, changedFields: TA_PERMISSION_KEYS.slice(), skippedReason: null, source: 'no-record (synthesized old fail-open default)' };
    }

    if (isLegacyTAPermissions(stored)) {
        // Old keys win over any stale partial new-shape data on the same
        // record - it can only be partial because an earlier lazy-read
        // normalization or script run was interrupted.
        const next = migrateLegacyTAPermissions(stored);
        const changedFields = TA_PERMISSION_KEYS.filter(key => stored[key] !== next[key]);
        // Never skip a legacy record, even if the computed new-shape values
        // happen to already match: the legacy keys themselves still need to
        // be $unset, or isLegacyTAPermissions keeps reading it as legacy and
        // every future PUT silently no-ops (see updateTAPermissions).
        return { next, changedFields, skippedReason: null, source: 'legacy-shape', needsUnsetLegacyKeys: true };
    }

    // Already new-shape. Fill in any missing key as false (matches what
    // getTAPermissions already infers for a missing key on read) rather
    // than leaving genuinely malformed partial data un-normalized.
    const next = {};
    const changedFields = [];
    for (const key of TA_PERMISSION_KEYS) {
        next[key] = stored[key] === true;
        if (!(key in stored)) changedFields.push(key);
    }
    return {
        next,
        changedFields,
        skippedReason: changedFields.length ? null : 'already consistent',
        source: changedFields.length ? 'partial-new-shape' : 'new-shape'
    };
}

function printHelp() {
    console.log(`Usage: node scripts/migrate-ta-permissions.js [options]

Dry-run is the default. No database records are updated without --apply.

Options:
  --apply                 Write the migrated permissions
  --course-id ID          Limit to one course
  --prune-orphaned        Remove taPermissions entries for TAs no longer in course.tas
  --backup-file PATH      Backup destination used before --apply updates
  --help                   Show this help`);
}

/**
 * The actual migration logic, factored out of main() so it can run against
 * an injected db (a real connection in production, an in-memory fake in
 * tests) without needing a live MongoClient. Returns the same summary
 * object main() prints.
 * @param {Object} db - MongoDB database instance
 * @param {Object} options - parseArgs() output
 */
async function runMigration(db, options) {
    const collection = db.collection('courses');

    const query = options.courseId ? { courseId: options.courseId } : {};
    const courses = await collection.find(query).toArray();

    const pending = [];
    const report = [];
    let orphanedFound = 0;
    let alreadyMigratedCourses = 0;

    for (const course of courses) {
        // A course already marked migrated is left alone entirely, even
        // in dry-run reporting: re-scanning it would report "no-record"
        // TAs added after the first run as needing the old fail-open
        // default, when they're actually meant to start with no access
        // (addTAToCourse already wrote their fail-closed record).
        if (course.taPermissionsMigrated === true) {
            alreadyMigratedCourses++;
            continue;
        }

        const tas = Array.isArray(course.tas) ? course.tas : [];
        const stored = course.taPermissions || {};
        const setFields = {};
        const unsetFields = {};
        const changedTAs = [];

        for (const taId of tas) {
            const plan = planTAMigration(stored[taId]);
            const entry = {
                courseId: course.courseId,
                taId,
                source: plan.source,
                newFlags: plan.next,
                changedFields: plan.changedFields,
                skippedReason: plan.skippedReason
            };
            report.push(entry);
            console.log(JSON.stringify(entry));

            if (!plan.skippedReason) {
                setFields[`taPermissions.${taId}`] = { ...plan.next, updatedAt: new Date() };
                changedTAs.push(taId);
                if (plan.needsUnsetLegacyKeys) {
                    unsetFields[`taPermissions.${taId}.canAccessCourses`] = '';
                    unsetFields[`taPermissions.${taId}.canAccessFlags`] = '';
                }
            }
        }

        // Stale taPermissions entries for TAs no longer in course.tas
        // are already unreachable via every read path - report, don't
        // touch, unless the caller explicitly asks to clean them up.
        const orphanedIds = Object.keys(stored).filter(id => !tas.includes(id));
        if (orphanedIds.length > 0) {
            orphanedFound += orphanedIds.length;
            console.log(JSON.stringify({ courseId: course.courseId, orphanedTaPermissions: orphanedIds }));
            if (options.pruneOrphaned) {
                for (const id of orphanedIds) {
                    unsetFields[`taPermissions.${id}`] = '';
                }
            }
        }

        // Every unmigrated course gets the marker set, even one with no
        // TAs or nothing to change - that's what makes a re-run a no-op
        // instead of re-deriving defaults for it indefinitely.
        setFields.taPermissionsMigrated = true;
        pending.push({ course, setFields, unsetFields, orphanedIds: options.pruneOrphaned ? orphanedIds : [] });
    }

    if (options.apply && pending.length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.resolve(
            options.backupFile || `ta-permissions-migration-backup-${timestamp}.json`
        );
        fs.writeFileSync(
            backupFile,
            JSON.stringify(pending.map(({ course }) => ({
                _id: course._id,
                courseId: course.courseId,
                tas: course.tas,
                taPermissions: course.taPermissions,
                taPermissionsMigrated: course.taPermissionsMigrated || false
            })), null, 2),
            { flag: 'wx', mode: 0o600 }
        );
        console.log(`Backup written before mutation: ${backupFile}`);

        for (const { course, setFields, unsetFields } of pending) {
            const update = { $set: setFields };
            if (Object.keys(unsetFields).length > 0) update.$unset = unsetFields;
            await collection.updateOne({ _id: course._id }, update);
        }

        // Verification pass: re-read every touched course and assert
        // its taPermissions round-trip to the shape we intended. This
        // is a security-relevant migration (fail-open/fail-closed
        // access), worth the extra check beyond what the precedent
        // repair script does.
        let verifiedOk = 0;
        let verifiedMismatch = 0;
        for (const { course, setFields } of pending) {
            const fresh = await collection.findOne(
                { _id: course._id },
                { projection: { taPermissions: 1, taPermissionsMigrated: 1 } }
            );

            if (fresh.taPermissionsMigrated !== true) {
                verifiedMismatch++;
                console.error(JSON.stringify({ verificationFailed: true, courseId: course.courseId, field: 'taPermissionsMigrated' }));
            } else {
                verifiedOk++;
            }

            for (const [key, expected] of Object.entries(setFields)) {
                if (!key.startsWith('taPermissions.')) continue; // taPermissionsMigrated, verified above
                const taId = key.split('.')[1];
                const actual = fresh.taPermissions && fresh.taPermissions[taId];
                const actualFlags = actual ? { ...actual, updatedAt: undefined } : undefined;
                const expectedFlags = { ...expected, updatedAt: undefined };
                if (same(actualFlags, expectedFlags)) {
                    verifiedOk++;
                } else {
                    verifiedMismatch++;
                    console.error(JSON.stringify({ verificationFailed: true, courseId: course.courseId, taId }));
                }
            }
        }
        console.log(JSON.stringify({ verifiedOk, verifiedMismatch }));
    }

    const summary = {
        mode: options.apply ? 'apply' : 'dry-run',
        coursesScanned: courses.length,
        alreadyMigratedCourses,
        tasScanned: report.length,
        migrated: report.filter(r => !r.skippedReason).length,
        alreadyConsistent: report.filter(r => r.skippedReason === 'already consistent').length,
        orphanedFound
    };
    console.log(JSON.stringify(summary));
    return summary;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const client = new MongoClient(
        process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017'
    );
    await client.connect();
    try {
        // Match the server (src/db/connection.js uses client.db() with no
        // name, which takes the database from MONGO_URI): an explicit
        // MONGODB_DB env var overrides it, but the fallback must be "use
        // the URI's database", not a hardcoded dev name. Defaulting to
        // 'biocbot-dev' here made it easy to silently scan the wrong
        // (possibly empty) database in prod.
        const db = process.env.MONGODB_DB ? client.db(process.env.MONGODB_DB) : client.db();
        await runMigration(db, options);
    } finally {
        await client.close();
    }
}

module.exports = { parseArgs, planTAMigration, runMigration };

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
