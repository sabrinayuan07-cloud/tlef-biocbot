require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cors = require('cors');

const { MongoClient } = require('mongodb');
const { ensureCourseCodes } = require('./models/Course');
const { ensureSuperchatsFromLegacy } = require('./models/Superchat');
const { ensureIndexes: ensureMessageFeedbackIndexes } = require('./models/MessageFeedback');
const { ensureIndexes: ensureChatSurveyResponseIndexes } = require('./models/ChatSurveyResponse');
const { ensureIndexes: ensureFlashcardIndexes } = require('./models/FlashcardDeck');
const { ensureIndexes: ensureProviderMigrationIndexes } = require('./services/providerMigrationService');
const { resumePendingMigrations } = require('./services/providerMigrationRunner');
const { backfillExistingScopes } = require('./services/scopeModelSettings');
const { initializeChatEncryption } = require('./services/chatEncryption');
const coursesRoutes = require('./routes/courses');
const flagsRoutes = require('./routes/flags');
const lecturesRoutes = require('./routes/lectures');

const chatRoutes = require('./routes/chat');
const instructorChatRoutes = require('./routes/instructorChat');
const studentSuperCourseRoutes = require('./routes/studentSuperCourse');
const authRoutes = require('./routes/auth');
const shibbolethRoutes = require('./routes/shibboleth');

const learningObjectivesRoutes = require('./routes/learning-objectives');
const documentsRoutes = require('./routes/documents');
const questionsRoutes = require('./routes/questions');
const onboardingRoutes = require('./routes/onboarding');
const qdrantRoutes = require('./routes/qdrant');
const studentsRoutes = require('./routes/students');
const userAgreementRoutes = require('./routes/user-agreement');
const settingsRoutes = require('./routes/settings');
const quizRoutes = require('./routes/quiz');
const flashcardRoutes = require('./routes/flashcards');
const studentTrackerRoutes = require('./routes/student-tracker');
const struggleActivityRoutes = require('./routes/struggle-activity');
const mentalHealthFlagsRoutes = require('./routes/mentalHealthFlags');
const superChatNotesRoutes = require('./routes/superChatNotes');
const superchatsRoutes = require('./routes/superchats');
const exportChangeLogRoutes = require('./routes/exportChangeLog');
const providerMigrationsRoutes = require('./routes/providerMigrations');
const academicSyncRoutes = require('./routes/academicSync');
const studentPseudonymRoutes = require('./routes/studentPseudonyms');
const previewRoutes = require('./routes/preview');
const { createHealthRouter } = require('./routes/health');
const { createCanvasLmsRouter } = require('./routes/canvasLms');
const { createLmsGradesRouter } = require('./routes/lmsGrades');
const { createLmsRosterSyncRouter } = require('./routes/lmsRosterSync');
const { createMoodleLmsRouter } = require('./routes/moodleLms');
const LLMService = require('./services/llm');
const LlmRegistry = require('./services/llmRegistry');
const AuthService = require('./services/authService');
const { isAcademicApiEnabled } = require('./services/academicApi');
const { createLmsIntegration, ensureLmsIndexes, getLmsDiagnostics } = require('./services/lmsIntegration');
const createAuthMiddleware = require('./middleware/auth');
const { crossSiteGuard, parseTrustProxy } = require('./middleware/crossSiteGuard');
const initializePassport = require('./config/passport');

const app = express();
const port = process.env.TLEF_BIOCBOT_PORT || 8080;

// Behind the TLS-terminating proxy this process speaks plain HTTP, so the
// Secure session cookie below is only issued when Express trusts the proxy's
// X-Forwarded-Proto. TRUST_PROXY overrides the same-host default.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// Production cookies are SameSite=None so the cross-site CWL SAML POST still
// carries the session, which also means other sites' form posts carry it.
const crossSiteCookies = process.env.NODE_ENV === 'production';

// Configure CORS to allow requests from localhost:3002 (browser-sync proxy)
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:8050'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
}));

// Serve shared static files publicly
app.use('/assets', express.static(path.join(__dirname, '../public/assets')));
app.use('/styles', express.static(path.join(__dirname, '../public/styles')));
app.use('/common', express.static(path.join(__dirname, '../public/common')));


// Shibboleth routes will be mounted after session and Passport are configured
// This ensures session support is available for Passport authentication

// Service connections
let db;
let mongoClient; // Store MongoDB client for session store
let llmService;
let llmRegistry;
let authService;
let authMiddleware;
let passport;
let lmsIntegration;

// Public probes bypass body parsing, sessions and auth, including requests
// carrying a stale session cookie while MongoDB is unavailable.
app.locals.startupComplete = false;
app.use('/api/health', createHealthRouter({ getRawDb: () => db }));

/**
 * Initialize the LLM service
 * @returns {Promise<void>}
 */
async function initializeLLM() {
    try {
        console.log('🤖 Starting LLM service initialization...');
        llmRegistry = new LlmRegistry();
        app.locals.llmRegistry = llmRegistry;

        const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
        const canUseGlobalOpenAiKey = provider === 'openai' && !!process.env.OPENAI_API_KEY;
        const shouldInitGlobalLlm =
            process.env.BIOCBOT_TEST_LLM_STUB === '1' ||
            provider === 'ollama' ||
            provider === 'ubc-llm-sandbox' ||
            canUseGlobalOpenAiKey;

        if (shouldInitGlobalLlm) {
            llmService = await LLMService.create();
            // Allow the LLM service to look up the active model/reasoning settings
            // from the global settings collection on demand.
            if (typeof llmService.setDbAccessor === 'function') {
                llmService.setDbAccessor(() => app.locals.db);
            }
            app.locals.llm = llmService;
        } else {
            console.log('ℹ️ Global LLM service skipped; scoped per-surface OpenAI keys will be used.');
            app.locals.llm = null;
        }
    } catch (error) {
        console.error('❌ Failed to initialize LLM service:', error.message);
        throw error;
    }
}

/**
 * Verify session middleware configuration
 * Session middleware is already configured early with MongoDB store using clientPromise
 * This function just confirms MongoDB connection is ready
 * @returns {void}
 */
function configureSession() {
    console.log('🔐 Verifying session middleware configuration...');
    console.log('✅ Session middleware is configured with MongoDB store');
    console.log('   MongoDB client promise will resolve when connection is established');
}

/**
 * Initialize Passport authentication
 * Must be called after session middleware is configured
 * @returns {Promise<void>}
 */
async function initializePassportAuth() {
    try {
        console.log('🔐 Starting Passport initialization...');

        // Initialize Passport with database connection
        passport = initializePassport(db);

        // Initialize Passport middleware (must be after session middleware)
        app.use(passport.initialize());
        app.use(passport.session());

        // Make passport available to routes
        app.locals.passport = passport;

        console.log('✅ Passport initialized successfully');

    } catch (error) {
        console.error('❌ Failed to initialize Passport:', error.message);
        throw error;
    }
}

/**
 * Initialize the authentication service
 * @returns {Promise<void>}
 */
async function initializeAuth() {
    try {
        console.log('🔐 Starting authentication service initialization...');
        authService = new AuthService(db);
        authMiddleware = createAuthMiddleware(db);

        // Make auth service available to routes
        app.locals.authService = authService;

        // Initialize default users for development
        const initResult = await authService.initializeDefaultUsers();
        if (initResult.success) {
            console.log('✅ Default users initialized');
        } else {
            console.log('ℹ️ Default users already exist or failed to initialize');
        }

    } catch (error) {
        console.error('❌ Failed to initialize authentication service:', error.message);
        throw error;
    }
}

async function initializeLms() {
    lmsIntegration = createLmsIntegration(db);
    app.locals.lmsIntegration = lmsIntegration;

    const diagnostics = getLmsDiagnostics(lmsIntegration);
    console.log('[LMS] Startup diagnostics:', JSON.stringify(diagnostics));

    if (lmsIntegration.canvas || lmsIntegration.moodle) {
        await ensureLmsIndexes(db);
    }

    if (lmsIntegration.toolkitMissing) {
        console.error(
            '[LMS] Canvas/Moodle environment configuration was found, but ' +
            '@ubc/ubc-genai-toolkit-lms-integration could not be loaded. LMS provider routes are disabled. ' +
            'Because this is an optional GitHub Packages dependency, npm may finish successfully after skipping it. ' +
            'Make a GitHub Packages read token available during the staging build, then confirm the package is present in the built image.'
        );
        if (lmsIntegration.toolkitError) {
            console.error('[LMS] Toolkit load error:', lmsIntegration.toolkitError.message);
        }
        return;
    }

    if (lmsIntegration.canvas) {
        console.log('✅ Canvas LMS integration configured');
    } else if (lmsIntegration.canvasStatus.partial) {
        const { missing, invalidScopes = [] } = lmsIntegration.canvasStatus;
        if (missing.length) {
            console.warn(`⚠️ Canvas LMS integration disabled; missing: ${missing.join(', ')}`);
        }
        if (invalidScopes.length) {
            console.warn(`⚠️ Canvas LMS integration disabled; CANVAS_SCOPES entries are not Canvas scopes: ${invalidScopes.join(', ')}`);
        }
    } else {
        console.log('ℹ️ Canvas LMS integration is not configured');
    }

    if (lmsIntegration.moodle) {
        console.log('✅ Moodle LMS integration configured');
    } else {
        console.log('ℹ️ Moodle LMS integration is not configured');
    }
}

function disabledLmsProviderHandler(provider) {
    return (req, res) => {
        const diagnostic = getLmsDiagnostics(lmsIntegration).providers[provider];
        const status = diagnostic.environment === 'absent' ? 404 : 503;
        const problems = [
            diagnostic.missing.length ? `missing: ${diagnostic.missing.join(', ')}` : null,
            diagnostic.invalid?.length ? `invalid: ${diagnostic.invalid.join(', ')}` : null
        ].filter(Boolean);
        const message = diagnostic.reason === 'toolkit_unavailable'
            ? `${provider} is configured, but the LMS integration package is unavailable in this deployment`
            : diagnostic.reason === 'environment_partial'
                ? `${provider} configuration is incomplete; ${problems.join('; ')}`
                : `${provider} is not configured for this deployment`;

        console.warn('[LMS] Request reached a disabled provider route:', JSON.stringify({
            method: req.method,
            path: req.originalUrl,
            provider,
            status,
            reason: diagnostic.reason,
            missing: diagnostic.missing,
            invalid: diagnostic.invalid
        }));
        res.status(status).json({
            success: false,
            provider,
            code: diagnostic.reason,
            message
        });
    };
}

/**
 * Connect to MongoDB using the connection string from environment variables
 * @returns {Promise<void>}
 */
async function connectToMongoDB() {
    try {
        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) {
            throw new Error('MONGO_URI environment variable is not set');
        }

        const client = new MongoClient(mongoUri);
        await client.connect();

        // Store the client for session store
        mongoClient = client;

        // Resolve the MongoDB client promise for session store
        if (global._resolveMongoClient) {
            global._resolveMongoClient(client);
            delete global._resolveMongoClient;
        }

        // Get the database instance
        db = client.db();

        console.log('✅ Successfully connected to MongoDB');

        // Make the database available to routes
        app.locals.db = db;

        // Test the connection by listing collections
        const collections = await db.listCollections().toArray();
        console.log(`📚 Available collections: ${collections.map(c => c.name).join(', ') || 'None'}`);

    } catch (error) {
        console.error('❌ Failed to connect to MongoDB:', error.message);
        process.exit(1);
    }
}



// Middleware for parsing request bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Create a promise that will resolve to the MongoDB client
// This allows us to configure session middleware early with MongoDB store
let mongoClientPromise = new Promise((resolve) => {
    // This will be resolved when MongoDB connects
    global._resolveMongoClient = resolve;
});

// Configure session middleware early (before MongoDB connection)
// Using clientPromise allows MongoDB store to work once client is connected
app.use(session({
    secret: process.env.SESSION_SECRET || 'biocbot-session-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        clientPromise: mongoClientPromise, // Will resolve when MongoDB connects
        dbName: process.env.MONGO_DB_NAME, // Optional: specify database name
        collectionName: 'sessions',
        ttl: 24 * 60 * 60, // 24 hours
        touchAfter: 24 * 3600
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: crossSiteCookies ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    },
    name: 'biocbot.sid'
}));

if (crossSiteCookies) {
    app.use('/api', crossSiteGuard({
        // The CWL IdP posts its SAML response here from its own site.
        exemptPaths: ['/auth/saml/callback'],
        // Public URLs of this app, for proxies that rewrite the Host header.
        trustedOrigins: [process.env.SAML_CALLBACK_URL, process.env.CANVAS_REDIRECT_URI].filter(Boolean)
    }));
}



// Home page - public marketing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Quick Qdrant test endpoint
app.get('/test-qdrant', async (req, res) => {
    try {
        const QdrantService = require('./services/qdrantService');
        const qdrantService = new QdrantService({ skipEmbeddings: true });

        console.log('🧪 Testing Qdrant connection...');
        await qdrantService.initialize();

        const stats = await qdrantService.getCollectionStats();

        res.json({
            success: true,
            message: 'Qdrant connection successful!',
            collection: stats
        });

    } catch (error) {
        console.error('❌ Qdrant test failed:', error);
        res.status(500).json({
            success: false,
            message: 'Qdrant test failed',
            error: error.message
        });
    }
});

/**
 * Set up protected routes after authentication middleware is initialized
 */
function setupProtectedRoutes() {
    // Runs ahead of every protected route below so that "View as Student"
    // requests are already wearing the sandboxed student identity by the time
    // role gating and data handlers see them.
    app.use(authMiddleware.resolvePreview);

    const redirectTATo = (targetPath) => (req, res, next) => {
        if (req.user && req.user.role === 'ta') {
            return res.redirect(targetPath);
        }
        next();
    };

    app.get('/instructor/downloads.html', authMiddleware.requireInstructorOrTA, redirectTATo('/ta'), authMiddleware.requireSystemAdmin, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/downloads.html'));
    });

    // Must be declared before the /instructor static mount, which would
    // otherwise serve student-hub.html to TAs (the mount only requires
    // instructor OR TA, not instructor exclusively).
    app.get('/instructor/student-hub.html', authMiddleware.requireInstructor, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/student-hub.html'));
    });

    app.get('/instructor/chat.html', authMiddleware.requireInstructorOrTA, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/chat.html'));
    });

    // Protected static files
    app.use('/student', authMiddleware.allowStudentAssets, express.static(path.join(__dirname, '../public/student')));
    app.use('/instructor', authMiddleware.requireInstructorOrTA, express.static(path.join(__dirname, '../public/instructor')));
    app.use('/ta', authMiddleware.requireTA, express.static(path.join(__dirname, '../public/ta')));

    // Qdrant test page (protected)
    app.get('/qdrant-test', authMiddleware.requireAuth, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/qdrant-test.html'));
    });

    // Student routes (protected)
    app.get('/student', authMiddleware.requireStudentOrPreview, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/student/index.html'));
    });

    app.get('/student/history', authMiddleware.requireStudentOrPreview, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/student/history.html'));
    });

    // Student flagged content page
    app.get('/student/flagged', authMiddleware.requireStudentOrPreview, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/student/flagged.html'));
    });

    // Student quiz practice page
    app.get('/student/quiz', authMiddleware.requireStudentOrPreview, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/student/quiz.html'));
    });

    app.get('/student/flashcards', authMiddleware.requireStudentOrPreview, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/student/flashcards.html'));
    });

    // Student Super Course chat page
    // Super Course spans courses beyond the one being previewed, so it stays
    // outside the preview sandbox; the nav item is hidden in preview too.
    app.get('/student/super-course', authMiddleware.requireStudent, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/student/super-course.html'));
    });

    // TA routes (protected)
    app.get('/ta', authMiddleware.requireTA, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/ta/home.html'));
    });

    app.get('/ta/onboarding', authMiddleware.requireTA, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/ta/onboarding.html'));
    });

    // TA course management - redirect to instructor course page
    app.get('/ta/courses', authMiddleware.requireTA, (req, res) => {
        res.redirect('/instructor/documents');
    });

    // TA student support - redirect to instructor flags page
    app.get('/ta/students', authMiddleware.requireTA, (req, res) => {
        res.redirect('/instructor/flagged');
    });

    // TA settings - serve dedicated TA settings page
    app.get('/ta/settings', authMiddleware.requireTA, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/ta/settings.html'));
    });

    // Instructor routes (protected - instructors and TAs can access)
    app.get('/instructor', authMiddleware.requireInstructorOrTA, (req, res) => {
        // Serve the documents page directly
        res.sendFile(path.join(__dirname, '../public/instructor/index.html'));
    });

    // Also handle /instructor/ (with trailing slash)
    app.get('/instructor/', authMiddleware.requireInstructorOrTA, (req, res) => {
        // Serve the documents page directly
        res.sendFile(path.join(__dirname, '../public/instructor/index.html'));
    });

    // Check if user can access onboarding (not completed)
    app.get('/instructor/onboarding', authMiddleware.requireInstructor, async (req, res) => {
        try {
            const instructorId = req.user.userId; // Get from authenticated user

            // Check if instructor has completed onboarding
            const db = req.app.locals.db;

            // "Set up another section" deliberately re-enters onboarding to create
            // a new course, so skip the completed-course redirect in that case —
            // but only when the academic API is on. With it off (the default),
            // restore the pre-feature behavior: a completed instructor is always
            // redirected away and can't re-enter onboarding to add a course.
            const addingCourse = req.query.addCourse && await isAcademicApiEnabled(db);
            if (db && !addingCourse) {
                const collection = db.collection('courses');
                const existingCourse = await collection.findOne({
                    instructorId,
                    isOnboardingComplete: true
                });

                if (existingCourse) {
                    // Redirect to course upload page if onboarding is complete
                    return res.redirect(`/instructor/documents?courseId=${existingCourse.courseId}`);
                }
            }

            // If no completed course (or explicitly adding another), show onboarding
            res.sendFile(path.join(__dirname, '../public/instructor/onboarding.html'));

        } catch (error) {
            console.error('Error checking onboarding status:', error);
            // If there's an error, show onboarding
            res.sendFile(path.join(__dirname, '../public/instructor/onboarding.html'));
        }
    });

    app.get('/instructor/settings', authMiddleware.requireInstructorOrTA, redirectTATo('/ta/settings'), (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/settings.html'));
    });

    app.get('/instructor/home', authMiddleware.requireInstructorOrTA, redirectTATo('/ta'), (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/home.html'));
    });

    app.get('/instructor/chat', authMiddleware.requireInstructorOrTA, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/chat.html'));
    });

    // Super Chat Notes — shared instructor knowledge layer
    app.get('/instructor/notes', authMiddleware.requireInstructorOrTA, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/notes.html'));
    });

    // Gated on ANY of materials/questions/settings, not one specific
    // permission: this page's sections span all three independently now, so
    // a TA with only one of them (e.g. 'questions' but not 'materials')
    // still needs to reach it - but a TA with none of them (e.g. fully
    // revoked) shouldn't. Each section is further hidden client-side per
    // instructor-units.js's applyTASectionPermissions, and every underlying
    // API call remains gated on its own specific permission regardless.
    app.get('/instructor/documents', authMiddleware.requireInstructorOrTA, authMiddleware.requireAnyPermission(['materials', 'questions', 'settings']), (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/index.html'));
    });

    app.get('/instructor/flagged', authMiddleware.requireInstructorOrTA, authMiddleware.requirePermission('flags'), (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/flagged.html'));
    });

    app.get('/instructor/downloads', authMiddleware.requireInstructorOrTA, redirectTATo('/ta'), authMiddleware.requireSystemAdmin, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/downloads.html'));
    });

    app.get('/instructor/ta-hub', authMiddleware.requireInstructorOrTA, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/ta-hub.html'));
    });

    app.get('/instructor/student-hub', authMiddleware.requireInstructor, (req, res) => {
        res.sendFile(path.join(__dirname, '../public/instructor/student-hub.html'));
    });
}

// Legacy routes (redirect to new structure)
app.get('/settings', (req, res) => {
    res.redirect('/student');
});

/**
 * Set up API routes after authentication middleware is initialized
 */
function setupAPIRoutes() {
    // Authentication routes (no auth required for most, but some need user population)
    app.use('/api/auth', authMiddleware.populateUser, authRoutes);

    // API endpoints (protected)
    app.use('/api/courses', authMiddleware.requireAuth, authMiddleware.requireActiveCourseForNonInstructors, coursesRoutes);
    app.use('/api/flags', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireActiveCourseForNonInstructors, flagsRoutes);
    app.use('/api/lectures', authMiddleware.requireAuth, authMiddleware.requireActiveCourseForNonInstructors, lecturesRoutes);

    app.use('/api/learning-objectives', authMiddleware.requireAuth, authMiddleware.requireActiveCourseForNonInstructors, learningObjectivesRoutes);
    app.use('/api/documents', authMiddleware.requireAuth, authMiddleware.requireActiveCourseForNonInstructors, documentsRoutes);
    app.use('/api/questions', authMiddleware.requireAuth, authMiddleware.requireActiveCourseForNonInstructors, questionsRoutes);
    app.use('/api/onboarding', authMiddleware.requireAuth, onboardingRoutes);
    app.use('/api/qdrant', authMiddleware.requireAuth, qdrantRoutes);
    app.use('/api/chat', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireActiveCourseForNonInstructors, authMiddleware.requireStudentEnrolled, chatRoutes);
    app.use('/api/instructor/chat', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireInstructorOrTA, instructorChatRoutes);
    app.use('/api/superchat-notes', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireInstructorOrTA, superChatNotesRoutes);
    app.use('/api/superchats', authMiddleware.requireAuth, authMiddleware.populateUser, superchatsRoutes);
    app.use('/api/export-change-log', authMiddleware.requireAuth, authMiddleware.populateUser, exportChangeLogRoutes);
    app.use('/api/provider-migrations', authMiddleware.requireAuth, authMiddleware.populateUser, providerMigrationsRoutes);
    app.use('/api/academic-sync', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireInstructor, academicSyncRoutes);
    app.use('/api/student-pseudonyms', authMiddleware.requireAuth, authMiddleware.populateUser, studentPseudonymRoutes);
    app.get(
        '/api/lms/configuration',
        authMiddleware.requireAuth,
        authMiddleware.populateUser,
        authMiddleware.requireInstructor,
        (req, res) => res.json({ success: true, data: getLmsDiagnostics(lmsIntegration) })
    );
    if (lmsIntegration.canvas) {
        app.use(
            '/api/lms/canvas',
            authMiddleware.requireAuth,
            authMiddleware.populateUser,
            authMiddleware.requireInstructor,
            createCanvasLmsRouter(lmsIntegration.canvas)
        );
    }
    if (!lmsIntegration.canvas) {
        app.use(
            '/api/lms/canvas',
            authMiddleware.requireAuth,
            authMiddleware.populateUser,
            authMiddleware.requireInstructor,
            disabledLmsProviderHandler('canvas')
        );
    }
    if (lmsIntegration.moodle) {
        app.use(
            '/api/lms/moodle',
            authMiddleware.requireAuth,
            authMiddleware.populateUser,
            authMiddleware.requireInstructor,
            createMoodleLmsRouter(lmsIntegration.moodle)
        );
    }
    if (!lmsIntegration.moodle) {
        app.use(
            '/api/lms/moodle',
            authMiddleware.requireAuth,
            authMiddleware.populateUser,
            authMiddleware.requireInstructor,
            disabledLmsProviderHandler('moodle')
        );
    }
    // Keep this mounted even when no provider is available. Its read endpoint
    // can still return an empty/configuration-aware view, and clients receive
    // JSON diagnostics instead of Express's HTML 404 page.
    app.use(
        '/api/lms/grades',
        authMiddleware.requireAuth,
        authMiddleware.populateUser,
        authMiddleware.requireInstructor,
        createLmsGradesRouter(lmsIntegration)
    );
    app.use(
        '/api/lms/roster',
        authMiddleware.requireAuth,
        authMiddleware.populateUser,
        authMiddleware.requireInstructor,
        createLmsRosterSyncRouter(lmsIntegration)
    );
    app.use('/api/student/super-course', authMiddleware.requireAuth, authMiddleware.populateUser, studentSuperCourseRoutes);
    app.use('/api/students', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireActiveCourseForNonInstructors, authMiddleware.requireStudentEnrolled, studentsRoutes);
    app.use('/api/user-agreement', authMiddleware.requireAuth, userAgreementRoutes);
    app.use('/api/settings', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireActiveCourseForNonInstructors, settingsRoutes);
    app.use('/api/student/struggle', authMiddleware.requireAuth, authMiddleware.populateUser, studentTrackerRoutes);
    app.use('/api/struggle-activity', authMiddleware.requireAuth, authMiddleware.requireActiveCourseForNonInstructors, struggleActivityRoutes);
    app.use('/api/quiz', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireActiveCourseForNonInstructors, authMiddleware.requireStudentEnrolled, quizRoutes);
    app.use('/api/flashcards', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireActiveCourseForNonInstructors, authMiddleware.requireStudentEnrolled, flashcardRoutes);
    app.use('/api/mental-health-flags', authMiddleware.requireAuth, authMiddleware.populateUser, authMiddleware.requireActiveCourseForNonInstructors, mentalHealthFlagsRoutes);

    // Preview control plane. Deliberately mounted without a role gate: calls
    // arrive from a tab that is already wearing the sandboxed student identity,
    // and each handler authorizes against the real user behind the preview.
    app.use('/api/preview', authMiddleware.requireAuth, authMiddleware.populateUser, previewRoutes);

    // Test-only routes for scripting the LLM stub. Gated by BIOCBOT_TEST_LLM_STUB
    // so they are unreachable in production runs (no flag = no router mounted).
    if (process.env.BIOCBOT_TEST_LLM_STUB === '1') {
        const testLlmStubRoutes = require('./routes/testLlmStub');
        app.use('/api/test/llm-stub', testLlmStubRoutes);
        console.log('🧪 Test LLM stub routes mounted at /api/test/llm-stub');
    }
}

// Initialize the application
async function startServer() {
    try {
        console.log('🚀 Starting BiocBot server...');

        // Session middleware is already configured early (before MongoDB connection)
        // It uses clientPromise which will resolve when MongoDB connects
        
        // Initialize core services in correct order
        await connectToMongoDB(); // Resolves the MongoDB client promise for session store
        
        // Verify session configuration
        configureSession();
        
        // Initialize Passport (requires session middleware - already configured)
        await initializePassportAuth();
        
        // Mount Shibboleth routes AFTER session and Passport are configured
        // These routes use Passport authentication and require session support
        app.use('/', shibbolethRoutes);
        
        // Initialize other services
        await initializeLLM();
        await initializeAuth();
        await initializeLms();

        // Run migrations
        await ensureCourseCodes(db);
        await ensureSuperchatsFromLegacy(db);
        await ensureMessageFeedbackIndexes(db);
        await ensureChatSurveyResponseIndexes(db);
        await ensureFlashcardIndexes(db);
        await ensureProviderMigrationIndexes(db);
        const materializedModelScopes = await backfillExistingScopes(db);
        console.log(`✅ Materialized per-scope model settings for ${materializedModelScopes} AI surface(s)`);

        // Persistent provider/embedding migrations survive restarts: resume any
        // job that was still queued or running when the server stopped.
        await resumePendingMigrations(db).catch((error) => {
            console.error('⚠️ Failed to resume provider migrations:', error.message);
        });

        // Keep startup migrations and connect-mongo on the driver's raw Db.
        // Routes receive the protected wrapper only after startup work is done;
        // unconfigured collections continue to pass through unchanged.
        app.locals.db = await initializeChatEncryption(db);

        // Set up routes after authentication is initialized
        setupProtectedRoutes();
        setupAPIRoutes();
        app.locals.startupComplete = true;

        // Start the Express server
        app.listen(port, () => {
            console.log('\n✨ All services initialized successfully!');
            console.log(`🌐 Server is running on http://localhost:${port}`);
            console.log(`👨‍🎓 Student interface: http://localhost:${port}/student`);
            console.log(`👨‍🏫 Instructor interface: http://localhost:${port}/instructor`);
            console.log(`🔍 Health check: http://localhost:${port}/api/health`);
            console.log(`   Liveness: /api/health/live   Readiness: /api/health/ready`);
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        process.exit(1);
    }
}

// Start the server
startServer();
