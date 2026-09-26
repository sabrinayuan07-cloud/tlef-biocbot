/**
 * TA Home Page JavaScript
 * Handles the TA dashboard functionality
 */

let taCourses = [];
let availableTACourses = [];
let taPermissions = {};
let selectedTACourseId = null;

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function isCourseInactive(course = {}) {
    return (course.status || 'active') === 'inactive';
}

function getCourseDisplayName(course = {}) {
    const courseName = course.courseName || course.courseId || 'Untitled Course';
    return isCourseInactive(course) ? `${courseName} (Inactive)` : courseName;
}

function dedupeCourses(courses = []) {
    const byId = new Map();

    courses.forEach(course => {
        if (!course || !course.courseId) {
            return;
        }

        byId.set(course.courseId, {
            ...(byId.get(course.courseId) || {}),
            ...course
        });
    });

    return Array.from(byId.values());
}

function getAssignedCourseById(courseId) {
    return taCourses.find(course => course.courseId === courseId) || null;
}

function getPickerCourses() {
    return dedupeCourses([...availableTACourses, ...taCourses]);
}

function getCourseById(courseId) {
    return getAssignedCourseById(courseId) ||
        getPickerCourses().find(course => course.courseId === courseId) ||
        null;
}

function isAssignedTACourse(course = {}) {
    if (course.isTAAssigned === true) {
        return true;
    }

    const taId = typeof getCurrentInstructorId === 'function' ? getCurrentInstructorId() : null;
    return !!(taId && Array.isArray(course.tas) && course.tas.includes(taId));
}

function getSelectedTACourse() {
    return getAssignedCourseById(selectedTACourseId);
}

function getInitialSelectedCourseId() {
    const urlParams = new URLSearchParams(window.location.search);
    const candidates = [
        urlParams.get('courseId'),
        localStorage.getItem('selectedCourseId'),
        taCourses[0]?.courseId,
        getCurrentUser()?.preferences?.courseId
    ];

    return candidates.find(courseId => courseId && getAssignedCourseById(courseId)) || null;
}

function buildCourseUrl(path, courseId) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set('courseId', courseId);
    return url.pathname + url.search;
}

function updateTAHomeUrl(courseId) {
    const url = new URL(window.location.href);
    if (courseId) {
        url.searchParams.set('courseId', courseId);
    } else {
        url.searchParams.delete('courseId');
    }
    window.history.replaceState({}, '', url.pathname + url.search);
}

function getCoursePermission(courseId, feature) {
    if (!courseId || !getAssignedCourseById(courseId)) {
        return false;
    }

    const key = feature === 'courses' ? 'materials' : feature;
    return window.permissionIsGranted(taPermissions[courseId], key);
}

function hasPermissionForFeature(feature) {
    return getCoursePermission(selectedTACourseId, feature);
}

document.addEventListener('DOMContentLoaded', async function() {
    await waitForAuth();

    await loadTACourses();
    await loadTAPermissions();
    await initializeCoursePicker();

    displayTACourses();
    initializeDashboard();
});

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

        taPermissions = {};

        for (const course of taCourses) {
            const response = await authenticatedFetch(`/api/courses/${course.courseId}/ta-permissions/${taId}`);

            if (response.ok) {
                const result = await response.json();
                if (result.success) {
                    taPermissions[course.courseId] = { ...result.data.permissions, roleLabel: result.data.roleLabel };
                }
            }
        }

        console.log('TA permissions loaded:', taPermissions);
    } catch (error) {
        console.error('Error loading TA permissions:', error);
    }
}

/**
 * Initialize dashboard functionality
 */
function initializeDashboard() {
    setupMyCoursesLink();
    setupStudentSupportLink();
    setupQuickActionsLinks();
    updateNavigationBasedOnPermissions();
    console.log('TA Dashboard initialized');
}

async function initializeCoursePicker() {
    const pickerSection = document.getElementById('ta-course-picker-section');
    const courseSelect = document.getElementById('ta-course-select');

    if (!pickerSection || !courseSelect) {
        return;
    }

    if (getPickerCourses().length === 0) {
        pickerSection.style.display = 'none';
        selectedTACourseId = null;
        updateTAHomeUrl(null);
        return;
    }

    pickerSection.style.display = 'block';
    populateCourseDropdown(courseSelect);

    courseSelect.addEventListener('change', async (event) => {
        const courseId = event.target.value;
        if (!courseId) {
            return;
        }

        await setSelectedTACourse(courseId, { showMessage: true });
    });

    await setSelectedTACourse(getInitialSelectedCourseId(), { showMessage: false, allowJoin: false });
}

function populateCourseDropdown(courseSelect) {
    courseSelect.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a course...';
    courseSelect.appendChild(placeholder);

    getPickerCourses().forEach(course => {
        const option = document.createElement('option');
        const assigned = isAssignedTACourse(course);
        const requiresCode = course.requiresCode === true || course.requiresCode === 'true';

        option.value = course.courseId;
        option.textContent = getCourseDisplayName(course);
        option.dataset.assigned = assigned ? 'true' : 'false';
        option.dataset.requiresCode = requiresCode ? 'true' : 'false';

        if (!assigned) {
            option.textContent += requiresCode ? ' (enter code to join)' : ' (join invite)';
        }

        courseSelect.appendChild(option);
    });
}

async function setSelectedTACourse(courseId, options = {}) {
    const { allowJoin = true } = options;
    let course = getCourseById(courseId);

    if (!course) {
        syncCourseSelectToSelection();
        return;
    }

    if (!isAssignedTACourse(course)) {
        if (!allowJoin) {
            syncCourseSelectToSelection();
            return;
        }

        const joined = await joinTACourseFromPicker(course);
        if (!joined) {
            syncCourseSelectToSelection();
            return;
        }

        await loadTACourses();
        await loadTAPermissions();

        const courseSelect = document.getElementById('ta-course-select');
        if (courseSelect) {
            populateCourseDropdown(courseSelect);
        }

        course = getAssignedCourseById(courseId);
        if (!course) {
            showNotification('Course joined, but it could not be loaded yet. Please refresh and try again.', 'warning');
            syncCourseSelectToSelection();
            return;
        }
    }

    selectedTACourseId = course.courseId;
    localStorage.setItem('selectedCourseId', course.courseId);
    updateTAHomeUrl(course.courseId);

    const courseSelect = document.getElementById('ta-course-select');
    if (courseSelect) {
        courseSelect.value = course.courseId;
    }

    updateSelectedCourseSummary();
    updateNavigationBasedOnPermissions();
    displayTACourses();

    if (typeof setCurrentCourseId === 'function') {
        setCurrentCourseId(course.courseId).catch(error => {
            console.warn('Failed to sync selected TA course to user preferences:', error);
        });
    }

    if (options.showMessage) {
        showNotification(`Selected ${getCourseDisplayName(course)}`, 'success');
    }
}

function syncCourseSelectToSelection() {
    const courseSelect = document.getElementById('ta-course-select');
    if (courseSelect) {
        courseSelect.value = selectedTACourseId || '';
    }
}

async function joinTACourseFromPicker(course) {
    const requiresCode = course.requiresCode === true || course.requiresCode === 'true';
    let code = '';

    if (requiresCode) {
        code = prompt(`Enter the student course code for ${getCourseDisplayName(course)}:`);
        if (!code) {
            return false;
        }
    }

    try {
        const response = await authenticatedFetch(`/api/courses/${course.courseId}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok || !result.success) {
            showNotification(result.message || 'Failed to join course. Please check the course code.', 'error');
            return false;
        }

        showNotification(`Joined ${getCourseDisplayName(course)}`, 'success');
        return true;
    } catch (error) {
        console.error('Error joining TA course:', error);
        showNotification('Error joining course. Please try again.', 'error');
        return false;
    }
}

function updateSelectedCourseSummary() {
    const course = getSelectedTACourse();
    const nameElement = document.getElementById('selected-course-name');
    const idElement = document.getElementById('selected-course-id');
    const statusElement = document.getElementById('selected-course-status');

    if (!course) {
        if (nameElement) nameElement.textContent = 'No course selected';
        if (idElement) idElement.textContent = '-';
        if (statusElement) {
            statusElement.textContent = 'Active';
            statusElement.className = 'course-status active';
        }
        return;
    }

    const inactive = isCourseInactive(course);
    if (nameElement) nameElement.textContent = getCourseDisplayName(course);
    if (idElement) idElement.textContent = course.courseId;
    if (statusElement) {
        statusElement.textContent = inactive ? 'Inactive' : 'Active';
        statusElement.className = `course-status ${inactive ? 'inactive' : 'active'}`;
    }
}

/**
 * Update navigation based on selected-course TA permissions
 */
function updateNavigationBasedOnPermissions() {
    const course = getSelectedTACourse();
    const canAccessCourses = !!course && hasPermissionForFeature('courses');
    const canAccessFlags = !!course && hasPermissionForFeature('flags');

    setNavLinkVisible(document.getElementById('my-courses-link'), canAccessCourses);
    setNavLinkVisible(document.getElementById('student-support-link'), canAccessFlags);

    const quickCoursesLink = document.getElementById('quick-courses-link');
    if (quickCoursesLink) {
        quickCoursesLink.style.display = canAccessCourses ? 'block' : 'none';
        if (course) {
            quickCoursesLink.href = buildCourseUrl('/instructor/documents', course.courseId);
        }
    }

    const quickSupportLink = document.getElementById('quick-support-link');
    if (quickSupportLink) {
        quickSupportLink.style.display = canAccessFlags ? 'block' : 'none';
        if (course) {
            quickSupportLink.href = buildCourseUrl('/instructor/flagged', course.courseId);
        }
    }
}

function setNavLinkVisible(link, isVisible) {
    if (!link) {
        return;
    }

    const listItem = link.closest('li');
    const target = listItem || link;
    target.style.display = isVisible ? '' : 'none';
}

/**
 * Setup My Courses link to navigate to the selected assigned course
 */
function setupMyCoursesLink() {
    const myCoursesLink = document.getElementById('my-courses-link');
    if (myCoursesLink) {
        myCoursesLink.addEventListener('click', (e) => {
            e.preventDefault();
            navigateToSelectedCourse('courses', '/instructor/documents', 'Course Upload');
        });
    }
}

/**
 * Setup Student Support link to navigate to the selected assigned course's flagged content
 */
function setupStudentSupportLink() {
    const studentSupportLink = document.getElementById('student-support-link');
    if (studentSupportLink) {
        studentSupportLink.addEventListener('click', (e) => {
            e.preventDefault();
            navigateToSelectedCourse('flags', '/instructor/flagged', 'Student Flags');
        });
    }
}

/**
 * Setup Quick Actions links to navigate with proper course context
 */
function setupQuickActionsLinks() {
    const quickCoursesLink = document.getElementById('quick-courses-link');
    if (quickCoursesLink) {
        quickCoursesLink.addEventListener('click', (e) => {
            e.preventDefault();
            navigateToSelectedCourse('courses', '/instructor/documents', 'Course Upload');
        });
    }

    const quickSupportLink = document.getElementById('quick-support-link');
    if (quickSupportLink) {
        quickSupportLink.addEventListener('click', (e) => {
            e.preventDefault();
            navigateToSelectedCourse('flags', '/instructor/flagged', 'Student Flags');
        });
    }
}

function navigateToSelectedCourse(feature, targetPath, featureName) {
    const course = getSelectedTACourse();

    if (taCourses.length === 0) {
        showNotification('Join or select a course first.', 'warning');
        return;
    }

    if (!course) {
        showNotification('Select a course first.', 'warning');
        return;
    }

    if (!getCoursePermission(course.courseId, feature)) {
        showNotification(`You do not have permission to access ${featureName} for this course. Contact your instructor.`, 'error');
        return;
    }

    localStorage.setItem('selectedCourseId', course.courseId);
    window.location.href = buildCourseUrl(targetPath, course.courseId);
}

/**
 * Load courses for the TA
 */
async function loadTACourses() {
    try {
        const taId = getCurrentInstructorId();
        if (!taId) {
            console.error('No TA ID found. User not authenticated.');
            return;
        }

        console.log(`Loading courses for TA: ${taId}`);

        const [assignedResponse, availableResponse] = await Promise.all([
            authenticatedFetch(`/api/courses/ta/${taId}`),
            authenticatedFetch('/api/courses/available/all')
        ]);

        if (!assignedResponse.ok) {
            throw new Error(`HTTP error! status: ${assignedResponse.status}`);
        }

        const assignedResult = await assignedResponse.json();

        if (!assignedResult.success) {
            throw new Error(assignedResult.message || 'Failed to fetch TA courses');
        }

        taCourses = (assignedResult.data || []).map(course => ({
            ...course,
            isTAAssigned: true,
            requiresCode: false
        }));

        if (availableResponse.ok) {
            const availableResult = await availableResponse.json();
            availableTACourses = availableResult.success ? (availableResult.data || []) : [];
        } else {
            availableTACourses = taCourses;
        }

        console.log('TA courses loaded:', taCourses);
    } catch (error) {
        console.error('Error loading TA courses:', error);
        availableTACourses = taCourses;
        showNotification('Error loading courses. Please try again.', 'error');
    }
}

/**
 * Display TA courses on the dashboard
 */
function displayTACourses() {
    const coursesContainer = document.getElementById('courses-container');

    if (!coursesContainer) {
        console.error('Courses container not found');
        return;
    }

    if (taCourses.length === 0) {
        coursesContainer.innerHTML = `
            <div class="no-courses-message">
                <h3>No courses joined</h3>
                <p>Use the course dropdown above to join a course with an invite or student course code.</p>
                <a href="/ta/onboarding" class="btn-primary">Join a Course</a>
            </div>
        `;
        return;
    }

    coursesContainer.innerHTML = taCourses.map(course => {
        const roleKey = (taPermissions[course.courseId] && taPermissions[course.courseId].roleLabel) || 'custom';
        const roleLabel = window.ROLE_PRESET_LABELS[roleKey] || roleKey;
        const isInactive = isCourseInactive(course);
        const isSelected = selectedTACourseId === course.courseId;
        const statusLabel = isInactive ? 'Inactive' : 'Active';

        return `
        <div class="course-card ${isSelected ? 'selected' : ''}" data-course-id="${escapeHtml(course.courseId)}" role="button" tabindex="0" aria-pressed="${isSelected}">
            <div class="course-header">
                <h3>${escapeHtml(getCourseDisplayName(course))}</h3>
                <span class="course-status ${isInactive ? 'inactive' : 'active'}">${statusLabel}</span>
            </div>
            <div class="course-info">
                <p><strong>Course ID:</strong> ${escapeHtml(course.courseId)}</p>
                <p><strong>Instructor:</strong> ${escapeHtml(course.instructorId || 'Unknown')}</p>
                <p><strong>Units:</strong> ${escapeHtml(course.totalUnits || 0)}</p>
            </div>
            <div class="course-permissions">
                <span class="permission-pill role">Role: ${escapeHtml(roleLabel)}</span>
            </div>
            <button type="button" class="course-select-button">${isSelected ? 'Selected' : 'Select Course'}</button>
        </div>
        `;
    }).join('');

    coursesContainer.querySelectorAll('.course-card').forEach(card => {
        const selectCard = () => setSelectedTACourse(card.dataset.courseId, { showMessage: true });
        card.addEventListener('click', selectCard);
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectCard();
            }
        });
    });
}

/**
 * Wait for authentication to be initialized
 * @returns {Promise<void>}
 */
async function waitForAuth() {
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
        if (typeof getCurrentInstructorId === 'function' && getCurrentInstructorId()) {
            console.log('[AUTH] TA Authentication ready');
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }

    console.warn('[AUTH] TA Authentication not ready after 5 seconds, proceeding anyway');
}
