/**
 * Unit tests for src/models/User.js against the in-memory Mongo double.
 */
jest.mock('../../../src/models/StruggleActivity', () => ({
    createActivityEntry: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../src/models/PersistenceTopic', () => ({
    incrementStudentCount: jest.fn().mockResolvedValue({ success: true }),
}));

const bcrypt = require('bcryptjs');
const { memoryDb } = require('../helpers/memory-db');
const StruggleActivity = require('../../../src/models/StruggleActivity');
const PersistenceTopic = require('../../../src/models/PersistenceTopic');
const User = require('../../../src/models/User');

const COLL = 'users';

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
});

beforeEach(() => {
    jest.clearAllMocks();
});

function userDoc(overrides = {}) {
    return {
        userId: 'u1',
        username: 'student1',
        email: 'student@example.com',
        passwordHash: null,
        role: 'student',
        displayName: 'Student One',
        authProvider: 'basic',
        isActive: true,
        lastLogin: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        preferences: { theme: 'light', notifications: true, courseId: 'C1' },
        permissions: { systemAdmin: false },
        struggleState: { topics: [] },
        ...overrides,
    };
}

describe('User.getUsersCollection', () => {
    test('returns the users collection', () => {
        const db = memoryDb({});
        expect(User.getUsersCollection(db)).toBe(db.collection(COLL));
    });
});

describe('User.createUser', () => {
    test('creates a basic active user with normalized email, defaults, and hashed password', async () => {
        const db = memoryDb({});

        const result = await User.createUser(db, {
            username: 'student1',
            email: '  Student@Example.COM ',
            password: 'secret-pass',
            role: 'student',
            displayName: '  ',
            courseId: 'C1',
        });

        expect(result).toMatchObject({
            success: true,
            insertedId: 'mem-1',
            user: {
                username: 'student1',
                email: 'student@example.com',
                role: 'student',
                baseRole: 'student',
                displayName: 'student1',
                authProvider: 'basic',
                permissions: { systemAdmin: false },
            },
        });
        expect(result.userId).toMatch(/^user_[0-9a-f-]{36}$/i);

        const stored = await db.collection(COLL).findOne({ userId: result.userId });
        expect(stored).toMatchObject({
            username: 'student1',
            email: 'student@example.com',
            role: 'student',
            isActive: true,
            lastLogin: null,
            preferences: { theme: 'light', notifications: true, courseId: 'C1' },
            permissions: { systemAdmin: false },
            struggleState: { topics: [] },
        });
        expect(stored.passwordHash).not.toBe('secret-pass');
        await expect(bcrypt.compare('secret-pass', stored.passwordHash)).resolves.toBe(true);
        expect(stored.createdAt).toBeInstanceOf(Date);
        expect(stored.updatedAt).toBeInstanceOf(Date);
    });

    test('persists an explicit systemAdmin permission and displayName', async () => {
        const db = memoryDb({});

        const result = await User.createUser(db, {
            username: 'admin1',
            email: 'admin@example.com',
            role: 'student',
            displayName: 'Admin One',
            permissions: { systemAdmin: true },
        });

        expect(result.user).toMatchObject({
            displayName: 'Admin One',
            role: 'student',
            baseRole: 'student',
            permissions: { systemAdmin: true },
        });
        const stored = await db.collection(COLL).findOne({ userId: result.userId });
        expect(stored.permissions.systemAdmin).toBe(true);
    });

    test('rejects duplicate username', async () => {
        const db = memoryDb({ [COLL]: [userDoc({ username: 'student1', email: 'other@example.com' })] });

        await expect(User.createUser(db, {
            username: 'student1',
            email: 'new@example.com',
            role: 'student',
        })).resolves.toEqual({
            success: false,
            error: 'User already exists with this username',
        });
    });

    test('rejects duplicate normalized email', async () => {
        const db = memoryDb({ [COLL]: [userDoc({ username: 'other', email: 'student@example.com' })] });

        await expect(User.createUser(db, {
            username: 'student1',
            email: ' STUDENT@example.com ',
            role: 'student',
        })).resolves.toEqual({
            success: false,
            error: 'User already exists with this email address',
        });
    });
});

describe('User.authenticateUser', () => {
    test('authenticates by username, updates lastLogin, and returns a session user', async () => {
        const passwordHash = await bcrypt.hash('secret-pass', 4);
        const db = memoryDb({ [COLL]: [userDoc({ passwordHash })] });

        const result = await User.authenticateUser(db, 'student1', 'secret-pass');

        expect(result).toMatchObject({
            success: true,
            user: {
                userId: 'u1',
                username: 'student1',
                email: 'student@example.com',
                role: 'student',
                baseRole: 'student',
                authProvider: 'basic',
                invitedCourses: [],
                permissions: { systemAdmin: false },
            },
        });

        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.lastLogin).toBeInstanceOf(Date);
        expect(stored.updatedAt).toBeInstanceOf(Date);
    });

    test('authenticates by normalized email', async () => {
        const passwordHash = await bcrypt.hash('secret-pass', 4);
        const db = memoryDb({ [COLL]: [userDoc({ passwordHash })] });

        await expect(User.authenticateUser(db, ' STUDENT@EXAMPLE.COM ', 'secret-pass'))
            .resolves.toMatchObject({ success: true, user: { userId: 'u1' } });
    });

    test('rejects missing users, inactive users, and wrong passwords with the same error', async () => {
        const passwordHash = await bcrypt.hash('secret-pass', 4);
        const db = memoryDb({
            [COLL]: [
                userDoc({ username: 'active', email: 'active@example.com', passwordHash }),
                userDoc({ username: 'inactive', email: 'inactive@example.com', passwordHash, isActive: false }),
            ],
        });

        await expect(User.authenticateUser(db, 'missing', 'secret-pass')).resolves.toEqual({
            success: false,
            error: 'Invalid username or password',
        });
        await expect(User.authenticateUser(db, 'inactive', 'secret-pass')).resolves.toEqual({
            success: false,
            error: 'Invalid username or password',
        });
        await expect(User.authenticateUser(db, 'active', 'wrong')).resolves.toEqual({
            success: false,
            error: 'Invalid username or password',
        });
    });

    test('rejects a basic user with no passwordHash without updating lastLogin', async () => {
        const db = memoryDb({ [COLL]: [userDoc({ username: 'nohash', email: 'nohash@example.com', passwordHash: null })] });

        await expect(User.authenticateUser(db, 'nohash', 'anything')).resolves.toEqual({
            success: false,
            error: 'Invalid username or password',
        });

        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.lastLogin).toBeNull();
    });

    test.each([
        ['a CWL account', { authProvider: 'saml', passwordHash: null }],
        ['a CWL account that still has an old local hash', { authProvider: 'saml', passwordHash: 'from-elsewhere' }],
        ['an account with no provider recorded', { authProvider: undefined, passwordHash: 'from-elsewhere' }],
    ])('signs in only local accounts with a password: refuses %s', async (_label, overrides) => {
        const passwordHash = overrides.passwordHash === 'from-elsewhere'
            ? await bcrypt.hash('secret-pass', 4)
            : overrides.passwordHash;
        const db = memoryDb({ [COLL]: [userDoc({
            username: 'cwl-admin',
            email: 'cwl.admin@ubc.ca',
            role: 'instructor',
            permissions: { systemAdmin: true },
            ...overrides,
            passwordHash,
        })] });

        for (const password of ['anything', 'secret-pass']) {
            await expect(User.authenticateUser(db, 'cwl.admin@ubc.ca', password)).resolves.toEqual({
                success: false,
                error: 'Invalid username or password',
            });
        }

        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.lastLogin).toBeNull();
    });

    test('a local account still signs in when a CWL account has the same email', async () => {
        const passwordHash = await bcrypt.hash('secret-pass', 4);
        const db = memoryDb({ [COLL]: [
            userDoc({ userId: 'cwl', username: 'shared@ubc.ca', email: 'shared@ubc.ca', authProvider: 'saml', passwordHash: null }),
            userDoc({ userId: 'local', username: 'shared-local', email: 'shared@ubc.ca', passwordHash }),
        ] });

        await expect(User.authenticateUser(db, 'shared@ubc.ca', 'secret-pass'))
            .resolves.toMatchObject({ success: true, user: { userId: 'local', authProvider: 'basic' } });
        await expect(User.authenticateUser(db, 'shared@ubc.ca', 'wrong')).resolves.toMatchObject({ success: false });
    });
});

describe('User.getUserById / getUserByPuid', () => {
    test('getUserById returns an active session-shaped user and elevates system admins', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                email: ' Admin@Example.COM ',
                permissions: { systemAdmin: true },
                invitedCourses: ['C1'],
            })],
        });

        await expect(User.getUserById(db, 'u1')).resolves.toMatchObject({
            userId: 'u1',
            email: 'admin@example.com',
            role: 'instructor',
            baseRole: 'student',
            invitedCourses: ['C1'],
            permissions: { systemAdmin: true },
            struggleState: { topics: [] },
        });
    });

    test('getUserById returns null for missing or inactive users', async () => {
        const db = memoryDb({ [COLL]: [userDoc({ userId: 'inactive', isActive: false })] });

        await expect(User.getUserById(db, 'missing')).resolves.toBeNull();
        await expect(User.getUserById(db, 'inactive')).resolves.toBeNull();
    });

    test('getUserByPuid returns null for falsy, missing, or inactive PUIDs', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({ puid: 'P1', isActive: false })],
        });

        await expect(User.getUserByPuid(db, '')).resolves.toBeNull();
        await expect(User.getUserByPuid(db, null)).resolves.toBeNull();
        await expect(User.getUserByPuid(db, 'missing')).resolves.toBeNull();
        await expect(User.getUserByPuid(db, 'P1')).resolves.toBeNull();
    });

    test('getUserByPuid returns an active user with PUID and access state applied', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({ puid: 'P1', role: 'ta', permissions: { systemAdmin: false } })],
        });

        await expect(User.getUserByPuid(db, 'P1')).resolves.toMatchObject({
            userId: 'u1',
            puid: 'P1',
            role: 'ta',
            baseRole: 'ta',
            permissions: { systemAdmin: false },
        });
    });
});

describe('User.updateUserPreferences', () => {
    test('replaces preferences and stamps updatedAt', async () => {
        const db = memoryDb({ [COLL]: [userDoc()] });
        const preferences = { theme: 'dark', notifications: false, courseId: 'C2' };

        await expect(User.updateUserPreferences(db, 'u1', preferences)).resolves.toEqual({
            success: true,
            modifiedCount: 1,
        });
        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.preferences).toEqual(preferences);
        expect(stored.updatedAt).toBeInstanceOf(Date);
    });

    test('returns a failure object when no user matches', async () => {
        const db = memoryDb({ [COLL]: [] });

        await expect(User.updateUserPreferences(db, 'missing', {})).resolves.toEqual({
            success: false,
            error: 'User not found or no changes made',
        });
    });
});

describe('User.createOrGetSAMLUser', () => {
    test('fails when SAML data has no PUID, SAML id, or email', async () => {
        const db = memoryDb({});

        await expect(User.createOrGetSAMLUser(db, { displayName: 'No ID' })).resolves.toEqual({
            success: false,
            error: 'SAML data missing required identifier (puid or samlId)',
        });
    });

    test('creates a new SAML user with normalized email and defaults', async () => {
        const db = memoryDb({});

        const result = await User.createOrGetSAMLUser(db, {
            samlId: 'saml-1',
            puid: 'P1',
            email: ' Student@Example.COM ',
            username: 'student1',
            displayName: 'Student One',
            role: 'student',
        });

        expect(result).toMatchObject({
            success: true,
            insertedId: 'mem-1',
            user: {
                username: 'student1',
                email: 'student@example.com',
                role: 'student',
                baseRole: 'student',
                displayName: 'Student One',
                authProvider: 'saml',
                permissions: { systemAdmin: false },
                invitedCourses: [],
            },
        });
        expect(result.userId).toMatch(/^user_[0-9a-f-]{36}$/i);

        const stored = await db.collection(COLL).findOne({ userId: result.userId });
        expect(stored).toMatchObject({
            passwordHash: null,
            authProvider: 'saml',
            samlId: 'saml-1',
            puid: 'P1',
            isActive: true,
            preferences: { theme: 'light', notifications: true, courseId: null },
        });
        expect(stored.lastLogin).toBeInstanceOf(Date);
    });

    test('email-only SAML data creates a user despite the missing-identifier error text', async () => {
        const db = memoryDb({});

        const result = await User.createOrGetSAMLUser(db, {
            email: 'email-only@example.com',
            displayName: 'Email Only',
        });

        expect(result).toMatchObject({
            success: true,
            user: {
                username: 'email-only@example.com',
                email: 'email-only@example.com',
                role: 'student',
            },
        });
    });

    test('updates an existing SAML user by PUID and reapplies non-TA role changes', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                userId: 'saml-user',
                username: 'old@example.com',
                email: 'old@example.com',
                role: 'student',
                displayName: 'old@example.com',
                authProvider: 'saml',
                puid: 'P1',
                samlId: null,
            })],
        });

        const result = await User.createOrGetSAMLUser(db, {
            puid: 'P1',
            samlId: 'new-saml',
            email: 'New@Example.COM',
            username: 'newuser',
            displayName: 'New Name',
            role: 'instructor',
        });

        expect(result).toMatchObject({
            success: true,
            user: {
                userId: 'saml-user',
                username: 'newuser',
                email: 'new@example.com',
                role: 'instructor',
                baseRole: 'instructor',
                displayName: 'New Name',
            },
        });
        const stored = await db.collection(COLL).findOne({ userId: 'saml-user' });
        expect(stored).toMatchObject({
            samlId: 'new-saml',
            email: 'new@example.com',
            username: 'newuser',
            displayName: 'New Name',
            role: 'instructor',
        });
        expect(stored.lastLogin).toBeInstanceOf(Date);
    });

    test('preserves an existing manually granted TA role during SAML login', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                userId: 'ta-user',
                role: 'ta',
                baseRole: 'ta',
                authProvider: 'saml',
                puid: 'P1',
            })],
        });

        const result = await User.createOrGetSAMLUser(db, {
            puid: 'P1',
            email: 'student@example.com',
            role: 'student',
        });

        expect(result).toMatchObject({
            success: true,
            user: { userId: 'ta-user', role: 'ta', baseRole: 'ta' },
        });
        const stored = await db.collection(COLL).findOne({ userId: 'ta-user' });
        expect(stored.role).toBe('ta');
    });
});

describe('User.getUsersByRole / deactivateUser', () => {
    test('getUsersByRole returns active users for the role newest first', async () => {
        const db = memoryDb({
            [COLL]: [
                userDoc({ userId: 'old', role: 'student', isActive: true, createdAt: new Date('2026-01-01') }),
                userDoc({ userId: 'new', role: 'student', isActive: true, createdAt: new Date('2026-03-01') }),
                userDoc({ userId: 'inactive', role: 'student', isActive: false, createdAt: new Date('2026-04-01') }),
                userDoc({ userId: 'instructor', role: 'instructor', isActive: true, createdAt: new Date('2026-02-01') }),
            ],
        });

        const users = await User.getUsersByRole(db, 'student');
        expect(users.map(u => u.userId)).toEqual(['new', 'old']);
    });

    test('deactivateUser marks a user inactive or returns a failure object', async () => {
        const db = memoryDb({ [COLL]: [userDoc()] });

        await expect(User.deactivateUser(db, 'u1')).resolves.toEqual({ success: true, modifiedCount: 1 });
        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.isActive).toBe(false);
        expect(stored.updatedAt).toBeInstanceOf(Date);

        await expect(User.deactivateUser(db, 'missing')).resolves.toEqual({
            success: false,
            error: 'User not found',
        });
    });
});

describe('User.updateUserStruggleState', () => {
    test('returns not found when the user is missing', async () => {
        const db = memoryDb({ [COLL]: [] });

        await expect(User.updateUserStruggleState(db, 'missing', { topic: 'ATP', isStruggling: true }))
            .resolves.toEqual({ success: false, error: 'User not found' });
    });

    test('skips non-struggle and unmapped topics without mutating state', async () => {
        const topics = [{ topic: 'enzyme', count: 2, isActive: false }];
        const db = memoryDb({ [COLL]: [userDoc({ struggleState: { topics } })] });

        await expect(User.updateUserStruggleState(db, 'u1', { topic: 'ATP', isStruggling: false }))
            .resolves.toMatchObject({ success: true, skipped: true, reason: 'Not struggling', allTopics: topics });
        await expect(User.updateUserStruggleState(db, 'u1', { topic: 'unmapped', isStruggling: true }))
            .resolves.toMatchObject({ success: true, skipped: true, reason: 'Unmapped topic', allTopics: topics });

        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.struggleState.topics).toEqual(topics);
        expect(PersistenceTopic.incrementStudentCount).not.toHaveBeenCalled();
        expect(StruggleActivity.createActivityEntry).not.toHaveBeenCalled();
    });

    test('adds a normalized inactive topic below the activation threshold', async () => {
        const db = memoryDb({ [COLL]: [userDoc()] });

        const result = await User.updateUserStruggleState(db, 'u1', { topic: '  ATP Synthase  ', isStruggling: true });

        expect(result).toMatchObject({
            success: true,
            state: { topic: 'atp synthase', count: 1, isActive: false },
        });
        expect(result.state.lastStruggle).toBeInstanceOf(Date);
        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.struggleState.topics).toHaveLength(1);
        expect(stored.struggleState.topics[0]).toMatchObject({ topic: 'atp synthase', count: 1, isActive: false });
        expect(PersistenceTopic.incrementStudentCount).not.toHaveBeenCalled();
        expect(StruggleActivity.createActivityEntry).not.toHaveBeenCalled();
    });

    test('activates on the third struggle, updates persistence, and logs activity once', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                struggleState: { topics: [{ topic: 'enzyme', count: 2, lastStruggle: new Date('2026-01-01'), isActive: false }] },
            })],
        });

        const result = await User.updateUserStruggleState(db, 'u1', { topic: 'Enzyme', isStruggling: true }, 'C9');

        expect(result).toMatchObject({
            success: true,
            state: { topic: 'enzyme', count: 3, isActive: true },
        });
        expect(PersistenceTopic.incrementStudentCount).toHaveBeenCalledWith(db, 'C9', 'enzyme', 'u1');
        expect(StruggleActivity.createActivityEntry).toHaveBeenCalledWith(db, expect.objectContaining({
            userId: 'u1',
            studentName: 'Student One',
            courseId: 'C9',
            topic: 'enzyme',
            state: 'Active',
            source: 'course',
        }));
        expect(StruggleActivity.createActivityEntry.mock.calls[0][1].timestamp).toBeInstanceOf(Date);
    });

    test('keeps active topics active, updates persistence, but does not log another activation', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                struggleState: { topics: [{ topic: 'enzyme', count: 3, lastStruggle: new Date('2026-01-01'), isActive: true }] },
            })],
        });

        const result = await User.updateUserStruggleState(db, 'u1', { topic: 'enzyme', isStruggling: true });

        expect(result).toMatchObject({
            success: true,
            state: { topic: 'enzyme', count: 4, isActive: true },
        });
        expect(PersistenceTopic.incrementStudentCount).toHaveBeenCalledWith(db, 'C1', 'enzyme', 'u1');
        expect(StruggleActivity.createActivityEntry).not.toHaveBeenCalled();
    });

    test('skipActivityLog suppresses activation activity but not persistence', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                struggleState: { topics: [{ topic: 'enzyme', count: 2, lastStruggle: new Date('2026-01-01'), isActive: false }] },
            })],
        });

        await User.updateUserStruggleState(db, 'u1', { topic: 'enzyme', isStruggling: true }, 'C9', {
            source: 'superCourse',
            skipActivityLog: true,
        });

        expect(PersistenceTopic.incrementStudentCount).toHaveBeenCalledWith(db, 'C9', 'enzyme', 'u1');
        expect(StruggleActivity.createActivityEntry).not.toHaveBeenCalled();
    });
});

describe('User.resetUserStruggleState', () => {
    test('resets a single topic and logs an inactive activity entry', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                struggleState: {
                    topics: [
                        { topic: 'enzyme', count: 3, isActive: true },
                        { topic: 'atp', count: 1, isActive: false },
                    ],
                },
            })],
        });

        await expect(User.resetUserStruggleState(db, 'u1', ' Enzyme ', 'C9')).resolves.toEqual({ success: true });

        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.struggleState.topics).toEqual([{ topic: 'atp', count: 1, isActive: false }]);
        expect(StruggleActivity.createActivityEntry).toHaveBeenCalledWith(db, expect.objectContaining({
            userId: 'u1',
            studentName: 'Student One',
            courseId: 'C9',
            topic: 'enzyme',
            state: 'Inactive',
        }));
    });

    test('reset ALL clears every topic and logs each reset topic', async () => {
        const db = memoryDb({
            [COLL]: [userDoc({
                struggleState: {
                    topics: [
                        { topic: 'enzyme', count: 3, isActive: true },
                        { topic: 'atp', count: 1, isActive: false },
                    ],
                },
            })],
        });

        await expect(User.resetUserStruggleState(db, 'u1', 'ALL')).resolves.toEqual({ success: true });

        const stored = await db.collection(COLL).findOne({ userId: 'u1' });
        expect(stored.struggleState.topics).toEqual([]);
        expect(StruggleActivity.createActivityEntry).toHaveBeenCalledTimes(2);
        expect(StruggleActivity.createActivityEntry.mock.calls.map(call => call[1].topic)).toEqual(['enzyme', 'atp']);
    });

    test('returns not found when resetting a missing user', async () => {
        const db = memoryDb({ [COLL]: [] });

        await expect(User.resetUserStruggleState(db, 'missing', 'ALL')).resolves.toEqual({
            success: false,
            error: 'User not found',
        });
    });
});

describe('User coverage: SAML PUID backfill and persistence failure tolerance', () => {
    test('createOrGetSAMLUser backfills a missing PUID on an existing user', async () => {
        const db = memoryDb({ users: [{
            userId: 'u-saml', username: 'old', email: 'saml@ubc.ca', role: 'student',
            authProvider: 'saml', samlId: 'saml-1', isActive: true,
        }] });
        const result = await User.createOrGetSAMLUser(db, { samlId: 'saml-1', puid: 'PUID-9', email: 'saml@ubc.ca' });
        expect(result.success).toBe(true);
        const stored = await db.collection('users').findOne({ userId: 'u-saml' });
        expect(stored.puid).toBe('PUID-9');
    });

    test('updateUserStruggleState swallows persistence-topic failures once Directive Mode activates', async () => {
        PersistenceTopic.incrementStudentCount.mockRejectedValueOnce(new Error('persistence down'));
        const db = memoryDb({ users: [{
            userId: 'u1', username: 'stu', role: 'student', isActive: true,
            struggleState: { topics: [{ topic: 'atp', courseId: 'C1', count: 2, isActive: false }] },
        }] });
        const result = await User.updateUserStruggleState(db, 'u1', { topic: 'ATP', isStruggling: true }, 'C1');
        expect(result.success).toBe(true);
        expect(result.state.isActive).toBe(true);
    });
});
