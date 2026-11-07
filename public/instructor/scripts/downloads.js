/**
 * Downloads Page Script
 * Handles fetching and displaying student chat sessions for instructors
 */

// Global variables
let currentCourseId = null;
let currentStudents = [];
let currentStudentSessions = [];

// Download scope: the instructor's course (default) or a superchat bucket.
// { type: 'course' } or { type: 'superchat', superchatId, name }
let currentScope = { type: 'course' };
let currentCourseName = null;
let activePseudonymMappings = new Map();

// Whether to include chats where the student never sent a message (e.g. a
// session saved from just the auto-welcome message landing) in the list and
// every download below. Off by default (#519) - see downloads.html's filter
// row.
let includeEmptyChats = false;

// Appends the empty-chats filter param to a request URL, whether or not it
// already has query params (e.g. a bucket export's ?studentId=).
function withEmptyChatsParam(url) {
    if (!includeEmptyChats) return url;
    return url + (url.includes('?') ? '&' : '?') + 'includeEmptyChats=true';
}

// Global variables to prevent multiple API calls and redirects
let courseIdCache = null;
let courseIdPromise = null;
let redirectInProgress = false;

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
    
    // If no course ID in URL, try to get it from the instructor's courses
    try {
        console.log('🔍 [GET_COURSE_ID] Getting instructor ID...');
        const instructorId = getCurrentInstructorId();
        console.log('🔍 [GET_COURSE_ID] Instructor ID:', instructorId);
        
        if (!instructorId) {
            console.error('No instructor ID available');
            return null;
        }
        
        console.log(`🔍 [GET_COURSE_ID] Fetching courses for instructor: ${instructorId}`);
        const response = await fetch(`/api/onboarding/instructor/${instructorId}`, {
            credentials: 'include'
        });
        
        console.log(`🔍 [GET_COURSE_ID] Response status: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
            const result = await response.json();
            console.log(`🔍 [GET_COURSE_ID] API response:`, result);
            
            if (result.data && result.data.courses && result.data.courses.length > 0) {
                // Return the first course found
                const firstCourse = result.data.courses[0];
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
    
    // If no course found, show an error and redirect to onboarding (only once)
    if (!redirectInProgress) {
        redirectInProgress = true;
        console.error('No course ID found. Redirecting to onboarding...');
        showNotification('No course found. Please complete onboarding first.', 'error');
        setTimeout(() => {
            window.location.href = '/instructor/onboarding';
        }, 2000);
    }
    
    // Return a placeholder (this should not be reached due to redirect)
    return null;
}

/**
 * Wait for authentication to be ready
 * @returns {Promise<void>}
 */
async function waitForAuth() {
    return new Promise((resolve) => {
        console.log('🔍 [WAIT_AUTH] Checking if auth is ready...');
        // Check if auth is already ready
        const currentUser = getCurrentUser();
        console.log('🔍 [WAIT_AUTH] Current user:', currentUser);
        
        if (currentUser) {
            console.log('🔍 [WAIT_AUTH] Auth already ready');
            resolve();
            return;
        }
        
        // Wait for auth:ready event
        document.addEventListener('auth:ready', () => {
            console.log('✅ [AUTH] Authentication ready');
            resolve();
        }, { once: true });
        
        // Fallback timeout in case auth never loads
        setTimeout(() => {
            console.warn('⚠️ [AUTH] Authentication timeout, proceeding anyway');
            resolve();
        }, 5000);
    });
}

/**
 * Initialize the downloads page
 */
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Downloads page initialized');
    
    // Set up event listeners
    setupEventListeners();

    // Wait for authentication to be ready
    await waitForAuth();

    if (typeof isSystemAdmin === 'function' && !isSystemAdmin()) {
        showErrorState('Only admins can access student chat downloads.');
        setTimeout(() => {
            window.location.href = '/instructor/home';
        }, 1500);
        return;
    }
    
    // Load the current course (the one the instructor is in)
    await loadCurrentCourse();

    // Offer superchat buckets as additional download scopes
    await populateScopeSelector();
});

/**
 * Populate the scope selector with the current course plus every superchat bucket.
 * Hidden unless at least one bucket exists.
 */
async function populateScopeSelector() {
    const container = document.getElementById('scope-selector-container');
    const selector = document.getElementById('scope-selector');
    if (!container || !selector) return;

    try {
        const response = await fetch('/api/superchats', { credentials: 'include' });
        if (!response.ok) return;

        const result = await response.json();
        const buckets = (result && result.superchats) || [];
        if (buckets.length === 0) return;

        selector.innerHTML = '';

        const courseOption = document.createElement('option');
        courseOption.value = 'course';
        courseOption.textContent = `Course: ${currentCourseName || currentCourseId || 'Current course'}`;
        selector.appendChild(courseOption);

        buckets.forEach(bucket => {
            const option = document.createElement('option');
            option.value = `superchat:${bucket.superchatId}`;
            option.textContent = `Superchat: ${bucket.name}`;
            option.dataset.name = bucket.name;
            selector.appendChild(option);
        });

        selector.addEventListener('change', handleScopeChange);
        container.style.display = '';
    } catch (error) {
        console.error('Error loading superchat buckets for scope selector:', error);
    }
}

/**
 * Switch between course and superchat download scopes.
 */
async function handleScopeChange(event) {
    const value = event.target.value;
    const selectedOption = event.target.selectedOptions[0];

    closeStudentModal();
    clearStudentData();

    if (value === 'course') {
        currentScope = { type: 'course' };
    } else {
        currentScope = {
            type: 'superchat',
            superchatId: value.slice('superchat:'.length),
            name: (selectedOption && selectedOption.dataset.name) || 'Superchat'
        };
    }

    updateScopeLabels();
    await loadStudentData();
}

/**
 * Update title, subtitle, bulk-download label, and empty state for the active scope.
 */
function updateScopeLabels() {
    const courseTitle = document.getElementById('course-title');
    const subtitle = document.getElementById('scope-subtitle');
    const downloadAllLabel = document.getElementById('download-all-label');
    const emptyState = document.querySelector('#empty-state p');

    if (currentScope.type === 'superchat') {
        if (courseTitle) courseTitle.textContent = `${currentScope.name} - Download Chats`;
        if (subtitle) subtitle.textContent = 'Superchat Student Chat Downloads';
        if (downloadAllLabel) downloadAllLabel.textContent = 'Download All Superchat Data';
        if (emptyState) emptyState.textContent = 'No students have saved chat sessions for this superchat yet.';
    } else {
        if (courseTitle) courseTitle.textContent = `${currentCourseName || currentCourseId} - Download Chats`;
        if (subtitle) subtitle.textContent = 'Student Chat Downloads';
        if (downloadAllLabel) downloadAllLabel.textContent = 'Download All Course Data';
        if (emptyState) emptyState.textContent = 'No students have saved chat sessions for this course yet.';
    }
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }

    // Empty-chats filter: chats where the student never sent a message (#519)
    const emptyChatFilter = document.getElementById('empty-chat-filter');
    if (emptyChatFilter) {
        emptyChatFilter.addEventListener('change', async () => {
            includeEmptyChats = emptyChatFilter.value === 'include';
            closeStudentModal();
            await loadStudentData();
        });
    }
}

/**
 * Load the current course that the instructor is in
 */
async function loadCurrentCourse() {
    try {
        console.log('Loading current course...');
        showLoadingState();
        
        // Get the current course ID using the same logic as other instructor pages
        const courseId = await getCurrentCourseId();
        
        if (!courseId) {
            throw new Error('No course found. Please complete onboarding first.');
        }
        
        console.log('Found current course ID:', courseId);
        
        // Get course details
        const response = await fetch(`/api/courses/${courseId}`, {
            method: 'GET',
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load course details: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to load course details');
        }
        
        const course = result.data;
        console.log('Found course:', course);
        
        // Set the course ID and load student data
        currentCourseId = courseId;
        currentCourseName = course.name;

        // Update course title
        const courseTitle = document.getElementById('course-title');
        if (courseTitle) {
            courseTitle.textContent = `${course.name} - Download Chats`;
        }
        
        // Load student data for the current course
        await loadStudentData();
        
    } catch (error) {
        console.error('Error loading current course:', error);
        showErrorState('Failed to load current course. Please try again.');
    }
}


/**
 * Load student data for the active scope (course or superchat bucket)
 */
async function loadStudentData() {
    try {
        const isSuperchat = currentScope.type === 'superchat';

        if (!isSuperchat && !currentCourseId) {
            console.log('No course selected');
            return;
        }

        const url = withEmptyChatsParam(isSuperchat
            ? `/api/superchats/${currentScope.superchatId}/chat-sessions`
            : `/api/students/${currentCourseId}`);

        console.log(`Loading student data for ${isSuperchat ? 'superchat' : 'course'}: ${isSuperchat ? currentScope.superchatId : currentCourseId}`);
        showLoadingState();

        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to load student data: ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.message || 'Failed to load student data');
        }

        const data = result.data;
        currentStudents = data.students || [];

        console.log(`Loaded ${currentStudents.length} students with saved chats`);

        // Update UI
        updateStudentStats(data.totalStudents, data.totalSessions);
        displayStudents(currentStudents);

        // Hide loading state
        hideLoadingState();

    } catch (error) {
        console.error('Error loading student data:', error);
        showErrorState('Failed to load student data. Please try again.');
    }
}

/**
 * Update student statistics
 * @param {number} totalStudents - Total number of students
 * @param {number} totalSessions - Total number of sessions
 */
function updateStudentStats(totalStudents, totalSessions) {
    const totalStudentsElement = document.getElementById('total-students');
    if (totalStudentsElement) {
        totalStudentsElement.textContent = totalStudents;
    }
    
    console.log(`Updated stats: ${totalStudents} students, ${totalSessions} sessions`);
}

/**
 * Display students in the UI
 * @param {Array} students - Array of student objects
 */
function displayStudents(students) {
    const studentsContainer = document.getElementById('students-container');
    const studentsList = document.getElementById('students-list');
    const emptyState = document.getElementById('empty-state');
    
    if (!studentsContainer || !studentsList || !emptyState) return;
    
    // Clear existing content
    studentsList.innerHTML = '';
    
    if (students.length === 0) {
        // Show empty state
        studentsContainer.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }
    
    // Hide empty state and show students
    emptyState.style.display = 'none';
    studentsContainer.style.display = 'block';
    
    // Show download course button if there are students
    const downloadCourseBtn = document.getElementById('download-course-btn');
    if (downloadCourseBtn) {
        downloadCourseBtn.style.display = students.length > 0 ? 'block' : 'none';
    }
    
    // Create student cards
    students.forEach(student => {
        const studentCard = createStudentCard(student);
        studentsList.appendChild(studentCard);
    });
    
    console.log(`Displayed ${students.length} students`);
}

/**
 * Download all chat sessions for all students in the course
 */
async function downloadAllCourseSessions(format = 'json', anonymized = false) {
    try {
        console.log(`Downloading all course sessions as ${format}...`);
        document.querySelectorAll('.download-dropdown-menu.open').forEach(menu => closeDownloadMenu(menu));

        if (currentStudents.length === 0) {
            alert('No students found to download.');
            return;
        }

        if (anonymized && !(await requireCompletePseudonymScope())) return;

        // Superchat scope: the export endpoint returns the whole bucket in one request
        if (currentScope.type === 'superchat') {
            await downloadSuperchatExport(format, undefined, anonymized);
            return;
        }

        // Show progress modal
        showDownloadProgress();
        const downloadStatus = document.getElementById('download-status');
        
        const allCourseData = {
            courseId: currentCourseId,
            exportDate: new Date().toISOString(),
            totalStudents: currentStudents.length,
            students: []
        };
        
        let processedStudents = 0;
        let totalSessionsCount = 0;
        
        // Iterate through all students
        for (const student of currentStudents) {
            if (downloadStatus) {
                downloadStatus.textContent = `Processing student ${processedStudents + 1} of ${currentStudents.length}: ${getStudentDisplayName(student)}`;
            }
            
            try {
                // Fetch sessions list for this student
                const sessionsResponse = await fetch(withEmptyChatsParam(`/api/students/${currentCourseId}/${student.studentId}/sessions`), {
                    method: 'GET',
                    credentials: 'include'
                });
                
                if (sessionsResponse.ok) {
                    const sessionsResult = await sessionsResponse.json();
                    if (sessionsResult.success && sessionsResult.data && sessionsResult.data.sessions) {
                        const studentSessions = sessionsResult.data.sessions;
                        const studentData = {
                            studentId: student.studentId,
                            studentName: getStudentDisplayName(student),
                            sessions: []
                        };
                        
                        // Fetch full content for each session
                        for (let i = 0; i < studentSessions.length; i++) {
                            const session = studentSessions[i];
                            if (downloadStatus) {
                                downloadStatus.textContent = `Fetching session ${i + 1}/${studentSessions.length} for ${getStudentDisplayName(student)}`;
                            }
                            
                            try {
                                const sessionResponse = await fetch(`/api/students/${currentCourseId}/${student.studentId}/sessions/${session.sessionId}`, {
                                    method: 'GET',
                                    credentials: 'include'
                                });
                                
                                if (sessionResponse.ok) {
                                    const sessionResult = await sessionResponse.json();
                                    if (sessionResult.success) {
                                        studentData.sessions.push(sessionResult.data);
                                        totalSessionsCount++;
                                    }
                                }
                            } catch (err) {
                                console.error(`Error fetching session ${session.sessionId}:`, err);
                            }
                        }
                        
                        allCourseData.students.push(studentData);
                    }
                }
            } catch (err) {
                console.error(`Error processing student ${student.studentId}:`, err);
            }
            
            processedStudents++;
            updateDownloadProgress(processedStudents, currentStudents.length);
        }
        
        // Download in chosen format
        const payload = anonymized ? anonymizeGroupedExport(allCourseData) : allCourseData;
        const suffix = anonymized ? '_Anonymized' : '';
        const baseFileName = `BiocBot_Course_${currentCourseId}_AllSessions${suffix}_${new Date().toISOString().split('T')[0]}`;
        if (format === 'txt') {
            downloadTXT(payload, `${baseFileName}.txt`);
        } else {
            downloadJSON(payload, `${baseFileName}.json`);
        }
        
        // Hide progress modal
        hideDownloadProgress();
        
        console.log(`Downloaded all course data: ${totalSessionsCount} sessions from ${processedStudents} students`);
        
    } catch (error) {
        console.error('Error downloading all course sessions:', error);
        hideDownloadProgress();
        alert('Failed to download course sessions. Please try again.');
    }
}

/**
 * Download superchat sessions via the bulk export endpoint —
 * the whole bucket, or one student when studentId is given.
 * @param {string} format - 'json' or 'txt'
 * @param {string} [studentId] - Limit the export to a single student
 */
async function downloadSuperchatExport(format, studentId, anonymized = false) {
    try {
        showDownloadProgress();
        const downloadStatus = document.getElementById('download-status');
        if (downloadStatus) downloadStatus.textContent = 'Fetching superchat sessions...';

        const params = studentId ? `?studentId=${encodeURIComponent(studentId)}` : '';
        const response = await fetch(
            withEmptyChatsParam(`/api/superchats/${currentScope.superchatId}/chat-sessions/export${params}`),
            { method: 'GET', credentials: 'include' }
        );

        if (!response.ok) {
            throw new Error(`Failed to export superchat sessions: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to export superchat sessions');
        }

        const exportData = anonymized ? anonymizeGroupedExport(result.data) : result.data;
        const dateStamp = new Date().toISOString().split('T')[0];
        let payload = exportData;
        let baseFileName = `BiocBot_Superchat_${currentScope.name}_AllSessions_${dateStamp}`;

        if (studentId) {
            // Flatten the single-student export so it matches the per-student combined shape
            const student = (exportData.students && exportData.students[0]) || { sessions: [] };
            payload = {
                ...(anonymized
                    ? { student: student.student || 'Unknown' }
                    : { studentName: student.studentName || 'Unknown Student' }),
                superchatId: exportData.superchatId,
                superchatName: exportData.superchatName,
                totalSessions: student.sessions.length,
                exportDate: exportData.exportDate,
                sessions: student.sessions
            };
            baseFileName = `BiocBot_Superchat_${currentScope.name}_${anonymized ? payload.student : payload.studentName}_${dateStamp}`;
        }

        if (anonymized) baseFileName += '_Anonymized';

        if (format === 'txt') {
            downloadTXT(payload, `${baseFileName}.txt`);
        } else {
            downloadJSON(payload, `${baseFileName}.json`);
        }

        hideDownloadProgress();
    } catch (error) {
        console.error('Error downloading superchat export:', error);
        hideDownloadProgress();
        alert('Failed to download superchat sessions. Please try again.');
    }
}

/**
 * Helper to get display name from student object safely
 */
function getStudentDisplayName(student) {
    if (!student || !student.studentName) return 'Unknown Student';
    if (typeof student.studentName === 'string') return student.studentName;
    return student.studentName.displayName || student.studentName.name || 'Unknown Student';
}

function pseudonymScopeDetails() {
    return currentScope.type === 'superchat'
        ? { type: 'superchat', id: currentScope.superchatId }
        : { type: 'course', id: currentCourseId };
}

async function requireCompletePseudonymScope() {
    const scope = pseudonymScopeDetails();
    try {
        const response = await fetch(
            `/api/student-pseudonyms/${scope.type}/${encodeURIComponent(scope.id)}`,
            { credentials: 'include' }
        );
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || `HTTP ${response.status}`);

        if (!result.data.complete) {
            const count = result.data.missingStudentIds.length;
            const goToHub = confirm(
                `Anonymized download blocked: ${count} student${count === 1 ? '' : 's'} still need a four-character ID. ` +
                'Generate the missing IDs in Student Hub before downloading. Open Student Hub now?'
            );
            if (goToHub) {
                const params = new URLSearchParams({ pseudonymScope: scope.type, pseudonymScopeId: scope.id });
                if (currentCourseId) params.set('courseId', currentCourseId);
                window.location.assign(`/instructor/student-hub?${params.toString()}`);
            }
            return false;
        }

        activePseudonymMappings = new Map(
            result.data.mappings.map(mapping => [String(mapping.studentId), mapping.student])
        );
        return true;
    } catch (error) {
        console.error('Could not verify anonymization IDs:', error);
        alert(`Could not verify anonymization IDs: ${error.message}`);
        return false;
    }
}

const ANONYMIZED_EXPORT_KEYS = new Set([
    'studentId', 'studentName', 'username', 'email', 'puid', 'academicStudentId', '_id'
]);

function stripExportIdentifiers(value) {
    if (Array.isArray(value)) return value.map(stripExportIdentifiers);
    if (!value || typeof value !== 'object') return value;
    const clean = {};
    Object.entries(value).forEach(([key, child]) => {
        if (!ANONYMIZED_EXPORT_KEYS.has(key)) clean[key] = stripExportIdentifiers(child);
    });
    return clean;
}

function anonymizeStudentExport(student, mappings = activePseudonymMappings) {
    const pseudonym = mappings.get(String(student.studentId));
    if (!pseudonym) throw new Error(`No anonymization ID exists for ${student.studentId}`);
    return { student: pseudonym, ...stripExportIdentifiers(student) };
}

function anonymizeGroupedExport(data, mappings = activePseudonymMappings) {
    return {
        ...stripExportIdentifiers(data),
        students: (data.students || []).map(student => anonymizeStudentExport(student, mappings))
    };
}

/**
 * Create a student card element
 * @param {Object} student - Student object
 * @returns {HTMLElement} Student card element
 */
function createStudentCard(student) {
    console.log('🔍 [CREATE_CARD] Student data:', student);
    console.log('🔍 [CREATE_CARD] studentName type:', typeof student.studentName);
    console.log('🔍 [CREATE_CARD] studentName value:', student.studentName);
    
    // Handle missing or invalid student name
    let studentName = 'Unknown Student';
    
    if (student.studentName) {
        if (typeof student.studentName === 'string') {
            studentName = student.studentName;
        } else if (typeof student.studentName === 'object') {
            // If it's an object, try to extract the name from common fields
            studentName = student.studentName.displayName || 
                         student.studentName.name || 
                         student.studentName.studentName || 
                         'Unknown Student';
        }
    }
    
    const firstLetter = studentName && typeof studentName === 'string' ? studentName.charAt(0).toUpperCase() : '?';
    
    const card = document.createElement('div');
    card.className = 'student-card';
    card.innerHTML = `
        <div class="student-info">
            <div class="student-avatar">${firstLetter}</div>
            <div class="student-details">
                <h3 class="student-name">${studentName}</h3>
                <p class="student-id">ID: ${student.studentId}</p>
                <p class="student-stats">${student.totalSessions} saved chat${student.totalSessions !== 1 ? 's' : ''}</p>
            </div>
        </div>
        <div class="student-actions">
            <button class="btn-primary" onclick="viewStudentSessions('${student.studentId}', '${studentName.replace(/'/g, "\\'")}')">
                View Sessions
            </button>
        </div>
    `;
    
    return card;
}

/**
 * View sessions for a specific student
 * @param {string} studentId - Student ID
 * @param {string} studentName - Student name
 */
async function viewStudentSessions(studentId, studentName) {
    try {
        console.log(`Loading sessions for student: ${studentName} (${studentId})`);

        // Superchat scope: session metadata (incl. studentId) is already in the listing
        if (currentScope.type === 'superchat') {
            const student = currentStudents.find(s => s.studentId === studentId);
            currentStudentSessions = (student && student.sessions) || [];
            showStudentModal(studentName, studentId, currentScope.name, currentStudentSessions);
            return;
        }

        if (!currentCourseId) {
            console.error('No course selected');
            return;
        }

        const response = await fetch(withEmptyChatsParam(`/api/students/${currentCourseId}/${studentId}/sessions`), {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to load student sessions: ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.message || 'Failed to load student sessions');
        }

        const data = result.data;
        currentStudentSessions = data.sessions || [];

        console.log(`Loaded ${currentStudentSessions.length} sessions for student ${studentName}`);

        // Show modal with sessions
        showStudentModal(studentName, data.studentName, currentCourseId, currentStudentSessions);

    } catch (error) {
        console.error('Error loading student sessions:', error);
        alert('Failed to load student sessions. Please try again.');
    }
}

/**
 * Show the student modal with sessions
 * @param {string} studentName - Student name
 * @param {string} studentUsername - Student username/ID
 * @param {string} courseName - Course name
 * @param {Array} sessions - Array of session objects
 */
function showStudentModal(studentName, studentUsername, courseName, sessions) {
    const modal = document.getElementById('student-modal');
    const modalTitle = document.getElementById('student-modal-title');
    const studentAvatar = document.getElementById('student-avatar');
    const studentNameElement = document.getElementById('student-name');
    const studentUsernameElement = document.getElementById('student-username');
    const studentCourseElement = document.getElementById('student-course');
    const sessionsList = document.getElementById('sessions-list');
    const downloadAllBtn = document.getElementById('download-all-btn');
    
    if (!modal) return;
    
    // Update modal content
    if (modalTitle) modalTitle.textContent = `${studentName}'s Chat Sessions`;
    if (studentAvatar) studentAvatar.textContent = studentName.charAt(0).toUpperCase();
    if (studentNameElement) studentNameElement.textContent = studentName;
    if (studentUsernameElement) studentUsernameElement.textContent = `@${studentUsername}`;
    if (studentCourseElement) studentCourseElement.textContent = courseName;
    
    // Clear and populate sessions list
    if (sessionsList) {
        sessionsList.innerHTML = '';
        
        if (sessions.length === 0) {
            sessionsList.innerHTML = '<p class="no-sessions">No saved chat sessions found.</p>';
        } else {
            sessions.forEach(session => {
                const sessionElement = createSessionElement(session);
                sessionsList.appendChild(sessionElement);
            });
        }
    }
    
    // Show/hide download all button
    if (downloadAllBtn) {
        downloadAllBtn.style.display = sessions.length > 0 ? 'block' : 'none';
    }
    
    // Show modal
    modal.style.display = 'block';
    a11yModal.open(modal, { onRequestClose: closeStudentModal });
}

/**
 * Create a session element
 * @param {Object} session - Session object
 * @returns {HTMLElement} Session element
 */
function createSessionElement(session) {
    const sessionDiv = document.createElement('div');
    sessionDiv.className = 'session-item-wrapper';

    const savedDate = session.savedAt ? new Date(session.savedAt).toLocaleDateString() : 'Unknown date';
    const savedTime = session.savedAt ? new Date(session.savedAt).toLocaleTimeString() : 'Unknown time';
    const previewId = `preview-${session.sessionId}`;

    sessionDiv.innerHTML = `
        <div class="session-item">
            <div class="session-info">
                <h4 class="session-title">${session.title}</h4>
                <p class="session-details">
                    ${session.unitName ? `Unit: ${session.unitName} | ` : ''}Messages: ${session.messageCount} |
                    Duration: ${session.duration}
                </p>
                <p class="session-date">Saved: ${savedDate} at ${savedTime}</p>
            </div>
            <div class="session-actions">
                <button class="btn-outline" onclick="toggleChatPreview('${session.sessionId}', '${session.studentId}')">
                    Preview Chat
                </button>
                <div class="download-dropdown">
                    <button class="btn-secondary download-dropdown-toggle" onclick="toggleDownloadMenu(event, '${session.sessionId}')" aria-expanded="false" aria-haspopup="menu">
                        Download &#9662;
                    </button>
                    <div class="download-dropdown-menu" id="download-menu-${session.sessionId}">
                        <button onclick="downloadSession('${session.sessionId}', 'json')">Download JSON</button>
                        <button onclick="downloadSession('${session.sessionId}', 'json', true)">Download anonymized JSON</button>
                        <button onclick="downloadSession('${session.sessionId}', 'txt')">Download TXT</button>
                        <button onclick="downloadSession('${session.sessionId}', 'txt', true)">Download anonymized TXT</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="chat-preview" id="${previewId}" style="display: none;">
            <div class="chat-preview-loading">Loading chat preview...</div>
        </div>
    `;

    return sessionDiv;
}

/**
 * Toggle download dropdown menu
 */
function toggleDownloadMenu(event, sessionId) {
    event.stopPropagation();
    const toggle = event.currentTarget;
    // Close all other open menus
    document.querySelectorAll('.download-dropdown-menu.open').forEach(menu => {
        if (menu.id !== `download-menu-${sessionId}`) {
            closeDownloadMenu(menu);
        }
    });
    const menu = document.getElementById(`download-menu-${sessionId}`);
    if (menu) {
        const isOpen = menu.classList.toggle('open');
        toggle.setAttribute('aria-haspopup', 'menu');
        toggle.setAttribute('aria-expanded', String(isOpen));
    }
}

function closeDownloadMenu(menu, returnFocus = false) {
    if (!menu.classList.contains('open')) return;
    menu.classList.remove('open');
    const toggle = menu.previousElementSibling;
    toggle?.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle?.focus();
}

// Close dropdown menus when clicking outside
document.addEventListener('click', () => {
    document.querySelectorAll('.download-dropdown-menu.open').forEach(menu => {
        closeDownloadMenu(menu);
    });
});

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.download-dropdown-menu.open').forEach(menu => closeDownloadMenu(menu, true));
});

document.addEventListener('focusout', (event) => {
    const dropdown = event.target.closest('.download-dropdown');
    if (!dropdown) return;
    requestAnimationFrame(() => {
        if (!dropdown.contains(document.activeElement)) {
            dropdown.querySelectorAll('.download-dropdown-menu.open').forEach(menu => closeDownloadMenu(menu));
        }
    });
});

/**
 * Toggle inline chat preview for a session
 */
async function toggleChatPreview(sessionId, studentId) {
    const previewDiv = document.getElementById(`preview-${sessionId}`);
    if (!previewDiv) return;

    // If already visible, collapse it
    if (previewDiv.style.display !== 'none') {
        previewDiv.style.display = 'none';
        return;
    }

    // Show and load if not yet loaded
    previewDiv.style.display = 'block';

    if (previewDiv.dataset.loaded === 'true') return;

    try {
        const url = currentScope.type === 'superchat'
            ? `/api/superchats/${currentScope.superchatId}/chat-sessions/${studentId}/${sessionId}`
            : `/api/students/${currentCourseId}/${studentId}/sessions/${sessionId}`;
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) throw new Error(`Failed to load session: ${response.status}`);

        const result = await response.json();
        if (!result.success) throw new Error(result.message || 'Failed to load session');

        const sessionData = result.data;
        const messages = sessionData.chatData?.messages || sessionData.chatData || sessionData.messages || [];
        const msgArray = Array.isArray(messages) ? messages : [];
        const previewMessages = msgArray.slice(0, 20);

        if (previewMessages.length === 0) {
            previewDiv.innerHTML = '<p class="chat-preview-empty">No messages in this session.</p>';
        } else {
            let html = '<div class="chat-preview-messages">';
            previewMessages.forEach(msg => {
                const role = getMsgRole(msg);
                const displayRole = role === 'bot' ? 'BiocBot' : 'Student';
                const roleClass = role === 'bot' ? 'bot' : 'user';
                const rawContent = msg.content || msg.text || msg.message || '';
                const cleanContent = stripHtml(rawContent);
                html += `
                    <div class="chat-preview-msg ${roleClass}">
                        <span class="chat-preview-role">${displayRole}</span>
                        <p class="chat-preview-content">${escapeHtml(cleanContent)}</p>
                    </div>
                `;
            });
            if (msgArray.length > 20) {
                html += `<p class="chat-preview-more">Showing 20 of ${msgArray.length} messages. Download for full chat.</p>`;
            }
            html += '</div>';
            previewDiv.innerHTML = html;
        }

        previewDiv.dataset.loaded = 'true';

    } catch (error) {
        console.error('Error loading chat preview:', error);
        previewDiv.innerHTML = '<p class="chat-preview-error">Failed to load chat preview.</p>';
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Strip HTML tags from a string and return plain text
 */
function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
}

/**
 * Get display role from a message object
 * Messages use `type` field with values 'user' or 'bot'
 */
function getMsgRole(msg) {
    const t = msg.type || msg.role || msg.sender || 'unknown';
    if (t === 'bot' || t === 'assistant') return 'bot';
    if (t === 'user') return 'user';
    return 'unknown';
}

/**
 * Strip HTML for plain text export
 */
function stripHtmlForText(html) {
    // Server-side safe: no DOM available in some contexts, but this runs in browser
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || div.innerText || '').trim();
}

/**
 * Return a copy of a messages array sorted oldest-first (chronological).
 * Ordering is stable: messages with an equal or missing timestamp keep their
 * existing relative order, and if any message lacks a usable timestamp the
 * original order (already chronological insertion order) is preserved.
 * @param {Array} messages - Array of message objects
 * @returns {Array} Chronologically ordered messages
 */
function sortMessagesChronologically(messages) {
    if (!Array.isArray(messages) || messages.length < 2) {
        return messages;
    }

    const withTimes = messages.map((msg, index) => {
        const raw = msg && (msg.timestamp || msg.time || msg.createdAt);
        const value = raw ? new Date(raw).getTime() : NaN;
        return { msg, index, value };
    });

    if (withTimes.some(entry => isNaN(entry.value))) {
        return messages;
    }

    withTimes.sort((a, b) => (a.value - b.value) || (a.index - b.index));
    return withTimes.map(entry => entry.msg);
}

/**
 * Return a deep copy of export data with every message array normalized to
 * chronological (oldest-first) order, regardless of export shape (single
 * session, per-student combined, or course/superchat-wide).
 * @param {Object} data - Chat export data
 * @returns {Object} Normalized copy
 */
function normalizeChatExportOrder(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }

    let clone;
    try {
        clone = JSON.parse(JSON.stringify(data));
    } catch (error) {
        // If the data can't be safely cloned, fall back to the original
        return data;
    }

    const sortSession = (session) => {
        if (!session || typeof session !== 'object') return;
        if (session.chatData && Array.isArray(session.chatData.messages)) {
            session.chatData.messages = sortMessagesChronologically(session.chatData.messages);
        } else if (Array.isArray(session.messages)) {
            session.messages = sortMessagesChronologically(session.messages);
        }
    };

    // Course / superchat-wide export: students[].sessions[]
    if (Array.isArray(clone.students)) {
        clone.students.forEach(student => {
            if (Array.isArray(student.sessions)) {
                student.sessions.forEach(sortSession);
            }
        });
    }

    // Combined single-student export: sessions[]
    if (Array.isArray(clone.sessions)) {
        clone.sessions.forEach(sortSession);
    }

    // Single session export: messages[]
    if (Array.isArray(clone.messages)) {
        clone.messages = sortMessagesChronologically(clone.messages);
    }

    return clone;
}

/**
 * Download a specific session
 * @param {string} sessionId - Session ID to download
 * @param {string} format - Download format: 'json' or 'txt'
 */
async function downloadSession(sessionId, format = 'json', anonymized = false) {
    try {
        console.log(`Downloading session: ${sessionId} as ${format}`);

        // Close any open dropdown menus
        document.querySelectorAll('.download-dropdown-menu.open').forEach(menu => closeDownloadMenu(menu));

        const isSuperchat = currentScope.type === 'superchat';

        if (!isSuperchat && !currentCourseId) {
            console.error('No course selected');
            return;
        }

        // Find the student ID from current sessions
        const session = currentStudentSessions.find(s => s.sessionId === sessionId);
        if (!session) {
            console.error('Session not found for sessionId:', sessionId);
            return;
        }

        if (anonymized && !(await requireCompletePseudonymScope())) return;

        const url = isSuperchat
            ? `/api/superchats/${currentScope.superchatId}/chat-sessions/${session.studentId}/${sessionId}`
            : `/api/students/${currentCourseId}/${session.studentId}/sessions/${sessionId}`;
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to download session: ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.message || 'Failed to download session');
        }

        const sessionData = result.data;
        const pseudonym = anonymized ? activePseudonymMappings.get(String(session.studentId)) : null;
        if (anonymized && !pseudonym) throw new Error('This student does not have an anonymization ID');
        const chatData = anonymized
            ? { student: pseudonym, ...stripExportIdentifiers(sessionData.chatData) }
            : sessionData.chatData;
        const scopeLabel = isSuperchat ? `Superchat_${currentScope.name}` : sessionData.courseId;
        const identityLabel = anonymized ? pseudonym : sessionData.studentName;
        const anonSuffix = anonymized ? '_Anonymized' : '';
        const baseFileName = `BiocBot_Chat_${scopeLabel}_${identityLabel}${anonSuffix}_${new Date(sessionData.savedAt).toISOString().split('T')[0]}`;

        if (format === 'txt') {
            downloadTXT(chatData, `${baseFileName}.txt`);
        } else {
            downloadJSON(chatData, `${baseFileName}.json`);
        }

        console.log(`Downloaded session: ${baseFileName}.${format}`);

    } catch (error) {
        console.error('Error downloading session:', error);
        alert('Failed to download session. Please try again.');
    }
}

/**
 * Download all sessions for the current student
 */
async function downloadAllSessions(format = 'json', anonymized = false) {
    try {
        console.log(`Downloading all sessions for current student as ${format}`);
        document.querySelectorAll('.download-dropdown-menu.open').forEach(menu => closeDownloadMenu(menu));

        if (currentStudentSessions.length === 0) {
            alert('No sessions to download.');
            return;
        }

        if (anonymized && !(await requireCompletePseudonymScope())) return;

        // Superchat scope: the export endpoint returns every session in one request
        if (currentScope.type === 'superchat') {
            await downloadSuperchatExport(format, currentStudentSessions[0].studentId, anonymized);
            return;
        }

        // Show progress modal
        showDownloadProgress();
        
        const allSessionsData = [];
        
        // Download each session
        for (let i = 0; i < currentStudentSessions.length; i++) {
            const session = currentStudentSessions[i];
            
            try {
                const response = await fetch(`/api/students/${currentCourseId}/${session.studentId}/sessions/${session.sessionId}`, {
                    method: 'GET',
                    credentials: 'include'
                });
                
                if (response.ok) {
                    const result = await response.json();
                    if (result.success) {
                        allSessionsData.push(result.data);
                    }
                }
                
                // Update progress
                updateDownloadProgress(i + 1, currentStudentSessions.length);
                
            } catch (error) {
                console.error(`Error downloading session ${session.sessionId}:`, error);
            }
        }
        
        // Create combined JSON file
        const combinedData = {
            studentName: allSessionsData[0]?.studentName || 'Unknown Student',
            courseId: currentCourseId,
            totalSessions: allSessionsData.length,
            exportDate: new Date().toISOString(),
            sessions: allSessionsData
        };
        
        const studentId = currentStudentSessions[0].studentId;
        const pseudonym = anonymized ? activePseudonymMappings.get(String(studentId)) : null;
        if (anonymized && !pseudonym) throw new Error('This student does not have an anonymization ID');
        const payload = anonymized
            ? { student: pseudonym, ...stripExportIdentifiers(combinedData) }
            : combinedData;
        const identityLabel = anonymized ? pseudonym : combinedData.studentName;
        const anonSuffix = anonymized ? '_Anonymized' : '';
        const baseFileName = `BiocBot_AllSessions_${currentCourseId}_${identityLabel}${anonSuffix}_${new Date().toISOString().split('T')[0]}`;

        if (format === 'txt') {
            downloadTXT(payload, `${baseFileName}.txt`);
        } else {
            downloadJSON(payload, `${baseFileName}.json`);
        }
        
        // Hide progress modal
        hideDownloadProgress();
        
        console.log(`Downloaded ${allSessionsData.length} sessions: ${baseFileName}.${format}`);
        
    } catch (error) {
        console.error('Error downloading all sessions:', error);
        hideDownloadProgress();
        alert('Failed to download sessions. Please try again.');
    }
}

/**
 * Download JSON data as a file
 * @param {Object} data - Data to download
 * @param {string} fileName - Name of the file
 */
function downloadJSON(data, fileName) {
    const jsonString = JSON.stringify(normalizeChatExportOrder(data), null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Format chat data as readable plain text
 * @param {Object} data - Chat session data (single session or combined)
 * @returns {string} Formatted text
 */
function formatChatAsText(data) {
    let lines = [];

    // If it's a course/superchat-wide export with multiple students
    if (data.students) {
        if (data.superchatName) {
            lines.push(`Superchat Chat Export - ${data.superchatName}`);
        } else {
            lines.push(`Course Chat Export - ${data.courseId}`);
        }
        lines.push(`Export Date: ${new Date(data.exportDate).toLocaleString()}`);
        lines.push(`Total Students: ${data.totalStudents}`);
        lines.push('='.repeat(60));
        lines.push('');

        data.students.forEach(student => {
            lines.push(`Student: ${student.student || student.studentName}`);
            if (student.studentId) lines.push(`Student ID: ${student.studentId}`);
            lines.push('-'.repeat(40));

            student.sessions.forEach(session => {
                lines.push(...formatSingleSessionText(session));
                lines.push('');
            });

            lines.push('='.repeat(60));
            lines.push('');
        });

        return lines.join('\n');
    }

    // If it's a combined export for one student (multiple sessions)
    if (data.sessions && Array.isArray(data.sessions)) {
        lines.push(`Student: ${data.student || data.studentName}`);
        if (data.superchatName) {
            lines.push(`Superchat: ${data.superchatName}`);
        } else {
            lines.push(`Course: ${data.courseId}`);
        }
        lines.push(`Export Date: ${new Date(data.exportDate).toLocaleString()}`);
        lines.push(`Total Sessions: ${data.totalSessions}`);
        lines.push('='.repeat(60));
        lines.push('');

        data.sessions.forEach(session => {
            lines.push(...formatSingleSessionText(session));
            lines.push('');
        });

        return lines.join('\n');
    }

    // Single session chat data (just messages)
    if (data.messages || Array.isArray(data)) {
        const messages = data.messages || data;
        if (data.student) lines.push(`Student: ${data.student}`);
        lines.push(`Chat Session`);
        lines.push('-'.repeat(40));
        messages.forEach(msg => {
            const role = getMsgRole(msg) === 'bot' ? 'BIOCBOT' : 'STUDENT';
            const timestamp = msg.timestamp ? ` [${new Date(msg.timestamp).toLocaleString()}]` : '';
            const rawContent = msg.content || msg.text || msg.message || '';
            lines.push(`${role}${timestamp}:`);
            lines.push(stripHtmlForText(rawContent));
            lines.push('');
        });
        return lines.join('\n');
    }

    // Fallback: just stringify
    return JSON.stringify(data, null, 2);
}

/**
 * Format a single session object as text lines
 * @param {Object} session - Session object with chatData/messages
 * @returns {string[]} Array of text lines
 */
function formatSingleSessionText(session) {
    const lines = [];
    const title = session.title || session.sessionTitle || 'Untitled Session';
    const unit = session.unitName || session.unit || '';
    const savedAt = session.savedAt ? new Date(session.savedAt).toLocaleString() : 'Unknown';
    const duration = session.duration || '';

    lines.push(`  Session: ${title}`);
    if (unit) lines.push(`  Unit: ${unit}`);
    lines.push(`  Saved: ${savedAt}`);
    if (duration) lines.push(`  Duration: ${duration}`);
    lines.push('  ' + '-'.repeat(36));

    const messages = session.chatData?.messages || session.chatData || session.messages || [];
    const msgArray = Array.isArray(messages) ? messages : [];

    msgArray.forEach(msg => {
        const role = getMsgRole(msg) === 'bot' ? 'BIOCBOT' : 'STUDENT';
        const timestamp = msg.timestamp ? ` [${new Date(msg.timestamp).toLocaleString()}]` : '';
        const rawContent = msg.content || msg.text || msg.message || '';
        lines.push(`  ${role}${timestamp}:`);
        lines.push(`  ${stripHtmlForText(rawContent)}`);
        lines.push('');
    });

    return lines;
}

/**
 * Download data as a TXT file
 * @param {Object} data - Data to format and download
 * @param {string} fileName - Name of the file (will replace .json with .txt)
 */
function downloadTXT(data, fileName) {
    const textContent = formatChatAsText(normalizeChatExportOrder(data));
    const blob = new Blob([textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.replace(/\.json$/, '.txt');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Show download progress modal
 */
function showDownloadProgress() {
    const modal = document.getElementById('download-modal');
    if (modal) {
        modal.style.display = 'block';
        a11yModal.open(modal, { escapable: false });
    }
}

/**
 * Hide download progress modal
 */
function hideDownloadProgress() {
    const modal = document.getElementById('download-modal');
    if (modal) {
        a11yModal.close(modal);
        modal.style.display = 'none';
    }
}

/**
 * Update download progress
 * @param {number} current - Current progress
 * @param {number} total - Total items
 */
function updateDownloadProgress(current, total) {
    const progressFill = document.getElementById('progress-fill');
    const downloadStatus = document.getElementById('download-status');
    
    if (progressFill) {
        const percentage = (current / total) * 100;
        progressFill.style.width = `${percentage}%`;
        const progressBar = progressFill.closest('.progress-bar');
        progressBar?.setAttribute('aria-valuenow', String(current));
        progressBar?.setAttribute('aria-valuemin', '0');
        progressBar?.setAttribute('aria-valuemax', String(total));
    }
    
    if (downloadStatus) {
        downloadStatus.textContent = `Downloading session ${current} of ${total}...`;
    }
}

/**
 * Close the student modal
 */
function closeStudentModal() {
    const modal = document.getElementById('student-modal');
    if (modal) {
        a11yModal.close(modal);
        modal.style.display = 'none';
    }
}

/**
 * Clear student data and reset UI
 */
function clearStudentData() {
    currentStudents = [];
    currentStudentSessions = [];
    
    const studentsContainer = document.getElementById('students-container');
    const emptyState = document.getElementById('empty-state');
    
    if (studentsContainer) studentsContainer.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    
    updateStudentStats(0, 0);
}

/**
 * Show loading state
 */
function showLoadingState() {
    const loadingState = document.getElementById('loading-state');
    const errorState = document.getElementById('error-state');
    const studentsContainer = document.getElementById('students-container');
    const emptyState = document.getElementById('empty-state');
    
    if (loadingState) loadingState.style.display = 'block';
    if (errorState) errorState.style.display = 'none';
    if (studentsContainer) studentsContainer.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
}

/**
 * Hide loading state
 */
function hideLoadingState() {
    const loadingState = document.getElementById('loading-state');
    if (loadingState) {
        loadingState.style.display = 'none';
    }
}

/**
 * Show error state
 * @param {string} message - Error message to display
 */
function showErrorState(message) {
    const loadingState = document.getElementById('loading-state');
    const errorState = document.getElementById('error-state');
    const errorMessage = document.getElementById('error-message');
    
    if (loadingState) loadingState.style.display = 'none';
    if (errorState) errorState.style.display = 'block';
    if (errorMessage) errorMessage.textContent = message;
}

/**
 * Handle logout
 */
function handleLogout() {
    // Redirect to login page
    window.location.href = '/login';
}

/* ------------------------------------------------------------------ *
 * Export change log
 *
 * The curated log of changes that affect what a downloaded chat contains
 * (src/data/export-change-log.json). Shown in a modal here and downloadable as
 * Markdown with the instructor export guide appended.
 * ------------------------------------------------------------------ */

// Fetched once per page load; the log only changes on deploy.
let changeLogCache = null;

/**
 * Open the change log modal, loading its content on first open
 */
async function openChangeLogModal() {
    const modal = document.getElementById('changelog-modal');
    if (!modal) return;

    modal.style.display = 'block';
    a11yModal.open(modal, { onRequestClose: closeChangeLogModal });

    await loadChangeLog();
}

/**
 * Close the change log modal
 */
function closeChangeLogModal() {
    const modal = document.getElementById('changelog-modal');
    if (modal) {
        a11yModal.close(modal);
        modal.style.display = 'none';
    }
}

/**
 * Fetch the change log and render it into the modal
 */
async function loadChangeLog() {
    const loadingElement = document.getElementById('changelog-loading');
    const errorElement = document.getElementById('changelog-error');
    const bodyElement = document.getElementById('changelog-body');

    if (changeLogCache) {
        renderChangeLog(changeLogCache);
        return;
    }

    if (loadingElement) loadingElement.style.display = 'block';
    if (errorElement) errorElement.style.display = 'none';
    if (bodyElement) bodyElement.style.display = 'none';

    try {
        const response = await fetch('/api/export-change-log', { credentials: 'include' });
        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.message || `Request failed with status ${response.status}`);
        }

        changeLogCache = result.data;
        renderChangeLog(result.data);
    } catch (error) {
        console.error('Error loading export change log:', error);
        if (loadingElement) loadingElement.style.display = 'none';
        if (errorElement) {
            errorElement.textContent = 'Unable to load the change log. Please try again.';
            errorElement.style.display = 'block';
        }
    }
}

/**
 * Render the change log document into the modal
 * @param {Object} changeLog - Change log returned by the API
 */
function renderChangeLog(changeLog) {
    const loadingElement = document.getElementById('changelog-loading');
    const errorElement = document.getElementById('changelog-error');
    const bodyElement = document.getElementById('changelog-body');
    const updatedElement = document.getElementById('changelog-updated');
    const introElement = document.getElementById('changelog-intro');
    const entriesElement = document.getElementById('changelog-entries');

    if (loadingElement) loadingElement.style.display = 'none';
    if (errorElement) errorElement.style.display = 'none';

    if (updatedElement) {
        updatedElement.textContent = changeLog.lastUpdated
            ? `Last updated ${changeLog.lastUpdated}`
            : '';
    }

    if (introElement) {
        introElement.innerHTML = '';
        (changeLog.intro || []).forEach(paragraph => {
            const p = document.createElement('p');
            p.textContent = paragraph;
            introElement.appendChild(p);
        });
    }

    if (entriesElement) {
        entriesElement.innerHTML = '';
        (changeLog.entries || []).forEach(entry => {
            entriesElement.appendChild(createChangeLogEntry(entry));
        });
    }

    if (bodyElement) bodyElement.style.display = 'block';
}

/**
 * Build the element for a single change log entry
 * @param {Object} entry - Change log entry
 * @returns {HTMLElement} Entry element
 */
function createChangeLogEntry(entry) {
    const article = document.createElement('article');
    article.className = 'changelog-entry';

    const heading = document.createElement('h3');
    heading.textContent = entry.title;
    article.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'changelog-meta';
    meta.textContent = entry.area ? `${entry.date} · ${entry.area}` : entry.date;
    article.appendChild(meta);

    const summary = document.createElement('p');
    summary.textContent = entry.summary;
    article.appendChild(summary);

    if (entry.exportImpact) {
        article.appendChild(createLabelledParagraph('What you see in exports now:', entry.exportImpact));
    }
    if (entry.beforeThisChange) {
        article.appendChild(createLabelledParagraph('In exports of earlier sessions:', entry.beforeThisChange));
    }
    if (Array.isArray(entry.references) && entry.references.length > 0) {
        const references = createLabelledParagraph('Reference:', entry.references.join(', '));
        references.classList.add('changelog-references');
        article.appendChild(references);
    }

    return article;
}

/**
 * Build a paragraph with a bold lead-in label
 * @param {string} label - Bold label text
 * @param {string} text - Body text
 * @returns {HTMLElement} Paragraph element
 */
function createLabelledParagraph(label, text) {
    const paragraph = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = label;
    paragraph.appendChild(strong);
    paragraph.appendChild(document.createTextNode(` ${text}`));
    return paragraph;
}

/**
 * Download the change log (plus the export guide) as a Markdown file
 */
async function downloadChangeLogMarkdown() {
    const button = document.getElementById('changelog-download-btn');
    if (button) button.disabled = true;

    try {
        const response = await fetch('/api/export-change-log/markdown', { credentials: 'include' });
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        const markdown = await response.text();
        const fileName = parseFileNameFromResponse(response) || 'biocbot-chat-export-change-log.md';
        const blob = new Blob([markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Error downloading export change log:', error);
        showNotification('Unable to download the change log. Please try again.', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

/**
 * Read the server-provided file name from a Content-Disposition header
 * @param {Response} response - Fetch response
 * @returns {string|null} File name, or null when the header is absent
 */
function parseFileNameFromResponse(response) {
    const header = response.headers.get('Content-Disposition') || '';
    const match = header.match(/filename="?([^"';]+)"?/i);
    return match ? match[1] : null;
}

// Make functions globally available
window.viewStudentSessions = viewStudentSessions;
window.downloadSession = downloadSession;
window.downloadAllSessions = downloadAllSessions;
window.downloadAllCourseSessions = downloadAllCourseSessions;
window.closeStudentModal = closeStudentModal;
window.toggleDownloadMenu = toggleDownloadMenu;
window.toggleChatPreview = toggleChatPreview;
window.openChangeLogModal = openChangeLogModal;
window.closeChangeLogModal = closeChangeLogModal;
window.downloadChangeLogMarkdown = downloadChangeLogMarkdown;
