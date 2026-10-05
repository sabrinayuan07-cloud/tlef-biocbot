/**
 * Unit tests for src/services/permissions.js - the single shared
 * authorization check that replaced the ~9 duplicated per-route-file
 * canX(db, user, courseId) helpers, plus the role-preset derivation used
 * by the TA hub UI.
 */
const { memoryDb } = require('../helpers/memory-db');
const { PERMISSION_KEYS, ROLE_PRESETS, hasPermission, deriveRoleLabel } = require('../../../src/services/permissions');

describe('hasPermission', () => {
    test('denies when user or courseId is missing', async () => {
        const db = memoryDb({});
        expect(await hasPermission(db, null, 'C1', 'materials')).toBe(false);
        expect(await hasPermission(db, { userId: 'i1', role: 'instructor' }, null, 'materials')).toBe(false);
    });

    test('grants a system admin regardless of course ownership', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'someone-else' }] });
        const admin = { userId: 'a1', role: 'instructor', permissions: { systemAdmin: true } };
        expect(await hasPermission(db, admin, 'C1', 'materials')).toBe(true);
    });

    test('grants an instructor who owns the course, denies one who does not', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1' }] });
        expect(await hasPermission(db, { userId: 'i1', role: 'instructor' }, 'C1', 'materials')).toBe(true);
        expect(await hasPermission(db, { userId: 'other', role: 'instructor' }, 'C1', 'materials')).toBe(false);
    });

    test('checks the specific permission for a TA, not just course membership', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', tas: ['t1'], taPermissions: { t1: { materials: true, flags: false } } }],
        });
        const taUser = { userId: 't1', role: 'ta' };
        expect(await hasPermission(db, taUser, 'C1', 'materials')).toBe(true);
        expect(await hasPermission(db, taUser, 'C1', 'flags')).toBe(false);
    });

    test('denies a student outright - never routed through course-access resolution', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: true } } }] });
        expect(await hasPermission(db, { userId: 's1', role: 'student' }, 'C1', 'materials')).toBe(false);
    });
});

describe('deriveRoleLabel', () => {
    test('matches an exact preset', () => {
        expect(deriveRoleLabel(ROLE_PRESETS.grader)).toBe('grader');
        expect(deriveRoleLabel(ROLE_PRESETS.contentTA)).toBe('contentTA');
        expect(deriveRoleLabel(ROLE_PRESETS.fullTA)).toBe('fullTA');
    });

    test('returns custom for a set that matches no preset', () => {
        const custom = { materials: true, questions: false, flags: true, roster: false, transcripts: true, settings: false };
        expect(deriveRoleLabel(custom)).toBe('custom');
    });

    test('returns custom for an empty or missing permissions object', () => {
        expect(deriveRoleLabel({})).toBe('custom');
        expect(deriveRoleLabel(null)).toBe('custom');
        expect(deriveRoleLabel(undefined)).toBe('custom');
    });

    test('every preset covers exactly the six permission keys', () => {
        Object.values(ROLE_PRESETS).forEach(preset => {
            expect(Object.keys(preset).sort()).toEqual([...PERMISSION_KEYS].sort());
        });
    });
});
