const { memoryDb } = require('../helpers/memory-db');
const { makeRouteApp, request } = require('../helpers/route-app');
const {
    buildPruneSafety,
    createLmsRosterSyncRouter,
    effectiveRosterSource,
    isDropCandidate
} = require('../../../src/routes/lmsRosterSync');

const instructor = { userId: 'inst-1', role: 'instructor' };

function course(overrides = {}) {
    return {
        courseId: 'BIOC-1',
        courseName: 'BIOC 301',
        instructorId: 'inst-1',
        instructors: ['inst-1'],
        rosterSource: 'manual',
        studentEnrollment: {
            'user-1': { enrolled: false, source: 'manual' },
            'user-2': { enrolled: true, source: 'manual' }
        },
        lmsGradeSources: {
            canvas: { courseId: '10', name: 'BIOC 301', code: 'BIOC301' }
        },
        ...overrides
    };
}

/** A student an earlier sync of Canvas course 10 put on this course. */
function canvasEnrollment(externalUserId, overrides = {}) {
    return {
        enrolled: true,
        source: 'canvas',
        externalUserId,
        externalCourseId: '10',
        ...overrides
    };
}

function integrationHarness() {
    const canvasClient = {};
    const moodleClient = {};
    const provider = (client, key) => ({
        api: {
            requireAuth: () => (req, res, next) => {
                req[key] = client;
                next();
            }
        },
        config: {}
    });
    return {
        canvasClient,
        integration: {
            canvas: provider(canvasClient, 'canvasApi'),
            moodle: provider(moodleClient, 'moodleApi')
        }
    };
}

describe('LMS roster sync routes', () => {
    test('Canvas sync claims ownership, persists matched enrollment, and returns coverage safety', async () => {
        const harness = integrationHarness();
        const db = memoryDb({
            courses: [course({
                studentEnrollment: {
                    'user-1': { enrolled: false, source: 'manual' },
                    'user-2': { enrolled: true, source: 'manual' },
                    'user-3': canvasEnrollment('903'),
                    'user-4': canvasEnrollment('904'),
                    'user-5': canvasEnrollment('905', { enrolled: false })
                }
            })]
        });
        // 904 moved to a section this teacher cannot see; Canvas still has them.
        const confirmLeft = jest.fn(async () => new Set(['903']));
        const matchRoster = jest.fn(async ({ db: matchDb }) => {
            await matchDb.collection('lms_identity_mappings').insertOne({
                courseId: 'BIOC-1',
                provider: 'canvas',
                externalCourseId: '10',
                externalUserId: '900',
                localUserId: 'user-1'
            });
            return {
                provider: 'canvas',
                externalCourseId: '10',
                rosterSize: 2,
                matchedCount: 1,
                matchedBy: { integration: 1 },
                unmatchedLmsStudents: [{ externalUserId: '901', name: 'New Student', reason: 'no-biocbot-account' }],
                unmatchedBiocBotStudents: [
                    { localUserId: 'user-2', displayName: 'Grace', email: '' },
                    { localUserId: 'user-3', displayName: 'Alan', email: '' },
                    { localUserId: 'user-4', displayName: 'Katherine', email: '' },
                    { localUserId: 'user-5', displayName: 'Edsger', email: '' }
                ],
                coverage: { total: 2, integrationId: 2, sisId: 2, email: 2, loginId: 2 }
            };
        });
        const app = makeRouteApp(createLmsRosterSyncRouter(harness.integration, { matchRoster, confirmLeft }), { db, user: instructor });

        const res = await request(app)
            .post('/courses/BIOC-1/sync')
            .send({ provider: 'canvas' })
            .expect(200);

        // Only students this Canvas course enrolled and who are gone from the
        // roster read are checked — not the manual one or the already-dropped one.
        expect(confirmLeft).toHaveBeenCalledWith(harness.canvasClient, '10', ['903', '904']);
        expect(matchRoster).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'canvas',
            externalCourseId: '10',
            client: harness.canvasClient
        }));
        expect(res.body.data).toMatchObject({
            rosterSource: 'canvas',
            coverage: { total: 2, integrationId: 2 },
            prune: { allowed: true, integrationIdRatio: 1 }
        });
        expect(res.body.data.syncToken).toEqual(expect.any(String));
        expect(res.body.data.dropCandidates).toEqual([
            { localUserId: 'user-3', displayName: 'Alan', email: '', accessDisabled: false }
        ]);
        expect(res.body.data.unmatchedBiocBotStudents.find((student) => student.localUserId === 'user-5'))
            .toMatchObject({ accessDisabled: true });

        const stored = await db.collection('courses').findOne({ courseId: 'BIOC-1' });
        expect(stored.rosterSource).toBe('canvas');
        expect(stored.studentEnrollment['user-1']).toMatchObject({
            enrolled: true,
            source: 'canvas',
            externalUserId: '900',
            externalCourseId: '10'
        });
        expect(stored.lmsRosterSync.dropCandidateIds).toEqual(['user-3']);
    });

    test('Canvas sync takes ownership from Academic Sync when explicitly triggered', async () => {
        const harness = integrationHarness();
        const matchRoster = jest.fn(async () => ({
            provider: 'canvas',
            externalCourseId: '10',
            rosterSize: 0,
            matchedCount: 0,
            matchedBy: {},
            unmatchedLmsStudents: [],
            unmatchedBiocBotStudents: [],
            coverage: { total: 0, integrationId: 0, sisId: 0, email: 0, loginId: 0 }
        }));
        const db = memoryDb({
            courses: [course({
                rosterSource: 'academicSync',
                academicSync: { sectionIds: ['SEC-1'] }
            })]
        });
        const app = makeRouteApp(createLmsRosterSyncRouter(harness.integration, { matchRoster }), { db, user: instructor });

        const res = await request(app)
            .post('/courses/BIOC-1/sync')
            .send({ provider: 'canvas' })
            .expect(200);

        expect(res.body.data.rosterSource).toBe('canvas');
        expect(matchRoster).toHaveBeenCalled();
        expect((await db.collection('courses').findOne({ courseId: 'BIOC-1' })).rosterSource).toBe('canvas');
    });

    test('soft-drops only the candidates from the exact safe sync token', async () => {
        const harness = integrationHarness();
        const db = memoryDb({
            courses: [course({
                rosterSource: 'canvas',
                studentEnrollment: {
                    'user-1': { enrolled: false, source: 'manual' },
                    'user-2': canvasEnrollment('902')
                },
                lmsRosterSync: {
                    provider: 'canvas',
                    externalCourseId: '10',
                    syncToken: 'sync-1',
                    coverage: { total: 10, integrationId: 9, sisId: 9, email: 10, loginId: 9 },
                    dropCandidateIds: ['user-2']
                }
            })]
        });
        const app = makeRouteApp(createLmsRosterSyncRouter(harness.integration), { db, user: instructor });

        await request(app)
            .post('/courses/BIOC-1/drop-unmatched')
            .send({ syncToken: 'stale' })
            .expect(409);

        const res = await request(app)
            .post('/courses/BIOC-1/drop-unmatched')
            .send({ syncToken: 'sync-1' })
            .expect(200);
        expect(res.body.data.droppedCount).toBe(1);

        const stored = await db.collection('courses').findOne({ courseId: 'BIOC-1' });
        expect(stored.studentEnrollment['user-1'].enrolled).toBe(false);
        expect(stored.studentEnrollment['user-2']).toMatchObject({ enrolled: false, source: 'canvas', externalCourseId: '10' });
        expect(stored.studentEnrollment['user-2'].droppedAt).toBeTruthy();
    });

    test('refuses to drop from a sync stored before drops were limited to the Canvas course', async () => {
        const harness = integrationHarness();
        const db = memoryDb({
            courses: [course({
                rosterSource: 'canvas',
                lmsRosterSync: {
                    provider: 'canvas',
                    externalCourseId: '10',
                    syncToken: 'sync-1',
                    coverage: { total: 10, integrationId: 9 },
                    unmatchedLocalUserIds: ['user-2']
                }
            })]
        });
        const app = makeRouteApp(createLmsRosterSyncRouter(harness.integration), { db, user: instructor });

        const res = await request(app)
            .post('/courses/BIOC-1/drop-unmatched')
            .send({ syncToken: 'sync-1' })
            .expect(409);

        expect(res.body.code).toBe('ROSTER_SYNC_STALE');
        const stored = await db.collection('courses').findOne({ courseId: 'BIOC-1' });
        expect(stored.studentEnrollment['user-2']).toEqual({ enrolled: true, source: 'manual' });
    });

    test('leaves a candidate alone when the instructor changed their access by hand after the sync', async () => {
        const harness = integrationHarness();
        const db = memoryDb({
            courses: [course({
                rosterSource: 'canvas',
                studentEnrollment: {
                    'user-2': { enrolled: true, updatedAt: new Date() },
                    'user-3': canvasEnrollment('903')
                },
                lmsRosterSync: {
                    provider: 'canvas',
                    externalCourseId: '10',
                    syncToken: 'sync-1',
                    coverage: { total: 10, integrationId: 9 },
                    dropCandidateIds: ['user-2', 'user-3']
                }
            })]
        });
        const app = makeRouteApp(createLmsRosterSyncRouter(harness.integration), { db, user: instructor });

        const res = await request(app)
            .post('/courses/BIOC-1/drop-unmatched')
            .send({ syncToken: 'sync-1' })
            .expect(200);

        expect(res.body.data.droppedCount).toBe(1);
        const stored = await db.collection('courses').findOne({ courseId: 'BIOC-1' });
        expect(stored.studentEnrollment['user-2'].enrolled).toBe(true);
        expect(stored.studentEnrollment['user-3'].enrolled).toBe(false);
    });

    test('only students this Canvas course enrolled, now gone from the roster read, go on to the Canvas check', () => {
        const context = { externalCourseId: '10', rosterExternalUserIds: new Set(['900']) };

        expect(isDropCandidate(canvasEnrollment('903'), context)).toBe(true);
        // Still on the roster, even if BiocBot could not match them this time.
        expect(isDropCandidate(canvasEnrollment('900'), context)).toBe(false);
        // Synced from a different Canvas course, or before the course was recorded.
        expect(isDropCandidate(canvasEnrollment('903', { externalCourseId: '99' }), context)).toBe(false);
        expect(isDropCandidate({ enrolled: true, source: 'canvas', externalUserId: '903' }, context)).toBe(false);
        // Joined another way, or already dropped.
        expect(isDropCandidate({ enrolled: true, source: 'manual' }, context)).toBe(false);
        expect(isDropCandidate(canvasEnrollment('903', { enrolled: false }), context)).toBe(false);
        expect(isDropCandidate(undefined, context)).toBe(false);
    });

    test('tells the browser to reconnect only when a Canvas 401 left no stored tokens behind', async () => {
        const harness = integrationHarness();
        const tokens = { current: null };
        harness.integration.canvas.config = {
            getUserKey: (req) => req.user.userId,
            tokenStore: { get: jest.fn(async () => tokens.current) }
        };
        const matchRoster = jest.fn(async () => {
            throw Object.assign(new Error('Canvas API request to /api/v1/courses/10/users returned 401'), { statusCode: 401 });
        });
        const db = memoryDb({ courses: [course()] });
        const app = makeRouteApp(createLmsRosterSyncRouter(harness.integration, { matchRoster }), { db, user: instructor });
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        const expired = await request(app).post('/courses/BIOC-1/sync').send({ provider: 'canvas' }).expect(401);
        expect(expired.body).toMatchObject({ connected: false, code: 'CANVAS_NOT_CONNECTED' });

        tokens.current = { accessToken: 'still-valid' };
        const refused = await request(app).post('/courses/BIOC-1/sync').send({ provider: 'canvas' }).expect(403);
        expect(refused.body).toMatchObject({ code: 'CANVAS_ACCESS_DENIED' });
        error.mockRestore();
    });

    test('never offers prune for an empty or low-integration-coverage roster', () => {
        expect(buildPruneSafety({ total: 0, integrationId: 0 })).toMatchObject({ allowed: false, reason: 'empty-roster' });
        expect(buildPruneSafety({ total: 10, integrationId: 7 })).toMatchObject({
            allowed: false,
            reason: 'insufficient-integration-id-coverage'
        });
        expect(buildPruneSafety({ total: 10, integrationId: 8 })).toMatchObject({ allowed: true });
    });

    test('treats legacy academic-linked courses as Academic Sync owned', () => {
        expect(effectiveRosterSource({ academicSync: { sectionIds: ['SEC-1'] } })).toBe('academicSync');
        expect(effectiveRosterSource({})).toBe('manual');
    });
});
