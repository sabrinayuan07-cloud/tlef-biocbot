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
const SUPER_COURSE_FLAG_COURSE_ID = 'SUPER_COURSE';

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
    
    // Initialize authentication first
    await initAuth();
    
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
        const permissionKey = feature === 'courses' ? 'materials' : feature;
        let hasPermission = false;
        const permResponse = await authenticatedFetch(`/api/courses/${selectedCourse.courseId}/ta-permissions/${taId}`);
        if (permResponse.ok) {
            const permResult = await permResponse.json();
            if (permResult.success) {
                hasPermission = window.permissionIsGranted(permResult.data.permissions, permissionKey);
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
    
    // Display texts
    const flagReasonDisplay = getFlagReasonDisplay(flag.flagReason);
    const botModeDisplay = getBotModeDisplay(flag.botMode);
    const statusDisplayText = getStatusDisplayText(flag.flagStatus);
    const statusClass = flag.flagStatus || 'pending';
    
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
    
    // Header Section
    let headerHtml = `
        <div class="flag-card-header">
            <div class="flag-header-left">
                <span class="flag-type-badge ${flag.flagReason}">${flagReasonDisplay}</span>
                <span class="flag-priority-badge ${flag.priority || 'medium'}">priority: ${flag.priority || 'medium'}</span>
            </div>
            <div class="flag-meta-info">
                <span class="flag-student">
                    <span class="meta-icon">👤</span> ${escapeHtml(reporterName)}
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
    
    // 2. Student Concern
    bodyHtml += `
        <div class="flag-section note-section">
            <h4 class="flag-section-title">${concernTitle}</h4>
            <div class="flag-note">
                ${escapeHtml(flag.flagDescription)}
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
            
            <div id="approval-form-${flag.flagId}" class="approval-form" style="display: none;">
                <div class="form-header">
                    <h4>Send Follow-up to ${reporterLabel}</h4>
                    <p class="form-description">This message will be sent to the ${reporterRole} who flagged this content.</p>
                </div>
                <div class="form-group">
                    <label for="message-content-${flag.flagId}">Message:</label>
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
        `;
    } else {
        return `
             <div class="action-status-msg">
                Item is <strong>${flag.flagStatus}</strong>.
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
    
    if (approvalForm) {
        approvalForm.style.display = 'block';
        approvalForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        
        // Hide the action buttons while form is open
        if (approveButton) approveButton.style.display = 'none';
        if (dismissButton) dismissButton.style.display = 'none';
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
    
    if (approvalForm) {
        approvalForm.style.display = 'none';
        
        // Show the action buttons again
        if (approveButton) approveButton.style.display = 'inline-block';
        if (dismissButton) dismissButton.style.display = 'inline-block';
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
        const sendButton = document.querySelector(`[data-flag-id="${flagId}"] .send-approve-btn`);
        const cancelButton = document.querySelector(`[data-flag-id="${flagId}"] .cancel-btn`);
        
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
        
        // Re-enable form
        const sendButton = document.querySelector(`[data-flag-id="${flagId}"] .send-approve-btn`);
        const cancelButton = document.querySelector(`[data-flag-id="${flagId}"] .cancel-btn`);
        
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
function getFlagReasonDisplay(flagReason) {
    const reasonMap = {
        'incorrect': 'Incorrect',
        'inappropriate': 'Inappropriate',
        'unclear': 'Unclear',
        'confusing': 'Confusing',
        'typo': 'Typo/Error',
        'offensive': 'Offensive',
        'irrelevant': 'Irrelevant'
    };
    
    return reasonMap[flagReason] || flagReason;
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
 * Show error message (simple implementation)
 * @param {string} message - Error message
 */
function showErrorMessage(message) {
    // TODO: Implement proper toast notification system
    console.error('Error:', message);
    alert(message); // Temporary simple alert
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
 * 'courses' -> the 'materials' permission) in any course - if any course
 * allows access, grant it.
 */
function hasPermissionForFeature(feature) {
    // If no permissions loaded, deny access
    if (!window.taPermissions || Object.keys(window.taPermissions).length === 0) {
        return false;
    }

    const permissionKey = feature === 'courses' ? 'materials' : feature;
    return Object.values(window.taPermissions).some(permissions =>
        window.permissionIsGranted(permissions, permissionKey)
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
    const loading = document.getElementById('mh-loading');
    const empty = document.getElementById('mh-empty');
    const list = document.getElementById('mh-flags-list');

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
 * Format a timestamp to PDT string
 */
function formatTimestampPDT(timestamp) {
    if (!timestamp) return 'Unknown';
    try {
        const date = new Date(timestamp);
        return date.toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        }) + ' PDT';
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
                <span class="mh-flag-date">${formatTimestampPDT(flag.createdAt)}</span>
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
