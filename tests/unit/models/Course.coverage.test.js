/** Focused coverage for the remaining public Course model lifecycle helpers. */
const { memoryDb } = require('../helpers/memory-db');
const Course = require('../../../src/models/Course');

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('Course chat survey settings', () => {
    test('normalizes defaults, valid overrides, and invalid prompt/count values', () => {
        expect(Course.normalizeChatSurveyTriggerMessageCount(2)).toBe(2);
        expect(Course.normalizeChatSurveyTriggerMessageCount(31)).toBe(10);
        expect(Course.normalizeChatSurveyTriggerMessageCount('bad', 7)).toBe(7);
        expect(Course.resolveChatSurveySettings()).toEqual(Course.DEFAULT_CHAT_SURVEY_SETTINGS);
        expect(Course.resolveChatSurveySettings({ chatSurveySettings: {
            enabled: true,
            triggerMessageCount: '5',
            promptText: '  Useful   today? ',
            introText: '',
            accuracyPrompt: 42,
            satisfactionPrompt: ' Happy? ',
            allowFreeText: true,
        } })).toMatchObject({
            enabled: true,
            triggerMessageCount: 5,
            promptText: 'Useful today?',
            introText: Course.DEFAULT_CHAT_SURVEY_SETTINGS.introText,
            accuracyPrompt: Course.DEFAULT_CHAT_SURVEY_SETTINGS.accuracyPrompt,
            satisfactionPrompt: 'Happy?',
            allowFreeText: true,
        });
    });

    test('gets defaults/stored settings and rejects missing courses', async () => {
        const db = memoryDb({ courses: [
            { courseId: 'C1', chatSurveySettings: { enabled: true, triggerMessageCount: 4 } },
            { courseId: 'GONE', status: 'deleted' },
        ] });
        await expect(Course.getChatSurveySettings(db, 'C1')).resolves.toMatchObject({
            success: true,
            settings: { enabled: true, triggerMessageCount: 4 },
            defaults: { minTriggerMessageCount: 2, maxTriggerMessageCount: 30 },
        });
        await expect(Course.getChatSurveySettings(db, 'missing')).resolves.toEqual({ success: false, error: 'Course not found' });
        await expect(Course.getChatSurveySettings(db, 'GONE')).resolves.toEqual({ success: false, error: 'Course not found' });
    });

    test('validates and persists survey settings with updater metadata', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        await expect(Course.updateChatSurveySettings(db, 'C1', { triggerMessageCount: 1 }))
            .resolves.toMatchObject({ success: false, error: 'Survey trigger must be an integer from 2 to 30' });
        const result = await Course.updateChatSurveySettings(db, 'C1', {
            enabled: true, triggerMessageCount: '', allowFreeText: false, promptText: ' Prompt ',
        }, 'i1');
        expect(result).toMatchObject({ success: true, settings: { enabled: true, triggerMessageCount: 10, promptText: 'Prompt', updatedById: 'i1' }, error: null });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).lastUpdatedById).toBe('i1');
        await expect(Course.updateChatSurveySettings(db, 'missing', { triggerMessageCount: 5 }))
            .resolves.toMatchObject({ success: false, error: 'Course not found' });
    });
});

describe('Course code migration and collection access', () => {
    test('returns the courses collection', () => {
        const db = memoryDb({ courses: [] });
        expect(Course.getCoursesCollection(db)).toBe(db.collection('courses'));
    });

    test('migrates missing/equal codes while preserving distinct existing codes', async () => {
        const updates = [];
        const docs = [
            { _id: '1', courseId: 'A' },
            { _id: '2', courseId: 'B', courseCode: 'SAME', instructorCourseCode: ' same ' },
            { _id: '3', courseId: 'C', courseCode: 'STUDENT', instructorCourseCode: 'TEACHER' },
        ];
        const db = { collection: () => ({
            find: () => ({ toArray: async () => docs }),
            updateOne: jest.fn(async (query, update) => { updates.push({ query, update }); return { modifiedCount: 1 }; }),
        }) };
        await Course.ensureCourseCodes(db);
        expect(updates).toHaveLength(3);
        expect(updates[0].update.$set.courseCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
        expect(updates[1].update.$set.instructorCourseCode).not.toBe(' same ');
        expect(updates[2].update.$set).toMatchObject({ courseCode: 'STUDENT', instructorCourseCode: 'TEACHER' });
    });

    test('does nothing when no courses require migration', async () => {
        const updateOne = jest.fn();
        const db = { collection: () => ({ find: () => ({ toArray: async () => [] }), updateOne }) };
        await Course.ensureCourseCodes(db);
        expect(updateOne).not.toHaveBeenCalled();
    });

    test('retries generated code collisions and tolerates non-string supplied codes', async () => {
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);
        const db = memoryDb({ courses: [] });
        await Course.upsertCourse(db, {
            courseId: 'C1', courseCode: 'AAAAAA', instructorCourseCode: 123,
        });
        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.instructorCourseCode).toBe(123);
        random.mockRestore();

        const collisionDb = memoryDb({ courses: [] });
        const sequence = jest.spyOn(Math, 'random')
            .mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0)
            .mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0)
            .mockReturnValue(0.1);
        await Course.upsertCourse(collisionDb, { courseId: 'C2', instructorCourseCode: 'AAAAAA' });
        expect((await collisionDb.collection('courses').findOne({ courseId: 'C2' })).courseCode).not.toBe('AAAAAA');
        sequence.mockRestore();
    });

    test('fails without writing when every generated code collides', async () => {
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);
        const db = memoryDb({ courses: [] });
        let error;

        try {
            await Course.upsertCourse(db, {
                courseId: 'C1', instructorCourseCode: 'AAAAAA',
            });
        } catch (caught) {
            error = caught;
        } finally {
            random.mockRestore();
        }

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Unable to generate a distinct course code after 20 attempts');
        expect(await db.collection('courses').findOne({ courseId: 'C1' })).toBeNull();
    });

    test('course onboarding does not insert when instructor-code generation exhausts collisions', async () => {
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);
        const db = memoryDb({ courses: [] });
        let error;

        try {
            await Course.createCourseFromOnboarding(db, {
                courseId: 'C1', courseName: 'BIOC 101', instructorId: 'i1',
                courseStructure: { weeks: 1, lecturesPerWeek: 1 },
            });
        } catch (caught) {
            error = caught;
        } finally {
            random.mockRestore();
        }

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Unable to generate a distinct course code after 20 attempts');
        expect(await db.collection('courses').findOne({ courseId: 'C1' })).toBeNull();
    });
});

describe('Course lecture metadata writes', () => {
    const seeded = () => memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1' }] }] });

    test.each([
        ['updateLecturePublishStatus', [true, 'i1']],
        ['updateLearningObjectives', [['LO1'], 'i1']],
        ['updatePassThreshold', [3, 'i1']],
    ])('%s distinguishes missing course, missing lecture, and success', async (method, tail) => {
        const fn = Course[method];
        await expect(fn(memoryDb({ courses: [] }), 'missing', 'Unit 1', ...tail)).resolves.toMatchObject({ success: false, error: 'Course not found' });
        await expect(fn(seeded(), 'C1', 'missing', ...tail)).resolves.toMatchObject({ success: false, error: expect.stringMatching(/Lecture not found/) });
        await expect(fn(seeded(), 'C1', 'Unit 1', ...tail)).resolves.toMatchObject({ success: true, created: false });
    });

    test.each([
        ['updateLecturePublishStatus', [true, 'i1']],
        ['updateLearningObjectives', [['LO1'], 'i1']],
        ['updatePassThreshold', [3, 'i1']],
    ])('%s fails when the lecture disappears before the positional write', async (method, tail) => {
        const collection = {
            findOne: jest.fn().mockResolvedValue({ courseId: 'C1', lectures: [{ name: 'Unit 1' }] }),
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
        };

        await expect(Course[method]({ collection: () => collection }, 'C1', 'Unit 1', ...tail))
            .resolves.toEqual({ success: false, error: 'Course or lecture no longer exists' });
    });
});

describe('Course onboarding/unit lifecycle', () => {
    test('gets onboarding course data and propagates database errors', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', courseName: 'Bio' }] });
        await expect(Course.getCourseWithOnboarding(db, 'C1')).resolves.toMatchObject({ courseName: 'Bio' });
        await expect(Course.getCourseWithOnboarding(db, 'missing')).resolves.toBeNull();
        const error = new Error('read failed');
        const broken = { collection: () => ({ findOne: jest.fn().mockRejectedValue(error) }) };
        await expect(Course.getCourseWithOnboarding(broken, 'C1')).rejects.toBe(error);
    });

    test('createCourseFromOnboarding propagates database failures', async () => {
        const error = new Error('onboarding read failed');
        const broken = { collection: () => ({ findOne: jest.fn().mockRejectedValue(error) }) };
        await expect(Course.createCourseFromOnboarding(broken, {
            courseId: 'C1', courseName: 'BIOC 101', instructorId: 'i1',
            courseStructure: { weeks: 1, lecturesPerWeek: 1 },
        })).rejects.toBe(error);
    });

    test('deleteUnit reports the database modification and propagates errors', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1' }, { name: 'Unit 2' }] }] });
        await expect(Course.deleteUnit(db, 'C1', 'Unit 1')).resolves.toMatchObject({ success: true, courseId: 'C1', unitName: 'Unit 1' });
        const error = new Error('write failed');
        const broken = { collection: () => ({ updateOne: jest.fn().mockRejectedValue(error) }) };
        await expect(Course.deleteUnit(broken, 'C1', 'Unit 1')).rejects.toBe(error);
    });

    test('updateUnitDisplayName validates course/unit and supports set/clear', async () => {
        await expect(Course.updateUnitDisplayName(memoryDb({ courses: [] }), 'C1', 'Unit 1', 'Name', 'i1'))
            .resolves.toEqual({ success: false, error: 'Course not found' });
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', displayName: 'Old' }] }] });
        await expect(Course.updateUnitDisplayName(db, 'C1', 'missing', 'Name', 'i1'))
            .resolves.toEqual({ success: false, error: 'Unit not found' });
        // showUnitNumber omitted -> defaults to true
        await expect(Course.updateUnitDisplayName(db, 'C1', 'Unit 1', '  New name ', 'i1'))
            .resolves.toMatchObject({ success: true, displayName: 'New name', showUnitNumber: true });
        await expect(Course.updateUnitDisplayName(db, 'C1', 'Unit 1', '   ', 'i1'))
            .resolves.toMatchObject({ success: true, displayName: null, showUnitNumber: true });
    });

    test('updateUnitDisplayName persists showUnitNumber: false and unsets it when the title is cleared', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1' }] }] });

        await expect(Course.updateUnitDisplayName(db, 'C1', 'Unit 1', 'Biology', 'i1', false))
            .resolves.toMatchObject({ success: true, displayName: 'Biology', showUnitNumber: false });
        let saved = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(saved.lectures[0]).toMatchObject({ displayName: 'Biology', showUnitNumber: false });

        // Clearing the title removes showUnitNumber too, so the unit returns to a clean state
        await expect(Course.updateUnitDisplayName(db, 'C1', 'Unit 1', '', 'i1'))
            .resolves.toMatchObject({ success: true, displayName: null, showUnitNumber: true });
        saved = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(saved.lectures[0]).not.toHaveProperty('displayName');
        expect(saved.lectures[0]).not.toHaveProperty('showUnitNumber');
    });

    test('updateUnitDisplayName fails when its positional write no longer matches', async () => {
        const collection = {
            findOne: jest.fn().mockResolvedValue({ courseId: 'C1', lectures: [{ name: 'Unit 1' }] }),
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
        };

        await expect(Course.updateUnitDisplayName(
            { collection: () => collection }, 'C1', 'Unit 1', 'New', 'i1'
        )).resolves.toEqual({ success: false, error: 'Course or unit no longer exists' });
    });
});

describe('Course residual result and sorting branches', () => {
    test('sorts same-status/same-date courses by name and supports empty metadata', async () => {
        const sameDate = new Date('2026-01-01');
        const db = memoryDb({ courses: [
            { courseId: 'Z', courseName: 'Zulu', instructorId: 'i1', updatedAt: sameDate },
            { courseId: 'A', courseName: 'Alpha', instructorId: 'i1', updatedAt: sameDate },
            { courseId: 'NO_NAME', instructorId: 'i1' },
        ] });
        expect((await Course.getCoursesForUser(db, 'i1', 'instructor')).map(course => course.courseId))
            .toEqual(['A', 'Z', 'NO_NAME']);
    });

    test('writes updater IDs for RAG, Super Course, and superchat changes', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1' }] });
        await Course.updateRagSettings(db, 'C1', { student: { topK: 4 } }, 'i1');
        await Course.updateAllowInSuperCourse(db, 'C1', true, 'i2');
        await Course.updateCourseSuperchats(db, 'C1', ['b1'], 'i3');
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).lastUpdatedById).toBe('i3');
    });

    test('reports no-op write failures for TA permissions and enrollment', async () => {
        const course = { courseId: 'C1', tas: ['t1'] };
        const collection = {
            findOne: jest.fn().mockResolvedValue(course),
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 0 }),
        };
        const db = { collection: () => collection };
        await expect(Course.updateTAPermissions(db, 'C1', 't1', {}))
            .resolves.toEqual({ success: false, error: 'Failed to update TA permissions' });
        await expect(Course.updateStudentEnrollment(db, 'C1', 's1', true))
            .resolves.toEqual({ success: false, error: 'Failed to update student enrollment' });
    });

    test('joinCourseAsInstructor handles missing course, bypass, and primary-instructor backfill', async () => {
        await expect(Course.joinCourseAsInstructor(memoryDb({ courses: [] }), 'C1', 'i1', 'x'))
            .resolves.toEqual({ success: false, error: 'Course not found' });
        const db = memoryDb({ courses: [{ courseId: 'C1', instructorCourseCode: 'secret' }] });
        await expect(Course.joinCourseAsInstructor(db, 'C1', 'i1', 'wrong', { skipCodeValidation: true }))
            .resolves.toMatchObject({ success: true });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).instructorId).toBe('i1');
    });

    test('updateAnonymizeStudents reports a missing course', async () => {
        await expect(Course.updateAnonymizeStudents(memoryDb({ courses: [] }), 'missing', 'i1', true))
            .resolves.toEqual({ success: false, error: 'Course not found' });
    });
});

describe('Course document lifecycle', () => {
    test('addDocumentToUnit validates parents and covers create/update contracts', async () => {
        await expect(Course.addDocumentToUnit(memoryDb({ courses: [] }), 'C1', 'Unit 1', { documentId: 'd1' }, 'i1'))
            .resolves.toEqual({ success: false, error: 'Course not found' });
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [{ name: 'Unit 1', documents: [{ documentId: 'd1' }] }] }] });
        await expect(Course.addDocumentToUnit(db, 'C1', 'missing', { documentId: 'd1' }, 'i1'))
            .resolves.toEqual({ success: false, error: 'Unit not found' });
        await expect(Course.addDocumentToUnit(db, 'C1', 'Unit 1', { documentId: 'd1', filename: 'new.pdf' }, 'i1'))
            .resolves.toMatchObject({ success: true, created: false });
        await expect(Course.addDocumentToUnit(db, 'C1', 'Unit 1', { documentId: 'd2' }, 'i1'))
            .resolves.toMatchObject({ success: true, created: true });
    });

    test.each([
        ['an existing document', [{ documentId: 'd1' }], 'Document or unit no longer exists'],
        ['a new document', [], 'Course or unit no longer exists'],
    ])('addDocumentToUnit fails when %s disappears before the write', async (_case, documents, error) => {
        const collection = {
            findOne: jest.fn().mockResolvedValue({
                courseId: 'C1', lectures: [{ name: 'Unit 1', documents }],
            }),
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
        };

        await expect(Course.addDocumentToUnit(
            { collection: () => collection }, 'C1', 'Unit 1', { documentId: 'd1' }, 'i1'
        )).resolves.toEqual({ success: false, error });
    });

    test('removeDocumentFromAnyUnit handles missing course/document and removes all matches', async () => {
        await expect(Course.removeDocumentFromAnyUnit(memoryDb({ courses: [] }), 'C1', 'd1', 'i1'))
            .resolves.toEqual({ success: false, error: 'Course not found during update' });
        const db = memoryDb({ courses: [{ courseId: 'C1', lectures: [
            { name: 'U1', documents: [{ documentId: 'd1' }, { documentId: 'keep' }] },
            { name: 'U2', documents: [{ documentId: 'd1' }] },
            { name: 'U3' },
        ] }] });
        await expect(Course.removeDocumentFromAnyUnit(db, 'C1', 'missing', 'i1'))
            .resolves.toEqual({ success: false, error: 'Document not found in any unit' });
        await expect(Course.removeDocumentFromAnyUnit(db, 'C1', 'd1', 'i1'))
            .resolves.toMatchObject({ success: true, documentId: 'd1' });
        const stored = await db.collection('courses').findOne({ courseId: 'C1' });
        expect(stored.lectures.flatMap(unit => unit.documents || []).map(doc => doc.documentId)).toEqual(['keep']);
    });
});

describe('Course approved struggle topics', () => {
    test('gets normalized labels/objects and returns empty for absent data', async () => {
        const db = memoryDb({ courses: [{ courseId: 'C1', approvedStruggleTopics: [' ATP ', { topic: 'Krebs', unitId: 'U1' }] }] });
        await expect(Course.getApprovedStruggleTopics(db, 'C1')).resolves.toEqual(['ATP', 'Krebs']);
        await expect(Course.getApprovedStruggleTopicObjects(db, 'C1')).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ topic: 'ATP' }), expect.objectContaining({ topic: 'Krebs', unitId: 'U1' }),
        ]));
        await expect(Course.getApprovedStruggleTopics(db, 'missing')).resolves.toEqual([]);
        await expect(Course.getApprovedStruggleTopicObjects(memoryDb({ courses: [{ courseId: 'C2' }] }), 'C2')).resolves.toEqual([]);
    });

    test('setApprovedStruggleTopics validates course, preserves legacy strings, and stores mapped objects', async () => {
        await expect(Course.setApprovedStruggleTopics(memoryDb({ courses: [] }), 'C1', ['ATP'], 'i1'))
            .resolves.toMatchObject({ success: false, error: 'Course not found', topics: [] });
        const db = memoryDb({ courses: [{ courseId: 'C1', approvedStruggleTopics: ['ATP'] }] });
        const result = await Course.setApprovedStruggleTopics(db, 'C1', ['ATP', { topic: 'Krebs', unitId: 'U1', source: 'scraped' }], 'i1');
        expect(result).toMatchObject({ success: true, topicLabels: ['ATP', 'Krebs'], error: null });
        expect((await db.collection('courses').findOne({ courseId: 'C1' })).approvedStruggleTopics[0]).toBe('ATP');
    });

    test('updateApprovedStruggleTopicUnit validates inputs and maps/unmaps a topic', async () => {
        const db = memoryDb({ courses: [{
            courseId: 'C1', lectures: [{ name: 'Unit 1' }], approvedStruggleTopics: ['ATP'],
        }] });
        await expect(Course.updateApprovedStruggleTopicUnit(memoryDb({ courses: [] }), 'C1', 'ATP', null, 'i1'))
            .resolves.toEqual({ success: false, error: 'Course not found' });
        await expect(Course.updateApprovedStruggleTopicUnit(db, 'C1', ' ', null, 'i1'))
            .resolves.toEqual({ success: false, error: 'Topic is required' });
        await expect(Course.updateApprovedStruggleTopicUnit(db, 'C1', 'ATP', 'missing', 'i1'))
            .resolves.toEqual({ success: false, error: 'Unit not found in this course' });
        await expect(Course.updateApprovedStruggleTopicUnit(db, 'C1', 'Unknown', null, 'i1'))
            .resolves.toEqual({ success: false, error: 'Approved topic not found' });
        await expect(Course.updateApprovedStruggleTopicUnit(db, 'C1', 'atp', ' Unit 1 ', 'i1'))
            .resolves.toMatchObject({ success: true, topic: { topic: 'ATP', unitId: 'Unit 1' } });
        await expect(Course.updateApprovedStruggleTopicUnit(db, 'C1', 'ATP', null, 'i1'))
            .resolves.toMatchObject({ success: true, topic: { unitId: null } });
    });
});
