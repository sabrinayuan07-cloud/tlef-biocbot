/**
 * Flagged Content Management JavaScript
 * Handles displaying and moderating student-flagged responses
 */

/**
 * Application state management
 */
const appState = {
    flags: [],
    filteredFlags: [],
    currentFilters: {
        flagType: 'all',
        status: 'pending'
    },
    stats: {
        totalFlags: 0,
        pendingFlags: 0,
        flagsToday: 0
    }
};

// Global variables to prevent multiple API calls and redirects
let courseIdCache = null;
let courseIdPromise = null;
let redirectInProgress = false;

// Batch resolve (#692): flagIds currently checked for a batch approve/dismiss action.
const selectedFlagIds = new Set();
const SUPER_COURSE_FLAG_COURSE_ID = 'SUPER_COURSE';

// Canned resolution notes (#694): quick-pick text an instructor/TA can insert
// into an approve or dismiss note instead of typing one from scratch each
// time. Free-text entry is still always available alongside these.
const CANNED_RESPONSES = [
    'Reviewed and approved — the content is accurate as written.',
    'Not inappropriate, just a sensitive topic. No change needed.',
    'Duplicate of an existing flag; already addressed.',
    'Content corrected based on your report. Thank you for flagging this!',
    'Unable to reproduce the issue as described.'
];

// Attribute-safe escape (escapeHtml only covers text-node content, not the
// quote characters a data-* attribute value needs escaped).
function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderCannedResponseChips(textareaId) {
    return `
        <div class="canned-response-chips" role="group" aria-label="Insert a canned resolution note">
            ${CANNED_RESPONSES.map(text => `
                <button type="button" class="canned-response-chip"
                        data-textarea-id="${escapeAttr(textareaId)}" data-canned-text="${escapeAttr(text)}">
                    ${escapeHtml(text.length > 42 ? `${text.slice(0, 39)}...` : text)}
                </button>
            `).join('')}
        </div>
    `;
}

/**
 * Insert a canned response into a note textarea. Replaces the textarea's
 * current content (including the approve form's pre-filled default message)
 * rather than appending, so picking a chip gives a clean starting point the
 * instructor can still freely edit on top of.
 */
function insertCannedResponse(textareaId, text) {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;
    textarea.value = text;
    textarea.focus();
}

// Event delegation for canned-response chips: these are re-rendered on every
// list refresh, so a single document-level listener avoids having to rebind
// per-button handlers (and sidesteps embedding free text inside an inline
// onclick, which is fragile to quote characters).
document.addEventListener('click', event => {
    const chip = event.target.closest('.canned-response-chip');
    if (!chip) return;
    insertCannedResponse(chip.dataset.textareaId, chip.dataset.cannedText);
});

// superchatId -> bucket name, for labeling super-course flags by their bucket.
const superchatNameById = new Map();

async function loadSuperchatNames() {
    try {
        const response = await fetch('/api/superchats', { credentials: 'include' });
        const result = await response.json();
        if (response.ok && result.success && Array.isArray(result.superchats)) {
            superchatNameById.clear();
            result.superchats.forEach(b => superchatNameById.set(b.superchatId, b.name));
        }
    } catch (error) {
        console.error('Error loading superchat names for flags:', error);
    }
}

// Human-readable bucket label for a super-course flag (falls back gracefully for
// legacy flags that have no superchatId or whose bucket was deleted).
function getSuperchatLabel(flag) {
    if (!flag || flag.isSuperCourseFlag !== true) return '';
    if (flag.superchatId && superchatNameById.has(flag.superchatId)) {
        return superchatNameById.get(flag.superchatId);
    }
    return flag.superchatId ? 'Super Course (archived bucket)' : 'Super Course (all)';
}

function redirectToOnboardingForMissingCourse() {
    if (redirectInProgress) {
        return;
    }

    redirectInProgress = true;
    console.error('No course ID found. Redirecting to onboarding...');
    showNotification('No course found. Please complete onboarding first.', 'error');
    setTimeout(() => {
        window.location.href = '/instructor/onboarding';
    }, 2000);
}

/**
 * Get the current course ID for the instructor
 * @returns {Promise<string>} Course ID
 */
async function getCurrentCourseId() {
    // Return cached result if available
    if (courseIdCache !== null) {
        return courseIdCache;
    }
    
    // If a request is already in progress, wait for it
    if (courseIdPromise) {
        return courseIdPromise;
    }
    
    // Start the request and cache the promise
    courseIdPromise = fetchCourseId();
    const result = await courseIdPromise;
    
    // Cache the result
    courseIdCache = result;
    
    return result;
}

async function fetchCourseId() {
    // Check if we have a courseId from URL parameters (onboarding redirect or direct navigation)
    const urlParams = new URLSearchParams(window.location.search);
    const courseIdFromUrl = urlParams.get('courseId');
    const courseIdFromStorage = localStorage.getItem('selectedCourseId');
    
    // Priority: URL > localStorage > API fetch
    if (courseIdFromUrl) {
        console.log('🔍 [GET_COURSE_ID] Using courseId from URL parameter:', courseIdFromUrl);
        // Update localStorage to match URL
        if (courseIdFromUrl !== courseIdFromStorage) {
            localStorage.setItem('selectedCourseId', courseIdFromUrl);
        }
        return courseIdFromUrl;
    }
    
    if (courseIdFromStorage) {
        console.log('🔍 [GET_COURSE_ID] Using courseId from localStorage:', courseIdFromStorage);
        // Update URL to match localStorage
        urlParams.set('courseId', courseIdFromStorage);
        window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
        return courseIdFromStorage;
    }
    
    // If no course ID in URL, try to get it from the user's courses
    try {
        const userId = getCurrentInstructorId(); // This works for both instructors and TAs
        if (!userId) {
            console.error('No user ID available');
            return null;
        }
        
        // Check if user is TA or instructor using the isTA function
        let apiEndpoint;
        let isTAUser = false;
        
        if (typeof isTA === 'function' && isTA()) {
            console.log(`🔍 [GET_COURSE_ID] Fetching courses for TA: ${userId}`);
            apiEndpoint = `/api/courses/ta/${userId}`;
            isTAUser = true;
        } else {
            console.log(`🔍 [GET_COURSE_ID] Fetching courses for instructor: ${userId}`);
            apiEndpoint = `/api/onboarding/instructor/${userId}`;
            isTAUser = false;
        }
        
        const response = await fetch(apiEndpoint, {
            credentials: 'include'
        });
        
        console.log(`🔍 [GET_COURSE_ID] Response status: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
            const result = await response.json();
            console.log(`🔍 [GET_COURSE_ID] API response:`, result);
            
            let courses = [];
            if (isTAUser) {
                courses = result.data || [];
            } else {
                courses = result.data && result.data.courses ? result.data.courses : [];
            }
            
            if (courses.length > 0) {
                // Return the first course found
                const firstCourse = courses[0];
                console.log(`🔍 [GET_COURSE_ID] Found course:`, firstCourse.courseId);
                return firstCourse.courseId;
            } else {
                console.log(`🔍 [GET_COURSE_ID] No courses found in response`);
            }
        } else {
            const errorText = await response.text();
            console.error(`🔍 [GET_COURSE_ID] API error: ${response.status} - ${errorText}`);
        }
    } catch (error) {
        console.error('Error fetching instructor courses:', error);
    }
    
    
    // Additional fallback: Check if we can get course ID from the current user's preferences
    const currentUser = getCurrentUser();
    if (currentUser && currentUser.preferences && currentUser.preferences.courseId) {
        console.log(`🔍 [GET_COURSE_ID] Using course from user preferences: ${currentUser.preferences.courseId}`);
        return currentUser.preferences.courseId;
    }
    
    if (typeof isSystemAdmin === 'function' && isSystemAdmin()) {
        console.log('🔍 [GET_COURSE_ID] No regular course found; system admin can still review Super Course flags');
        return null;
    }

    // If no course found, show an error and redirect to onboarding (only once)
    redirectToOnboardingForMissingCourse();
    
    // Return a placeholder (this should not be reached due to redirect)
    return null;
}

async function getFlagReviewCourseIds() {
    const courseId = await getCurrentCourseId();
    const courseIds = [];

    if (courseId) {
        courseIds.push(courseId);
    }

    if (typeof isSystemAdmin === 'function' && isSystemAdmin() && !courseIds.includes(SUPER_COURSE_FLAG_COURSE_ID)) {
        courseIds.push(SUPER_COURSE_FLAG_COURSE_ID);
    }

    return courseIds;
}

/**
 * Initialize the flagged content page
 */
document.addEventListener('DOMContentLoaded', async function() {
    console.log('🔧 [DOM] DOMContentLoaded event fired');
    console.log('🔧 [DOM] Document ready state:', document.readyState);
    console.log('🔧 [DOM] Current URL:', window.location.href);
    
    // Debug URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const courseId = urlParams.get('courseId');
    console.log('🔧 [FLAGGED DEBUG] URL parameters:', Object.fromEntries(urlParams));
    console.log('🔧 [FLAGGED DEBUG] CourseId from URL:', courseId);
    
    console.log('🔧 [DOM] All elements with IDs:', document.querySelectorAll('[id]'));
    console.log('🔧 [DOM] Elements in flagged-content-container:', document.querySelectorAll('.flagged-content-container *'));
    console.log('🔧 [DOM] loading-state element:', document.getElementById('loading-state'));
    console.log('🔧 [DOM] flagged-list element:', document.getElementById('flagged-list'));
    console.log('🔧 [DOM] empty-state element:', document.getElementById('empty-state'));
    
    initializeEventListeners();

    // Wait for authentication to be ready before loading courses
    await waitForAuth();
    
    console.log('🔧 [DOM] After auth, elements in flagged-content-container:', document.querySelectorAll('.flagged-content-container *'));
    console.log('🔧 [DOM] After auth, loading-state element:', document.getElementById('loading-state'));
    console.log('🔧 [DOM] After auth, flagged-list element:', document.getElementById('flagged-list'));
    console.log('🔧 [DOM] After auth, empty-state element:', document.getElementById('empty-state'));
    
    // Setup sidebar based on user role
    await setupSidebarForUserRole();
    
    // Set up periodic permission refresh for TAs
    if (typeof isTA === 'function' && isTA()) {
        // Refresh permissions every 30 seconds
        setInterval(async () => {
            await updateTANavigationBasedOnPermissions();
        }, 30000);
        
        // Also refresh when page becomes visible
        document.addEventListener('visibilitychange', async () => {
            if (!document.hidden) {
                await updateTANavigationBasedOnPermissions();
            }
        });
    }
    
    console.log('🔧 [DOM] After sidebar setup, elements in flagged-content-container:', document.querySelectorAll('.flagged-content-container *'));
    console.log('🔧 [DOM] After sidebar setup, loading-state element:', document.getElementById('loading-state'));
    console.log('🔧 [DOM] After sidebar setup, flagged-list element:', document.getElementById('flagged-list'));
    console.log('🔧 [DOM] After sidebar setup, empty-state element:', document.getElementById('empty-state'));
    
    // Load content directly
    initializeFilters();
    await loadSuperchatNames();
    loadFlaggedContent();
    loadFlagStats();

    // Load mental health flags section
    loadMentalHealthFlags();
    initMHEventListeners();

    // Load flashcard "review again" stats section
    initReviewAgainModal();
    loadReviewAgainStats();
});

/**
 * Setup sidebar based on user role
 */
async function setupSidebarForUserRole() {
    console.log('🔍 [FLAGGED DEBUG] Setting up sidebar for user role');
    console.log('🔍 [FLAGGED DEBUG] Current URL:', window.location.href);
    
    const currentUser = getCurrentUser();
    if (!currentUser) {
        console.error('No user data available for sidebar setup');
        return;
    }
    
    const isTAUser = typeof isTA === 'function' && isTA();
    console.log('🔍 [FLAGGED DEBUG] isTA function available:', typeof isTA === 'function');
    console.log('🔍 [FLAGGED DEBUG] isTAUser:', isTAUser);
    console.log('🔍 [FLAGGED DEBUG] Current user:', currentUser);
    
    // Show/hide navigation items based on role
    const instructorNavItems = [
        'instructor-home-nav',
        'instructor-documents-nav', 
        'instructor-onboarding-nav',
        'instructor-flagged-nav',
        'instructor-downloads-nav',
        'instructor-ta-hub-nav',
        'instructor-settings-nav'
    ];
    
    const taNavItems = [
        'ta-dashboard-nav',
        'ta-courses-nav',
        'ta-support-nav',
        'ta-settings-nav'
    ];
    
    if (isTAUser) {
        // Show TA navigation, hide instructor navigation
        instructorNavItems.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.style.display = 'none';
        });
        
        taNavItems.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.style.display = 'block';
        });
        
        // Update user info for TA
        const userAvatar = document.getElementById('user-avatar');
        const userRole = document.getElementById('user-role');
        
        if (userAvatar) {
            userAvatar.textContent = typeof getCurrentUserInitial === 'function'
                ? getCurrentUserInitial()
                : 'T';
        }
        if (userRole) userRole.textContent = 'Teaching Assistant';
        
        // Setup TA navigation handlers
        setupTANavigationHandlers();
        
        // Update navigation based on permissions
        await updateTANavigationBasedOnPermissions();
        
        console.log('✅ [SIDEBAR] TA sidebar configured');
    } else {
        // Show instructor navigation, hide TA navigation
        taNavItems.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.style.display = 'none';
        });
        
        instructorNavItems.forEach(id => {
            const element = document.getElementById(id);
            if (!element) return;

            if (id === 'instructor-downloads-nav') {
                element.style.display = typeof isSystemAdmin === 'function' && isSystemAdmin()
                    ? 'block'
                    : 'none';
                return;
            }

            element.style.display = 'block';
        });
        
        // Update user info for instructor
        const userAvatar = document.getElementById('user-avatar');
        const userRole = document.getElementById('user-role');
        
        if (userAvatar) {
            userAvatar.textContent = typeof getCurrentUserInitial === 'function'
                ? getCurrentUserInitial()
                : 'I';
        }
        if (userRole) {
            userRole.textContent = typeof getCurrentUserRoleLabel === 'function'
                ? getCurrentUserRoleLabel()
                : 'Instructor';
        }
        
        console.log('✅ [SIDEBAR] Instructor sidebar configured');
    }
}

/**
 * Setup TA navigation handlers
 */
function setupTANavigationHandlers() {
    // TA My Courses link
    const taMyCoursesLink = document.getElementById('ta-my-courses-link');
    if (taMyCoursesLink) {
        taMyCoursesLink.addEventListener('click', (e) => {
            e.preventDefault();

            // Check permissions first
            checkTAPermissionsAndNavigate('courses', '/instructor/documents');
        });
    }
    
    // TA Student Support link (current page, so just prevent default)
    const taStudentSupportLink = document.getElementById('ta-student-support-link');
    if (taStudentSupportLink) {
        taStudentSupportLink.addEventListener('click', (e) => {
            e.preventDefault();
            // Already on student support page, do nothing
        });
    }
}

/**
 * Check TA permissions and navigate if allowed
 */
async function checkTAPermissionsAndNavigate(feature, targetPage) {
    try {
        const taId = getCurrentInstructorId();
        if (!taId) {
            showNotification('No TA ID found. User not authenticated.', 'error');
            return;
        }
        
        // Get TA courses first
        const response = await authenticatedFetch(`/api/courses/ta/${taId}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to fetch TA courses');
        }
        
        const courses = result.data || [];
        
        if (courses.length === 0) {
            showNotification('No courses assigned. Contact an instructor to be added to a course.', 'warning');
            return;
        }
        
        const selectedCourseId = localStorage.getItem('selectedCourseId');
        const selectedCourse = courses.find(course => course.courseId === selectedCourseId) || courses[0];

        // Check permission for the currently selected course. A failed
        // fetch denies access (fail-closed) rather than defaulting to
        // allowed - this previously defaulted to `true` on any non-OK
        // response, silently granting access whenever the permissions
        // fetch itself failed.
        // 'courses' gates /instructor/documents, which the server allows
        // for ANY of materials/questions/settings - see
        // window.DOCUMENTS_PAGE_PERMISSIONS.
        const permissionKeys = feature === 'courses' ? window.DOCUMENTS_PAGE_PERMISSIONS : [feature];
        let hasPermission = false;
        const permResponse = await authenticatedFetch(`/api/courses/${selectedCourse.courseId}/ta-permissions/${taId}`);
        if (permResponse.ok) {
            const permResult = await permResponse.json();
            if (permResult.success) {
                hasPermission = permissionKeys.some(permissionKey =>
                    window.permissionIsGranted(permResult.data.permissions, permissionKey)
                );
            }
        }

        if (!hasPermission) {
            const featureName = feature === 'courses' ? 'My Courses' : 'Student Support';
            showNotification(`You do not have permission to access ${featureName}. Contact your instructor.`, 'error');
            return;
        }
        
        localStorage.setItem('selectedCourseId', selectedCourse.courseId);
        window.location.href = `${targetPage}?courseId=${encodeURIComponent(selectedCourse.courseId)}`;
        
    } catch (error) {
        console.error('Error checking TA permissions:', error);
        showNotification('Error checking permissions. Please try again.', 'error');
    }
}

/**
 * Get TA courses and navigate to specified page
 */
async function getTACoursesAndNavigate(targetPage) {
    try {
        const taId = getCurrentInstructorId();
        if (!taId) {
            showNotification('No TA ID found. User not authenticated.', 'error');
            return;
        }
        
        const response = await authenticatedFetch(`/api/courses/ta/${taId}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to fetch TA courses');
        }
        
        const courses = result.data || [];
        
        if (courses.length === 0) {
            showNotification('No courses assigned. Contact an instructor to be added to a course.', 'warning');
            return;
        }
        
        const selectedCourseId = localStorage.getItem('selectedCourseId');
        const selectedCourse = courses.find(course => course.courseId === selectedCourseId) || courses[0];
        localStorage.setItem('selectedCourseId', selectedCourse.courseId);
        window.location.href = `${targetPage}?courseId=${encodeURIComponent(selectedCourse.courseId)}`;
        
    } catch (error) {
        console.error('Error loading TA courses:', error);
        showNotification('Error loading courses. Please try again.', 'error');
    }
}

/**
 * Initialize filter state to match dropdown values
 */
function initializeFilters() {
    const flagTypeFilter = document.getElementById('flag-type-filter');
    const statusFilter = document.getElementById('status-filter');
    
    if (flagTypeFilter && statusFilter) {
        appState.currentFilters.flagType = flagTypeFilter.value;
        appState.currentFilters.status = statusFilter.value;
        console.log('Filters initialized:', appState.currentFilters);
    }
}

/**
 * Sync filter state with UI dropdowns
 */
function syncFiltersWithUI() {
    const flagTypeFilter = document.getElementById('flag-type-filter');
    const statusFilter = document.getElementById('status-filter');
    
    if (flagTypeFilter && statusFilter) {
        // Update UI to match current filter state
        flagTypeFilter.value = appState.currentFilters.flagType;
        statusFilter.value = appState.currentFilters.status;
        console.log('UI synced with filter state:', appState.currentFilters);
    }
}

/**
 * Set up event listeners for the page
 */
function initializeEventListeners() {
    // Filter controls
    const flagTypeFilter = document.getElementById('flag-type-filter');
    const statusFilter = document.getElementById('status-filter');
    const refreshButton = document.getElementById('refresh-flags');
    if (flagTypeFilter) {
        addKeyboardPickerActivation(flagTypeFilter);
        flagTypeFilter.addEventListener('change', handleFilterChange);
    }
    
    if (statusFilter) {
        addKeyboardPickerActivation(statusFilter);
        statusFilter.addEventListener('change', handleFilterChange);
    }
    
    if (refreshButton) {
        refreshButton.addEventListener('click', handleRefresh);
    }

    // Batch resolve controls (#692)
    const selectAllFlags = document.getElementById('batch-select-all-flags');
    if (selectAllFlags) {
        selectAllFlags.addEventListener('change', () => handleSelectAllFlagsChange(selectAllFlags.checked));
    }
    const batchApproveBtn = document.getElementById('batch-approve-flags');
    if (batchApproveBtn) {
        batchApproveBtn.addEventListener('click', batchApproveSelectedFlags);
    }
    const batchCancelBtn = document.getElementById('batch-cancel-selection');
    if (batchCancelBtn) {
        batchCancelBtn.addEventListener('click', cancelFlagSelection);
    }
}

function addKeyboardPickerActivation(selectElement) {
    selectElement.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;

        try {
            if (typeof selectElement.showPicker === 'function') {
                selectElement.showPicker();
                event.preventDefault();
                return;
            }
        } catch (error) {
            // Fall through to the browser's native select behavior.
        }
    });
}


/**
 * Handle filter changes and update the displayed content
 */
function handleFilterChange() {
    const flagTypeFilter = document.getElementById('flag-type-filter');
    const statusFilter = document.getElementById('status-filter');
    
    // Update current filters
    appState.currentFilters.flagType = flagTypeFilter.value;
    appState.currentFilters.status = statusFilter.value;
    
    // Apply filters and re-render
    applyFilters();
    renderFlaggedContent();
}

/**
 * Handle refresh button click
 */
function handleRefresh() {
    const refreshButton = document.getElementById('refresh-flags');
    refreshButton.textContent = 'Refreshing...';
    refreshButton.disabled = true;
    
    Promise.all([loadFlaggedContent(), loadFlagStats()])
        .finally(() => {
            refreshButton.textContent = 'Refresh';
            refreshButton.disabled = false;
        });
}

/**
 * Fetch flagged content from the API
 */
async function loadFlaggedContent() {
    console.log('🔧 [LOAD] loadFlaggedContent called');
    console.log('🔧 [LOAD] Elements in flagged-content-container:', document.querySelectorAll('.flagged-content-container *'));
    console.log('🔧 [LOAD] loading-state element:', document.getElementById('loading-state'));
    console.log('🔧 [LOAD] flagged-list element:', document.getElementById('flagged-list'));
    console.log('🔧 [LOAD] empty-state element:', document.getElementById('empty-state'));
    
    try {
        showLoadingState();
        
        // Get current course ID from auth or other source
        console.log('🔍 [FLAGGED] About to call getCurrentCourseId()');
        console.log('🔍 [FLAGGED] Current user:', getCurrentUser());
        console.log('🔍 [FLAGGED] Instructor ID:', getCurrentInstructorId());
        
        // Let's manually test the API call that getCurrentCourseId() makes
        const instructorId = getCurrentInstructorId();
        if (instructorId) {
            console.log('🔍 [FLAGGED] Testing API call manually...');
            try {
                const response = await fetch(`/api/onboarding/instructor/${instructorId}`, {
                    credentials: 'include'
                });
                console.log('🔍 [FLAGGED] Manual API response status:', response.status);
                if (response.ok) {
                    const result = await response.json();
                    console.log('🔍 [FLAGGED] Manual API response data:', result);
                } else {
                    const errorText = await response.text();
                    console.log('🔍 [FLAGGED] Manual API error:', errorText);
                }
            } catch (error) {
                console.log('🔍 [FLAGGED] Manual API error:', error);
            }
        }
        
        const courseIds = await getFlagReviewCourseIds();
        console.log('🔍 [FLAGGED] getFlagReviewCourseIds() returned:', courseIds);
        
        if (!courseIds.length) {
            console.log('No course available, showing empty state');
            console.log('🔍 [FLAGGED] DEBUG: This means getCurrentCourseId() returned null/undefined');
            console.log('🔍 [FLAGGED] DEBUG: This could mean:');
            console.log('🔍 [FLAGGED] DEBUG: 1. Instructor not authenticated');
            console.log('🔍 [FLAGGED] DEBUG: 2. Instructor has no courses assigned');
            console.log('🔍 [FLAGGED] DEBUG: 3. API call to /api/onboarding/instructor/ failed');
            console.log('🔍 [FLAGGED] DEBUG: 4. User preferences don\'t have courseId');
            
            // Show empty state and redirect to onboarding
            appState.flags = [];
            applyFilters();
            renderFlaggedContent();
            redirectToOnboardingForMissingCourse();
            return;
        }
        
        console.log(`Loading flagged content for courses: ${courseIds.join(', ')}`);

        const flagGroups = await Promise.all(courseIds.map(async (courseId) => {
            const response = await fetch(`/api/flags/course/${encodeURIComponent(courseId)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.message || 'Failed to load flagged content');
            }

            return result.data.flags || [];
        }));

        appState.flags = flagGroups.flat();
        console.log(`Loaded ${appState.flags.length} flagged questions for courses ${courseIds.join(', ')}`);
        console.log('Flags data:', appState.flags);
        applyFilters();
        renderFlaggedContent();
        
    } catch (error) {
        console.error('Error loading flagged content:', error);
        showErrorState('Failed to load flagged content. Please try again.');
    }
}

/**
 * Fetch flag statistics from the API
 */
async function loadFlagStats() {
    try {
        const courseIds = await getFlagReviewCourseIds();
        
        if (!courseIds.length) {
            console.log('No course available for stats, using default stats');
            appState.stats = { total: 0, pending: 0, reviewed: 0, resolved: 0, dismissed: 0 };
            updateStatsDisplay();
            return;
        }
        
        console.log(`Loading flag statistics for courses: ${courseIds.join(', ')}`);

        const statsGroups = await Promise.all(courseIds.map(async (courseId) => {
            const response = await fetch(`/api/flags/stats/${encodeURIComponent(courseId)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.message || 'Failed to load flag statistics');
            }

            return result.data.statistics || {};
        }));

        appState.stats = statsGroups.reduce((totals, stats) => ({
            total: totals.total + (stats.total || 0),
            pending: totals.pending + (stats.pending || 0),
            reviewed: totals.reviewed + (stats.reviewed || 0),
            resolved: totals.resolved + (stats.resolved || 0),
            dismissed: totals.dismissed + (stats.dismissed || 0)
        }), { total: 0, pending: 0, reviewed: 0, resolved: 0, dismissed: 0 });
        console.log('Flag statistics loaded:', appState.stats);
        updateStatsDisplay();
        
    } catch (error) {
        console.error('Error loading flag stats:', error);
        // Don't show error for stats, just use defaults
        appState.stats = { total: 0, pending: 0, reviewed: 0, resolved: 0, dismissed: 0 };
        updateStatsDisplay();
    }
}

/**
 * Apply current filters to the flags data
 */
function applyFilters() {
    const { flagType, status } = appState.currentFilters;
    
    console.log('Applying filters with state:', appState.currentFilters);
    console.log('Available flags:', appState.flags);
    
    appState.filteredFlags = appState.flags.filter(flag => {
        const matchesFlagType = flagType === 'all' || flag.flagReason === flagType;
        const matchesStatus = status === 'all' || flag.flagStatus === status;
        
        console.log(`Flag ${flag.flagId}: flagReason=${flag.flagReason}, flagStatus=${flag.flagStatus}`);
        console.log(`  matchesFlagType: ${flagType} === 'all' || ${flag.flagReason} === ${flagType} = ${matchesFlagType}`);
        console.log(`  matchesStatus: ${status} === 'all' || ${flag.flagStatus} === ${status} = ${matchesStatus}`);
        
        return matchesFlagType && matchesStatus;
    });
    
    console.log(`Applied filters: flagType=${flagType}, status=${status}`);
    console.log(`Filtered ${appState.filteredFlags.length} flags from ${appState.flags.length} total`);
    console.log('Filtered flags:', appState.filteredFlags);
}

/**
 * Render the flagged content list
 */
function renderFlaggedContent() {
    const flaggedList = document.getElementById('flagged-list');
    const loadingState = document.getElementById('loading-state');
    const emptyState = document.getElementById('empty-state');
    
    // Hide loading state
    if (loadingState) {
        loadingState.style.display = 'none';
    }
    
    if (!flaggedList) return;
    
    // Clear existing content
    flaggedList.innerHTML = '';
    
    if (appState.filteredFlags.length === 0) {
        // Show empty state
        if (emptyState) {
            emptyState.style.display = 'block';
        }
        return;
    }
    
    // Hide empty state
    if (emptyState) {
        emptyState.style.display = 'none';
    }
    
    // Render each flagged item
    appState.filteredFlags.forEach(flag => {
        const flagElement = createFlagElement(flag);
        flaggedList.appendChild(flagElement);
    });

    updateBatchControlsUI();
}

/**
 * Batch resolve (#692): selection + "select all" + Approve/Dismiss Selected.
 */
function toggleFlagSelection(flagId, checked) {
    if (checked) {
        selectedFlagIds.add(flagId);
    } else {
        selectedFlagIds.delete(flagId);
    }
    updateBatchControlsUI();
}

function getVisibleSelectedFlagIds() {
    return Array.from(document.querySelectorAll('.flag-select-checkbox:checked'))
        .map(checkbox => checkbox.dataset.selectFlagId);
}

function updateBatchControlsUI() {
    const checkboxes = Array.from(document.querySelectorAll('.flag-select-checkbox'));
    const checkedCount = checkboxes.filter(checkbox => checkbox.checked).length;

    const countEl = document.getElementById('batch-selection-count');
    if (countEl) countEl.textContent = `${checkedCount} selected`;

    const approveBtn = document.getElementById('batch-approve-flags');
    const cancelBtn = document.getElementById('batch-cancel-selection');
    if (approveBtn) approveBtn.disabled = checkedCount === 0;
    if (cancelBtn) cancelBtn.disabled = checkedCount === 0;

    const selectAll = document.getElementById('batch-select-all-flags');
    if (selectAll) {
        selectAll.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
        selectAll.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
    }
}

function handleSelectAllFlagsChange(checked) {
    document.querySelectorAll('.flag-select-checkbox').forEach(checkbox => {
        checkbox.checked = checked;
        if (checked) {
            selectedFlagIds.add(checkbox.dataset.selectFlagId);
        } else {
            selectedFlagIds.delete(checkbox.dataset.selectFlagId);
        }
    });
    updateBatchControlsUI();
}

// Clears the current batch selection without touching any flag (#692: the
// "Cancel" button next to Approve Selected is just a clear-selection action,
// not a batch dismiss - dismissing stays a per-flag action on each card).
function cancelFlagSelection() {
    selectedFlagIds.clear();
    document.querySelectorAll('.flag-select-checkbox').forEach(checkbox => {
        checkbox.checked = false;
    });
    updateBatchControlsUI();
}

// Approves and resolves every selected flag (no reply message is sent -
// that's still only available per-flag via Approve & Reply).
async function batchApproveSelectedFlags() {
    const flagIds = getVisibleSelectedFlagIds();
    if (flagIds.length === 0) return;

    const confirmed = confirm(`Approve ${flagIds.length} selected flag${flagIds.length === 1 ? '' : 's'}?`);
    if (!confirmed) return;

    const approveBtn = document.getElementById('batch-approve-flags');
    const cancelBtn = document.getElementById('batch-cancel-selection');
    if (approveBtn) approveBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    const instructorId = getCurrentInstructorId();

    const results = await Promise.allSettled(flagIds.map(flagId =>
        fetch(`/api/flags/${flagId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'resolved', instructorId })
        }).then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
    ));

    const succeeded = results.filter(result => result.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    flagIds.forEach(flagId => selectedFlagIds.delete(flagId));

    if (failed === 0) {
        showSuccessMessage(`${succeeded} flag${succeeded === 1 ? '' : 's'} approved.`);
    } else if (succeeded === 0) {
        showErrorMessage('Failed to approve the selected flags. Please try again.');
    } else {
        showErrorMessage(`${succeeded} approved, ${failed} failed. Please retry the failed ones.`);
    }

    loadFlagStats();
    await loadFlaggedContent();

    // The list just re-rendered (new checkboxes, new button instances), so
    // the DOM node that had focus before this started is gone and focus
    // silently drops to <body>. Send it somewhere deliberate.
    const selectAllAfterRefresh = document.getElementById('batch-select-all-flags');
    if (selectAllAfterRefresh) selectAllAfterRefresh.focus();
}

/**
 * Create a DOM element for a single flagged item
 * @param {Object} flag - The flag data object
 * @returns {HTMLElement} The created flag element
 */
function createFlagElement(flag) {
    const flagDiv = document.createElement('div');
    flagDiv.className = 'flag-card';
    flagDiv.setAttribute('data-flag-id', flag.flagId);
    
    // Format timestamp
    const timestamp = formatTimestamp(flag.createdAt);
    
    // Display texts. A stored flag's reason, mode, status and priority are
    // escaped like its other fields, and reduced to a plain word where they
    // become a class name.
    const flagReasonDisplay = escapeHtml(getFlagReasonDisplay(flag.flagReason));
    const botModeDisplay = escapeHtml(getBotModeDisplay(flag.botMode));
    const statusDisplayText = escapeHtml(getStatusDisplayText(flag.flagStatus));
    const statusClass = toClassName(flag.flagStatus || 'pending');
    const reasonClass = toClassName(flag.flagReason);
    const priority = toClassName(flag.priority || 'medium');
    
    // Question content
    const questionContent = flag.questionContent || {};
    const questionText = questionContent.question || 'Question content not available';
    const unitName = flag.unitName || 'Unknown Unit';
    const courseName = flag.courseName || '';
    const superchatLabel = getSuperchatLabel(flag);
    const courseTagHtml = superchatLabel
        ? `<span class="context-tag">Bucket: ${escapeHtml(superchatLabel)}</span>`
        : (courseName
            ? `<span class="context-tag">Course: ${escapeHtml(courseName)}</span>`
            : '');
    const reporterName = flag.reporterName || flag.studentName || `Student ${flag.studentId}`;
    const reporterRole = flag.reporterRole ? `${flag.reporterRole.charAt(0).toUpperCase()}${flag.reporterRole.slice(1)}` : 'Student';
    const concernTitle = flag.reporterRole === 'instructor' ? "Instructor's Concern" : "Student's Concern";
    const breadcrumbsHtml = createSourceBreadcrumbsHtml(flag);
    
    // Batch resolve (#692): only pending flags get Approve/Dismiss buttons
    // (see createActionButtons), so only those should be selectable for a
    // batch approve - otherwise Select all → Approve Selected would send
    // "resolved" for flags that are already dismissed/resolved.
    const selectCheckboxHtml = flag.flagStatus === 'pending' ? `
                <label class="flag-select-label">
                    <input type="checkbox" class="flag-select-checkbox" data-select-flag-id="${flag.flagId}"
                           ${selectedFlagIds.has(flag.flagId) ? 'checked' : ''}
                           onchange="toggleFlagSelection('${flag.flagId}', this.checked)">
                    <span class="visually-hidden">Select flag from ${escapeHtml(reporterName)}, ${timestamp}, for a batch action</span>
                </label>` : '';

    // Header Section
    let headerHtml = `
        <div class="flag-card-header">
            <div class="flag-header-left">
                ${selectCheckboxHtml}
                <span class="flag-type-badge ${reasonClass}">${flagReasonDisplay}</span>
                <span class="flag-priority-badge ${priority}">priority: ${priority}</span>
            </div>
            <div class="flag-meta-info">
                <span class="flag-student">
                    <span class="meta-icon">${Icons.user}</span> ${escapeHtml(reporterName)}
                </span>
                <span class="flag-date">${timestamp}</span>
                <span class="flag-status-badge ${statusClass}">${statusDisplayText}</span>
            </div>
        </div>
    `;

    // Content Body
    let bodyHtml = `<div class="flag-card-body">`;
    
    // 1. Question Context
    bodyHtml += `
        <div class="flag-section context-section">
            <h4 class="flag-section-title">Flagged Content</h4>
            <div class="flag-context-meta">
                ${courseTagHtml}
                <span class="context-tag">${escapeHtml(unitName)}</span>
                <span class="context-tag">${botModeDisplay} mode</span>
                <span class="context-tag">Type: ${escapeHtml(questionContent.questionType || 'Unknown')}</span>
                <span class="context-tag">Reporter: ${escapeHtml(reporterRole)}</span>
            </div>
            ${breadcrumbsHtml}
            <div class="flag-quote">
                "${escapeHtml(questionText)}"
            </div>
        </div>
    `;
    
    // 2. Student Concern - editable (#756): an instructor can correct a flag
    // that was submitted incorrectly (e.g. wrong reason/category) instead of
    // only being able to resolve/dismiss it as-is.
    bodyHtml += `
        <div class="flag-section note-section">
            <div class="flag-section-header-row">
                <h4 class="flag-section-title">${concernTitle}</h4>
                <button type="button" class="edit-flag-btn" id="edit-flag-btn-${flag.flagId}"
                        onclick="showEditFlagForm('${flag.flagId}')"
                        title="Edit flag reason and description">${Icons.pencil}<span class="visually-hidden">Edit this flag's reason and description</span></button>
            </div>
            <div class="flag-note" id="flag-note-display-${flag.flagId}">
                ${escapeHtml(flag.flagDescription)}
            </div>
            <div class="edit-flag-form" id="edit-flag-form-${flag.flagId}" style="display: none;">
                <div class="form-group">
                    <label for="edit-flag-reason-${flag.flagId}">Reason:</label>
                    <select id="edit-flag-reason-${flag.flagId}" class="edit-flag-reason-select">
                        ${getFlagReasonOptionsHtml(flag.flagReason)}
                    </select>
                </div>
                <div class="form-group">
                    <label for="edit-flag-description-${flag.flagId}">Description:</label>
                    <textarea id="edit-flag-description-${flag.flagId}" class="message-textarea" rows="3">${escapeHtml(flag.flagDescription)}</textarea>
                </div>
                <div class="form-actions-row">
                    <button type="button" class="action-btn save-flag-edit-btn" onclick="saveFlagEdit('${flag.flagId}')">Save</button>
                    <button type="button" class="action-btn cancel-btn" onclick="hideEditFlagForm('${flag.flagId}')">Cancel</button>
                </div>
            </div>
        </div>
    `;
    
    // 3. Instructor Response (if exists)
    if (flag.instructorResponse) {
        bodyHtml += `
            <div class="flag-section response-section">
                <h4 class="flag-section-title">Instructor Response</h4>
                <div class="response-content">
                    ${escapeHtml(flag.instructorResponse)}
                </div>
                <div class="response-footer">
                    Responded by ${escapeHtml(flag.instructorName || 'Instructor')} • ${formatTimestamp(flag.updatedAt)}
                </div>
            </div>
        `;
    }
    
    bodyHtml += `</div>`; // End body
    
    // Footer / Actions
    bodyHtml += `
        <div class="flag-card-footer">
            <div class="flag-actions">
                ${createActionButtons(flag)}
            </div>
        </div>
    `;
    
    flagDiv.innerHTML = headerHtml + bodyHtml;
    
    return flagDiv;
}

function createSourceBreadcrumbsHtml(flag) {
    if (!flag || flag.isSuperCourseFlag !== true) {
        return '';
    }

    const ids = Array.isArray(flag.sourceCourseIds) ? flag.sourceCourseIds : [];
    const names = Array.isArray(flag.sourceCourseNames) ? flag.sourceCourseNames : [];
    const crumbs = [];
    const seen = new Set();

    ids.forEach((courseId, index) => {
        const safeId = String(courseId || '').trim();
        const safeName = String(names[index] || safeId || '').trim();
        const key = safeId || safeName;
        if (!key || seen.has(key)) return;
        seen.add(key);
        if (safeId) seen.add(safeId);
        if (safeName) seen.add(safeName);
        crumbs.push({
            courseId: safeId,
            courseName: safeName
        });
    });

    names.forEach((courseName) => {
        const safeName = String(courseName || '').trim();
        if (!safeName || seen.has(safeName)) return;
        seen.add(safeName);
        crumbs.push({ courseId: '', courseName: safeName });
    });

    const breadcrumbItems = crumbs.length
        ? crumbs.map(crumb => `
            <span class="source-breadcrumb">
                ${escapeHtml(crumb.courseName || crumb.courseId)}
                ${crumb.courseId && crumb.courseName !== crumb.courseId ? `<span class="source-breadcrumb-id">${escapeHtml(crumb.courseId)}</span>` : ''}
            </span>
        `).join('')
        : '<span class="source-breadcrumb muted">No cited source courses</span>';

    return `
        <div class="source-breadcrumb-row" aria-label="Super Course source courses">
            <span class="source-breadcrumb-label">Source courses</span>
            ${breadcrumbItems}
        </div>
    `;
}

/**
 * Create action buttons based on flag status
 * @param {Object} flag - The flag data object
 * @returns {string} HTML for action buttons
 */
function createActionButtons(flag) {
    if (flag.flagStatus === 'pending') {
        const reporterRole = flag.reporterRole === 'instructor' ? 'instructor' : 'student';
        const reporterLabel = reporterRole === 'instructor' ? 'Instructor' : 'Student';
        const defaultMessage = reporterRole === 'instructor'
            ? 'Thanks for flagging this. This Super Course response has been reviewed and marked as resolved.'
            : 'Thanks for flagging this, please follow up on this email or come to my office hours if you are still working on this topic';

        return `
            <button class="action-btn approve-btn" onclick="showApprovalForm('${flag.flagId}')">
                Approve & Reply
            </button>
            <button class="action-btn dismiss-btn" onclick="handleFlagAction('${flag.flagId}', 'rejected')">
                Dismiss
            </button>
            <button class="action-btn dismiss-with-note-btn" onclick="showDismissForm('${flag.flagId}')">
                Dismiss with note
            </button>

            <div id="approval-form-${flag.flagId}" class="approval-form" style="display: none;">
                <div class="form-header">
                    <h4>Send Follow-up to ${reporterLabel}</h4>
                    <p class="form-description">This message will be sent to the ${reporterRole} who flagged this content.</p>
                </div>
                <div class="form-group">
                    <label for="message-content-${flag.flagId}">Message:</label>
                    ${renderCannedResponseChips(`message-content-${flag.flagId}`)}
                    <textarea id="message-content-${flag.flagId}" class="message-textarea" rows="4">${escapeHtml(defaultMessage)}</textarea>
                </div>
                <div class="form-actions-row">
                    <button class="action-btn send-approve-btn" onclick="sendApprovalMessage('${flag.flagId}')">
                        Send & Approve
                    </button>
                    <button class="action-btn cancel-btn" onclick="hideApprovalForm('${flag.flagId}')">
                        Cancel
                    </button>
                </div>
                <input type="hidden" id="flag-recipient-role-${flag.flagId}" value="${reporterRole}">
                <input type="hidden" id="student-email-${flag.flagId}" value="student.${flag.studentId}@university.edu">
            </div>

            <div id="dismiss-form-${flag.flagId}" class="approval-form" style="display: none;">
                <div class="form-header">
                    <h4>Dismiss Flag</h4>
                    <p class="form-description">Optionally add a note explaining why. If you add one, the ${reporterRole} will see it on their flagged item.</p>
                </div>
                <div class="form-group">
                    <label for="dismiss-note-${flag.flagId}">Note (optional):</label>
                    ${renderCannedResponseChips(`dismiss-note-${flag.flagId}`)}
                    <textarea id="dismiss-note-${flag.flagId}" class="message-textarea" rows="3"></textarea>
                </div>
                <div class="form-actions-row">
                    <button class="action-btn send-dismiss-btn" onclick="sendDismissal('${flag.flagId}')">
                        Confirm Dismiss
                    </button>
                    <button class="action-btn cancel-btn" onclick="hideDismissForm('${flag.flagId}')">
                        Cancel
                    </button>
                </div>
            </div>
        `;
    } else {
        return `
             <div class="action-status-msg">
                Item is <strong>${escapeHtml(flag.flagStatus)}</strong>.
            </div>
            <!-- Future: View Details or Re-open buttons could go here -->
        `;
    }
}

/**
 * Show the approval form for a specific flag
 * @param {string} flagId - The flag ID
 */
function showApprovalForm(flagId) {
    const approvalForm = document.getElementById(`approval-form-${flagId}`);
    const approveButton = document.querySelector(`[data-flag-id="${flagId}"] .approve-btn`);
    const dismissButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-btn`);
    const dismissWithNoteButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-with-note-btn`);

    if (approvalForm) {
        approvalForm.style.display = 'block';
        approvalForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        // Hide the action buttons while form is open
        if (approveButton) approveButton.style.display = 'none';
        if (dismissButton) dismissButton.style.display = 'none';
        if (dismissWithNoteButton) dismissWithNoteButton.style.display = 'none';
    }
}

/**
 * Hide the approval form for a specific flag
 * @param {string} flagId - The flag ID
 */
function hideApprovalForm(flagId) {
    const approvalForm = document.getElementById(`approval-form-${flagId}`);
    const approveButton = document.querySelector(`[data-flag-id="${flagId}"] .approve-btn`);
    const dismissButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-btn`);
    const dismissWithNoteButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-with-note-btn`);

    if (approvalForm) {
        approvalForm.style.display = 'none';

        // Show the action buttons again
        if (approveButton) approveButton.style.display = 'inline-block';
        if (dismissButton) dismissButton.style.display = 'inline-block';
        if (dismissWithNoteButton) dismissWithNoteButton.style.display = 'inline-block';
    }
}

/**
 * Show the dismiss form for a specific flag (#694: optional note + canned responses)
 * @param {string} flagId - The flag ID
 */
function showDismissForm(flagId) {
    const dismissForm = document.getElementById(`dismiss-form-${flagId}`);
    const approveButton = document.querySelector(`[data-flag-id="${flagId}"] .approve-btn`);
    const dismissButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-btn`);
    const dismissWithNoteButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-with-note-btn`);

    if (dismissForm) {
        dismissForm.style.display = 'block';
        dismissForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        if (approveButton) approveButton.style.display = 'none';
        if (dismissButton) dismissButton.style.display = 'none';
        if (dismissWithNoteButton) dismissWithNoteButton.style.display = 'none';
    }
}

/**
 * Hide the dismiss form for a specific flag
 * @param {string} flagId - The flag ID
 */
function hideDismissForm(flagId) {
    const dismissForm = document.getElementById(`dismiss-form-${flagId}`);
    const approveButton = document.querySelector(`[data-flag-id="${flagId}"] .approve-btn`);
    const dismissButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-btn`);
    const dismissWithNoteButton = document.querySelector(`[data-flag-id="${flagId}"] .dismiss-with-note-btn`);

    if (dismissForm) {
        dismissForm.style.display = 'none';
        if (dismissWithNoteButton) dismissWithNoteButton.style.display = 'inline-block';

        if (approveButton) approveButton.style.display = 'inline-block';
        if (dismissButton) dismissButton.style.display = 'inline-block';
    }
}

/**
 * Show the edit form for a flag's own reason/description (#756), e.g. to fix
 * a flag that was submitted with the wrong category.
 * @param {string} flagId - The flag ID
 */
function showEditFlagForm(flagId) {
    const display = document.getElementById(`flag-note-display-${flagId}`);
    const form = document.getElementById(`edit-flag-form-${flagId}`);
    const editBtn = document.getElementById(`edit-flag-btn-${flagId}`);

    if (display) display.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';
    if (form) form.style.display = 'block';
}

/**
 * Hide the edit form, discarding any unsaved changes by resetting the
 * fields back to the flag's current values.
 * @param {string} flagId - The flag ID
 */
function hideEditFlagForm(flagId) {
    const display = document.getElementById(`flag-note-display-${flagId}`);
    const form = document.getElementById(`edit-flag-form-${flagId}`);
    const editBtn = document.getElementById(`edit-flag-btn-${flagId}`);
    const reasonSelect = document.getElementById(`edit-flag-reason-${flagId}`);
    const descriptionTextarea = document.getElementById(`edit-flag-description-${flagId}`);

    const flag = appState.flags.find(f => f.flagId === flagId);
    if (flag) {
        if (reasonSelect) reasonSelect.value = flag.flagReason;
        if (descriptionTextarea) descriptionTextarea.value = flag.flagDescription || '';
    }

    if (form) form.style.display = 'none';
    if (display) display.style.display = 'block';
    if (editBtn) editBtn.style.display = 'inline-flex';
}

/**
 * Save edits to a flag's reason/description (#756).
 * @param {string} flagId - The flag ID
 */
async function saveFlagEdit(flagId) {
    const saveButton = document.querySelector(`#edit-flag-form-${flagId} .save-flag-edit-btn`);
    const cancelButton = document.querySelector(`#edit-flag-form-${flagId} .cancel-btn`);
    try {
        const reasonSelect = document.getElementById(`edit-flag-reason-${flagId}`);
        const descriptionTextarea = document.getElementById(`edit-flag-description-${flagId}`);
        const flagReason = reasonSelect ? reasonSelect.value : undefined;
        const flagDescription = descriptionTextarea ? descriptionTextarea.value.trim() : undefined;

        if (saveButton) saveButton.disabled = true;
        if (cancelButton) cancelButton.disabled = true;

        const response = await fetch(`/api/flags/${flagId}/details`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flagReason, flagDescription })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to update flag');
        }

        const flagIndex = appState.flags.findIndex(flag => flag.flagId === flagId);
        if (flagIndex !== -1) {
            appState.flags[flagIndex].flagReason = flagReason;
            appState.flags[flagIndex].flagDescription = flagDescription;
        }

        applyFilters();
        renderFlaggedContent();
        showSuccessMessage('Flag updated successfully');
    } catch (error) {
        console.error('Error updating flag:', error);
        showErrorMessage('Failed to update flag. Please try again.');
        if (saveButton) saveButton.disabled = false;
        if (cancelButton) cancelButton.disabled = false;
    }
}

/**
 * Confirm dismissal, with an optional note (#694). A non-empty note routes
 * through the same /response endpoint the approve flow uses, so the note is
 * stored and shown to the reporter the same way an approval reply is. An
 * empty note instead uses the plain /status endpoint (the same one the
 * one-click Dismiss button uses) - /response 400s when response is empty,
 * since that endpoint's contract is "set a response", not "maybe set one".
 * @param {string} flagId - The flag ID
 */
async function sendDismissal(flagId) {
    const sendButton = document.querySelector(`[data-flag-id="${flagId}"] .send-dismiss-btn`);
    const cancelButton = document.querySelector(`#dismiss-form-${flagId} .cancel-btn`);
    try {
        const noteTextarea = document.getElementById(`dismiss-note-${flagId}`);
        const note = noteTextarea ? noteTextarea.value.trim() : '';

        if (sendButton) {
            sendButton.textContent = 'Dismissing...';
            sendButton.disabled = true;
        }
        if (cancelButton) cancelButton.disabled = true;

        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        const currentUser = getCurrentUser();
        const instructorName = currentUser ? (currentUser.displayName || currentUser.username) : 'Instructor';

        const response = note
            ? await fetch(`/api/flags/${flagId}/response`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    response: note,
                    instructorId,
                    instructorName,
                    flagStatus: 'dismissed'
                })
            })
            : await fetch(`/api/flags/${flagId}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'dismissed',
                    instructorId
                })
            });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to dismiss flag');
        }

        const flagIndex = appState.flags.findIndex(flag => flag.flagId === flagId);
        if (flagIndex !== -1) {
            appState.flags[flagIndex].flagStatus = 'dismissed';
            if (note) {
                appState.flags[flagIndex].instructorResponse = note;
                appState.flags[flagIndex].instructorId = instructorId;
                appState.flags[flagIndex].instructorName = instructorName;
            }
            appState.flags[flagIndex].updatedAt = new Date().toISOString();
        }

        hideDismissForm(flagId);
        applyFilters();
        renderFlaggedContent();
        loadFlagStats();
        showSuccessMessage('Flag dismissed successfully');
    } catch (error) {
        console.error('Error dismissing flag:', error);
        showErrorMessage('Failed to dismiss flag. Please try again.');

        if (sendButton) {
            sendButton.textContent = 'Confirm Dismiss';
            sendButton.disabled = false;
        }
        if (cancelButton) cancelButton.disabled = false;
    }
}

/**
 * Send approval message and approve the flag
 * @param {string} flagId - The flag ID
 */
async function sendApprovalMessage(flagId) {
    try {
        const emailInput = document.getElementById(`student-email-${flagId}`);
        const messageTextarea = document.getElementById(`message-content-${flagId}`);
        const recipientRoleInput = document.getElementById(`flag-recipient-role-${flagId}`);
        
        if (!emailInput || !messageTextarea) {
            throw new Error('Form elements not found');
        }
        
        const studentEmail = emailInput.value.trim(); // Hidden field, automatically generated
        const messageContent = messageTextarea.value.trim();
        const recipientRole = recipientRoleInput?.value === 'instructor' ? 'instructor' : 'student';
        
        if (!messageContent) {
            alert(`Please enter a message to send to the ${recipientRole}.`);
            return;
        }
        
        // Disable form while processing
        // Scoped to this flag's approval form (#756 follow-up): a bare
        // card-level selector is ambiguous now that the edit-flag form (which
        // renders earlier in the card) also has a .cancel-btn.
        const sendButton = document.querySelector(`#approval-form-${flagId} .send-approve-btn`);
        const cancelButton = document.querySelector(`#approval-form-${flagId} .cancel-btn`);

        if (sendButton) {
            sendButton.textContent = 'Sending...';
            sendButton.disabled = true;
        }
        if (cancelButton) {
            cancelButton.disabled = true;
        }
        
        // Get actual user information from auth
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        const currentUser = getCurrentUser();
        const instructorName = currentUser ? (currentUser.displayName || currentUser.username) : 'Instructor';
        
        // Send instructor response using the new API
        const response = await fetch(`/api/flags/${flagId}/response`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                response: messageContent,
                instructorId: instructorId,
                instructorName: instructorName,
                flagStatus: 'resolved'
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (result.success) {
            // Update the flag in local state
            const flagIndex = appState.flags.findIndex(flag => flag.flagId === flagId);
            if (flagIndex !== -1) {
                appState.flags[flagIndex].flagStatus = 'resolved';
                appState.flags[flagIndex].instructorResponse = messageContent;
                appState.flags[flagIndex].instructorId = instructorId;
                appState.flags[flagIndex].instructorName = instructorName;
                appState.flags[flagIndex].updatedAt = new Date().toISOString();
            }
            
            // Hide the approval form
            hideApprovalForm(flagId);
            
            // Re-apply filters and re-render
            applyFilters();
            renderFlaggedContent();
            
            // Refresh stats
            loadFlagStats();
            
            // Show combined success message
            showSuccessMessage(`Follow-up message sent to ${recipientRole} and flag resolved successfully`);
            
        } else {
            throw new Error(result.message || 'Failed to send instructor response');
        }
        
    } catch (error) {
        console.error('Error sending approval message:', error);
        showErrorMessage('Failed to send message. Please try again.');
        
        // Re-enable form (scoped to this flag's approval form - see note above)
        const sendButton = document.querySelector(`#approval-form-${flagId} .send-approve-btn`);
        const cancelButton = document.querySelector(`#approval-form-${flagId} .cancel-btn`);

        if (sendButton) {
            sendButton.textContent = 'Send & Approve';
            sendButton.disabled = false;
        }
        if (cancelButton) {
            cancelButton.disabled = false;
        }
    }
}

/**
 * Handle flag action (approve/reject)
 * @param {string} flagId - The flag ID
 * @param {string} action - The action to take (resolved/dismissed)
 * @param {boolean} skipSuccessMessage - Whether to skip showing the success message
 */
async function handleFlagAction(flagId, action, skipSuccessMessage = false) {
    try {
        // Disable buttons to prevent double-clicking
        const flagElement = document.querySelector(`[data-flag-id="${flagId}"]`);
        const buttons = flagElement.querySelectorAll('.action-btn');
        buttons.forEach(btn => btn.disabled = true);
        
        // Get actual user information from auth
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        const currentUser = getCurrentUser();
        const instructorName = currentUser ? (currentUser.displayName || currentUser.username) : 'Instructor';
        
        // Map old action names to new ones
        const actionMap = {
            'approved': 'resolved',
            'rejected': 'dismissed'
        };
        
        const newStatus = actionMap[action] || action;
        
        // Update flag status using the new API
        const response = await fetch(`/api/flags/${flagId}/status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                status: newStatus,
                instructorId: instructorId
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (result.success) {
            // Update the flag in local state
            const flagIndex = appState.flags.findIndex(flag => flag.flagId === flagId);
            if (flagIndex !== -1) {
                appState.flags[flagIndex].flagStatus = newStatus;
            }
            
            // Re-apply filters and re-render
            applyFilters();
            renderFlaggedContent();
            
            // Refresh stats
            loadFlagStats();
            
            // Show success message only if not skipped
            if (!skipSuccessMessage) {
                const actionText = newStatus === 'dismissed' ? 'dismissed' : newStatus;
                showSuccessMessage(`Flag ${actionText} successfully`);
            }
            
        } else {
            throw new Error(result.message || `Failed to ${newStatus} flag`);
        }
        
    } catch (error) {
        const actionText = action === 'rejected' ? 'dismiss' : action;
        console.error(`Error ${actionText} flag:`, error);
        showErrorMessage(`Failed to ${actionText} flag. Please try again.`);
        
        // Re-enable buttons
        const flagElement = document.querySelector(`[data-flag-id="${flagId}"]`);
        const buttons = flagElement.querySelectorAll('.action-btn');
        buttons.forEach(btn => btn.disabled = false);
    }
}



/**
 * Update the statistics display
 */
function updateStatsDisplay() {
    const totalElement = document.getElementById('total-flags');
    const pendingElement = document.getElementById('pending-flags');
    const todayElement = document.getElementById('today-flags');
    
    if (totalElement) {
        totalElement.textContent = appState.stats.total || 0;
    }
    
    if (pendingElement) {
        pendingElement.textContent = appState.stats.pending || 0;
    }
    
    if (todayElement) {
        // Calculate today's flags from the flags array
        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const todayFlags = appState.flags.filter(flag => {
            const flagDate = new Date(flag.createdAt);
            return flagDate >= todayStart;
        }).length;
        todayElement.textContent = todayFlags;
    }
}

/**
 * Show loading state
 */
function showLoadingState() {
    console.log('🔧 [LOADING] showLoadingState called');
    console.log('🔧 [LOADING] Elements in flagged-content-container:', document.querySelectorAll('.flagged-content-container *'));
    
    const loadingState = document.getElementById('loading-state');
    const emptyState = document.getElementById('empty-state');
    const flaggedList = document.getElementById('flagged-list');
    
    console.log('🔧 [LOADING] loadingState element:', loadingState);
    console.log('🔧 [LOADING] emptyState element:', emptyState);
    console.log('🔧 [LOADING] flaggedList element:', flaggedList);
    
    if (loadingState) {
        loadingState.style.display = 'block';
    }
    
    if (emptyState) {
        emptyState.style.display = 'none';
    }
    
    if (flaggedList) {
        flaggedList.innerHTML = '';
    }
}

/**
 * Show error state
 * @param {string} message - Error message to display
 */
function showErrorState(message) {
    const loadingState = document.getElementById('loading-state');
    const emptyState = document.getElementById('empty-state');
    const flaggedList = document.getElementById('flagged-list');
    
    if (loadingState) {
        loadingState.style.display = 'none';
    }
    
    if (emptyState) {
        emptyState.innerHTML = `<p class="error-message">${message}</p>`;
        emptyState.style.display = 'block';
    }
    
    if (flaggedList) {
        flaggedList.innerHTML = '';
    }
}

/**
 * Utility Functions
 */

/**
 * Format timestamp for display
 * @param {string} timestamp - ISO timestamp string
 * @returns {string} Formatted timestamp
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    
    try {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return 'Invalid date';
        }

        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 1) {
            return 'Just now';
        } else if (diffMins < 60) {
            return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
        } else if (diffHours < 24) {
            return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
        } else if (diffDays < 7) {
            return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
        } else {
            return date.toLocaleDateString();
        }
    } catch (error) {
        return 'Invalid date';
    }
}

/**
 * Get display text for flag reason
 * @param {string} flagReason - The flag reason
 * @returns {string} Display text for the flag reason
 */
const FLAG_REASON_LABELS = {
    'incorrect': 'Incorrect',
    'inappropriate': 'Inappropriate',
    'unclear': 'Unclear',
    'confusing': 'Confusing',
    'typo': 'Typo/Error',
    'offensive': 'Offensive',
    'irrelevant': 'Irrelevant'
};

function getFlagReasonDisplay(flagReason) {
    return FLAG_REASON_LABELS[flagReason] || flagReason;
}

/**
 * <option> list for the edit-flag reason <select> (#756), matching the
 * server's FLAG_REASONS/isValidFlagReason in src/models/FlaggedQuestion.js.
 * @param {string} currentReason - The flag's current flagReason
 * @returns {string} HTML for the <option> elements
 */
function getFlagReasonOptionsHtml(currentReason) {
    return Object.entries(FLAG_REASON_LABELS)
        .map(([value, label]) => `<option value="${value}" ${value === currentReason ? 'selected' : ''}>${escapeHtml(label)}</option>`)
        .join('');
}

/**
 * Get display text for bot mode
 * @param {string} botMode - The bot mode (protege or tutor)
 * @returns {string} Display text for the bot mode
 */
function getBotModeDisplay(botMode) {
    if (!botMode) {
        return 'Unknown';
    }
    
    const modeMap = {
        'protege': 'Protégé',
        'tutor': 'Tutor',
        'supercourse-student': 'Super Course Student',
        'supercourse-instructor': 'Super Course Instructor'
    };
    
    return modeMap[botMode.toLowerCase()] || botMode;
}

/**
 * Get display text for flag status
 * @param {string} status - The flag status
 * @returns {string} Display text for the status
 */
function getStatusDisplayText(status) {
    const statusMap = {
        'pending': 'Pending Review',
        'reviewed': 'Reviewed',
        'resolved': 'Resolved',
        'dismissed': 'Dismissed'
    };
    
    return statusMap[status] || status;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * A stored value as one plain class name: lowercase letters, digits, "-" and
 * "_" only. The known values ("incorrect", "high", "pending") pass unchanged.
 * escapeHtml leaves quotes alone, so it isn't enough inside an attribute.
 * @param {*} value
 * @returns {string}
 */
function toClassName(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/**
 * Show success message (simple implementation)
 * @param {string} message - Success message
 */
function showSuccessMessage(message) {
    // Calculate position based on existing toasts
    const existingToasts = document.querySelectorAll('.success-toast');
    const topOffset = 20 + (existingToasts.length * 60); // Stack toasts 60px apart
    
    // Simple toast notification implementation
    const toast = document.createElement('div');
    toast.className = 'success-toast';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: ${topOffset}px;
        right: 20px;
        background: #10b981;
        color: white;
        padding: 12px 20px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 1000;
        font-size: 14px;
        font-weight: 500;
        animation: slideInRight 0.3s ease-out;
        max-width: 300px;
        word-wrap: break-word;
    `;
    
    // Add animation keyframes to document if not already added
    if (!document.querySelector('#toast-animations')) {
        const style = document.createElement('style');
        style.id = 'toast-animations';
        style.textContent = `
            @keyframes slideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOutRight {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }
    
    document.body.appendChild(toast);
    
    // Auto-remove after 4 seconds (longer for longer message)
    setTimeout(() => {
        toast.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 4000);
    
    console.log('Success:', message);
}

/**
 * Show error message
 * @param {string} message - Error message
 */
function showErrorMessage(message) {
    console.error('Error:', message);
    showNotification(message, 'error');
}



/**
 * Wait for authentication to be initialized
 * @returns {Promise<void>}
 */
async function waitForAuth() {
    // Wait for auth.js to initialize
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max wait
    
    while (attempts < maxAttempts) {
        if (typeof getCurrentInstructorId === 'function' && getCurrentInstructorId()) {
            console.log('✅ [AUTH] Authentication ready');
            return;
        }
        
        // Wait 100ms before next attempt
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
    
    console.warn('⚠️ [AUTH] Authentication not ready after 5 seconds, proceeding anyway');
}

/**
 * Load TA permissions for all courses
 */
async function loadTAPermissions() {
    try {
        const taId = getCurrentInstructorId();
        if (!taId) {
            console.error('No TA ID found. User not authenticated.');
            return;
        }
        
        console.log(`Loading permissions for TA: ${taId}`);
        
        // First, we need to load TA courses to get the course IDs
        const coursesResponse = await authenticatedFetch(`/api/courses/ta/${taId}`);
        
        if (!coursesResponse.ok) {
            throw new Error(`HTTP error! status: ${coursesResponse.status}`);
        }
        
        const coursesResult = await coursesResponse.json();
        
        if (!coursesResult.success) {
            throw new Error(coursesResult.message || 'Failed to fetch TA courses');
        }
        
        const courses = coursesResult.data || [];
        console.log('TA courses for permissions:', courses);
        
        // Load permissions for each course
        const permissions = {};
        for (const course of courses) {
            const response = await authenticatedFetch(`/api/courses/${course.courseId}/ta-permissions/${taId}`);
            
            if (response.ok) {
                const result = await response.json();
                if (result.success) {
                    permissions[course.courseId] = result.data.permissions;
                }
            }
        }
        
        console.log('TA permissions loaded:', permissions);
        
        // Store permissions globally
        window.taPermissions = permissions;
        
    } catch (error) {
        console.error('Error loading TA permissions:', error);
        window.taPermissions = {};
    }
}

/**
 * Check if TA has permission for a specific feature (nav-link naming:
 * 'courses' -> /instructor/documents, gated server-side on ANY of
 * materials/questions/settings - see window.DOCUMENTS_PAGE_PERMISSIONS) in
 * any course - if any course allows access, grant it.
 */
function hasPermissionForFeature(feature) {
    // If no permissions loaded, deny access
    if (!window.taPermissions || Object.keys(window.taPermissions).length === 0) {
        return false;
    }

    const permissionKeys = feature === 'courses' ? window.DOCUMENTS_PAGE_PERMISSIONS : [feature];
    return Object.values(window.taPermissions).some(permissions =>
        permissionKeys.some(permissionKey => window.permissionIsGranted(permissions, permissionKey))
    );
}

/**
 * Update TA navigation based on permissions
 */
async function updateTANavigationBasedOnPermissions() {
    console.log('🔍 [PERMISSIONS] Starting permission update...');
    
    // Load permissions first
    await loadTAPermissions();
    
    console.log('🔍 [PERMISSIONS] Loaded permissions:', window.taPermissions);
    console.log('🔍 [PERMISSIONS] Can access courses:', hasPermissionForFeature('courses'));
    console.log('🔍 [PERMISSIONS] Can access flags:', hasPermissionForFeature('flags'));
    
    // Hide/show My Courses link
    const taMyCoursesLink = document.getElementById('ta-my-courses-link');
    console.log('🔍 [PERMISSIONS] My Courses link element:', taMyCoursesLink);
    if (taMyCoursesLink) {
        if (hasPermissionForFeature('courses')) {
            taMyCoursesLink.style.display = 'block';
            console.log('🔍 [PERMISSIONS] Showing My Courses link');
        } else {
            taMyCoursesLink.style.display = 'none';
            console.log('🔍 [PERMISSIONS] Hiding My Courses link');
        }
    } else {
        console.warn('⚠️ [PERMISSIONS] My Courses link not found');
    }
    
    // Hide/show Student Support link
    const taStudentSupportLink = document.getElementById('ta-student-support-link');
    console.log('🔍 [PERMISSIONS] Student Support link element:', taStudentSupportLink);
    if (taStudentSupportLink) {
        if (hasPermissionForFeature('flags')) {
            taStudentSupportLink.style.display = 'block';
            console.log('🔍 [PERMISSIONS] Showing Student Support link');
        } else {
            taStudentSupportLink.style.display = 'none';
            console.log('🔍 [PERMISSIONS] Hiding Student Support link');
        }
    } else {
        console.warn('⚠️ [PERMISSIONS] Student Support link not found');
    }
    
    console.log('🔍 [PERMISSIONS] Navigation updated based on TA permissions');
}

// ===================================================================
// MENTAL HEALTH FLAGS SECTION
// ===================================================================

const mhState = {
    flags: [],
    filteredFlags: [],
    isAdmin: false,
    currentFilter: 'pending'
};

/**
 * Initialize event listeners for the mental health flags section
 */
function initMHEventListeners() {
    const statusFilter = document.getElementById('mh-status-filter');
    if (statusFilter) {
        addKeyboardPickerActivation(statusFilter);
        statusFilter.addEventListener('change', () => {
            mhState.currentFilter = statusFilter.value;
            applyMHFilters();
            renderMHFlags();
        });
    }

    const refreshBtn = document.getElementById('refresh-mh-flags');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => loadMentalHealthFlags());
    }
}

/**
 * Load mental health flags from API
 */
async function loadMentalHealthFlags() {
    const section = document.getElementById('mental-health-section');
    const loading = document.getElementById('mh-loading');
    const empty = document.getElementById('mh-empty');
    const list = document.getElementById('mh-flags-list');

    // Gated server-side on 'transcripts' (requireCourseStaff in
    // mentalHealthFlags.js), not 'flags'/'roster' - a grader TA without it
    // would otherwise hit a 403 here that gets swallowed below, leaving the
    // section visible with a "0" badge that reads as "no flags" instead of
    // "you can't see this".
    if (typeof isTA === 'function' && isTA()) {
        const courseId = await getCurrentCourseId();
        const permissions = courseId && window.taPermissions ? window.taPermissions[courseId] : null;
        if (!window.permissionIsGranted(permissions, 'transcripts')) {
            if (section) section.style.display = 'none';
            return;
        }
    }
    if (section) section.style.display = '';

    if (loading) loading.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (list) list.innerHTML = '';

    try {
        const courseId = await getCurrentCourseId();
        if (!courseId) return;

        const response = await fetch(`/api/mental-health-flags/course/${courseId}`);
        const result = await response.json();

        if (result.success) {
            mhState.flags = result.flags || [];
            mhState.isAdmin = result.isAdmin || false;

            // Default admins to "escalated" filter on first load
            if (mhState.isAdmin && !mhState.filterInitialized) {
                mhState.currentFilter = 'escalated';
                const statusFilter = document.getElementById('mh-status-filter');
                if (statusFilter) statusFilter.value = 'escalated';
                mhState.filterInitialized = true;
            }

            // Update total badge
            const totalCount = document.getElementById('mh-total-count');
            if (totalCount) {
                const pendingCount = mhState.flags.filter(f => f.status === 'pending').length;
                const escalatedCount = mhState.flags.filter(f => f.status === 'escalated').length;
                totalCount.textContent = pendingCount + escalatedCount;
            }

            applyMHFilters();
            renderMHFlags();
        }
    } catch (error) {
        console.error('Error loading mental health flags:', error);
    } finally {
        if (loading) loading.style.display = 'none';
    }
}

/**
 * Apply filters to mental health flags
 */
function applyMHFilters() {
    if (mhState.currentFilter === 'all') {
        mhState.filteredFlags = [...mhState.flags];
    } else {
        mhState.filteredFlags = mhState.flags.filter(f => f.status === mhState.currentFilter);
    }
}

/**
 * Render mental health flag cards
 */
function renderMHFlags() {
    const list = document.getElementById('mh-flags-list');
    const empty = document.getElementById('mh-empty');
    if (!list) return;

    list.innerHTML = '';

    if (mhState.filteredFlags.length === 0) {
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    mhState.filteredFlags.forEach(flag => {
        const card = createMHFlagCard(flag);
        list.appendChild(card);
    });
}

/**
 * Load the flashcard "review again" stats section. This is a
 * course-wide aggregate (counts only, no student identity), so it
 * doesn't need the anonymize-students check that per-student views
 * (like Student Hub) use.
 */
async function loadReviewAgainStats() {
    const section = document.getElementById('review-again-section');
    const loading = document.getElementById('ra-loading');
    const empty = document.getElementById('ra-empty');
    const list = document.getElementById('ra-list');
    const totalBadge = document.getElementById('ra-total-count');

    // Flashcard deck management (and this stats view) is instructor-only
    // server-side (requireInstructorCourse in flashcards.js) - no TA
    // permission grants access, unlike the rest of this page.
    if (typeof isTA === 'function' && isTA()) {
        if (section) section.style.display = 'none';
        return;
    }
    if (section) section.style.display = '';

    if (loading) loading.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (list) list.innerHTML = '';

    try {
        const courseId = await getCurrentCourseId();
        if (!courseId) return;

        const response = await fetch(`/api/flashcards/instructor/review-again-stats?courseId=${courseId}`);
        const result = await response.json();

        if (result.success) {
            reviewAgainStats = result.data || [];
            if (totalBadge) totalBadge.textContent = reviewAgainStats.length;
            renderReviewAgainStats(reviewAgainStats);
        }
    } catch (error) {
        console.error('Error loading review-again stats:', error);
    } finally {
        if (loading) loading.style.display = 'none';
    }
}

/**
 * Same citation format as the student flashcards page
 * (public/student/scripts/flashcards.js's sourceLabel), so a card looks
 * the same whether a student or an instructor is looking at it.
 */
function formatCardSourceLabel(source) {
    if (!source) return 'Instructor-created card';
    if (source.slideNumber) return `${source.fileName || 'Course material'}, slide ${source.slideNumber}`;
    if (source.pageNumber) return `${source.fileName || 'Course material'}, page ${source.pageNumber}`;
    return `${source.fileName || 'Course material'}${Number.isInteger(source.chunkIndex) ? `, section ${source.chunkIndex + 1}` : ''}`;
}

function renderReviewAgainStats(stats) {
    const list = document.getElementById('ra-list');
    const empty = document.getElementById('ra-empty');
    if (!list) return;

    list.innerHTML = '';

    if (!stats.length) {
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    stats.forEach((stat, index) => {
        const card = document.createElement('div');
        card.className = 'ra-card';
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `View flashcard: ${stat.front}`);
        card.dataset.raIndex = String(index);
        card.innerHTML = `
            <div class="ra-card-main">
                <p class="ra-card-front">${escapeHtml(stat.front)}</p>
                <p class="ra-card-source">${escapeHtml(stat.lectureName || '')} — ${escapeHtml(formatCardSourceLabel(stat.source))}</p>
            </div>
            <div class="ra-card-counts">
                <span class="ra-card-student-count">${stat.studentCount} student${stat.studentCount === 1 ? '' : 's'}</span>
                <span class="ra-card-again-count">${stat.totalAgainCount} "again" presses</span>
            </div>
        `;
        card.addEventListener('click', () => openReviewAgainCardModal(index));
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openReviewAgainCardModal(index);
            }
        });
        list.appendChild(card);
    });
}

// Stats currently backing the Review Again list/modal, so the modal can look
// up a card's full data (deckId, cardId, source) by the index stashed on its
// row - re-set every time loadReviewAgainStats() refreshes the list.
let reviewAgainStats = [];
let reviewAgainModalCardIndex = null;

/**
 * Render a card side's live preview exactly like the Course Upload editor
 * does, so a card looks the same in both places.
 */
function renderReviewAgainCardPreview(side) {
    const input = document.getElementById(`ra-card-modal-${side}`);
    const preview = document.getElementById(`ra-card-modal-${side}-preview`);
    if (!input || !preview) return;
    if (typeof RichText === 'undefined') {
        preview.textContent = input.value || '';
        return;
    }
    RichText.render(preview, input.value || '');
}

function setReviewAgainModalEditing(isEditing) {
    const front = document.getElementById('ra-card-modal-front');
    const back = document.getElementById('ra-card-modal-back');
    const editBtn = document.getElementById('ra-card-modal-edit-btn');
    const saveBtn = document.getElementById('ra-card-modal-save-btn');
    const cancelBtn = document.getElementById('ra-card-modal-cancel-btn');
    if (front) front.readOnly = !isEditing;
    if (back) back.readOnly = !isEditing;
    if (editBtn) editBtn.style.display = isEditing ? 'none' : '';
    if (saveBtn) saveBtn.style.display = isEditing ? '' : 'none';
    if (cancelBtn) cancelBtn.style.display = isEditing ? '' : 'none';
}

function openReviewAgainCardModal(index) {
    const stat = reviewAgainStats[index];
    const modal = document.getElementById('ra-card-modal');
    if (!stat || !modal) return;

    reviewAgainModalCardIndex = index;

    document.getElementById('ra-card-modal-title').textContent = stat.lectureName || 'Flashcard';
    document.getElementById('ra-card-modal-source').textContent = formatCardSourceLabel(stat.source);
    document.getElementById('ra-card-modal-counts').textContent =
        `${stat.studentCount} student${stat.studentCount === 1 ? '' : 's'} · ${stat.totalAgainCount} "again" presses`;

    const front = document.getElementById('ra-card-modal-front');
    const back = document.getElementById('ra-card-modal-back');
    if (front) front.value = stat.front;
    if (back) back.value = stat.back;
    renderReviewAgainCardPreview('front');
    renderReviewAgainCardPreview('back');
    setReviewAgainModalEditing(false);

    modal.classList.add('show');
}

function closeReviewAgainCardModal() {
    const modal = document.getElementById('ra-card-modal');
    if (modal) modal.classList.remove('show');
    reviewAgainModalCardIndex = null;
}

async function saveReviewAgainCardEdit() {
    const stat = reviewAgainStats[reviewAgainModalCardIndex];
    const saveBtn = document.getElementById('ra-card-modal-save-btn');
    if (!stat || !saveBtn) return;

    const front = document.getElementById('ra-card-modal-front')?.value.trim();
    const back = document.getElementById('ra-card-modal-back')?.value.trim();
    if (!front || !back) {
        showErrorMessage('A flashcard needs both a front and a back.');
        return;
    }

    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        const response = await fetch(`/api/flashcards/instructor/${stat.deckId}/cards/${stat.cardId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ front, back })
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || 'Unable to save flashcard');

        stat.front = front;
        stat.back = back;
        setReviewAgainModalEditing(false);
        renderReviewAgainStats(reviewAgainStats);
        showSuccessMessage('Flashcard updated.');
    } catch (error) {
        console.error('Error saving flashcard edit:', error);
        showErrorMessage(error.message || 'Unable to save flashcard');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    }
}

function initReviewAgainModal() {
    const modal = document.getElementById('ra-card-modal');
    if (!modal) return;

    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeReviewAgainCardModal();
    });
    document.getElementById('ra-card-modal-close')?.addEventListener('click', closeReviewAgainCardModal);
    document.getElementById('ra-card-modal-edit-btn')?.addEventListener('click', () => setReviewAgainModalEditing(true));
    document.getElementById('ra-card-modal-save-btn')?.addEventListener('click', saveReviewAgainCardEdit);
    document.getElementById('ra-card-modal-cancel-btn')?.addEventListener('click', () => {
        const stat = reviewAgainStats[reviewAgainModalCardIndex];
        if (stat) {
            document.getElementById('ra-card-modal-front').value = stat.front;
            document.getElementById('ra-card-modal-back').value = stat.back;
            renderReviewAgainCardPreview('front');
            renderReviewAgainCardPreview('back');
        }
        setReviewAgainModalEditing(false);
    });
    document.getElementById('ra-card-modal-front')?.addEventListener('input', () => renderReviewAgainCardPreview('front'));
    document.getElementById('ra-card-modal-back')?.addEventListener('input', () => renderReviewAgainCardPreview('back'));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('show')) closeReviewAgainCardModal();
    });
}

/**
 * Time zone to format a date in Vancouver time.
 * B.C. stays on UTC-7 from 2026-11-01 02:00 PDT (09:00 UTC), but browsers with
 * time-zone data older than tzdata 2026b still fall back to UTC-8 for
 * America/Vancouver. Pin instants from then on to a fixed UTC-7 zone so every
 * browser agrees; earlier instants keep Vancouver's PDT/PST rules.
 */
function vancouverTimeZoneFor(date) {
    const bcPermanentUtc7From = Date.UTC(2026, 10, 1, 9);
    // Etc/GMT+7 is UTC-7: the POSIX sign is inverted.
    return new Date(date).getTime() >= bcPermanentUtc7From ? 'Etc/GMT+7' : 'America/Vancouver';
}

/**
 * Format a timestamp to Pacific Time (Vancouver) string
 */
function formatTimestampPT(timestamp) {
    if (!timestamp) return 'Unknown';
    try {
        const date = new Date(timestamp);
        return date.toLocaleString('en-US', {
            timeZone: vancouverTimeZoneFor(date),
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        }) + ' PT';
    } catch (e) {
        return 'Invalid date';
    }
}

/**
 * Create a DOM element for a single mental health flag card
 */
function createMHFlagCard(flag) {
    const card = document.createElement('div');
    const concernClass = flag.concernLevel === 'high concern' ? 'concern-high' : 'concern-low';
    const concernLabel = flag.concernLevel === 'high concern' ? 'High Concern' : 'Low Concern';
    const badgeClass = flag.concernLevel === 'high concern' ? 'high' : 'low';

    card.className = `mh-flag-card ${concernClass}`;
    card.setAttribute('data-mh-flag-id', flag.flagId);

    // Header
    let headerHtml = `
        <div class="mh-flag-card-header">
            <span class="mh-concern-badge ${badgeClass}">${concernLabel}</span>
            <div class="mh-flag-meta">
                <span class="mh-flag-date">${formatTimestampPT(flag.createdAt)}</span>
                <span class="mh-flag-status ${flag.status}">${flag.status.toUpperCase()}</span>
            </div>
        </div>
    `;

    // Body
    let bodyHtml = '<div class="mh-flag-card-body">';

    // Student name (only for admins on escalated flags)
    if (mhState.isAdmin && flag.studentName && flag.studentName !== 'Anonymous Student') {
        bodyHtml += `<div class="mh-flag-student-info">Student: ${escapeHtml(flag.studentName)}</div>`;
    }

    // Course & unit context
    bodyHtml += `<div style="font-size: 0.8rem; color: #64748b; margin-bottom: 0.5rem;">
        Course: ${escapeHtml(flag.courseId || 'N/A')} &bull; Unit: ${escapeHtml(flag.unitName || 'N/A')}
    </div>`;

    // LLM reason
    if (flag.llmReason) {
        bodyHtml += `<div class="mh-flag-reason">Detection reason: ${escapeHtml(flag.llmReason)}</div>`;
    }

    // The flagged message
    bodyHtml += `<div class="mh-flag-message">${escapeHtml(flag.message || 'No message content')}</div>`;

    // Conversation context toggle
    if (flag.conversationContext && flag.conversationContext.length > 0) {
        const contextId = `mh-ctx-${flag.flagId}`;
        bodyHtml += `<button class="mh-flag-context-toggle" onclick="toggleMHContext('${contextId}')">Show conversation context</button>`;
        bodyHtml += `<div id="${contextId}" class="mh-flag-context" style="display: none;">`;
        flag.conversationContext.forEach(msg => {
            const role = msg.role === 'user' ? 'Student' : 'Bot';
            bodyHtml += `<div class="ctx-msg"><span class="ctx-role">${role}:</span> ${escapeHtml(msg.content)}</div>`;
        });
        bodyHtml += '</div>';
    }

    bodyHtml += '</div>';

    // Footer with actions
    let footerHtml = '<div class="mh-flag-card-footer">';
    footerHtml += createMHActionButtons(flag);
    footerHtml += '</div>';

    card.innerHTML = headerHtml + bodyHtml + footerHtml;
    return card;
}

/**
 * Create action buttons based on flag status and user role
 */
function createMHActionButtons(flag) {
    if (flag.status === 'pending') {
        return `
            <button class="mh-action-btn mh-escalate-btn" onclick="handleMHAction('${flag.flagId}', 'escalate')">Escalate</button>
            <button class="mh-action-btn mh-dismiss-btn" onclick="handleMHAction('${flag.flagId}', 'dismiss')">Dismiss</button>
        `;
    }
    if (flag.status === 'escalated' && mhState.isAdmin) {
        return `
            <button class="mh-action-btn mh-resolve-btn" onclick="handleMHAction('${flag.flagId}', 'resolve')">Resolved</button>
            <button class="mh-action-btn mh-disregard-btn" onclick="handleMHAction('${flag.flagId}', 'disregard')">Disregard</button>
        `;
    }
    return `<span style="font-size: 0.8rem; color: #64748b;">Status: ${flag.status}</span>`;
}

/**
 * Toggle conversation context visibility
 */
function toggleMHContext(contextId) {
    const el = document.getElementById(contextId);
    if (el) {
        const isVisible = el.style.display !== 'none';
        el.style.display = isVisible ? 'none' : 'block';
        // Update button text
        const btn = el.previousElementSibling;
        if (btn) btn.textContent = isVisible ? 'Show conversation context' : 'Hide conversation context';
    }
}

/**
 * Handle a mental health flag action (escalate, dismiss, resolve, disregard)
 */
async function handleMHAction(flagId, action) {
    try {
        const response = await fetch(`/api/mental-health-flags/${flagId}/${action}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        });
        const result = await response.json();

        if (result.success) {
            showSuccessMessage(`Flag ${action}${action.endsWith('e') ? 'd' : 'ed'} successfully`);
            await loadMentalHealthFlags();
        } else {
            showErrorMessage(result.message || `Failed to ${action} flag`);
        }
    } catch (error) {
        console.error(`Error ${action} MH flag:`, error);
        showErrorMessage(`Failed to ${action} flag. Please try again.`);
    }
}
