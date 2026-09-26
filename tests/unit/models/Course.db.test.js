/**
 * Unit tests for the DB-backed helpers of src/models/Course.js, run against the
 * in-memory Mongo double (tests/unit/helpers/memory-db.js).
 *
 * NOTE on the positional `$` operator: updateAssessmentQuestions /
 * deleteAssessmentQuestion write via `lectures.$.assessmentQuestions`, which
 * memory-db does NOT apply (see unit_tests.md §7). Their branch decisions and
 * return contracts come from the pre-write findOne(), so we assert those — not
 * the array mutation. Helpers that use computed-key $set (studentEnrollment.<id>,
 * taPermissions.<id>) ARE fully supported, so those get write->read round-trips.
 */
const { memoryDb } = require('../helpers/memory-db');
const Course = require('../../../src/models/Course');

beforeAll(() => {
    // Course logs verbosely on creates/updates/deletes.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
    jest.restoreAllMocks();
});

describe('Course.updateCourseSuperchats', () => {
    test('normalizes, persists, and returns the new bucket list', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', superchatIds: ['old'] }] });
        const res = await Course.updateCourseSuperchats(db, 'C1', ['b', ' b ', 'a', '']);
        expect(res).toEqual({ success: true, superchatIds: ['b', 'a'], error: null });

        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.superchatIds).toEqual(['b', 'a']);
    });

    test('returns "Course not found" for an unknown or deleted course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', status: 'deleted' }] });
        expect(await Course.updateCourseSuperchats(db, 'C1', ['x'])).toMatchObject({
            success: false,
            error: 'Course not found',
        });
        expect(await Course.updateCourseSuperchats(db, 'NOPE', ['x'])).toMatchObject({
            success: false,
            error: 'Course not found',
        });
    });
});

describe('Course.getLecturePublishStatus', () => {
    test('maps each lecture name to its isPublished flag', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [
                { name: 'Unit 1', isPublished: true },
                { name: 'Unit 2', isPublished: false },
            ] }],
        });
        expect(await Course.getLecturePublishStatus(db, 'C1')).toEqual({ 'Unit 1': true, 'Unit 2': false });
    });

    test('returns {} when the course or its lectures are missing', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C2' }] });
        expect(await Course.getLecturePublishStatus(db, 'C2')).toEqual({});
        expect(await Course.getLecturePublishStatus(db, 'NOPE')).toEqual({});
    });
});

describe('Course.getPublishedLectures', () => {
    test('returns the names (strings) of only the published lectures', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [
                { name: 'Unit 1', isPublished: true },
                { name: 'Unit 2', isPublished: false },
                { name: 'Unit 3', isPublished: true },
            ] }],
        });
        expect(await Course.getPublishedLectures(db, 'C1')).toEqual(['Unit 1', 'Unit 3']);
    });

    test('returns [] when nothing is published or the course is missing', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', isPublished: false }] }] });
        expect(await Course.getPublishedLectures(db, 'C1')).toEqual([]);
        expect(await Course.getPublishedLectures(db, 'NOPE')).toEqual([]);
    });
});

describe('Course.getAssessmentQuestions', () => {
    test('returns the questions stored on the named lecture', async () => {
        const questions = [{ questionId: 'q1' }, { questionId: 'q2' }];
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', assessmentQuestions: questions }] }],
        });
        expect(await Course.getAssessmentQuestions(db, 'C1', 'Unit 1')).toEqual(questions);
    });

    test('returns [] for a missing lecture, a lecture with no questions, or no course', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1' }] }],
        });
        expect(await Course.getAssessmentQuestions(db, 'C1', 'Unit 1')).toEqual([]);
        expect(await Course.getAssessmentQuestions(db, 'C1', 'Unit 99')).toEqual([]);
        expect(await Course.getAssessmentQuestions(db, 'NOPE', 'Unit 1')).toEqual([]);
    });
});

describe('Course.updateAssessmentQuestions (return contract; positional write not asserted)', () => {
    test('rejects when the course does not exist', async () => {
        const db = memoryDb({ courses: [] });
        expect(await Course.updateAssessmentQuestions(db, 'NOPE', 'Unit 1', {}, 'i1')).toEqual({
            success: false,
            error: 'Course not found',
        });
    });

    test('rejects when the lecture does not exist', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1' }] }] });
        expect(await Course.updateAssessmentQuestions(db, 'C1', 'Unit 9', {}, 'i1')).toEqual({
            success: false,
            error: 'Lecture not found',
        });
    });

    test('auto-generates a questionId and reports created:true for a new question', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', assessmentQuestions: [] }] }] });
        const res = await Course.updateAssessmentQuestions(db, 'C1', 'Unit 1', { question: 'Q?' }, 'i1');
        expect(res.success).toBe(true);
        expect(res.created).toBe(true);
        expect(res.questionId).toMatch(/^q_[0-9a-f-]{36}$/i);
    });

    test('reports created:false when the questionId already exists on the lecture', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', assessmentQuestions: [{ questionId: 'q1' }] }] }],
        });
        const res = await Course.updateAssessmentQuestions(db, 'C1', 'Unit 1', { questionId: 'q1', question: 'Edited' }, 'i1');
        expect(res).toMatchObject({ success: true, created: false, questionId: 'q1' });
    });

    test('requireExisting rejects an unknown question without inserting it', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', assessmentQuestions: [] }] }],
        });
        const res = await Course.updateAssessmentQuestions(
            db, 'C1', 'Unit 1', { questionId: 'missing', question: 'Must not be created' }, 'i1',
            { requireExisting: true }
        );
        expect(res).toEqual({ success: false, notFound: true, error: 'Question not found' });
        expect(await Course.getAssessmentQuestions(db, 'C1', 'Unit 1')).toEqual([]);
    });

    test('requireExisting reports not found when the question disappears before the write', async () => {
        const collection = {
            findOne: jest.fn().mockResolvedValue({
                courseId: 'C1',
                lectures: [{ name: 'Unit 1', assessmentQuestions: [{ questionId: 'q1', question: 'Old' }] }],
            }),
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
        };
        const db = { collection: jest.fn(() => collection) };

        const res = await Course.updateAssessmentQuestions(
            db, 'C1', 'Unit 1', { questionId: 'q1', question: 'Stale edit' }, 'i1',
            { requireExisting: true }
        );

        expect(res).toEqual({ success: false, notFound: true, error: 'Question not found' });
        expect(collection.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ 'lectures.assessmentQuestions.questionId': 'q1' }),
            expect.any(Object)
        );
    });
});

describe('Course.deleteAssessmentQuestion (return contract; positional write not asserted)', () => {
    test('rejects when course or lecture is missing', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1' }] }] });
        expect(await Course.deleteAssessmentQuestion(db, 'NOPE', 'Unit 1', 'q1', 'i1')).toMatchObject({
            success: false, error: 'Course not found',
        });
        expect(await Course.deleteAssessmentQuestion(db, 'C1', 'Unit 9', 'q1', 'i1')).toMatchObject({
            success: false, error: 'Lecture not found',
        });
    });

    test('is a no-op (deletedCount 0) when the question is not on the lecture', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', assessmentQuestions: [{ questionId: 'q1' }] }] }],
        });
        expect(await Course.deleteAssessmentQuestion(db, 'C1', 'Unit 1', 'missing', 'i1')).toEqual({
            success: true, deletedCount: 0, questionId: 'missing',
        });
    });

    test('reports deletedCount 1 when the question exists', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', assessmentQuestions: [{ questionId: 'q1' }] }] }],
        });
        expect(await Course.deleteAssessmentQuestion(db, 'C1', 'Unit 1', 'q1', 'i1')).toEqual({
            success: true, deletedCount: 1, questionId: 'q1',
        });
    });
});

describe('Course.userHasCourseAccess', () => {
    test('instructor: matches the primary instructorId or the instructors array', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', instructorId: 'i1', instructors: ['i1', 'i2'] }],
        });
        expect(await Course.userHasCourseAccess(db, 'C1', 'i1', 'instructor')).toBe(true);
        expect(await Course.userHasCourseAccess(db, 'C1', 'i2', 'instructor')).toBe(true);
        expect(await Course.userHasCourseAccess(db, 'C1', 'someone', 'instructor')).toBe(false);
    });

    test('ta: matches an assigned TA but not on a deleted course', async () => {
        const active = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'] }] });
        expect(await Course.userHasCourseAccess(active, 'C1', 't1', 'ta')).toBe(true);
        expect(await Course.userHasCourseAccess(active, 'C1', 't2', 'ta')).toBe(false);

        const deleted = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'], status: 'deleted' }] });
        expect(await Course.userHasCourseAccess(deleted, 'C1', 't1', 'ta')).toBe(false);
    });

    test('student: true only when enrollment override is enrolled', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: true }, s2: { enrolled: false } } }],
        });
        expect(await Course.userHasCourseAccess(db, 'C1', 's1', 'student')).toBe(true);
        expect(await Course.userHasCourseAccess(db, 'C1', 's2', 'student')).toBe(false);
        expect(await Course.userHasCourseAccess(db, 'C1', 's3', 'student')).toBe(false);
    });

    test('unknown course is always false', async () => {
        const db = memoryDb({ courses: [] });
        expect(await Course.userHasCourseAccess(db, 'NOPE', 'i1', 'instructor')).toBe(false);
    });
});

describe('Course.getTAPermissions / updateTAPermissions', () => {
    test('getTAPermissions rejects for a missing course or unassigned TA', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'] }] });
        expect(await Course.getTAPermissions(db, 'NOPE', 't1')).toMatchObject({ success: false, error: 'Course not found' });
        expect(await Course.getTAPermissions(db, 'C1', 't2')).toMatchObject({
            success: false, error: 'TA is not assigned to this course',
        });
    });

    const ALL_FALSE = { materials: false, questions: false, flags: false, roster: false, transcripts: false, settings: false };

    test('getTAPermissions defaults to no access (fail-closed) when none are stored', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'] }] });
        expect(await Course.getTAPermissions(db, 'C1', 't1')).toEqual({
            success: true,
            permissions: ALL_FALSE,
        });
    });

    test('getTAPermissions lazily normalizes a still-legacy two-boolean record, preserving its effective access', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', tas: ['t1'], taPermissions: { t1: { canAccessCourses: true, canAccessFlags: false } } }],
        });
        expect(await Course.getTAPermissions(db, 'C1', 't1')).toEqual({
            success: true,
            // canAccessCourses covered materials/questions/settings, and -
            // via the mentalHealthFlags 'courses' bug - transcripts too.
            // canAccessFlags covered flags and (bundled in) roster.
            permissions: { materials: true, questions: true, settings: true, transcripts: true, flags: false, roster: false },
        });
    });

    test('getTAPermissions reads an already-new-shape record directly, ignoring extra stored keys like updatedAt', async () => {
        const db = memoryDb({
            courses: [{
                courseId: 'C1', tas: ['t1'],
                taPermissions: { t1: { materials: true, questions: false, flags: true, roster: true, transcripts: false, settings: false, updatedAt: new Date() } },
            }],
        });
        expect(await Course.getTAPermissions(db, 'C1', 't1')).toEqual({
            success: true,
            permissions: { materials: true, questions: false, flags: true, roster: true, transcripts: false, settings: false },
        });
    });

    test('updateTAPermissions persists a partial patch, and getTAPermissions reads it back merged with defaults', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'] }] });
        const upd = await Course.updateTAPermissions(db, 'C1', 't1', { flags: true });
        expect(upd.success).toBe(true);

        const read = await Course.getTAPermissions(db, 'C1', 't1');
        expect(read.success).toBe(true);
        expect(read.permissions).toEqual({ ...ALL_FALSE, flags: true });
    });

    test('updateTAPermissions rejects for a missing course or unassigned TA', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'] }] });
        expect(await Course.updateTAPermissions(db, 'NOPE', 't1', {})).toMatchObject({ success: false, error: 'Course not found' });
        expect(await Course.updateTAPermissions(db, 'C1', 't2', {})).toMatchObject({
            success: false, error: 'TA is not assigned to this course',
        });
    });
});

describe('Course.checkTAPermission', () => {
    test('reflects the stored per-permission flag', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', tas: ['t1'], taPermissions: { t1: { materials: true, questions: false, flags: false, roster: false, transcripts: false, settings: false } } }],
        });
        expect(await Course.checkTAPermission(db, 'C1', 't1', 'materials')).toBe(true);
        expect(await Course.checkTAPermission(db, 'C1', 't1', 'flags')).toBe(false);
    });

    test('does not let a stray stored key (e.g. updatedAt) resolve as a granted permission', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', tas: ['t1'], taPermissions: { t1: { materials: true, updatedAt: new Date() } } }],
        });
        expect(await Course.checkTAPermission(db, 'C1', 't1', 'updatedAt')).toBe(false);
    });

    test('returns false for an unknown feature, an unassigned TA, or a deleted course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'] }] });
        expect(await Course.checkTAPermission(db, 'C1', 't1', 'banana')).toBe(false);
        expect(await Course.checkTAPermission(db, 'C1', 't2', 'materials')).toBe(false);

        const deleted = memoryDb({ courses: [{ courseId: 'C1', tas: ['t1'], status: 'deleted' }] });
        expect(await Course.checkTAPermission(deleted, 'C1', 't1', 'materials')).toBe(false);
    });
});

describe('Course.getStudentEnrollment / updateStudentEnrollment', () => {
    test('reports "none" when the student has no enrollment entry', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        expect(await Course.getStudentEnrollment(db, 'C1', 's1')).toEqual({
            success: true, enrolled: false, status: 'none',
        });
    });

    test('distinguishes enrolled (true) from banned (explicit false)', async () => {
        const db = memoryDb({
            courses: [{ courseId: 'C1', studentEnrollment: { s1: { enrolled: true }, s2: { enrolled: false } } }],
        });
        expect(await Course.getStudentEnrollment(db, 'C1', 's1')).toMatchObject({ enrolled: true, status: 'enrolled' });
        expect(await Course.getStudentEnrollment(db, 'C1', 's2')).toMatchObject({ enrolled: false, status: 'banned' });
    });

    test('an inactive/deleted course bans everyone with reason course_inactive', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', status: 'inactive', studentEnrollment: { s1: { enrolled: true } } }] });
        expect(await Course.getStudentEnrollment(db, 'C1', 's1')).toEqual({
            success: true, enrolled: false, status: 'banned', reason: 'course_inactive',
        });
    });

    test('rejects when the course is missing', async () => {
        const db = memoryDb({ courses: [] });
        expect(await Course.getStudentEnrollment(db, 'NOPE', 's1')).toMatchObject({ success: false, error: 'Course not found' });
    });

    test('updateStudentEnrollment persists and is read back by getStudentEnrollment', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        const upd = await Course.updateStudentEnrollment(db, 'C1', 's1', true);
        expect(upd.success).toBe(true);
        expect(await Course.getStudentEnrollment(db, 'C1', 's1')).toMatchObject({ enrolled: true, status: 'enrolled' });
    });

    test('updateStudentEnrollment rejects for a missing course', async () => {
        const db = memoryDb({ courses: [] });
        expect(await Course.updateStudentEnrollment(db, 'NOPE', 's1', true)).toMatchObject({
            success: false, error: 'Course not found',
        });
    });
});

describe('Course.createCourseFromOnboarding', () => {
    const onboarding = {
        courseId: 'BIOC401',
        courseName: 'BIOC 401',
        instructorId: 'i1',
        learningOutcomes: ['Explain glycolysis', 'Describe the Krebs cycle'],
        courseStructure: { weeks: 2, lecturesPerWeek: 3 },
    };

    test('creates a course with weeks*lecturesPerWeek units and inserts it', async () => {
        const db = memoryDb({ courses: [] });
        const res = await Course.createCourseFromOnboarding(db, onboarding);
        expect(res).toMatchObject({ success: true, created: true, courseId: 'BIOC401', totalUnits: 6 });

        const stored = await db.collection('courses').findOne({ courseId: 'BIOC401' });
        expect(stored.lectures).toHaveLength(6);
        expect(stored.instructors).toEqual(['i1']);
        expect(stored.superchatIds).toEqual([]);
        expect(stored.yearLevel).toBe(4); // derived from "BIOC 401"
    });

    test('seeds Unit 1 with the onboarding learning outcomes; later units start empty', async () => {
        const db = memoryDb({ courses: [] });
        await Course.createCourseFromOnboarding(db, onboarding);
        const stored = await db.collection('courses').findOne({ courseId: 'BIOC401' });

        const unit1 = stored.lectures.find(l => l.name === 'Unit 1');
        const unit2 = stored.lectures.find(l => l.name === 'Unit 2');
        expect(unit1.learningObjectives).toEqual(onboarding.learningOutcomes);
        expect(unit1.passThreshold).toBe(2);
        expect(unit1.isPublished).toBe(false);
        expect(unit2.learningObjectives).toEqual([]);
    });

    test('does not recreate when a course with the same courseId already exists', async () => {
        const db = memoryDb({ courses: [{ courseId: 'BIOC401', instructorId: 'other', courseStructure: { totalUnits: 9 } }] });
        const res = await Course.createCourseFromOnboarding(db, onboarding);
        expect(res).toMatchObject({ success: true, created: false, modifiedCount: 0, message: 'Course already exists', totalUnits: 9 });
    });

    test('with the academic API on, creates an additional course even when the instructor already owns one', async () => {
        // An instructor can set up more than one course (e.g. another of their
        // sections); owning a different course must not block creation.
        const db = memoryDb({
            settings: [{ _id: 'global', academicApiEnabled: true }],
            courses: [{ courseId: 'OTHER', instructorId: 'i1' }]
        });
        const res = await Course.createCourseFromOnboarding(db, onboarding);
        expect(res).toMatchObject({ success: true, created: true, courseId: 'BIOC401', totalUnits: 6 });

        const stored = await db.collection('courses').findOne({ courseId: 'BIOC401' });
        expect(stored).not.toBeNull();
    });

    test('with the academic API off, an instructor who already owns a course cannot create a second', async () => {
        // Pre-feature behavior: one course per instructor. Owning any course
        // blocks creating another, so the multi-section flow stays gated off.
        const db = memoryDb({ courses: [{ courseId: 'OTHER', instructorId: 'i1', courseStructure: { totalUnits: 4 } }] });
        const res = await Course.createCourseFromOnboarding(db, onboarding);
        expect(res).toMatchObject({ success: true, created: false, message: 'Course already exists', courseId: 'OTHER' });

        const stored = await db.collection('courses').findOne({ courseId: 'BIOC401' });
        expect(stored).toBeNull();
    });
});

describe('Course.getRagSettings / updateRagSettings / updateAllowInSuperCourse', () => {
    test('getRagSettings resolves stored topK + allowInSuperCourse, defaulting topK to 3', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C1', ragSettings: { student: { topK: 8 } }, allowInSuperCourse: true },
            { courseId: 'C2' },
        ] });
        expect(await Course.getRagSettings(db, 'C1')).toEqual({
            success: true, ragSettings: { student: { topK: 8 } }, allowInSuperCourse: true,
        });
        expect(await Course.getRagSettings(db, 'C2')).toEqual({
            success: true, ragSettings: { student: { topK: 3 } }, allowInSuperCourse: false,
        });
    });

    test('getRagSettings rejects a missing or deleted course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', status: 'deleted' }] });
        expect(await Course.getRagSettings(db, 'C1')).toMatchObject({ success: false, error: 'Course not found' });
        expect(await Course.getRagSettings(db, 'NOPE')).toMatchObject({ success: false, error: 'Course not found' });
    });

    test('updateRagSettings rejects an out-of-range topK before writing', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        expect(await Course.updateRagSettings(db, 'C1', { student: { topK: 99 } })).toEqual({
            success: false, error: 'Student Chat Top-K must be an integer from 1 to 20',
        });
    });

    test('updateRagSettings persists a valid topK and reads back', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        const res = await Course.updateRagSettings(db, 'C1', { student: { topK: 7 } });
        expect(res).toEqual({ success: true, ragSettings: { student: { topK: 7 } }, error: null });
        expect(await Course.getRagSettings(db, 'C1')).toMatchObject({ ragSettings: { student: { topK: 7 } } });
    });

    test('updateRagSettings reports "Course not found" for a valid topK but missing course', async () => {
        const db = memoryDb({ courses: [] });
        expect(await Course.updateRagSettings(db, 'NOPE', { student: { topK: 5 } })).toMatchObject({
            success: false, error: 'Course not found',
        });
    });

    test('updateAllowInSuperCourse coerces to a strict boolean and persists', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        expect(await Course.updateAllowInSuperCourse(db, 'C1', 'yes')).toEqual({
            success: true, allowInSuperCourse: false, error: null, // only true stays true
        });
        expect(await Course.updateAllowInSuperCourse(db, 'C1', true)).toMatchObject({ allowInSuperCourse: true });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).allowInSuperCourse).toBe(true);
    });
});

describe('Course.getQuizSettings / updateQuizSettings', () => {
    test('getQuizSettings returns defaults for a missing course or unset settings', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        const defaults = { enabled: false, testableUnits: 'all', allowLectureMaterialAccess: true, allowSourceAttributionDownloads: false };
        expect(await Course.getQuizSettings(db, 'C1')).toEqual(defaults);
        expect(await Course.getQuizSettings(db, 'NOPE')).toEqual(defaults);
    });

    test('getQuizSettings merges stored values over defaults', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', quizSettings: { enabled: true } }] });
        expect(await Course.getQuizSettings(db, 'C1')).toEqual({
            enabled: true, testableUnits: 'all', allowLectureMaterialAccess: true, allowSourceAttributionDownloads: false,
        });
    });

    test('updateQuizSettings fills defaults, persists, and reads back', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        const res = await Course.updateQuizSettings(db, 'C1', { enabled: true }, 'i1');
        expect(res.success).toBe(true);
        expect(await Course.getQuizSettings(db, 'C1')).toEqual({
            enabled: true, testableUnits: 'all', allowLectureMaterialAccess: true, allowSourceAttributionDownloads: false,
        });
    });

    test('updateQuizSettings rejects a missing course', async () => {
        const db = memoryDb({ courses: [] });
        expect(await Course.updateQuizSettings(db, 'NOPE', {}, 'i1')).toMatchObject({ success: false, error: 'Course not found' });
    });
});

describe('Course.getAnonymizeStudents / updateAnonymizeStudents', () => {
    test('defaults to enabled=true when unset (anonymize on by default)', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        expect(await Course.getAnonymizeStudents(db, 'C1', 'i1')).toEqual({ success: true, enabled: true });
    });

    test('reads a per-instructor override and rejects a missing course', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', anonymizeStudents: { i1: { enabled: false } } }] });
        expect(await Course.getAnonymizeStudents(db, 'C1', 'i1')).toEqual({ success: true, enabled: false });
        expect(await Course.getAnonymizeStudents(db, 'NOPE', 'i1')).toMatchObject({ success: false, error: 'Course not found' });
    });

    test('updateAnonymizeStudents persists per instructor and reads back', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        expect(await Course.updateAnonymizeStudents(db, 'C1', 'i1', false)).toEqual({ success: true });
        expect(await Course.getAnonymizeStudents(db, 'C1', 'i1')).toEqual({ success: true, enabled: false });
        // A different instructor still gets the default.
        expect(await Course.getAnonymizeStudents(db, 'C1', 'i2')).toEqual({ success: true, enabled: true });
    });
});

describe('Course.joinCourse', () => {
    const base = { courseId: 'C1', courseCode: 'ABC123', courseName: 'Bio' };

    test('rejects missing, deactivated, or revoked-access cases', async () => {
        expect(await Course.joinCourse(memoryDb({ courses: [] }), 'NOPE', 's1', 'ABC123')).toMatchObject({
            success: false, error: 'Course not found',
        });
        expect(await Course.joinCourse(memoryDb({ courses: [{ ...base, status: 'inactive' }] }), 'C1', 's1', 'ABC123')).toMatchObject({
            success: false, error: 'Course is deactivated by the instructor',
        });
        const revoked = memoryDb({ courses: [{ ...base, studentEnrollment: { s1: { enrolled: false } } }] });
        expect(await Course.joinCourse(revoked, 'C1', 's1', 'ABC123')).toMatchObject({
            success: false, error: 'Access revoked by instructor',
        });
    });

    test('rejects a wrong code but accepts the correct code case-insensitively', async () => {
        const db = memoryDb({ courses: [{ ...base }] });
        expect(await Course.joinCourse(db, 'C1', 's1', 'WRONG')).toMatchObject({ success: false, error: 'Invalid course code' });

        const res = await Course.joinCourse(db, 'C1', 's1', '  abc123 ');
        expect(res).toMatchObject({ success: true, enrolled: true });
        expect(await Course.getStudentEnrollment(db, 'C1', 's1')).toMatchObject({ enrolled: true, status: 'enrolled' });
    });

    test('skipCodeValidation bypasses the code check', async () => {
        const db = memoryDb({ courses: [{ ...base }] });
        expect(await Course.joinCourse(db, 'C1', 's1', 'irrelevant', { skipCodeValidation: true })).toMatchObject({ success: true });
    });
});

describe('Course.joinCourseAsInstructor', () => {
    const base = { courseId: 'C1', instructorCourseCode: 'INS999', instructorId: 'owner', instructors: ['owner'] };

    test('short-circuits when the instructor already has access', async () => {
        const db = memoryDb({ courses: [{ ...base }] });
        expect(await Course.joinCourseAsInstructor(db, 'C1', 'owner', 'whatever')).toMatchObject({
            success: true, alreadyJoined: true,
        });
    });

    test('rejects a wrong code, then adds the instructor on the correct code', async () => {
        const db = memoryDb({ courses: [{ ...base }] });
        expect(await Course.joinCourseAsInstructor(db, 'C1', 'newby', 'WRONG')).toMatchObject({
            success: false, error: 'Invalid instructor course code',
        });
        const res = await Course.joinCourseAsInstructor(db, 'C1', 'newby', 'ins999');
        expect(res).toMatchObject({ success: true });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).instructors).toContain('newby');
    });

    test('rejects a deleted/inactive course', async () => {
        const db = memoryDb({ courses: [{ ...base, status: 'deleted' }] });
        expect(await Course.joinCourseAsInstructor(db, 'C1', 'newby', 'INS999')).toMatchObject({
            success: false, error: 'Course is not available to join',
        });
    });
});

describe('Course.getCoursesForUser', () => {
    test('instructor: matches primary or additional instructor, excludes deleted, inactive sorted last', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'ACTIVE', instructorId: 'i1', updatedAt: new Date('2026-01-01') },
            { courseId: 'EXTRA', instructors: ['i1'], updatedAt: new Date('2026-02-01') },
            { courseId: 'INACTIVE', instructorId: 'i1', status: 'inactive', updatedAt: new Date('2026-03-01') },
            { courseId: 'DELETED', instructorId: 'i1', status: 'deleted' },
            { courseId: 'OTHER', instructorId: 'someone-else' },
        ] });
        const ids = (await Course.getCoursesForUser(db, 'i1', 'instructor')).map(c => c.courseId);
        expect(ids).not.toContain('DELETED');
        expect(ids).not.toContain('OTHER');
        expect(ids).toEqual(['EXTRA', 'ACTIVE', 'INACTIVE']); // active by updatedAt desc, inactive last
    });

    test('ta: matches assigned TA courses, excluding deleted', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C1', tas: ['t1'] },
            { courseId: 'C2', tas: ['t1'], status: 'deleted' },
            { courseId: 'C3', tas: ['t2'] },
        ] });
        const ids = (await Course.getCoursesForUser(db, 't1', 'ta')).map(c => c.courseId);
        expect(ids).toEqual(['C1']);
    });
});

describe('Course lifecycle lookups', () => {
    test('getCourseById hides soft-deleted courses', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'ACTIVE', status: 'active' },
            { courseId: 'DELETED', status: 'deleted' },
        ] });
        await expect(Course.getCourseById(db, 'ACTIVE')).resolves.toMatchObject({ courseId: 'ACTIVE' });
        await expect(Course.getCourseById(db, 'DELETED')).resolves.toBeNull();
    });

    test('instructors cannot access a soft-deleted course through the shared helper', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'i1', status: 'deleted' }] });
        await expect(Course.userHasCourseAccess(db, 'C1', 'i1', 'instructor')).resolves.toBe(false);
    });
});

describe('Course.upsertCourse', () => {
    test('inserts a new course, generating two distinct course codes and timestamps', async () => {
        const db = memoryDb({ courses: [] });
        const result = await Course.upsertCourse(db, { courseId: 'NEW', courseName: 'Bio', instructorId: 'i1' });
        expect(result.upsertedCount).toBe(1);

        const stored = await db.collection('courses').findOne({ courseId: 'NEW' });
        expect(stored.courseCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
        expect(stored.instructorCourseCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
        expect(stored.instructorCourseCode).not.toBe(stored.courseCode);
        expect(stored.createdAt).toBeInstanceOf(Date);
    });

    test('regenerates the instructor code when it collides with the student code', async () => {
        const db = memoryDb({ courses: [] });
        await Course.upsertCourse(db, { courseId: 'NEW', courseCode: 'ABC234', instructorCourseCode: 'abc234' });
        const stored = await db.collection('courses').findOne({ courseId: 'NEW' });
        expect(stored.courseCode).toBe('ABC234');
        expect(stored.instructorCourseCode).not.toBe('abc234'); // collided -> regenerated
    });

    test('updates an existing course in place', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseCode: 'AAA111', instructorCourseCode: 'BBB222', courseName: 'Old' }] });
        const result = await Course.upsertCourse(db, { courseId: 'C1', courseCode: 'AAA111', instructorCourseCode: 'BBB222', courseName: 'New' });
        expect(result.matchedCount).toBe(1);
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).courseName).toBe('New');
    });
});

describe('Course.getPassThreshold', () => {
    test('returns the stored threshold, or 0 as the default', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [
            { name: 'Unit 1', passThreshold: 3 },
            { name: 'Unit 2' }, // no threshold -> 0
        ] }] });
        expect(await Course.getPassThreshold(db, 'C1', 'Unit 1')).toBe(3);
        expect(await Course.getPassThreshold(db, 'C1', 'Unit 2')).toBe(0);
        expect(await Course.getPassThreshold(db, 'C1', 'Missing')).toBe(0);
        expect(await Course.getPassThreshold(db, 'NOPE', 'Unit 1')).toBe(0);
    });
});

describe('Course.getLearningObjectives', () => {
    test('returns the lecture objectives, or [] when absent', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [
            { name: 'Unit 1', learningObjectives: ['LO1', 'LO2'] },
            { name: 'Unit 2' },
        ] }] });
        expect(await Course.getLearningObjectives(db, 'C1', 'Unit 1')).toEqual(['LO1', 'LO2']);
        expect(await Course.getLearningObjectives(db, 'C1', 'Unit 2')).toEqual([]);
        expect(await Course.getLearningObjectives(db, 'C1', 'Missing')).toEqual([]);
        expect(await Course.getLearningObjectives(db, 'NOPE', 'Unit 1')).toEqual([]);
    });
});

describe('Course.addInstructorToCourse', () => {
    test('rejects a missing course', async () => {
        expect(await Course.addInstructorToCourse(memoryDb({ courses: [] }), 'NOPE', 'i1')).toMatchObject({
            success: false, error: 'Course not found',
        });
    });

    test('adds the instructor (idempotently) and backfills instructorId when absent', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        await Course.addInstructorToCourse(db, 'C1', 'i1');
        await Course.addInstructorToCourse(db, 'C1', 'i1'); // idempotent via $addToSet
        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.instructors).toEqual(['i1']);
        expect(stored.instructorId).toBe('i1'); // backfilled (was absent)
    });

    test('does not overwrite an existing primary instructorId', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorId: 'owner', instructors: ['owner'] }] });
        await Course.addInstructorToCourse(db, 'C1', 'i2');
        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.instructorId).toBe('owner');
        expect(stored.instructors).toEqual(['owner', 'i2']);
    });
});

describe('Course.addTAToCourse', () => {
    test('rejects a missing course, otherwise adds the TA idempotently', async () => {
        expect(await Course.addTAToCourse(memoryDb({ courses: [] }), 'NOPE', 't1')).toMatchObject({
            success: false, error: 'Course not found',
        });
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        await Course.addTAToCourse(db, 'C1', 't1');
        await Course.addTAToCourse(db, 'C1', 't1');
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).tas).toEqual(['t1']);
    });
});
