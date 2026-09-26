/**
 * Instructor: TA sidebar, navigation, and permission handling.
 */

/**
 * Update sidebar navigation for TAs
 */
async function updateSidebarForTA() {
    // Check if user is a TA
    if (typeof isTA === 'function' && isTA()) {
        console.log('🔄 [SIDEBAR] Updating sidebar for TA user');
        
        // Hide instructor navigation items
        const instructorNavItems = [
            'instructor-home-nav',
            'instructor-chat-nav',
            'instructor-documents-nav', 
            'instructor-onboarding-nav',
            'instructor-flagged-nav',
            'instructor-downloads-nav',
            'instructor-ta-hub-nav',
            'instructor-settings-nav'
        ];
        
        instructorNavItems.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.style.display = 'none';
        });
        
        // Show TA navigation items
        const taNavItems = [
            'ta-dashboard-nav',
            'ta-courses-nav',
            'ta-support-nav',
            'ta-settings-nav'
        ];
        
        taNavItems.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.style.display = 'block';
        });
        
        // Update user info
        const userAvatar = document.querySelector('.user-avatar');
        if (userAvatar) {
            userAvatar.textContent = typeof getCurrentUserInitial === 'function'
                ? getCurrentUserInitial()
                : 'T';
        }
        
        const userRole = document.querySelector('.user-role');
        if (userRole) {
            userRole.textContent = 'Teaching Assistant';
        }
        
        // Setup TA navigation handlers
        setupTANavigationHandlers();
        
        // Update navigation based on permissions
        await updateTANavigationBasedOnPermissions();
        
        console.log('✅ [SIDEBAR] Sidebar updated for TA');
    } else {
        // Explicitly set role for regular Instructors
        const userRole = document.querySelector('.user-role');
        if (userRole) {
            userRole.textContent = typeof getCurrentUserRoleLabel === 'function'
                ? getCurrentUserRoleLabel()
                : 'Instructor';
        }
    }
}

/**
 * Setup TA navigation handlers
 */
function setupTANavigationHandlers() {
    console.log('🔍 [TA NAV] Setting up TA navigation handlers');
    
    // TA My Courses link
    const taMyCoursesLink = document.getElementById('ta-my-courses-link');
    if (taMyCoursesLink) {
        taMyCoursesLink.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('🔍 [TA NAV] My Courses clicked');

            const courseId = getSelectedCourseIdForTA();
            if (courseId && !window.location.pathname.includes('/instructor/documents')) {
                window.location.href = `/instructor/documents?courseId=${encodeURIComponent(courseId)}`;
            }
        });
    }
    
    // TA Student Support link
    const taStudentSupportLink = document.getElementById('ta-student-support-link');
    console.log('🔍 [TA NAV] Looking for ta-student-support-link element:', taStudentSupportLink);
    if (taStudentSupportLink) {
        console.log('🔍 [TA NAV] Setting up TA Student Support link');
        taStudentSupportLink.addEventListener('click', async (e) => {
            e.preventDefault();
            console.log('🔍 [TA NAV] Student Support clicked');

            const courseId = getSelectedCourseIdForTA() || await getCurrentCourseId();
            console.log('🔍 [TA NAV] Current URL:', window.location.href);
            console.log('🔍 [TA NAV] Selected CourseId:', courseId);
            
            if (courseId) {
                console.log('🔍 [TA NAV] Navigating to flagged page with courseId:', courseId);
                localStorage.setItem('selectedCourseId', courseId);
                window.location.href = `/instructor/flagged?courseId=${encodeURIComponent(courseId)}`;
            } else {
                console.error('❌ [TA NAV] No courseId found in URL');
                alert('No course selected. Please try again.');
            }
        });
    } else {
        console.warn('⚠️ [TA NAV] TA Student Support link not found');
    }
}

function getSelectedCourseIdForTA() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('courseId') ||
        localStorage.getItem('selectedCourseId') ||
        getCurrentUser()?.preferences?.courseId ||
        window.taCourses?.[0]?.courseId ||
        null;
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
        window.taCourses = courses;
        
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
 * 'courses' -> the 'materials' permission, 'flags' -> the 'flags'
 * permission) in any of their courses, or just the currently-selected one
 * when one is picked.
 */
function hasPermissionForFeature(feature) {
    // If no permissions loaded, deny access
    if (!window.taPermissions || Object.keys(window.taPermissions).length === 0) {
        return false;
    }

    const permissionKey = feature === 'courses' ? 'materials' : feature;

    const selectedCourseId = getSelectedCourseIdForTA();
    const courseIds = selectedCourseId && window.taPermissions[selectedCourseId]
        ? [selectedCourseId]
        : Object.keys(window.taPermissions);

    return courseIds.some(courseId =>
        window.permissionIsGranted(window.taPermissions[courseId], permissionKey)
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

    // On the documents page, unit sub-sections need the same gating - the
    // units may already be rendered by the time permissions finish loading
    // (or vice versa), so re-apply here regardless of order.
    if (typeof window.applyTASectionPermissions === 'function') {
        window.applyTASectionPermissions();
    }
}
