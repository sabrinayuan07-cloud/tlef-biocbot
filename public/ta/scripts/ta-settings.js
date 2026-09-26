/**
 * TA Settings Page JavaScript
 * Handles the Teaching Assistant settings functionality
 */

let taCourses = [];
let taPermissions = {};

function isCourseInactive(course = {}) {
    return (course.status || 'active') === 'inactive';
}

function getCourseDisplayName(course = {}) {
    const courseName = course.courseName || course.courseId || 'Untitled Course';
    return isCourseInactive(course) ? `${courseName} (Inactive)` : courseName;
}

function getSelectedOrFirstTACourseId() {
    const urlParams = new URLSearchParams(window.location.search);
    const candidates = [
        urlParams.get('courseId'),
        localStorage.getItem('selectedCourseId'),
        getCurrentUser()?.preferences?.courseId
    ];

    return candidates.find(courseId => courseId && taCourses.some(course => course.courseId === courseId))
        || taCourses[0]?.courseId
        || null;
}

function getSelectedTAPermissions() {
    const courseId = getSelectedOrFirstTACourseId();
    return courseId ? taPermissions[courseId] : null;
}

function navigateToTACourse(path) {
    const courseId = getSelectedOrFirstTACourseId();

    if (!courseId) {
        showNotification('No courses available. Contact your instructor.', 'warning');
        return;
    }

    localStorage.setItem('selectedCourseId', courseId);
    window.location.href = `${path}?courseId=${encodeURIComponent(courseId)}`;
}

document.addEventListener('DOMContentLoaded', async function() {
    console.log('🚀 [TA SETTINGS] Page loaded');
    
    // Wait for authentication to be ready
    await waitForAuth();
    
    // Load TA data
    await loadTAData();
    
    // Setup navigation handlers
    setupTANavigationHandlers();
    
    // Update navigation based on permissions
    await updateTANavigationBasedOnPermissions();
    
    console.log('✅ [TA SETTINGS] Page initialized');
});

/**
 * Load TA data (courses and permissions)
 */
async function loadTAData() {
    try {
        // Load TA courses
        await loadTACourses();
        
        // Load TA permissions
        await loadTAPermissions();
        
        // Update UI with loaded data
        updateAccountInfo();
        updateCourseAssignments();
        updatePermissionsStatus();
        
    } catch (error) {
        console.error('Error loading TA data:', error);
        showNotification('Error loading your data. Please refresh the page.', 'error');
    }
}

/**
 * Load TA courses
 */
async function loadTACourses() {
    try {
        const taId = getCurrentInstructorId();
        if (!taId) {
            console.error('No TA ID found. User not authenticated.');
            return;
        }
        
        console.log(`Loading courses for TA: ${taId}`);
        
        const response = await authenticatedFetch(`/api/courses/ta/${taId}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to fetch TA courses');
        }
        
        taCourses = result.data || [];
        console.log('TA courses loaded:', taCourses);
        
    } catch (error) {
        console.error('Error loading TA courses:', error);
        taCourses = [];
    }
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
        
        // Load permissions for each course
        const permissions = {};
        for (const course of taCourses) {
            const response = await authenticatedFetch(`/api/courses/${course.courseId}/ta-permissions/${taId}`);
            
            if (response.ok) {
                const result = await response.json();
                if (result.success) {
                    permissions[course.courseId] = result.data.permissions;
                }
            }
        }

        console.log('TA permissions loaded:', permissions);
        taPermissions = permissions;
        
    } catch (error) {
        console.error('Error loading TA permissions:', error);
        taPermissions = {};
    }
}

/**
 * Update account information display
 */
function updateAccountInfo() {
    const taId = getCurrentInstructorId();
    const currentUser = getCurrentUser();
    
    // Update TA ID
    const taIdInput = document.getElementById('ta-id');
    if (taIdInput) {
        taIdInput.value = taId || 'Not available';
    }
    
    // Update email (this would come from user data)
    const emailInput = document.getElementById('ta-email');
    
    if (emailInput) {
        emailInput.value = currentUser?.email || 'Not available';
    }
}

/**
 * Update course assignments display
 */
function updateCourseAssignments() {
    const container = document.getElementById('course-assignments');
    if (!container) return;
    
    if (taCourses.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No Course Assignments</h3>
                <p>You haven't been assigned to any courses yet. Contact your instructor to be added to a course.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = taCourses.map(course => {
        const isInactive = isCourseInactive(course);

        return `
        <div class="course-assignment">
            <div class="course-info">
                <h4>${getCourseDisplayName(course)}</h4>
                <p>Course ID: ${course.courseId}</p>
            </div>
            <div class="course-status ${isInactive ? 'inactive' : 'active'}">${isInactive ? 'Inactive' : 'Active'}</div>
        </div>
    `;
    }).join('');
}

/**
 * Update permissions status display
 */
function updatePermissionsStatus() {
    const container = document.getElementById('permissions-status');
    if (!container) return;
    
    if (Object.keys(taPermissions).length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No Permission Data</h3>
                <p>Permission information is not available. Contact your instructor for details.</p>
            </div>
        `;
        return;
    }
    
    const permissions = getSelectedTAPermissions();
    const labels = {
        materials: 'Course Materials',
        questions: 'Question Bank',
        flags: 'Flagged Content',
        roster: 'Student Roster',
        transcripts: 'Student Transcripts',
        settings: 'Course Settings'
    };

    const rows = window.TA_PERMISSION_KEYS.map(key => {
        const allowed = hasPermissionForFeature(key);
        return `
        <div class="permission-item">
            <span class="permission-name">${labels[key]}</span>
            <span class="permission-status ${allowed ? 'allowed' : 'denied'}">
                ${allowed ? 'Allowed' : 'Denied'}
            </span>
        </div>`;
    }).join('');

    container.innerHTML = rows;
}

/**
 * Check if TA has permission for the selected course context.
 * 'courses' is accepted as an alias for 'materials' for callers still using
 * the old nav-link naming (e.g. setupTANavigationHandlers below).
 */
function hasPermissionForFeature(feature) {
    const permissions = getSelectedTAPermissions();
    const key = feature === 'courses' ? 'materials' : feature;
    return window.permissionIsGranted(permissions, key);
}

/**
 * Setup TA navigation handlers
 */
function setupTANavigationHandlers() {
    console.log('🔍 [TA SETTINGS] Setting up navigation handlers');
    
    // TA My Courses link
    const taMyCoursesLink = document.getElementById('ta-my-courses-link');
    if (taMyCoursesLink) {
        taMyCoursesLink.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('🔍 [TA SETTINGS] My Courses clicked');
            
            navigateToTACourse('/instructor/documents');
        });
    }
    
    // TA Student Support link
    const taStudentSupportLink = document.getElementById('ta-student-support-link');
    if (taStudentSupportLink) {
        taStudentSupportLink.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('🔍 [TA SETTINGS] Student Support clicked');
            
            navigateToTACourse('/instructor/flagged');
        });
    }
}

/**
 * Update TA navigation based on permissions
 */
async function updateTANavigationBasedOnPermissions() {
    console.log('🔍 [TA SETTINGS] Updating navigation based on permissions');
    
    // Hide/show My Courses link
    const taMyCoursesLink = document.getElementById('ta-my-courses-link');
    if (taMyCoursesLink) {
        if (hasPermissionForFeature('courses')) {
            taMyCoursesLink.style.display = 'block';
        } else {
            taMyCoursesLink.style.display = 'none';
        }
    }
    
    // Hide/show Student Support link
    const taStudentSupportLink = document.getElementById('ta-student-support-link');
    if (taStudentSupportLink) {
        if (hasPermissionForFeature('flags')) {
            taStudentSupportLink.style.display = 'block';
        } else {
            taStudentSupportLink.style.display = 'none';
        }
    }
}

/**
 * Contact instructor function
 */
function contactInstructor() {
    showNotification('Contact instructor functionality coming soon!', 'info');
}

/**
 * View help function
 */
function viewHelp() {
    showNotification('Help guide coming soon!', 'info');
}

/**
 * Wait for authentication to be initialized
 */
async function waitForAuth() {
    let attempts = 0;
    const maxAttempts = 50;
    
    while (attempts < maxAttempts) {
        if (typeof getCurrentInstructorId === 'function' && getCurrentInstructorId()) {
            console.log('✅ [AUTH] TA Authentication ready');
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
    
    console.warn('⚠️ [AUTH] TA Authentication not ready after 5 seconds, proceeding anyway');
}
