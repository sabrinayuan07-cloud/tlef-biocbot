const fs = require('fs');
const os = require('os');
const path = require('path');
const { memoryDb } = require('../helpers/memory-db');
const { planTAMigration, runMigration } = require('../../../scripts/migrate-ta-permissions');

const ALL_TRUE = { materials: true, questions: true, settings: true, transcripts: true, flags: true, roster: true };
const ALL_FALSE = { materials: false, questions: false, settings: false, transcripts: false, flags: false, roster: false };

// runMigration writes a JSON backup via fs.writeFileSync({ flag: 'wx' }) before
// any apply - point it at a scratch dir per test so nothing lands in the repo.
let backupDir;
function backupFileFor(name) {
    return path.join(backupDir, `${name}.json`);
}

beforeEach(() => {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-permissions-migration-'));
});

afterEach(() => {
    fs.rmSync(backupDir, { recursive: true, force: true });
});

describe('planTAMigration', () => {
    test('no record: synthesizes the old fail-open default, never skipped', () => {
        const plan = planTAMigration(undefined);
        expect(plan.next).toEqual(ALL_TRUE);
        expect(plan.skippedReason).toBeNull();
        expect(plan.needsUnsetLegacyKeys).toBeUndefined();
    });

    test('legacy shape: never skipped even when the mapped new-shape values already match', () => {
        // A record that somehow already carries materials/questions/etc. equal
        // to what migrateLegacyTAPermissions would compute - the old bug
        // treated this as "already consistent" and left canAccessCourses/
        // canAccessFlags in place forever.
        const stored = { canAccessCourses: true, canAccessFlags: true, ...ALL_TRUE };
        const plan = planTAMigration(stored);
        expect(plan.skippedReason).toBeNull();
        expect(plan.next).toEqual(ALL_TRUE);
    });

    test('legacy shape: old keys win over stale partial new-shape data', () => {
        const stored = { canAccessCourses: false, canAccessFlags: true, materials: true };
        const plan = planTAMigration(stored);
        expect(plan.next).toEqual({ materials: false, questions: false, settings: false, transcripts: false, flags: true, roster: true });
    });

    test('already new-shape and fully consistent: skipped', () => {
        const plan = planTAMigration({ ...ALL_FALSE, updatedAt: new Date() });
        expect(plan.skippedReason).toBe('already consistent');
        expect(plan.needsUnsetLegacyKeys).toBeUndefined();
    });

    test('partial new-shape: fills missing keys as false, not skipped', () => {
        const plan = planTAMigration({ materials: true });
        expect(plan.skippedReason).toBeNull();
        expect(plan.next).toEqual({ ...ALL_FALSE, materials: true });
    });
});

describe('runMigration', () => {
    test('dry-run reports the no-record plan but writes nothing', async () => {
        const db = memoryDb({
            courses: [{ _id: 'c1', courseId: 'C1', tas: ['t1'] }],
        });

        const summary = await runMigration(db, { apply: false, pruneOrphaned: false });
        expect(summary).toMatchObject({ mode: 'dry-run', coursesScanned: 1, alreadyMigratedCourses: 0, migrated: 1 });

        const course = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(course.taPermissions).toBeUndefined();
        expect(course.taPermissionsMigrated).toBeUndefined();
    });

    test('apply backfills the no-record TA to the old fail-open default and marks the course migrated', async () => {
        const db = memoryDb({
            courses: [{ _id: 'c1', courseId: 'C1', tas: ['t1'] }],
        });

        const summary = await runMigration(db, {
            apply: true,
            pruneOrphaned: false,
            backupFile: backupFileFor('apply-no-record'),
        });
        expect(summary).toMatchObject({ mode: 'apply', migrated: 1 });

        const course = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(course.taPermissionsMigrated).toBe(true);
        expect(course.taPermissions.t1).toMatchObject(ALL_TRUE);
    });

    test('apply on a legacy-shaped record $unsets the two legacy keys', async () => {
        const db = memoryDb({
            courses: [{
                _id: 'c1',
                courseId: 'C1',
                tas: ['t1'],
                taPermissions: { t1: { canAccessCourses: true, canAccessFlags: false } },
            }],
        });

        await runMigration(db, { apply: true, pruneOrphaned: false, backupFile: backupFileFor('apply-legacy') });

        const course = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(course.taPermissions.t1).not.toHaveProperty('canAccessCourses');
        expect(course.taPermissions.t1).not.toHaveProperty('canAccessFlags');
        expect(course.taPermissions.t1).toMatchObject({
            materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false,
        });
        expect(course.taPermissionsMigrated).toBe(true);
    });

    test('idempotent: a second apply run leaves an already-migrated course untouched, including a TA added after the first run with no record', async () => {
        const db = memoryDb({
            courses: [{ _id: 'c1', courseId: 'C1', tas: ['t1'] }],
        });

        await runMigration(db, { apply: true, pruneOrphaned: false, backupFile: backupFileFor('first-run') });

        // Simulate a TA added after the first run via addTAToCourse's explicit
        // fail-closed write (no backfill default - the TA should start with
        // no access).
        let course = await db.collection('courses').findOne({ courseId: 'C1' });
        course.tas.push('t2');
        course.taPermissions.t2 = { ...ALL_FALSE, updatedAt: new Date() };
        await db.collection('courses').updateOne(
            { courseId: 'C1' },
            { $set: { tas: course.tas, 'taPermissions.t2': course.taPermissions.t2 } }
        );

        const secondRun = await runMigration(db, {
            apply: true,
            pruneOrphaned: false,
            backupFile: backupFileFor('second-run'),
        });

        // The course is already migrated, so the second run must skip it
        // entirely rather than re-scan t2 as a "no-record" TA and grant it
        // the old fail-open default.
        expect(secondRun.alreadyMigratedCourses).toBe(1);
        expect(secondRun.coursesScanned).toBe(1);
        expect(secondRun.tasScanned).toBe(0);

        course = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(course.taPermissions.t1).toMatchObject(ALL_TRUE);
        expect(course.taPermissions.t2).toMatchObject(ALL_FALSE);
    });

    test('a course already marked migrated with a genuinely no-record TA still reads fail-closed (not re-swept)', async () => {
        const db = memoryDb({
            courses: [{ _id: 'c1', courseId: 'C1', tas: ['t1'], taPermissionsMigrated: true }],
        });

        const summary = await runMigration(db, { apply: true, pruneOrphaned: false, backupFile: backupFileFor('already-migrated') });
        expect(summary.alreadyMigratedCourses).toBe(1);
        expect(summary.tasScanned).toBe(0);

        const course = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(course.taPermissions).toBeUndefined();
    });
});
