/**
 * Authentication Routes
 * Handles user login, logout, and session management
 * Uses Passport.js for authentication strategies
 */

const express = require('express');
const passport = require('passport');
const router = express.Router();
const { normalizeErrorResponses } = require('../middleware/apiResponse');
const { isPreviewUserId } = require('../services/previewSession');
const PreviewState = require('../models/PreviewState');

// Middleware to parse JSON bodies
router.use(express.json());
router.use(normalizeErrorResponses);

const AUTH_UNAVAILABLE_MESSAGE = 'Sign-in is temporarily unavailable. Please try again later.';

async function isLocalLoginAllowed(req) {
    const db = req.app.locals.db;
    if (!db) {
        throw new Error('Authentication database connection not available');
    }

    const settings = await db.collection('settings').findOne({ _id: 'global' });
    return settings?.allowLocalLogin !== false;
}

function sendAuthenticationUnavailable(res) {
    return res.status(503).json({
        success: false,
        error: AUTH_UNAVAILABLE_MESSAGE,
        code: 'AUTH_SERVICE_UNAVAILABLE'
    });
}

// Generic middleware to log all incoming requests to this router for debugging
router.use((req, res, next) => {
    console.log(`[AUTH DEBUG] Incoming request: ${req.method} ${req.originalUrl}`);
    console.log(`[AUTH DEBUG] Request Body:`, req.body);
    console.log(`[AUTH DEBUG] Request Query:`, req.query);
    next();
});

/**
 * POST /api/auth/login
 * Authenticate user with username and password using Passport Local Strategy
 */
router.post('/login', async (req, res, next) => {
    // The administrator's setting is authoritative. If it cannot be read, do
    // not fall back to exposing or accepting local credentials.
    try {
        if (!await isLocalLoginAllowed(req)) {
            return res.status(403).json({
                success: false,
                error: 'Local login is currently disabled by the administrator.'
            });
        }
    } catch (error) {
        console.error('Unable to verify whether local login is enabled:', error);
        return sendAuthenticationUnavailable(res);
    }

    // Validate required fields before Passport authentication
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            error: 'Username and password are required'
        });
    }

    // Use Passport's local strategy for authentication
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            console.error('Error in Passport authentication:', err);
            return res.status(500).json({
                success: false,
                error: 'Login failed. Please try again.'
            });
        }

        if (!user) {
            // Authentication failed
            return res.status(401).json({
                success: false,
                error: info && info.message ? info.message : 'Invalid username or password'
            });
        }

        // Log user in (creates session via Passport)
        req.login(user, (loginErr) => {
            if (loginErr) {
                console.error('Error logging in user:', loginErr);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to create session'
                });
            }

            // Get auth service for creating session user object
            const authService = req.app.locals.authService;

            // Also store role in session for backward compatibility
            req.session.userId = user.userId;
            req.session.userRole = user.role;
            req.session.userDisplayName = user.displayName;

            console.log(`User logged in: ${user.userId} (${user.role})`);

            // Determine redirect based on role
            let redirectPath = '/login';
            if (user.role === 'instructor') {
                redirectPath = '/instructor/home';
            } else if (user.role === 'student') {
                redirectPath = '/student';
            } else if (user.role === 'ta') {
                redirectPath = '/ta';
            }

            res.json({
                success: true,
                user: authService ? authService.createSessionUser(user) : {
                    userId: user.userId,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    displayName: user.displayName,
                    authProvider: user.authProvider,
                    studentOnboardingComplete: user.studentOnboardingComplete,
                    preferences: user.preferences
                },
                redirect: redirectPath
            });
        });
    })(req, res, next);
});

/**
 * POST /api/auth/register
 * Register a new user account
 */
router.post('/register', async (req, res) => {
    try {
        // Check if local registration is allowed (same setting as login)
        try {
            if (!await isLocalLoginAllowed(req)) {
                return res.status(403).json({
                    success: false,
                    error: 'Account creation is currently disabled by the administrator.'
                });
            }
        } catch (error) {
            console.error('Unable to verify whether local registration is enabled:', error);
            return sendAuthenticationUnavailable(res);
        }

        const { username, password, email, role, displayName } = req.body;

        // Validate required fields
        if (!username || !password || !role) {
            return res.status(400).json({
                success: false,
                error: 'Username, password, and role are required'
            });
        }

        // Validate role
        if (!['instructor', 'student', 'ta'].includes(role)) {
            return res.status(400).json({
                success: false,
                error: 'Role must be "instructor", "student", or "ta"'
            });
        }

        // Get auth service from app locals
        const authService = req.app.locals.authService;
        if (!authService) {
            return res.status(500).json({
                success: false,
                error: 'Authentication service not available'
            });
        }

        // Register user
        const result = await authService.registerUser({
            username,
            password,
            email,
            role,
            displayName
        });

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }

        console.log(`User registered: ${result.userId} (${role})`);

        res.json({
            success: true,
            message: 'Account created successfully',
            user: result.user
        });

    } catch (error) {
        console.error('Error in register endpoint:', error);
        res.status(500).json({
            success: false,
            error: 'Registration failed. Please try again.'
        });
    }
});

/**
 * POST /api/auth/logout
 * Logout user and destroy session using Passport
 */
router.post('/logout', (req, res) => {
    try {
        const user = req.user;
        const userId = user ? user.userId : req.session.userId;

        // Check if user is authenticated via CWL (SAML)
        // User model sets authProvider to 'saml' for CWL users
        const isCWL = user && user.authProvider === 'saml';
        
        let logoutPerformed = false;
        
        // Collect debug info to send to client
        const debugInfo = {
            userId: userId,
            isCWL: isCWL,
            authProvider: user ? user.authProvider : 'unknown',
            strategyFound: false,
            helperFound: false,
            samlLogoutInitiated: false,
            samlLogoutUrl: null,
            error: null
        };

        const performLocalLogout = (redirectUrl = '/login', finalDebugInfo = {}) => {
            if (logoutPerformed) return;
            logoutPerformed = true;

            // Use Passport's logout method
            req.logout((err) => {
                if (err) {
                    console.error('Passport logout error:', err);
                    finalDebugInfo.logoutError = err.message;
                }

                // Destroy session
                req.session.destroy((destroyErr) => {
                    if (destroyErr) {
                        console.error('Session destroy error:', destroyErr);
                        return res.status(500).json({
                            success: false,
                            error: 'Failed to logout',
                            debug: { ...debugInfo, ...finalDebugInfo, destroyError: destroyErr.message }
                        });
                    }

                    console.log(`User logged out: ${userId} (${isCWL ? 'CWL' : 'Local'})`);

                    res.json({
                        success: true,
                        message: 'Logged out successfully',
                        redirect: redirectUrl,
                        debug: { ...debugInfo, ...finalDebugInfo }
                    });
                });
            });
        };

        // If CWL user, try to initiate SAML logout
        if (isCWL) {
            console.log(`[AUTH] Initiating CWL logout for user ${userId}`);
            
            // Get passport instance from app.locals
            const passport = req.app.locals.passport;
            
            // Access the strategy instance directly from passport
            const strategy = passport && passport._strategies ? passport._strategies['ubcshib'] : null;
            debugInfo.strategyFound = !!strategy;
            
            if (strategy && typeof strategy.logout === 'function') {
                console.log('[AUTH] Calling ubcshib strategy.logout');
                debugInfo.samlLogoutInitiated = true;
                
                // Wrap SAML logout in a promise with timeout to prevent hanging
                const samlLogoutPromise = new Promise((resolve, reject) => {
                    try {
                        strategy.logout(req, (err, requestUrl) => {
                            if (err) return reject(err);
                            resolve(requestUrl);
                        });
                    } catch (e) {
                        reject(e);
                    }
                });

                // Set a timeout of 5 seconds
                let timeoutId;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('SAML logout timeout')), 5000);
                });

                Promise.race([samlLogoutPromise, timeoutPromise])
                    .then((requestUrl) => {
                        console.log(`[AUTH] Generated SAML logout URL: ${requestUrl}`);
                        debugInfo.samlLogoutUrl = requestUrl;
                        performLocalLogout(requestUrl, { samlSuccess: true });
                    })
                    .catch((err) => {
                        console.error('[AUTH] SAML logout failed or timed out:', err);
                        debugInfo.error = err.message;
                        // Fallback to local logout
                        performLocalLogout('/login', { samlError: true });
                    })
                    .finally(() => {
                        clearTimeout(timeoutId);
                    });
                    
                return; // Wait for promise resolution
            } else {
                console.warn('[AUTH] UBC Shibboleth strategy not found or missing logout method');
                
                // Check if we can fallback to helpers if strategy access failed
                if (passport && passport.ubcShibHelpers && typeof passport.ubcShibHelpers.logout === 'function') {
                     console.log('[AUTH] Falling back to passport.ubcShibHelpers.logout');
                     debugInfo.helperFound = true;
                     
                     passport.ubcShibHelpers.logout(req, (err, requestUrl) => {
                        if (err) {
                             console.error('SAML logout helper error:', err);
                             debugInfo.error = err.message;
                             return performLocalLogout('/login', { helperError: true });
                        }
                        debugInfo.samlLogoutUrl = requestUrl;
                        performLocalLogout(requestUrl, { helperSuccess: true });
                     });
                     return;
                }
            }
        }

        // Standard local logout
        performLocalLogout('/login', { localOnly: true });

    } catch (error) {
        console.error('Error in logout endpoint:', error);
        res.status(500).json({
            success: false,
            error: 'Logout failed',
            debugError: error.message
        });
    }
});

/**
 * GET /api/auth/me
 * Get current user information
 * Uses Passport's req.user if available, falls back to session
 */
router.get('/me', async (req, res) => {
    try {
        console.log('Auth /me endpoint called');
        console.log('Passport user:', req.user);
        console.log('Session:', req.session);
        console.log('Session userId:', req.session?.userId);

        // Check if user is authenticated via Passport
        // Passport populates req.user after deserialization
        let user = req.user;

        // Fallback to session-based auth for backward compatibility
        if (!user && req.session && req.session.userId) {
            const authService = req.app.locals.authService;
            if (authService) {
                user = await authService.getUserById(req.session.userId);
            }
        }

        if (!user) {
            console.log('User not authenticated - no user found');
            return res.status(401).json({
                success: false,
                error: 'Not authenticated',
                redirect: '/login'
            });
        }

        // Get auth service for creating session user object
        const authService = req.app.locals.authService;
        if (!authService) {
            return res.status(500).json({
                success: false,
                error: 'Authentication service not available'
            });
        }

        res.json({
            success: true,
            user: authService.createSessionUser(user)
        });

    } catch (error) {
        console.error('Error in me endpoint:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get user information'
        });
    }
});

/**
 * POST /api/auth/student-onboarding/complete
 * Complete the one-time student welcome after a course and unit are selected.
 */
router.post('/student-onboarding/complete', async (req, res) => {
    try {
        let user = req.user;
        const authService = req.app.locals.authService;

        if (!user && req.session?.userId && authService) {
            user = await authService.getUserById(req.session.userId);
        }

        if (!user) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }

        if (user.role !== 'student') {
            return res.status(403).json({ success: false, error: 'Student access required' });
        }

        if (!authService) {
            return res.status(503).json({ success: false, error: 'Authentication service not available' });
        }

        const result = await authService.completeStudentOnboarding(user.userId);
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        // A "View as Student" sandbox tracks the same milestone in its own state
        // document, which is what the instructor tab reads before deciding
        // whether to open the preview on the first-run walkthrough. Without this
        // the two disagree forever: the walkthrough never replays, but the
        // preview keeps setting itself up as though it were about to.
        const db = req.app.locals.db;
        if (db && isPreviewUserId(user.userId)) {
            try {
                await PreviewState.setFirstRunCompleted(db, user.userId, true);
            } catch (error) {
                console.error('[PREVIEW] Could not record first-run completion:', error);
            }
        }

        return res.json({
            success: true,
            data: {
                studentOnboardingComplete: true,
                completedAt: result.completedAt
            }
        });
    } catch (error) {
        console.error('Error completing student onboarding:', error);
        return res.status(500).json({ success: false, error: 'Failed to complete student onboarding' });
    }
});

/**
 * PUT /api/auth/preferences
 * Update user preferences
 */
router.put('/preferences', async (req, res) => {
    try {
        // Check if user is authenticated
        if (!req.session || !req.session.userId) {
            return res.status(401).json({
                success: false,
                error: 'Not authenticated',
                redirect: '/login'
            });
        }

        const { preferences } = req.body;

        if (!preferences || typeof preferences !== 'object') {
            return res.status(400).json({
                success: false,
                error: 'Preferences object is required'
            });
        }

        // Get auth service from app locals
        const authService = req.app.locals.authService;
        if (!authService) {
            return res.status(500).json({
                success: false,
                error: 'Authentication service not available'
            });
        }

        // Update preferences
        const result = await authService.updateUserPreferences(req.session.userId, preferences);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }

        res.json({
            success: true,
            message: 'Preferences updated successfully'
        });

    } catch (error) {
        console.error('Error in preferences endpoint:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update preferences'
        });
    }
});

/**
 * POST /api/auth/set-course
 * Set user's current course context
 */
router.post('/set-course', async (req, res) => {
    try {
        // Check if user is authenticated
        if (!req.session || !req.session.userId) {
            return res.status(401).json({
                success: false,
                error: 'Not authenticated',
                redirect: '/login'
            });
        }

        const { courseId } = req.body;

        if (!courseId) {
            return res.status(400).json({
                success: false,
                error: 'Course ID is required'
            });
        }

        // Get auth service from app locals
        const authService = req.app.locals.authService;
        if (!authService) {
            return res.status(500).json({
                success: false,
                error: 'Authentication service not available'
            });
        }

        // Set course context
        const result = await authService.setCurrentCourseId(req.session.userId, courseId);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }

        res.json({
            success: true,
            message: 'Course context updated successfully',
            courseId: courseId
        });

    } catch (error) {
        console.error('Error in set-course endpoint:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to set course context'
        });
    }
});

/**
 * GET /api/users/tas
 * Get all Teaching Assistants (instructor only)
 */
router.get('/tas', async (req, res) => {
    try {
        console.log('🔍 [AUTH_TAS] Request received');
        console.log('🔍 [AUTH_TAS] Session:', req.session);
        console.log('🔍 [AUTH_TAS] User:', req.user);

        // Get authenticated user information
        const user = req.user;
        if (!user) {
            console.log('🔍 [AUTH_TAS] No user found, returning 401');
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        // Only instructors can view TAs
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can view TAs'
            });
        }

        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        // Get all users with TA role
        const usersCollection = db.collection('users');
        const tas = await usersCollection.find({ role: 'ta' })
            .project({
                userId: 1,
                username: 1,
                email: 1,
                displayName: 1,
                isActive: 1,
                createdAt: 1,
                lastLogin: 1
            })
            .sort({ createdAt: -1 })
            .toArray();

        console.log(`Retrieved ${tas.length} TAs`);

        res.json({
            success: true,
            data: tas
        });

    } catch (error) {
        console.error('Error fetching TAs:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching TAs'
        });
    }
});

/**
 * GET /api/auth/users/:userId
 * Get user details by ID (instructor only)
 */
router.get('/users/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        // Only instructors can view user details
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can view user details'
            });
        }

        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        // Get user by ID
        const usersCollection = db.collection('users');
        const userData = await usersCollection.findOne(
            { userId },
            {
                projection: {
                    userId: 1,
                    username: 1,
                    email: 1,
                    displayName: 1,
                    role: 1,
                    isActive: 1,
                    createdAt: 1,
                    lastLogin: 1
                }
            }
        );

        if (!userData) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        console.log(`Retrieved user details for: ${userId}`);

        res.json({
            success: true,
            data: userData
        });

    } catch (error) {
        console.error('Error fetching user details:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while fetching user details'
        });
    }
});

/**
 * DELETE /api/users/tas/:taId
 * Remove a TA from all courses (instructor only)
 */
router.delete('/tas/:taId', async (req, res) => {
    try {
        const { taId } = req.params;

        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        // Only instructors can remove TAs
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can remove TAs'
            });
        }

        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        // Update user role back to 'student'
        const usersCollection = db.collection('users');
        await usersCollection.updateOne(
            { userId: taId },
            { 
                $set: { 
                    role: 'student',
                    updatedAt: new Date()
                } 
            }
        );

        // Remove TA from all courses, and clear their permissions record on
        // each one - otherwise a stale record survives the removal and
        // comes right back (unrevoked) if this TA is ever re-added later.
        const coursesCollection = db.collection('courses');
        const result = await coursesCollection.updateMany(
            { tas: taId },
            {
                $pull: { tas: taId },
                $unset: { [`taPermissions.${taId}`]: '' },
                $set: { updatedAt: new Date() }
            }
        );

        console.log(`Removed TA ${taId} from ${result.modifiedCount} courses`);

        res.json({
            success: true,
            message: 'TA removed from all courses successfully',
            data: {
                taId,
                modifiedCount: result.modifiedCount
            }
        });

    } catch (error) {
        console.error('Error removing TA:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while removing TA'
        });
    }
});

/**
 * GET /api/auth/saml
 * Initiate SAML authentication flow
 * Redirects to SAML Identity Provider
 */
router.get('/saml', (req, res, next) => {
    console.log('[AUTH DEBUG] Initiating SAML authentication flow via /api/auth/saml');
    passport.authenticate('saml', {
        failureRedirect: '/login?error=saml_failed'
    })(req, res, next);
});

/**
 * POST /api/auth/saml/callback
 * SAML callback endpoint (called by IdP after authentication)
 */
router.post('/saml/callback',
    (req, res, next) => {
        console.log('[AUTH DEBUG] SAML callback received at /api/auth/saml/callback.');
        console.log('[AUTH DEBUG] Request body:', req.body);
        next();
    },
    passport.authenticate('saml', {
        failureRedirect: '/login?error=saml_failed',
        session: true
    }),
    (req, res) => {
        // Successful SAML authentication
        // Determine redirect based on role
        let redirectPath = '/login';
        if (req.user && req.user.role) {
            if (req.user.role === 'instructor') {
                redirectPath = '/instructor/home';
            } else if (req.user.role === 'student') {
                redirectPath = '/student';
            } else if (req.user.role === 'ta') {
                redirectPath = '/ta';
            }
        }

        // Store role in session for backward compatibility
        if (req.user) {
            req.session.userId = req.user.userId;
            req.session.userRole = req.user.role;
            req.session.userDisplayName = req.user.displayName;
        }

        res.redirect(redirectPath);
    }
);

/**
 * GET /api/auth/methods
 * Get available authentication methods
 * Returns which auth methods are configured and available
 */
router.get('/methods', async (req, res) => {
    try {
        const methods = {
            local: false,
            saml: false,
            ubcshib: false,
            allowLocalLogin: false,
            serviceAvailable: true
        };

        // The setting defaults to enabled only after a successful database
        // read. A missing or failing database must never turn local login on.
        methods.allowLocalLogin = await isLocalLoginAllowed(req);
        methods.local = methods.allowLocalLogin;

        // Check if SAML is configured
        if (process.env.SAML_ENTRY_POINT &&
            process.env.SAML_ISSUER &&
            process.env.SAML_CALLBACK_URL &&
            process.env.SAML_CERT) {
            methods.saml = true;
        }

        // Check if UBC Shibboleth is configured
        // Uses generic SAML_ variables (not UBC_SAML_ prefix)
        const ubcShibIssuer = process.env.SAML_ISSUER;
        const ubcShibCallbackUrl = process.env.SAML_CALLBACK_URL;
        if (ubcShibIssuer && ubcShibCallbackUrl) {
            methods.ubcshib = true;
        }

        res.json({
            success: true,
            methods: methods
        });
    } catch (error) {
        console.error('Error getting auth methods:', error);
        res.status(503).json({
            success: false,
            error: AUTH_UNAVAILABLE_MESSAGE,
            code: 'AUTH_SERVICE_UNAVAILABLE',
            methods: {
                local: false,
                saml: false,
                ubcshib: false,
                allowLocalLogin: false,
                serviceAvailable: false
            }
        });
    }
});

// Legacy /api/auth/ubcshib routes were removed in favor of the root-level
// Shibboleth routes implemented by src/routes/shibboleth.js.

/**
 * POST /api/auth/promote-to-ta
 * Promote a student to TA role (instructor only)
 */
router.post('/promote-to-ta', async (req, res) => {
    try {
        const { userId, courseId } = req.body;
        
        // Get authenticated user information
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        // Only instructors can promote students
        if (user.role !== 'instructor') {
            return res.status(403).json({
                success: false,
                message: 'Only instructors can promote students to TAs'
            });
        }
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }
        
        // Get database instance from app.locals
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({
                success: false,
                message: 'Database connection not available'
            });
        }

        // If a courseId is supplied, the requesting instructor must own it —
        // otherwise an instructor of course A could invite anyone into course B.
        if (courseId) {
            const course = await db.collection('courses').findOne(
                { courseId, status: { $ne: 'deleted' } },
                { projection: { instructorId: 1, instructors: 1 } }
            );
            if (!course) {
                return res.status(404).json({
                    success: false,
                    message: 'Course not found'
                });
            }
            const owns = course.instructorId === user.userId
                || (Array.isArray(course.instructors) && course.instructors.includes(user.userId));
            if (!owns) {
                return res.status(403).json({
                    success: false,
                    message: 'You can only promote TAs into courses you own.'
                });
            }
        }

        // Prepare update operations
        const updateOps = {
            $set: {
                role: 'ta',
                updatedAt: new Date()
            }
        };

        // If courseId is provided, add it to invitedCourses
        if (courseId) {
            updateOps.$addToSet = { invitedCourses: courseId };
        }
        
        // Update user role to 'ta'
        const usersCollection = db.collection('users');
        const result = await usersCollection.updateOne(
            { userId: userId },
            updateOps
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        
        console.log(`Promoted user ${userId} to TA${courseId ? ` for course ${courseId}` : ''}`);
        
        res.json({
            success: true,
            message: 'User promoted to TA successfully',
            data: {
                userId,
                role: 'ta',
                invitedToCourse: courseId || null
            }
        });
        
    } catch (error) {
        console.error('Error promoting user to TA:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error while promoting user'
        });
    }
});

module.exports = router;
