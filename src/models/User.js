/**
 * User Model for MongoDB
 * Stores user authentication and profile information
 * Supports both basic authentication and future SAML integration
 */

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const StruggleActivity = require('./StruggleActivity');
const PersistenceTopic = require('./PersistenceTopic');
const { applyAccessState, normalizeEmail } = require('../services/authorization');
const { createId } = require('../services/id');
const { publishEvent } = require('../services/events');
const { isPreviewUserId } = require('../services/previewSession');

/**
 * User Schema Structure:
 * {
 *   _id: ObjectId,
 *   userId: String,              // Unique user identifier
 *   username: String,            // Username for basic auth
 *   email: String,               // User email address
 *   passwordHash: String,        // Hashed password (for basic auth)
 *   role: String,                // "instructor", "student", or "ta"
 *   displayName: String,         // Display name for UI
 *   authProvider: String,        // "basic" or "saml" (for future)
 *   samlId: String,              // SAML identifier (for future)
 *   puid: String,                // UBC Personal Unique Identifier (for CWL authentication)
 *   academicStudentId: String,   // UBC student number from the academic API roster
 *   isActive: Boolean,           // Account status
 *   lastLogin: Date,             // Last login timestamp
 *   createdAt: Date,             // Account creation timestamp
 *   updatedAt: Date,             // Last update timestamp
 *   studentOnboardingComplete: Boolean, // New students skip first-visit calibration until this is true
 *   preferences: {               // User preferences
 *     theme: String,             // UI theme preference
 *     notifications: Boolean,    // Notification preferences
 *     courseId: String           // Current course context
 *   }
 * }
 */

/**
 * Get the users collection from the database
 * @param {Object} db - MongoDB database instance
 * @returns {Collection} Users collection
 */
function getUsersCollection(db) {
    return db.collection('users');
}

function toSessionUser(user) {
    const resolvedUser = applyAccessState(user);

    return {
        userId: resolvedUser.userId,
        username: resolvedUser.username,
        email: resolvedUser.email,
        role: resolvedUser.role,
        baseRole: resolvedUser.baseRole,
        displayName: resolvedUser.displayName,
        authProvider: resolvedUser.authProvider,
        puid: resolvedUser.puid,
        academicStudentId: resolvedUser.academicStudentId,
        ...(typeof resolvedUser.studentOnboardingComplete === 'boolean' && {
            studentOnboardingComplete: resolvedUser.studentOnboardingComplete
        }),
        preferences: resolvedUser.preferences,
        permissions: resolvedUser.permissions,
        invitedCourses: resolvedUser.invitedCourses || []
    };
}

/**
 * Create a new user account
 * @param {Object} db - MongoDB database instance
 * @param {Object} userData - User data object
 * @returns {Promise<Object>} Created user result
 */
async function createUser(db, userData) {
    const collection = getUsersCollection(db);
    
    const now = new Date();
    
    // Generate unique user ID
    const userId = createId('user');
    
    // Hash password if provided (for basic auth)
    let passwordHash = null;
    if (userData.password) {
        const saltRounds = 12;
        passwordHash = await bcrypt.hash(userData.password, saltRounds);
    }
    
    const user = {
        userId,
        username: userData.username,
        email: normalizeEmail(userData.email),
        passwordHash,
        role: userData.role, // "instructor", "student", or "ta"
        displayName: userData.displayName && userData.displayName.trim() !== '' ? userData.displayName : userData.username,
        authProvider: userData.authProvider || 'basic',
        samlId: userData.samlId || null,
        puid: userData.puid || null, // UBC Personal Unique Identifier (for CWL authentication)
        academicStudentId: userData.academicStudentId || null,
        isActive: true,
        lastLogin: null,
        createdAt: now,
        updatedAt: now,
        ...(userData.role === 'student' && { studentOnboardingComplete: false }),
        preferences: {
            theme: 'light',
            notifications: true,
            courseId: userData.courseId || null
        },
        permissions: {
            systemAdmin: !!(userData.permissions && userData.permissions.systemAdmin === true)
        },
        struggleState: {
            topics: [] // Array of { topic: String, count: Number, lastStruggle: Date, isActive: Boolean }
        }
    };
    
    // Check if user already exists
    const queryConditions = [{ username: userData.username }];
    
    // Only check email if it's provided and not empty
    if (user.email) {
        queryConditions.push({ email: user.email });
    }
    
    const existingUser = await collection.findOne({
        $or: queryConditions
    });
    
    if (existingUser) {
        let errorMessage = 'User already exists with this username';
        if (user.email && existingUser.email === user.email) {
            errorMessage = 'User already exists with this email address';
        } else if (existingUser.username === userData.username) {
            errorMessage = 'User already exists with this username';
        }
        
        return {
            success: false,
            error: errorMessage
        };
    }
    
    const result = await collection.insertOne(user);
    
    console.log(`User created: ${userId} (${userData.role})`);
    
    return {
        success: true,
        userId,
        insertedId: result.insertedId,
        user: {
            userId,
            username: user.username,
            email: user.email,
            role: user.role,
            baseRole: user.role,
            displayName: user.displayName,
            authProvider: user.authProvider,
            permissions: user.permissions
        }
    };
}

/**
 * The account a roster sync creates for a student it enrolls before they have
 * ever signed in. It is a CWL account in waiting: authProvider 'saml' plus the
 * PUID is what createOrGetSAMLUser looks up, so the student's first CWL login
 * lands on this account instead of creating a second one.
 * @param {Object} details
 * @param {string} details.username
 * @param {string|null} details.puid
 * @param {string|null} [details.email]
 * @param {string|null} [details.displayName]
 * @param {string|null} [details.academicStudentId]
 * @param {string} details.courseId - The course that enrolled them
 * @param {Date} [now]
 * @returns {Object} A users document, not yet inserted
 */
function buildPlaceholderStudent({ username, puid, email, displayName, academicStudentId, courseId }, now = new Date()) {
    return {
        userId: createId('user'),
        username,
        email: email || null,
        passwordHash: null,
        role: 'student',
        displayName: displayName || username,
        authProvider: 'saml',
        samlId: null,
        puid: puid || null,
        academicStudentId: academicStudentId || null,
        isActive: true,
        lastLogin: null,
        createdAt: now,
        updatedAt: now,
        studentOnboardingComplete: false,
        preferences: {
            theme: 'light',
            notifications: true,
            courseId
        },
        permissions: {
            systemAdmin: false
        },
        struggleState: {
            topics: []
        }
    };
}

/**
 * Authenticate user with username and password
 * @param {Object} db - MongoDB database instance
 * @param {string} username - Username or email
 * @param {string} password - Plain text password
 * @returns {Promise<Object>} Authentication result
 */
async function authenticateUser(db, username, password) {
    const collection = getUsersCollection(db);
    const normalizedUsername = normalizeEmail(username) || username;
    
    // Find user by username or email
    const user = await collection.findOne({
        $or: [
            { username: username },
            { email: normalizedUsername }
        ],
        isActive: true
    });
    
    if (!user) {
        return {
            success: false,
            error: 'Invalid username or password'
        };
    }
    
    // A basic-auth account without a stored hash is malformed and must fail
    // closed. Otherwise the missing hash would skip password verification and
    // accept any supplied password.
    if (user.authProvider === 'basic') {
        if (!user.passwordHash) {
            return {
                success: false,
                error: 'Invalid username or password'
            };
        }

        const isValidPassword = await bcrypt.compare(password, user.passwordHash);
        if (!isValidPassword) {
            return {
                success: false,
                error: 'Invalid username or password'
            };
        }
    }
    
    // Update last login
    const now = new Date();
    const loginUpdates = { lastLogin: now, updatedAt: now };
    if (user.role === 'student' && typeof user.studentOnboardingComplete !== 'boolean' && !user.lastLogin) {
        loginUpdates.studentOnboardingComplete = false;
    }
    await collection.updateOne(
        { userId: user.userId },
        { $set: loginUpdates }
    );
    
    console.log(`User authenticated: ${user.userId} (${user.role})`);
    
    return {
        success: true,
        user: toSessionUser({ ...user, ...loginUpdates })
    };
}

/**
 * Get user by ID
 * @param {Object} db - MongoDB database instance
 * @param {string} userId - User identifier
 * @returns {Promise<Object>} User object or null
 */
async function getUserById(db, userId) {
    const collection = getUsersCollection(db);
    
    const user = await collection.findOne({ 
        userId,
        isActive: true 
    });
    
    if (!user) {
        return null;
    }

    const resolvedUser = applyAccessState(user);

    return {
        userId: resolvedUser.userId,
        username: resolvedUser.username,
        email: resolvedUser.email,
        role: resolvedUser.role,
        baseRole: resolvedUser.baseRole,
        displayName: resolvedUser.displayName,
        authProvider: resolvedUser.authProvider,
        puid: resolvedUser.puid,
        academicStudentId: resolvedUser.academicStudentId,
        ...(typeof resolvedUser.studentOnboardingComplete === 'boolean' && {
            studentOnboardingComplete: resolvedUser.studentOnboardingComplete
        }),
        preferences: resolvedUser.preferences,
        lastLogin: resolvedUser.lastLogin,
        struggleState: resolvedUser.struggleState,
        invitedCourses: resolvedUser.invitedCourses || [],
        permissions: resolvedUser.permissions
    };
}

/**
 * Get user by PUID (UBC Personal Unique Identifier)
 * Used for CWL authentication to find existing users
 * @param {Object} db - MongoDB database instance
 * @param {string} puid - UBC Personal Unique Identifier
 * @returns {Promise<Object>} User object or null
 */
async function getUserByPuid(db, puid) {
    const collection = getUsersCollection(db);
    
    if (!puid) {
        return null;
    }
    
    const user = await collection.findOne({ 
        puid,
        isActive: true 
    });
    
    if (!user) {
        return null;
    }

    const resolvedUser = applyAccessState(user);

    return {
        userId: resolvedUser.userId,
        username: resolvedUser.username,
        email: resolvedUser.email,
        role: resolvedUser.role,
        baseRole: resolvedUser.baseRole,
        displayName: resolvedUser.displayName,
        authProvider: resolvedUser.authProvider,
        preferences: resolvedUser.preferences,
        lastLogin: resolvedUser.lastLogin,
        puid: resolvedUser.puid,
        academicStudentId: resolvedUser.academicStudentId,
        ...(typeof resolvedUser.studentOnboardingComplete === 'boolean' && {
            studentOnboardingComplete: resolvedUser.studentOnboardingComplete
        }),
        permissions: resolvedUser.permissions
    };
}

/**
 * Update user preferences
 * @param {Object} db - MongoDB database instance
 * @param {string} userId - User identifier
 * @param {Object} preferences - New preferences
 * @returns {Promise<Object>} Update result
 */
async function updateUserPreferences(db, userId, preferences) {
    const collection = getUsersCollection(db);
    
    const now = new Date();
    
    const result = await collection.updateOne(
        { userId },
        {
            $set: {
                'preferences': preferences,
                updatedAt: now
            }
        }
    );
    
    if (result.modifiedCount > 0) {
        console.log(`User preferences updated: ${userId}`);
        return { success: true, modifiedCount: result.modifiedCount };
    } else {
        return { success: false, error: 'User not found or no changes made' };
    }
}

/**
 * Create or get user for SAML authentication
 * For CWL (UBC Shibboleth) users, PUID is the primary identifier
 * @param {Object} db - MongoDB database instance
 * @param {Object} samlData - SAML authentication data
 * @param {string} samlData.samlId - SAML identifier (nameID or fallback)
 * @param {string} samlData.puid - UBC Personal Unique Identifier (for CWL users)
 * @param {string} samlData.email - User email address
 * @param {string} samlData.username - Username
 * @param {string} samlData.displayName - Display name
 * @param {string} samlData.role - User role
 * @returns {Promise<Object>} User result
 */
async function createOrGetSAMLUser(db, samlData) {
    const collection = getUsersCollection(db);
    const normalizedEmail = normalizeEmail(samlData.email);
    
    // For CWL users, PUID is the primary identifier for user lookup
    // Check if user already exists by PUID first (most reliable for CWL)
    // Then fall back to samlId if PUID is not available
    const queryConditions = [];
    
    if (samlData.puid) {
        // PUID is the primary identifier for CWL users
        queryConditions.push({ puid: samlData.puid, authProvider: 'saml' });
    }
    
    // Also check by samlId as fallback (for non-CWL SAML users)
    if (samlData.samlId) {
        queryConditions.push({ samlId: samlData.samlId, authProvider: 'saml' });
    }

    if (normalizedEmail) {
        queryConditions.push({ email: normalizedEmail, authProvider: 'saml' });
    }
    
    // If no query conditions, we can't look up existing users
    if (queryConditions.length === 0) {
        return {
            success: false,
            error: 'SAML data missing required identifier (puid or samlId)'
        };
    }
    
    // Find existing user by PUID or samlId
    const existingUser = await collection.findOne({
        $or: queryConditions
    });
    
    if (existingUser) {
        // User exists — update fields that may have changed since last login.
        const updateFields = {
            lastLogin: new Date(),
            updatedAt: new Date()
        };

        if (
            existingUser.role === 'student' &&
            typeof existingUser.studentOnboardingComplete !== 'boolean' &&
            !existingUser.lastLogin
        ) {
            updateFields.studentOnboardingComplete = false;
        }

        // If PUID is provided but not yet stored (migration case), save it now
        if (samlData.puid && !existingUser.puid) {
            updateFields.puid = samlData.puid;
            console.log(`Storing PUID on existing user ${existingUser.userId}`);
        }

        if (samlData.samlId && !existingUser.samlId) {
            updateFields.samlId = samlData.samlId;
        }

        if (normalizedEmail && existingUser.email !== normalizedEmail) {
            updateFields.email = normalizedEmail;
        }

        if (samlData.username && (!existingUser.username || existingUser.username === existingUser.email)) {
            updateFields.username = samlData.username;
        }

        if (
            samlData.displayName &&
            (
                !existingUser.displayName ||
                existingUser.displayName === existingUser.email ||
                existingUser.displayName === existingUser.username
            )
        ) {
            updateFields.displayName = samlData.displayName;
        }

        // Always re-apply the role determined by the Passport strategy on each login.
        // This corrects any previously mis-assigned roles (e.g. a student+staff dual-role
        // user who was incorrectly given 'instructor' before this fix was applied).
        //
        // IMPORTANT: Do NOT overwrite a manually-granted 'ta' role.
        // The 'ta' role is assigned by an instructor through the app — it is not
        // derived from CWL affiliations. A TA's CWL affiliation will still say 'student',
        // so we must preserve the 'ta' role and never downgrade it via CWL login.
        const isManuallyGrantedRole = existingUser.role === 'ta';

        if (samlData.role && samlData.role !== existingUser.role && !isManuallyGrantedRole) {
            console.log(
                `[USER] Role change for ${existingUser.userId}: ` +
                `${existingUser.role} → ${samlData.role} (re-evaluated from CWL attributes)`
            );
            updateFields.role = samlData.role;
        } else if (isManuallyGrantedRole) {
            console.log(
                `[USER] Preserving manually-granted 'ta' role for ${existingUser.userId} ` +
                `(CWL says '${samlData.role}', keeping 'ta')`
            );
        }

        await collection.updateOne(
            { userId: existingUser.userId },
            { $set: updateFields }
        );

        return {
            success: true,
            user: toSessionUser({
                ...existingUser,
                ...updateFields
            })
        };
    }
    
    // Create new SAML user
    const now = new Date();
    const userId = createId('user');
    
    const user = {
        userId,
        username: samlData.username || normalizedEmail,
        email: normalizedEmail,
        passwordHash: null, // No password for SAML users
        role: samlData.role || 'student', // Default to student, can be updated
        displayName: samlData.displayName || samlData.username || normalizedEmail,
        authProvider: 'saml',
        samlId: samlData.samlId || null,
        puid: samlData.puid || null, // Store PUID for CWL users
        isActive: true,
        lastLogin: now,
        createdAt: now,
        updatedAt: now,
        ...((samlData.role || 'student') === 'student' && { studentOnboardingComplete: false }),
        preferences: {
            theme: 'light',
            notifications: true,
            courseId: null
        },
        permissions: {
            systemAdmin: false
        }
    };
    
    const result = await collection.insertOne(user);
    
    console.log(`SAML user created: ${userId} (${user.role})`);
    
    return {
        success: true,
        userId,
        insertedId: result.insertedId,
        user: toSessionUser(user)
    };
}

/**
 * Get all users by role
 * @param {Object} db - MongoDB database instance
 * @param {string} role - User role to filter by
 * @returns {Promise<Array>} Array of users
 */
async function getUsersByRole(db, role) {
    const collection = getUsersCollection(db);
    
    const users = await collection.find({ 
        role,
        isActive: true 
    })
    .project({
        userId: 1,
        username: 1,
        email: 1,
        displayName: 1,
        lastLogin: 1,
        createdAt: 1
    })
    .sort({ createdAt: -1 })
    .toArray();
    
    return users;
}

/**
 * Deactivate user account
 * @param {Object} db - MongoDB database instance
 * @param {string} userId - User identifier
 * @returns {Promise<Object>} Deactivation result
 */
async function deactivateUser(db, userId) {
    const collection = getUsersCollection(db);
    
    const now = new Date();
    
    const result = await collection.updateOne(
        { userId },
        {
            $set: {
                isActive: false,
                updatedAt: now
            }
        }
    );
    
    if (result.modifiedCount > 0) {
        console.log(`User deactivated: ${userId}`);
        return { success: true, modifiedCount: result.modifiedCount };
    } else {
        return { success: false, error: 'User not found' };
    }
}

/**
 * Mark the one-time student welcome flow as complete.
 * Existing users without this field are treated as already onboarded by the
 * client, so only accounts created with an explicit false value enter it.
 * @param {Object} db - MongoDB database instance
 * @param {string} userId - Student user identifier
 * @returns {Promise<Object>} Update result
 */
async function completeStudentOnboarding(db, userId) {
    const now = new Date();
    const result = await getUsersCollection(db).updateOne(
        { userId, role: 'student', isActive: true },
        {
            $set: {
                studentOnboardingComplete: true,
                studentOnboardingCompletedAt: now,
                updatedAt: now
            }
        }
    );

    if (result.matchedCount === 0) {
        return { success: false, error: 'Student not found' };
    }

    return { success: true, completedAt: now.toISOString() };
}

module.exports = {
    getUsersCollection,
    createUser,
    buildPlaceholderStudent,
    authenticateUser,
    getUserById,
    getUserByPuid,
    updateUserPreferences,
    createOrGetSAMLUser,
    getUsersByRole,
    deactivateUser,
    completeStudentOnboarding,
    updateUserStruggleState,
    resetUserStruggleState
};

/**
 * Update user struggle state for a detected topic
 * @param {Object} db - MongoDB database instance
 * @param {string} userId - User identifier
 * @param {Object} struggleData - Analysis result { topic, isStruggling }
 * @param {string} courseId - Course ID context (from current chat/session)
 * @returns {Promise<Object>} Update result and current state
 */
async function updateUserStruggleState(db, userId, struggleData, courseId = null, options = {}) {
    const collection = getUsersCollection(db);
    const { topic, isStruggling } = struggleData || {};
    // source: tags any activity record this call writes ('course' default, or
    //   'superCourse' for cross-course Super Chat struggles).
    // skipActivityLog: when true, update the global counter/persistence but do
    //   NOT write a StruggleActivity row here. The Super Chat path uses this so
    //   it can log its own per-event row instead of an activation-only row.
    const { source = 'course', skipActivityLog = false } = options || {};
    const now = new Date();

    // 1. Get current user to find existing topic state
    const user = await collection.findOne({ userId });
    if (!user) return { success: false, error: 'User not found' };

    const existingTopics = user.struggleState?.topics || [];

    // Ignore non-struggle messages (do not create/update topics)
    if (!isStruggling) {
        return {
            success: true,
            skipped: true,
            reason: 'Not struggling',
            state: null,
            allTopics: existingTopics
        };
    }

    // Ignore unmapped/invalid topics (do not create/update topics)
    if (!topic || typeof topic !== 'string' || topic.toLowerCase().trim() === 'unmapped') {
        return {
            success: true,
            skipped: true,
            reason: 'Unmapped topic',
            state: null,
            allTopics: existingTopics
        };
    }
    
    // Normalize topic for consistency (simple lowercase for now)
    const normalizedTopic = topic.toLowerCase().trim();

    let topics = existingTopics;
    let currentTopicIndex = topics.findIndex(t => t.topic === normalizedTopic);
    let topicState = null;

    if (currentTopicIndex === -1) {
        // New topic
        topicState = {
            topic: normalizedTopic,
            count: isStruggling ? 1 : 0,
            lastStruggle: isStruggling ? now : null,
            isActive: false // Directive mode triggers at count >= 3
        };
        topics.push(topicState);
    } else {
        // Existing topic
        topicState = topics[currentTopicIndex];
        
        if (isStruggling) {
            topicState.count += 1;
            topicState.lastStruggle = now;
        } else {
            // Optional: Decay logic or reset on good understanding? 
            // For now, we only increment on struggle. 
            // The prompt "reset" button handles clearing.
        }
        
        // Update in array
        topics[currentTopicIndex] = topicState;
    }

    // Track previous active state before updating
    const wasActive = topicState.isActive;
    
    // Check if Directive Mode should be active
    topicState.isActive = topicState.count >= 3;
    
    // Persist to MongoDB if this is a NEW activation (transition from inactive to active)
    const isNewActivation = !wasActive && topicState.isActive;
    
    // Determine active course ID
    const activeCourseId = courseId || user.preferences?.courseId || null;
    const studentName = user.displayName || user.username || 'Unknown Student';
    
    // PERSISTENCE TOPIC UPDATE:
    // Update the cumulative count for this topic (tracks unique students over time)
    // Only update if the student has reached the threshold for Directive Mode (count >= 3)
    if (topicState.isActive && activeCourseId) {
        try {
            await PersistenceTopic.incrementStudentCount(db, activeCourseId, normalizedTopic, user.userId);
            console.log(`📊 [PERSISTENCE] Updated persistence count for topic: ${normalizedTopic} (Directive Mode Active)`);
        } catch (err) {
            console.error('❌ [PERSISTENCE] Error updating persistence topic:', err);
        }
    }

    if (isNewActivation && !skipActivityLog) {
        // Persist to activity history for permanent record
        await StruggleActivity.createActivityEntry(db, {
            userId: user.userId,
            studentName: studentName,
            courseId: activeCourseId,
            topic: normalizedTopic,
            state: 'Active',
            source,
            timestamp: now
        });

        console.log(`💾 [DB] Persisted Active state for ${user.userId}`);

        publishStruggleChange('struggle.topic.activated', user, activeCourseId, normalizedTopic);
    }

    // Persist changes. struggleState is encrypted as one value, so it is written
    // whole: an update cannot address a path inside it.
    await collection.updateOne(
        { userId },
        { 
            $set: { 
                struggleState: { ...(user.struggleState || {}), topics },
                updatedAt: now
            }
        }
    );

    return { 
        success: true, 
        state: topicState,
        allTopics: topics 
    };
}

/**
 * Reset struggle state for a topic
 * @param {Object} db - MongoDB database instance
 * @param {string} userId - User identifier
 * @param {string} topic - Topic to reset (or 'ALL' for global reset)
 * @param {string} courseId - Course ID context (from current session)
 * @returns {Promise<Object>} Update result
 */
async function resetUserStruggleState(db, userId, topic, courseId = null) {
    const collection = getUsersCollection(db);
    const now = new Date();
    
    // Get user first to fetch topics for persistence
    const user = await collection.findOne({ userId });
    if (!user) return { success: false, error: 'User not found' };
    
    const studentName = user.displayName || user.username || 'Unknown Student';
    const activeCourseId = courseId || user.preferences?.courseId || null;

    const existingTopics = user.struggleState?.topics || [];
    let topicsToReset = []; // Track which topics were reset
    let remainingTopics = [];
    
    if (topic === 'ALL') {
        // Get all active topics before clearing
        topicsToReset = existingTopics;
    } else {
        // Find the specific topic before removing
        const normalizedTopic = topic.toLowerCase().trim();
        const existingTopic = existingTopics.find(t => t.topic === normalizedTopic);
        
        if (existingTopic) {
            topicsToReset = [existingTopic];
        }
        
        // Remove specific topic
        remainingTopics = existingTopics.filter(t => t.topic !== normalizedTopic);
    }

    // struggleState is encrypted as one value, so it is written whole: an update
    // cannot $pull from a path inside it.
    await collection.updateOne(
        { userId },
        {
            $set: {
                struggleState: { ...(user.struggleState || {}), topics: remainingTopics },
                updatedAt: now
            }
        }
    );
    
    // Persist to MongoDB for each topic that was reset (deactivated)
    if (topicsToReset.length > 0) {
        for (const topicObj of topicsToReset) {
            // Persist to activity history for permanent record
            await StruggleActivity.createActivityEntry(db, {
                userId: user.userId,
                studentName: studentName,
                courseId: activeCourseId,
                topic: topicObj.topic,
                state: 'Inactive',
                timestamp: now
            });
            
            console.log(`💾 [DB] Persisted Inactive state for ${user.userId}`);

            publishStruggleChange('struggle.topic.cleared', user, activeCourseId, topicObj.topic);
        }
    }

    return { success: true };
}

/**
 * Announce a struggle change, next to the struggleActivity row that records it
 * (the pub/sub toolkit's rung 3). One event per row: an `Active` row is
 * struggle.topic.activated, and each `Inactive` row a reset writes is
 * struggle.topic.cleared. Both are sensitive, so a listener on everything
 * doesn't get them unless it asks. Super Chat's own per-message rows
 * (routes/studentSuperCourse.js) don't publish.
 *
 * It never throws, so the row and the rest of the update are as before.
 *
 * @param {string} type - struggle.topic.activated or struggle.topic.cleared
 * @param {Object} user - The user document (its pseudonymous userId only)
 * @param {string|null} courseId - The course the row names, if any
 * @param {string} topic - The topic the row names
 */
function publishStruggleChange(type, user, courseId, topic) {
    publishEvent(type, {
        user: user.userId,
        ...(courseId ? { course: courseId } : {}),
        preview: user.isPreview === true || isPreviewUserId(user.userId),
        data: { topic }
    });
}
