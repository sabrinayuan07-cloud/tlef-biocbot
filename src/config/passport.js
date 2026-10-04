/**
 * Passport Configuration
 * Configures authentication strategies for BiocBot
 * Supports: Local (username/password), SAML, and UBC Shibboleth
 */
const fs = require('fs');
const path = require('path');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const SamlStrategy = require('@node-saml/passport-saml').Strategy;
const User = require('../models/User');

// Try to import passport-ubcshib (may not be available in all environments)
let UBCShibStrategy;
let ubcShibHelpers;
try {
    // Import according to passport-ubcshib documentation
    // Documentation shows: const { Strategy } = require('passport-ubcshib');
    const ubcshib = require('passport-ubcshib');
    // addings
    // Try different import patterns to handle various module export styles
    if (ubcshib.Strategy) {
        // Named export: { Strategy }
        UBCShibStrategy = ubcshib.Strategy;
    } else if (ubcshib.default && ubcshib.default.Strategy) {
        // Default export with Strategy property
        UBCShibStrategy = ubcshib.default.Strategy;
    } else if (typeof ubcshib === 'function') {
        // Direct export as constructor function
        UBCShibStrategy = ubcshib;
    } else {
        throw new Error('Could not find Strategy in passport-ubcshib module');
    }

    // Import helper middleware (ensureAuthenticated, logout, conditionalAuth)
    ubcShibHelpers = {
        ensureAuthenticated: ubcshib.ensureAuthenticated || (ubcshib.default && ubcshib.default.ensureAuthenticated),
        logout: ubcshib.logout || (ubcshib.default && ubcshib.default.logout),
        conditionalAuth: ubcshib.conditionalAuth || (ubcshib.default && ubcshib.default.conditionalAuth)
    };

    console.log('✅ passport-ubcshib module loaded successfully');
    console.log(`   Strategy type: ${typeof UBCShibStrategy}`);
} catch (error) {
    console.warn('⚠️ passport-ubcshib not available, UBC Shibboleth authentication will be disabled');
    console.warn(`   Error: ${error.message}`);
    UBCShibStrategy = null;
    ubcShibHelpers = null;
}

/**
 * Initialize Passport strategies
 * @param {Object} db - MongoDB database instance
 * @returns {Object} Configured passport instance
 */
function initializePassport(db) {
    /**
     * Local Strategy - Username/Password Authentication
     * Used for basic authentication (instructor, student, ta)
     */
    passport.use('local', new LocalStrategy(
        {
            usernameField: 'username', // Field name for username in request
            passwordField: 'password', // Field name for password in request
            passReqToCallback: false // Don't pass request to callback
        },
        async (username, password, done) => {
            try {
                // Authenticate user using existing User model
                const result = await User.authenticateUser(db, username, password);

                if (!result.success) {
                    // Authentication failed
                    return done(null, false, { message: result.error });
                }

                // Authentication successful - return user
                return done(null, result.user);

            } catch (error) {
                console.error('Error in local strategy:', error);
                return done(error);
            }
        }
    ));

    /**
     * SAML Strategy - Generic SAML 2.0 Authentication
     * Used for SAML-based authentication (can be configured for any SAML IdP)
     * Only configured if SAML environment variables are set
     */
    const samlEntryPoint = process.env.SAML_ENTRY_POINT;
    const samlIssuer = process.env.SAML_ISSUER;
    const samlCallbackUrl = process.env.SAML_CALLBACK_URL;
    const samlCertPath = process.env.SAML_CERT_PATH;
    const samlPrivateKey = process.env.SAML_PRIVATE_KEY;

    // Only read certificate file if SAML_CERT_PATH is provided
    let cert = null;
    if (samlCertPath) {
        try {
            cert = fs.readFileSync(samlCertPath, 'utf8');
        } catch (error) {
            console.error(`❌ Failed to read SAML certificate from ${samlCertPath}:`, error.message);
            cert = null;
        }
    }

    if (samlEntryPoint && samlIssuer && samlCallbackUrl && cert) {
        try {
            passport.use('saml', new SamlStrategy(
                {
                    entryPoint: samlEntryPoint,
                    issuer: samlIssuer,
                    callbackUrl: samlCallbackUrl,
                    idpCert: cert, // @node-saml renamed passport-saml's `cert` to `idpCert`
                    privateKey: samlPrivateKey || null,
                    signatureAlgorithm: process.env.SAML_SIGNATURE_ALGORITHM || 'sha256',
                    digestAlgorithm: process.env.SAML_DIGEST_ALGORITHM || 'sha256',
                    acceptedClockSkewMs: parseInt(process.env.SAML_CLOCK_SKEW_MS) || 0,
                    // @node-saml takes 'always' | 'ifPresent' | 'never' instead of a boolean
                    validateInResponseTo: process.env.SAML_VALIDATE_IN_RESPONSE_TO === 'true' ? 'always' : 'never',
                    disableRequestAcsUrl: process.env.SAML_DISABLE_REQUEST_ACS_URL === 'true'
                },
                async (profile, done) => {
                    try {
                        // Extract SAML attributes
                        const samlId = profile.nameID || profile.ID || profile.issuer;
                        const email = profile.email || profile.mail || profile['urn:oid:0.9.2342.19200300.100.1.3'];
                        const displayName = profile.displayName || profile.cn || email;

                        if (!samlId || !email) {
                            return done(null, false, { message: 'SAML profile missing required attributes' });
                        }

                        // Create or get user from SAML data
                        const samlData = {
                            samlId: samlId,
                            email: email,
                            username: email.split('@')[0], // Use email prefix as username
                            displayName: displayName,
                            role: profile.role || 'student' // Default to student, can be mapped from SAML attributes
                        };

                        const result = await User.createOrGetSAMLUser(db, samlData);

                        if (!result.success) {
                            return done(null, false, { message: result.error });
                        }

                        // Return user object
                        return done(null, result.user);

                    } catch (error) {
                        console.error('Error in SAML strategy:', error);
                        return done(error);
                    }
                },
                // Logout verify: @node-saml calls this for an IdP-initiated
                // LogoutRequest and throws without it. This strategy has no SLO
                // route of its own, so there is no user to match.
                (profile, done) => done(null, null)
            ));
            console.log('✅ SAML strategy configured');
        } catch (error) {
            console.error('❌ Failed to configure SAML strategy:', error.message);
        }
    } else {
        console.log('ℹ️ SAML strategy not configured (missing environment variables)');
    }

    /**
     * UBC Shibboleth Strategy - UBC-specific SAML Authentication
     * Uses passport-ubcshib for UBC's Shibboleth IdP integration
     * Only configured if SAML environment variables are set
     */
    if (UBCShibStrategy) {
        const ubcShibIssuer = process.env.SAML_ISSUER;
        const ubcShibCallbackUrl = process.env.SAML_CALLBACK_URL;
        const ubcShibPrivateKeyPath = process.env.SAML_PRIVATE_KEY_PATH;
        const ubcShibCertPath = process.env.SAML_CERT_PATH;
        const ubcShibEnvironment = process.env.SAML_ENVIRONMENT || 'STAGING';

        // Read SAML certificate if path is provided
        let ubcShibCert = null;
        if (ubcShibCertPath) {
            try {
                ubcShibCert = fs.readFileSync(ubcShibCertPath, 'utf8');
            } catch (error) {
                console.error(`❌ Failed to read SAML certificate from ${ubcShibCertPath}:`, error.message);
            }
        }

        console.log('🔍 Checking UBC Shibboleth configuration...');
        console.log(`   SAML_ISSUER: ${ubcShibIssuer ? '✓ Set' : '✗ Missing'}`);
        console.log(`   SAML_CALLBACK_URL: ${ubcShibCallbackUrl ? '✓ Set' : '✗ Missing'}`);
        console.log(`   SAML_PRIVATE_KEY_PATH: ${ubcShibPrivateKeyPath ? '✓ Set' : '✗ Missing'}`);
        console.log(`   SAML_CERT_PATH: ${ubcShibCertPath ? '✓ Set' : '✗ Missing'}`);
        console.log(`   SAML_CERT: ${ubcShibCert ? '✓ Loaded' : '✗ Not loaded'}`);
        console.log(`   SAML_ENVIRONMENT: ${ubcShibEnvironment}`);

        if (ubcShibIssuer && ubcShibCallbackUrl && ubcShibCert) {
            try {
                passport.use('ubcshib', new UBCShibStrategy(
                    {
                        entryPoint: process.env.SAML_ENTRY_POINT,
                        issuer: ubcShibIssuer,
                        callbackUrl: ubcShibCallbackUrl,
                        cert: ubcShibCert,
                        privateKeyPath: ubcShibPrivateKeyPath,
                        attributeConfig: ['ubcEduCwlPuid', 'mail', 'eduPersonAffiliation'],
                        enableSLO: process.env.ENABLE_SLO !== 'false',
                        validateInResponseTo: process.env.SAML_VALIDATE_IN_RESPONSE_TO !== 'false',
                        acceptedClockSkewMs: parseInt(process.env.SAML_CLOCK_SKEW_MS) || 0,
                        logoutUrl: process.env.SAML_LOGOUT_URL || process.env.SAML_ENTRY_POINT,
                        metadataUrl: process.env.SAML_METADATA_URL
                    },
                    async (profile, done) => {

                        console.log( 'passport.js profile', profile );

                        try {
                            // Extract UBC Shibboleth attributes
                            // The attribute is called 'ubcEduCwlPuid' and can be in multiple formats:
                            // 1. profile.attributes.ubcEduCwlPuid (friendly name)
                            // 2. profile['urn:mace:dir:attribute-def:ubcEduCwlPuid'] (MACE format)
                            // 3. profile['urn:oid:1.3.6.1.4.1.60.6.1.6'] (OID format)
                            const ubcEduCwlPuid = profile.attributes?.ubcEduCwlPuid ||
                                                   profile['urn:mace:dir:attribute-def:ubcEduCwlPuid'] ||
                                                   profile['urn:oid:1.3.6.1.4.1.60.6.1.6'];
                            
                            // Log available attributes for debugging
                            if (!ubcEduCwlPuid) {
                                console.warn('[UBC SHIB] ubcEduCwlPuid not found in profile');
                                console.warn('[UBC SHIB] Available profile keys:', Object.keys(profile));
                                console.warn('[UBC SHIB] Available attributes:', Object.keys(profile.attributes || {}));
                            } else {
                                console.log(`[UBC SHIB] Extracted ubcEduCwlPuid: ${ubcEduCwlPuid}`);
                            }
                            
                            const samlId = profile.nameID || ubcEduCwlPuid;
                            const email = profile.attributes?.mail || 
                                         profile.attributes?.email || 
                                         profile['urn:oid:0.9.2342.19200300.100.1.3'] ||
                                         profile.mail ||
                                         profile.email ||
                                         profile.nameID;
                            const displayName = profile.attributes?.displayName || 
                                               profile.attributes?.cn || 
                                               profile['urn:oid:2.16.840.1.113730.3.1.241'] ||
                                               email;
                            const affiliation = profile.attributes?.eduPersonAffiliation || 
                                               profile['urn:oid:1.3.6.1.4.1.5923.1.1.1.1'] ||
                                               [];

                            // ubcEduCwlPuid is required for CWL authentication (primary identifier)
                            if (!ubcEduCwlPuid) {
                                return done(null, false, { message: 'UBC Shibboleth profile missing required attribute: ubcEduCwlPuid' });
                            }

                            if (!samlId || !email) {
                                return done(null, false, { message: 'UBC Shibboleth profile missing required attributes (email or nameID)' });
                            }

                            // --- Role Determination Logic ---
                            //
                            // Role comes from CWL affiliation only.
                            // Platform-wide admin access is stored separately in MongoDB and
                            // applied after login as an extra permission, not from env config.
                            //
                            // A user gets 'instructor' ONLY if they have faculty affiliation
                            // and do NOT also have a student affiliation. Everyone else
                            // defaults to 'student'.

                            let role = 'student'; // Default role

                            // Normalize the affiliation attribute — it can arrive as a string or array
                            const affiliationList = Array.isArray(affiliation) ? affiliation : [affiliation];

                            const normalizedEmail = (email || '').trim().toLowerCase();

                            // Check UBC affiliations.
                            // ONLY users with the 'faculty' affiliation — and nothing that
                            // indicates a dual student/staff role — get instructor.
                            // 'staff', 'member', 'employee', etc. are not sufficient on their own.
                            // If a user has BOTH 'faculty' and 'student', they are treated as student.
                            const hasFacultyAffiliation = affiliationList.includes('faculty');
                            const hasStudentAffiliation = affiliationList.includes('student');

                            if (hasFacultyAffiliation && !hasStudentAffiliation) {
                                role = 'instructor';
                            } else {
                                role = 'student';
                            }

                            console.log(`[UBC SHIB] Affiliation: ${JSON.stringify(affiliationList)}, Email: ${normalizedEmail}, Assigned Role: ${role}`);

                            // Create or get user from UBC Shibboleth data
                            // ubcEduCwlPuid is the primary identifier for CWL users
                            const samlData = {
                                samlId: samlId || ubcEduCwlPuid,
                                puid: ubcEduCwlPuid, // Store ubcEduCwlPuid as primary identifier for CWL users
                                email: email,
                                username: ubcEduCwlPuid || email.split('@')[0],
                                displayName: displayName,
                                role: role
                            };

                            const result = await User.createOrGetSAMLUser(db, samlData);

                            if (!result.success) {
                                return done(null, false, { message: result.error });
                            }

                            // PUID is now stored in the user document via createOrGetSAMLUser
                            // No need to store it separately in preferences

                            // Return user object
                            return done(null, result.user);

                        } catch (error) {
                            console.error('Error in UBC Shibboleth strategy:', error);
                            return done(error);
                        }
                    }
                ));
                console.log(`✅ UBC Shibboleth strategy configured (${ubcShibEnvironment})`);
            } catch (error) {
                console.error('❌ Failed to configure UBC Shibboleth strategy:', error.message);
                console.error('   Error details:', error);
            }
        } else {
            console.log('ℹ️ UBC Shibboleth strategy not configured (missing required environment variables)');
            console.log('   Required: SAML_ISSUER, SAML_CALLBACK_URL, and SAML_CERT_PATH');
        }
    } else {
        console.log('ℹ️ UBC Shibboleth strategy not available (passport-ubcshib module not loaded)');
    }

    /**
     * Serialize user for session storage
     * Stores only the user ID in the session
     * @param {Object} user - User object from authentication
     * @param {Function} done - Callback function
     */
    passport.serializeUser((user, done) => {
        // Store only the userId in the session
        done(null, user.userId);
    });

    /**
     * Deserialize user from session
     * Retrieves full user object from database using stored userId
     * @param {string} userId - User ID from session
     * @param {Function} done - Callback function
     */
    passport.deserializeUser(async (userId, done) => {
        try {
            const user = await User.getUserById(db, userId);
            if (!user) {
                // User not found - clear session
                return done(null, false);
            }
            // Return user object
            done(null, user);
        } catch (error) {
            console.error('Error deserializing user:', error);
            done(error);
        }
    });

    // Export helper middleware if available
    if (ubcShibHelpers) {
        passport.ubcShibHelpers = ubcShibHelpers;
    }

    return passport;
}

module.exports = initializePassport;
