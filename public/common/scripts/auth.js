/**
 * Common Authentication Script
 * Handles user authentication state and logout functionality
 */

let currentUser = null;
let currentLLMTagClasses = [];

const PREVIEW_SKIP_TUTORIAL_KEY = 'biocbot_preview_skip_tutorial';

const LLM_TAG_CLASS_PATTERN = /^(llm|reasoning)-\d+$/;
const LLM_TAG_TARGET_SELECTOR = 'body, .chat-container, #chat-messages, .quiz-chat-container, #quiz-chat-messages';
const LLM_TAG_COMMENT_PREFIX = 'LLM tag map:';
const LLM_TAG_COMMENT_TEXT = 'LLM tag map: llm-1 = gpt-4.1-mini; llm-2 = gpt-5-nano; llm-3 = gpt-5.4-nano; llm-4 = gpt-5.6-luna; reasoning-* applies to GPT-5 models only; reasoning-1 = minimal; reasoning-2 = low; reasoning-3 = medium; reasoning-4 = high';

function stripLLMTagClasses(element) {
    if (!element || !element.classList) return;

    Array.from(element.classList)
        .filter(className => LLM_TAG_CLASS_PATTERN.test(className))
        .forEach(className => element.classList.remove(className));
}

function applyLLMTagClassesToElement(element, tagClasses = currentLLMTagClasses) {
    if (!element || !element.classList) return;

    stripLLMTagClasses(element);
    tagClasses.forEach(className => element.classList.add(className));
    if (tagClasses.length > 0) {
        ensureLLMTagComment(element);
    }
}

function applyLLMTagClasses(tagClasses = currentLLMTagClasses) {
    document
        .querySelectorAll(LLM_TAG_TARGET_SELECTOR)
        .forEach(element => applyLLMTagClassesToElement(element, tagClasses));
}

function getCurrentLLMTagClasses() {
    return currentLLMTagClasses.slice();
}

function ensureLLMTagComment(element) {
    const parent = element.parentNode;
    if (!parent) return;

    const previousNode = element.previousSibling;
    if (
        previousNode &&
        previousNode.nodeType === Node.COMMENT_NODE &&
        previousNode.nodeValue.trim().startsWith(LLM_TAG_COMMENT_PREFIX)
    ) {
        previousNode.nodeValue = ` ${LLM_TAG_COMMENT_TEXT} `;
        return;
    }

    parent.insertBefore(document.createComment(` ${LLM_TAG_COMMENT_TEXT} `), element);
}

/**
 * Tag the chat DOM with obfuscated classes (e.g. "llm-2 reasoning-1") and a
 * nearby HTML comment mapping those classes for anyone inspecting DevTools.
 */
async function applyLLMBodyTag() {
    try {
        const response = await fetch('/api/settings/llm-tag');
        const result = await response.json();
        if (!result || !result.success) return;
        const { llmIndex, reasoningIndex } = result;
        currentLLMTagClasses = [
            llmIndex ? `llm-${llmIndex}` : null,
            reasoningIndex ? `reasoning-${reasoningIndex}` : null
        ].filter(Boolean);
        applyLLMTagClasses();
    } catch (e) {
        // Non-critical: tag is for internal debugging only
        console.warn('applyLLMBodyTag failed', e);
    }
}

window.applyLLMBodyTag = applyLLMBodyTag;
window.applyLLMTagClassesToElement = applyLLMTagClassesToElement;
window.getCurrentLLMTagClasses = getCurrentLLMTagClasses;

/**
 * The six granular TA permissions, matching src/services/permissions.js's
 * PERMISSION_KEYS. Kept as a plain array here (not fetched) since it's static.
 */
window.TA_PERMISSION_KEYS = ['materials', 'questions', 'flags', 'roster', 'transcripts', 'settings'];

/**
 * Does a fetched permissions object grant `key`? Single shared check so
 * instructor-ta.js, flagged.js, ta-settings.js, and ta-home.js don't each
 * hand-roll the same truthy comparison. Named permissionIsGranted (not
 * hasPermissionForFeature) because each of those files already defines its
 * own hasPermissionForFeature(feature) with a different signature (union
 * across a TA's courses, or the currently-selected one) - this is the
 * single-permissions-object primitive their per-file logic calls into.
 * @param {Object} permissions - A TA's permission object (any of the 6 keys)
 * @param {string} key - One of window.TA_PERMISSION_KEYS
 * @returns {boolean}
 */
window.permissionIsGranted = function (permissions, key) {
    return !!(permissions && permissions[key] === true);
};

async function initAuth() {
    try {
        // Apply the hidden LLM debug tag in parallel with auth check
        applyLLMBodyTag();

        // Get current user information
        const response = await fetch('/api/auth/me');
        const result = await response.json();
        
        if (result.success && result.user) {
            currentUser = result.user;
            updateUserDisplay();
            adjustNavigationForRole();
            setupLogoutHandler();
            setupAccountMenu();
            // Notify listeners that auth/user state is ready
            try {
                document.dispatchEvent(new CustomEvent('auth:ready', { detail: currentUser }));
            } catch (e) {
                console.warn('auth:ready event dispatch failed', e);
            }
        } else {
            // User not authenticated, redirect to login
            window.location.href = '/login';
        }
    } catch (error) {
        console.error('Error checking authentication:', error);
        // On error, redirect to login
        window.location.href = '/login';
    }
}

/**
 * Hide/show navigation items based on role
 */
function adjustNavigationForRole() {
    try {
        if (!currentUser) return;
        const downloadsNav = document.getElementById('instructor-downloads-nav') ||
            document.getElementById('nav-downloads')?.closest('li');

        if (downloadsNav) {
            downloadsNav.style.display = isSystemAdmin() ? '' : 'none';
        }

        // Hide Student Hub link from TAs
        if (currentUser.role === 'ta') {
            const studentHubNav = document.getElementById('nav-student-hub-li');
            if (studentHubNav && studentHubNav.style) {
                studentHubNav.style.display = 'none';
            }
        }
        // Check quiz visibility for students
        if (currentUser.role === 'student') {
            checkQuizNavVisibility();
            checkSuperCourseNavVisibility();
        }

        if (currentUser.role === 'instructor' || currentUser.role === 'ta') {
            addStudentPreviewNavItem();
        }
    } catch (e) {
        console.warn('adjustNavigationForRole failed:', e);
    }
}

const PREVIEW_COURSE_BACKUP_KEY = 'biocbot_course_before_preview';

/**
 * Put the instructor's selected course back if a preview cleared it.
 *
 * A preview replaying the student first-run flow has to start with no course
 * stored, but localStorage is shared with the instructor tabs, which read the
 * same key. Without this, instructor pages opened afterwards fall back to a
 * stale course and their requests are refused.
 *
 * Runs at parse time rather than after the auth check, because pages such as
 * Flagged Content and Download Chats read the course on DOMContentLoaded and
 * would otherwise race an async restore. Skipped inside a preview tab, which
 * needs the key to stay empty until its course step is done.
 */
(function restoreCourseAfterPreview() {
    try {
        if (window.BiocBotPreview && window.BiocBotPreview.active) {
            return;
        }

        const backup = localStorage.getItem(PREVIEW_COURSE_BACKUP_KEY);
        if (backup && !localStorage.getItem('selectedCourseId')) {
            localStorage.setItem('selectedCourseId', backup);
        }
    } catch (error) {
        console.warn('Could not restore the selected course:', error);
    }
})();

/**
 * Add the "View as Student" entry to the bottom of the sidebar nav.
 *
 * Injected here rather than hard-coded into each sidebar so the entry point
 * cannot drift between the ten instructor pages and the three TA pages.
 */
function addStudentPreviewNavItem() {
    const navList = document.querySelector('.main-nav ul');
    if (!navList || document.getElementById('nav-student-preview')) {
        return;
    }

    const item = document.createElement('li');
    item.id = 'nav-student-preview-li';
    item.innerHTML = `
        <div class="student-preview-control">
            <a href="#" id="nav-student-preview" aria-expanded="false"
               aria-controls="nav-student-preview-options">View as Student</a>
            <label class="student-preview-option" id="nav-student-preview-options"
                   for="nav-student-preview-skip" hidden>
                <input type="checkbox" id="nav-student-preview-skip">
                <span class="student-preview-checkbox" aria-hidden="true"></span>
                <span class="student-preview-option-label">Skip tutorial</span>
            </label>
        </div>
    `;

    // Sits last in the nav list, directly above the Settings/Logout block.
    navList.appendChild(item);

    const previewLink = item.querySelector('#nav-student-preview');
    const previewOptions = item.querySelector('#nav-student-preview-options');
    const skipTutorialToggle = item.querySelector('#nav-student-preview-skip');

    try {
        skipTutorialToggle.checked = localStorage.getItem(PREVIEW_SKIP_TUTORIAL_KEY) === '1';
    } catch (error) {
        console.warn('Could not restore the preview tutorial preference:', error);
    }

    skipTutorialToggle.addEventListener('change', () => {
        try {
            localStorage.setItem(PREVIEW_SKIP_TUTORIAL_KEY, skipTutorialToggle.checked ? '1' : '0');
        } catch (error) {
            console.warn('Could not save the preview tutorial preference:', error);
        }
    });

    previewLink.addEventListener('click', async event => {
        event.preventDefault();

        if (previewOptions.hidden) {
            previewOptions.hidden = false;
            previewLink.setAttribute('aria-expanded', 'true');
            previewLink.textContent = 'Open as Student';
            skipTutorialToggle.focus();
            return;
        }

        await startStudentPreview(event.currentTarget, skipTutorialToggle.checked);
    });
}

/**
 * Let a first-time preview open on the student walkthrough's course step.
 *
 * That step's dropdown only renders when no course is stored, so the preview
 * tab must not pin one until the previewer has chosen it. Flagged from this tab
 * because localStorage is shared between the two, and the preview tab cannot
 * know whether this is a first run early enough in its own startup.
 *
 * The instructor's own stored course is left alone: the preview tab clears it
 * for itself and restores pinning as soon as the step is done.
 *
 * @param {string} previewUserId - Namespaced preview user id
 * @param {boolean} firstRunCompleted - Whether the walkthrough already ran
 */
function seedPreviewWalkthrough(previewUserId, firstRunCompleted) {
    if (!previewUserId) {
        return;
    }

    try {
        // A tab closed during an earlier first-run preview can leave this
        // shared marker behind. Skipping must explicitly clear it or the new
        // tab would still behave like the walkthrough is pending.
        if (firstRunCompleted) {
            localStorage.removeItem('biocbot_preview_first_run_pending');
            return;
        }

        // Stash the course before the preview tab clears the shared key, so
        // instructor pages can put it back rather than falling through to a
        // stale one and having their requests refused.
        const current = localStorage.getItem('selectedCourseId');
        if (current) {
            localStorage.setItem(PREVIEW_COURSE_BACKUP_KEY, current);
        }

        localStorage.removeItem(`biocbot_student_guided_tour_${previewUserId}`);
        localStorage.setItem('biocbot_preview_first_run_pending', '1');
    } catch (error) {
        console.warn('Could not prepare the preview walkthrough:', error);
    }
}

/**
 * Open a sandboxed student view of the current course in a new tab.
 *
 * A new tab rather than a redirect: the point of the feature is to change a
 * prompt on one side and watch the effect on the other, which needs both
 * sessions alive at once.
 *
 * @param {HTMLElement} trigger - The clicked nav link, disabled while starting
 * @param {boolean} [skipTutorial=false] - Open with preview onboarding complete
 * @returns {Promise<void>}
 */
async function startStudentPreview(trigger, skipTutorial = false) {
    // Instructor pages do not all resolve course context the same way: the
    // shared auth helper is synchronous, while Course Upload, Flagged Content,
    // and Download Chats provide asynchronous resolvers. Awaiting works for
    // both and prevents a Promise from being serialized as `courseId: {}`.
    const courseId = await getCurrentCourseId();

    if (!courseId) {
        alert('Select a course first, then open the student preview.');
        return;
    }

    const originalText = trigger.textContent;
    trigger.textContent = 'Opening…';
    trigger.style.pointerEvents = 'none';

    try {
        const response = await fetch('/api/preview/start', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId, skipTutorial })
        });

        const result = await response.json();

        if (result && result.success) {
            seedPreviewWalkthrough(result.grant && result.grant.previewUserId, result.firstRunCompleted);
            window.open(result.entryUrl, '_blank', 'noopener');
        } else {
            alert((result && result.message) || 'Could not open the student preview.');
        }
    } catch (error) {
        console.error('Failed to start student preview:', error);
        alert('Could not open the student preview.');
    } finally {
        trigger.textContent = originalText;
        trigger.style.pointerEvents = '';
    }
}

/**
 * Check if quiz page is enabled and show/hide nav item accordingly
 */
async function checkSuperCourseNavVisibility() {
    const navItem = document.getElementById('super-course-nav-item');
    if (!navItem) return;
    try {
        const response = await fetch('/api/student/super-course/status', { credentials: 'include' });
        const data = await response.json();
        navItem.style.display = data && data.success && data.enabled ? '' : 'none';
    } catch (e) {
        navItem.style.display = 'none';
    }
}

async function checkQuizNavVisibility() {
    const quizNavItem = document.getElementById('quiz-nav-item');
    if (!quizNavItem) return;
    try {
        // getCurrentCourseId may be sync (auth.js) or async (student.js override)
        let courseId = getCurrentCourseId();
        if (courseId && typeof courseId.then === 'function') {
            courseId = await courseId;
        }
        if (!courseId) {
            quizNavItem.style.display = 'none';
            return;
        }
        const response = await fetch(`/api/quiz/status?courseId=${courseId}`);
        const data = await response.json();
        if (data.success && data.enabled) {
            quizNavItem.style.display = '';
        } else {
            quizNavItem.style.display = 'none';
        }
    } catch (e) {
        // On error, hide quiz nav
        quizNavItem.style.display = 'none';
    }
}

/**
 * Update user display information
 */
function updateUserDisplay() {
    if (!currentUser) return;
    
    // Update user display name
    const displayNameElement = document.getElementById('user-display-name');
    if (displayNameElement) {
        displayNameElement.textContent = currentUser.displayName || currentUser.username;
    }
    
    // Update user avatar with first letter of display name
    const avatarElement = document.querySelector('.user-avatar');
    if (avatarElement) {
        avatarElement.textContent = getCurrentUserInitial();
    }

    const roleElement = document.querySelector('.user-role');
    if (roleElement) {
        roleElement.textContent = getCurrentUserRoleLabel();
    }

    // Update settings link based on role
    const settingsLink = document.querySelector('a[href="/instructor/settings"]');
    if (settingsLink && currentUser.role === 'ta') {
        settingsLink.href = '/ta/settings';
    }

    // Account menu popup: signed-in email shown as a non-interactive header
    const emailElement = document.getElementById('account-menu-email');
    if (emailElement) {
        emailElement.textContent = currentUser.email || '';
    }
}

/**
 * Wire up the collapsed sidebar account row: opens/closes the popup menu
 * (Settings / Log out) on click, closes on outside click or Escape, and
 * moves focus predictably so keyboard users land in the menu on open and
 * back on the trigger on close. Menu items are plain focusable links in
 * DOM order, so Tab/Shift+Tab already move between them natively.
 */
function setupAccountMenu() {
    const trigger = document.getElementById('account-menu-trigger');
    const menu = document.getElementById('account-menu');
    if (!trigger || !menu) return;

    const firstItem = () => menu.querySelector('.account-menu-item');

    const openMenu = () => {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        const item = firstItem();
        if (item) item.focus();
    };

    const closeMenu = (returnFocus) => {
        if (menu.hidden) return;
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (returnFocus) trigger.focus();
    };

    trigger.addEventListener('click', () => {
        if (menu.hidden) openMenu();
        else closeMenu(false);
    });

    document.addEventListener('click', (e) => {
        if (menu.hidden) return;
        if (trigger.contains(e.target) || menu.contains(e.target)) return;
        closeMenu(false);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || menu.hidden) return;
        closeMenu(true);
    });
}

/**
 * Setup logout button handler
 */
function setupLogoutHandler() {
    // If a page-level Auth controller is in place (e.g. dashboard.js exposes
    // window.Auth with its own logout, or a test installs a shim), defer to
    // it instead of double-attaching. Without this guard, two handlers fire
    // on the same click — one navigates and one calls the page controller —
    // and the navigation races the page logic. See Redundancies R1d.
    if (typeof window.Auth === 'object' && window.Auth && typeof window.Auth.logout === 'function') {
        return;
    }

    const logoutBtns = ['logout-btn', 'mobile-logout-btn'];

    logoutBtns.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                await logout();
            });
        }
    });
}

/**
 * Logout user
 */
async function logout() {
    try {
        const response = await fetch('/api/auth/logout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Log debug info for troubleshooting
            if (result.debug) {
                console.log('Logout Debug Info:', result.debug);
                if (result.debug.isCWL) {
                    console.log('CWL Logout Status:', result.debug.samlLogoutUrl ? 'SUCCESS' : 'FAILED/SKIPPED');
                }
            }
            
            // Clear local user data
            currentUser = null;
            // Course selection is user-specific. Leaving it in origin-wide
            // localStorage can make the next account open instructor pages
            // with a course it cannot access.
            localStorage.removeItem('selectedCourseId');
            localStorage.removeItem(PREVIEW_COURSE_BACKUP_KEY);
            
            // Redirect to login page
            // Use redirect URL from server if available (important for SAML logout)
            window.location.href = result.redirect || '/login';
        } else {
            console.error('Logout failed:', result.error);
            if (result.debug) console.log('Debug Info:', result.debug);
            // Still redirect to login even if logout failed
            window.location.href = '/login';
        }
    } catch (error) {
        console.error('Error during logout:', error);
        // Still redirect to login even if logout failed
        window.location.href = '/login';
    }
}

/**
 * Get current user information
 * @returns {Object|null} Current user object or null
 */
function getCurrentUser() {
    return currentUser;
}

function waitForCurrentUser(timeoutMs = 5000) {
    if (currentUser) return Promise.resolve(currentUser);

    return new Promise(resolve => {
        let settled = false;
        const finish = user => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(user || currentUser || null);
        };
        const timeoutId = setTimeout(() => finish(null), timeoutMs);
        document.addEventListener('auth:ready', event => finish(event.detail), { once: true });
    });
}

/**
 * Check if current user has system administrator access
 * @returns {boolean} True if user is a system admin
 */
function isSystemAdmin() {
    return !!(currentUser && currentUser.permissions && currentUser.permissions.systemAdmin === true);
}

/**
 * Get user's display initial
 * @returns {string} Uppercase initial for the current user
 */
function getCurrentUserInitial() {
    if (!currentUser) return 'U';

    const displayValue = currentUser.displayName || currentUser.username || currentUser.email || currentUser.userId || 'User';
    return displayValue.charAt(0).toUpperCase();
}

/**
 * Get user's role label for display
 * @returns {string} Display-ready role label
 */
function getCurrentUserRoleLabel() {
    if (!currentUser) return 'User';

    if (currentUser.role === 'instructor') {
        return isSystemAdmin() ? 'Instructor (Admin)' : 'Instructor';
    }

    if (currentUser.role === 'ta') {
        return 'Teaching Assistant';
    }

    if (currentUser.role === 'student') {
        return 'Student';
    }

    return currentUser.role || 'User';
}

/**
 * Check if current user has specific role
 * @param {string} role - Role to check for
 * @returns {boolean} True if user has the role
 */
function hasRole(role) {
    return currentUser && currentUser.role === role;
}

/**
 * Check if current user is instructor
 * @returns {boolean} True if user is instructor
 */
function isInstructor() {
    return hasRole('instructor');
}

/**
 * Check if current user is student
 * @returns {boolean} True if user is student
 */
function isStudent() {
    return hasRole('student');
}

/**
 * Check if current user is TA
 * @returns {boolean} True if user is TA
 */
function isTA() {
    return hasRole('ta');
}

/**
 * Get user's current course context
 * @returns {string|null} Current course ID or null
 */
function getCurrentCourseId() {
    // First check URL parameters (highest priority)
    const urlParams = new URLSearchParams(window.location.search);
    const courseIdFromUrl = urlParams.get('courseId');
    if (courseIdFromUrl) {
        return courseIdFromUrl;
    }
    
    // Then check localStorage (for instructor pages)
    const courseIdFromStorage = localStorage.getItem('selectedCourseId');
    if (courseIdFromStorage) {
        return courseIdFromStorage;
    }
    
    // Finally check user preferences
    return currentUser && currentUser.preferences ? currentUser.preferences.courseId : null;
}

/**
 * Get current instructor ID (for backward compatibility)
 * @returns {string|null} Current user ID or null
 */
function getCurrentInstructorId() {
    return currentUser ? currentUser.userId : null;
}

/**
 * Set user's current course context
 * @param {string} courseId - Course ID to set
 * @returns {Promise<boolean>} True if successful
 */
async function setCurrentCourseId(courseId) {
    try {
        const response = await fetch('/api/auth/set-course', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ courseId })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Update local user data
            if (currentUser && currentUser.preferences) {
                currentUser.preferences.courseId = courseId;
            }
            return true;
        } else {
            console.error('Failed to set course context:', result.error);
            return false;
        }
    } catch (error) {
        console.error('Error setting course context:', error);
        return false;
    }
}

/**
 * Authenticated fetch helper that automatically includes credentials
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
function authenticatedFetch(url, options = {}) {
    console.log('🔍 [AUTH_FETCH] Making request to:', url);
    console.log('🔍 [AUTH_FETCH] Full URL would be:', window.location.origin + url);
    return fetch(url, {
        ...options,
        credentials: 'include'
    });
}

// Initialize authentication when DOM is loaded
document.addEventListener('DOMContentLoaded', initAuth);
