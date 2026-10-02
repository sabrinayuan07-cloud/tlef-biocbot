/**
 * Home Page JavaScript
 * Handles instructor dashboard functionality and interactions
 */

let anonymizeStudentsEnabled = false;
let canBypassInstructorCourseCodes = false;
let selectedCourseRequiresInstructorCode = true;
// Pinned courseId during a setSelectedCourse cascade. Subroutines call
// getSelectedCourseId() which would otherwise re-read localStorage on every
// invocation — and a concurrent test (or another tab) can mutate that storage
// mid-cascade, causing per-course fetches to fire against a stale course.
let _pinnedCourseId = null;

// Sentinel courseId for the cross-course "Super Chat" struggle view. Selecting
// it in the course dropdown shows Super Chat struggles aggregated across ALL
// courses (source: 'superCourse') instead of a single course's data.
const SUPER_COURSE_FILTER_ID = '__super_course__';
// Per-bucket filter ids look like "__super_course__::<superchatId>". The bare
// sentinel means "all buckets" (legacy/global aggregate).
const SUPER_COURSE_BUCKET_PREFIX = `${SUPER_COURSE_FILTER_ID}::`;

function isSuperCourseSelected() {
    const id = getSelectedCourseId();
    return id === SUPER_COURSE_FILTER_ID || (typeof id === 'string' && id.startsWith(SUPER_COURSE_BUCKET_PREFIX));
}

// Extract the superchatId from a per-bucket filter id, or '' for the all-buckets view.
function selectedSuperchatId() {
    const id = getSelectedCourseId();
    return (typeof id === 'string' && id.startsWith(SUPER_COURSE_BUCKET_PREFIX))
        ? id.slice(SUPER_COURSE_BUCKET_PREFIX.length)
        : '';
}

function superCourseQuerySuffix() {
    const scId = selectedSuperchatId();
    return scId ? `&superchatId=${encodeURIComponent(scId)}` : '';
}

// Resolve the struggle-activity endpoints, swapping in the cross-course
// aggregate routes when the Super Chat filter is active.
function struggleActivityEndpoint(limit) {
    return isSuperCourseSelected()
        ? `/api/struggle-activity/super-course?limit=${limit}${superCourseQuerySuffix()}`
        : `/api/struggle-activity/${getSelectedCourseId()}?limit=${limit}`;
}

function weeklyStruggleEndpoint(weeks) {
    return isSuperCourseSelected()
        ? `/api/struggle-activity/super-course/weekly?weeks=${weeks}${superCourseQuerySuffix()}`
        : `/api/struggle-activity/weekly/${getSelectedCourseId()}?weeks=${weeks}`;
}

document.addEventListener('DOMContentLoaded', function() {
    // Two racers can start the page: the auth:ready event and a 500ms fallback
    // timer. When auth resolves in under 500ms — the common case — both fire, so
    // initializeHomePage() must guard against running twice. A second run
    // re-registers every listener and re-enters setSelectedCourse(), whose
    // hideCourseSelector() call slams the course selector shut underneath an
    // instructor who has already opened it.
    let homePageInitialized = false;
    let initFallbackTimer = null;

    function tryInitialize() {
        if (homePageInitialized) {
            return true;
        }
        if (typeof getCurrentInstructorId === 'function' && getCurrentInstructorId()) {
            homePageInitialized = true;
            if (initFallbackTimer !== null) {
                clearTimeout(initFallbackTimer);
                initFallbackTimer = null;
            }
            initializeHomePage();
            return true;
        }
        return false;
    }

    // Try initializing immediately if auth is already ready
    if (!tryInitialize()) {
        // Wait for auth:ready event if auth hasn't loaded yet
        // Use a one-time listener
        const authReadyHandler = function() {
            if (tryInitialize()) {
                document.removeEventListener('auth:ready', authReadyHandler);
            }
        };
        document.addEventListener('auth:ready', authReadyHandler);

        // Fallback: try initializing after a short delay if event doesn't fire
        initFallbackTimer = setTimeout(() => {
            initFallbackTimer = null;
            if (tryInitialize()) {
                document.removeEventListener('auth:ready', authReadyHandler);
            }
        }, 500);
    }
});

/**
 * Initialize all home page functionality
 */
async function initializeHomePage() {
    console.log('Home page initialized');

    try {
        // VERY FIRST: if localStorage holds a selectedCourseId that the
        // current user no longer owns (different role/session, revoked
        // access, etc.), strip it before ANY other code path can use it.
        // Otherwise loadFlaggedContent / loadStatistics / checkMissingContent
        // can fire `/api/*` requests against the stale course inside
        // setSelectedCourse's reload cascade.
        await sanitizeStaleSelectedCourseStorage();

        // Check onboarding status first - if not complete, show prompt and hide other content
        const isOnboardingComplete = await checkOnboardingStatus();
        
        if (!isOnboardingComplete) {
            // If onboarding is not complete, show prompt and hide other sections
            showOnboardingPrompt();
            return; // Exit early - don't load other content
        }
        
        // Onboarding is complete, hide prompt and show normal content
        hideOnboardingPrompt();
        
        // Initialize course selection functionality (this will load current course and data)
        await initializeCourseSelection();
        
        // Statistics, flagged content, and missing content are loaded 
        // inside setSelectedCourse() after course is set
        // Only load them here if no course was selected (fallback)
        const selectedCourseId = getSelectedCourseId();
        if (!selectedCourseId) {
            // No course selected, try to load data for all courses
            await loadStatistics();
            await loadFlaggedContent();
            await checkMissingContent();
            await loadStruggleTopics();
            await loadApprovedGlobalTopics();
            await loadPersistenceTopics();
            await loadWeeklyStruggleChart();
        }

        // Add event listeners for live struggle table controls
        const filterCheckbox = document.getElementById('filter-active-only');
        if (filterCheckbox) {
            filterCheckbox.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                filterCheckbox.click();
            });
            filterCheckbox.addEventListener('change', renderLiveStruggleTable);
        }
        
        const downloadCSVBtn = document.getElementById('download-csv-btn');
        if (downloadCSVBtn) {
            downloadCSVBtn.addEventListener('click', downloadStruggleActivityCSV);
        }

        // Weekly chart navigation
        const chartPrevBtn = document.getElementById('chart-prev-weeks');
        if (chartPrevBtn) {
            chartPrevBtn.addEventListener('click', () => {
                weeklyChartOffset++;
                loadWeeklyStruggleChart();
            });
        }

        const chartNextBtn = document.getElementById('chart-next-weeks');
        if (chartNextBtn) {
            chartNextBtn.addEventListener('click', () => {
                if (weeklyChartOffset > 0) {
                    weeklyChartOffset--;
                    loadWeeklyStruggleChart();
                }
            });
        }
    } catch (error) {
        console.error('Error initializing home page:', error);
        showErrorMessage('Failed to load home page data');
    }
}

/**
 * Check if instructor has completed onboarding
 * @returns {Promise<boolean>} True if onboarding is complete, false otherwise
 */
/**
 * If localStorage has a selectedCourseId that the current user does not own
 * (and the URL doesn't override it), remove it before any per-course request
 * can fire against that stale course. Runs once at page bootstrap.
 */
async function sanitizeStaleSelectedCourseStorage() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const courseIdFromUrl = urlParams.get('courseId');
        const courseIdFromStorage = localStorage.getItem('selectedCourseId');
        if (courseIdFromUrl || !courseIdFromStorage) return;

        const userId = getCurrentInstructorId();
        if (!userId) return;

        const isTAUser = typeof isTA === 'function' && isTA();
        const response = await authenticatedFetch(
            isTAUser ? `/api/courses/ta/${userId}` : `/api/onboarding/instructor/${userId}`
        );
        if (!response.ok) return;

        const result = await response.json();
        const owned = isTAUser ? (result.data || []) : (result.data?.courses || []);
        const ownsCourse = owned.some((c) => c.courseId === courseIdFromStorage);
        if (!ownsCourse) {
            console.log(`Clearing stale selectedCourseId ${courseIdFromStorage} (not in instructor's courses)`);
            try { localStorage.removeItem('selectedCourseId'); } catch (_) {}
        }
    } catch (error) {
        console.warn('sanitizeStaleSelectedCourseStorage failed:', error);
    }
}

async function checkOnboardingStatus() {
    try {
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.log('No instructor ID found');
            return false;
        }

        if (typeof isTA === 'function' && isTA()) {
            const response = await authenticatedFetch(`/api/courses/ta/${instructorId}`);

            if (!response.ok) {
                console.error('Failed to fetch TA courses');
                return false;
            }

            const result = await response.json();
            const courses = result.success ? (result.data || []) : [];
            return courses.length > 0;
        }
        
        console.log(`Checking onboarding status for instructor: ${instructorId}`);
        
        // Check if instructor has any courses with onboarding complete
        const response = await authenticatedFetch(`/api/onboarding/instructor/${instructorId}`);
        
        if (!response.ok) {
            console.error('Failed to fetch instructor courses');
            return false;
        }
        
        const result = await response.json();
        
        if (!result.success || !result.data || !result.data.courses) {
            console.log('No courses found for instructor');
            return false;
        }
        
        // Check if any course has onboarding complete
        const completedCourse = result.data.courses.find(course => course.isOnboardingComplete === true);
        
        if (completedCourse) {
            console.log('✅ Onboarding complete - found completed course:', completedCourse.courseId);
            return true;
        }
        
        console.log('⚠️ Onboarding not complete - no completed courses found');
        return false;
        
    } catch (error) {
        console.error('Error checking onboarding status:', error);
        return false; // Default to showing onboarding prompt on error
    }
}

/**
 * Show onboarding prompt and hide other content sections
 */
function showOnboardingPrompt() {
    const onboardingPrompt = document.getElementById('onboarding-prompt-section');
    const flaggedSection = document.querySelector('.flagged-section');
    const missingItemsSection = document.getElementById('missing-items-section');
    const completeSection = document.getElementById('complete-section');
    const disclaimerSection = document.querySelector('.disclaimer-section');
    
    // Show onboarding prompt
    if (onboardingPrompt) {
        onboardingPrompt.style.display = 'block';
    }
    
    // Hide other content sections
    if (flaggedSection) {
        flaggedSection.style.display = 'none';
    }
    if (missingItemsSection) {
        missingItemsSection.style.display = 'none';
    }
    if (completeSection) {
        completeSection.style.display = 'none';
    }
    if (disclaimerSection) {
        disclaimerSection.style.display = 'none';
    }
}

/**
 * Hide onboarding prompt and show normal content sections
 */
function hideOnboardingPrompt() {
    const onboardingPrompt = document.getElementById('onboarding-prompt-section');
    
    if (onboardingPrompt) {
        onboardingPrompt.style.display = 'none';
    }
    
    // Other sections will be shown/hidden by their own functions
}

/**
 * Load statistics for all instructor courses
 */
async function loadStatistics() {
    try {
        const courseId = getSelectedCourseId();
        let url = '/api/courses/statistics';
        
        // If a course is selected, filter by course ID
        if (courseId) {
            url += `?courseId=${encodeURIComponent(courseId)}`;
        }
        
        const response = await fetch(url, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch statistics');
        }
        
        const result = await response.json();
        
        if (!result.success || !result.data) {
            console.log('No statistics data available');
            return;
        }
        
        const stats = result.data;
        
        // Update statistics display
        updateStatisticsDisplay(stats);
        
    } catch (error) {
        console.error('Error loading statistics:', error);
        // Don't show error to user, just hide the section
        document.getElementById('statistics-section')?.setAttribute('style', 'display: none;');
    }
}

/**
 * Load struggle topics for the selected course
 */
async function loadStruggleTopics() {
    try {
        const courseId = getSelectedCourseId();
        if (!courseId) return;

        const response = await authenticatedFetch(`/api/courses/${courseId}/students`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const result = await response.json();
        const students = result.data?.students || [];

        // Aggregate struggle topics
        const topicMap = new Map(); // topic -> { count, students: [] }

        students.forEach(student => {
            if (student.struggleState && student.struggleState.topics && student.struggleState.topics.length > 0) {
                student.struggleState.topics.forEach(t => {
                    // Only count active struggles if that's the requirement, 
                    // but the prompt implies "pull different topics... Enzymes: 3 students"
                    // checking student-hub.js, it lists all topics in struggleState.
                    // Let's count all topics present in struggleState.
                    // We might want to filter by `isActive` if that's what "Struggle Topics" implies,
                    // but usually instructors want to see historical struggles too or current ones.
                    // Given the prompt "Struggle Topics" and "Enzymes: 3 students", implies active or recent.
                    // Let's count all for now, maybe distinguish active in the list.
                    
                    const topicName = t.topic.toLowerCase().trim();
                    if (!topicMap.has(topicName)) {
                        topicMap.set(topicName, { count: 0, students: [], isActiveCount: 0 });
                    }
                    
                    const entry = topicMap.get(topicName);
                    // Avoid counting the same student multiple times for the same topic if data allows duplicates (unlikely)
                    if (!entry.students.some(s => s.id === student.userId)) {
                        entry.count++;
                        entry.students.push({
                            id: student.userId,
                            name: student.displayName || student.username || 'Unknown',
                            isActive: t.isActive
                        });
                        if (t.isActive) entry.isActiveCount++;
                    }
                });
            }
        });

        renderStruggleTopics(topicMap);

    } catch (error) {
        console.error('Error loading struggle topics:', error);
        document.getElementById('struggle-topics-section')?.setAttribute('style', 'display: none;');
    }
}

/**
 * Render struggle topics list
 * @param {Map} topicMap - Aggregated struggle topics
 */
function renderStruggleTopics(topicMap) {
    const container = document.getElementById('struggle-topics-content');
    const section = document.getElementById('struggle-topics-section');
    
    if (!container || !section) return;

    if (topicMap.size === 0) {
        section.style.display = 'block';
        container.innerHTML = '<p class="no-data-message" style="text-align: center; color: #666; font-style: italic; padding: 20px;">No struggle topics recorded for this course yet.</p>';
        return;
    }

    section.style.display = 'block';
    
    // Sort by active count (descending), then total count
    const sortedTopics = Array.from(topicMap.entries()).sort((a, b) => {
        if (b[1].isActiveCount !== a[1].isActiveCount) {
            return b[1].isActiveCount - a[1].isActiveCount;
        }
        return b[1].count - a[1].count;
    });

    let html = '<div class="struggle-topics-list">';
    
    sortedTopics.forEach(([topic, data]) => {
        const displayTopic = topic.charAt(0).toUpperCase() + topic.slice(1);
        
        // Sort students: active first
        const sortedStudents = [...data.students].sort((a, b) => {
            if (a.isActive === b.isActive) return 0;
            return a.isActive ? -1 : 1;
        });

        // Generate student list with indicators
        // Limit to 10 names to avoid overcrowding, show "and X more" if needed
        const displayLimit = 10;
        const displayedStudents = sortedStudents.slice(0, displayLimit);
        const remaining = sortedStudents.length - displayLimit;

        const studentHtmlList = displayedStudents.map(s => {
            const dotColor = s.isActive ? '#dc3545' : '#9ca3af';
            const indicator = `<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false" style="color: ${dotColor}; vertical-align: middle;"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>`;
            const title = s.isActive ? 'Active (Directive Mode)' : 'Inactive (Monitoring)';
            // safe check for escapeHTML in case it's not hoisted or defined yet (it is defined below in the file)
            // But to be safe, we can use a local helper or rely on the one in scope. 
            // Since this function is at the bottom, escapeHTML (defined above or below) should be visible if it's a function declaration.
            // In the previous view, escapeHTML was a function declaration.
            const displayName = anonymizeStudentsEnabled ? 'Student' : escapeHtml(s.name);
            return `<span title="${title}" style="display: inline-block; margin-right: 8px; white-space: nowrap;">${indicator} ${displayName}</span>`;
        }).join('');
        
        const moreText = remaining > 0 ? `<span style="color: #666; font-size: 0.9em;">+ ${remaining} more</span>` : '';

        // Badge color based on whether there are active struggles
        const badgeColor = data.isActiveCount > 0 ? '#dc3545' : '#6c757d';
        const badgeText = `${data.count} student${data.count !== 1 ? 's' : ''}` + 
                          (data.isActiveCount > 0 ? ` (${data.isActiveCount} active)` : '');

        html += `
            <div class="struggle-topic-item" style="background: white; padding: 15px; margin-bottom: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); border-left: 4px solid ${data.isActiveCount > 0 ? '#dc3545' : '#28a745'};">
                <div class="topic-header" onclick="toggleTopic(this)">
                    <h3 style="margin: 0; font-size: 1.1em; color: #333;">
                        <span class="toggle-icon">▼</span>
                         ${displayTopic}
                    </h3>
                    <span class="badge" style="background: ${badgeColor}; color: white; padding: 4px 10px; border-radius: 12px; font-weight: bold;">
                        ${badgeText}
                    </span>
                </div>
                <div class="topic-content">
                    <div style="font-size: 0.95em; color: #555; line-height: 1.5;">
                        ${studentHtmlList} ${moreText}
                    </div>
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    html += '<div style="margin-top: 10px; font-size: 0.85em; color: #666; text-align: right;">' +
        '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false" style="color: #dc3545; vertical-align: middle;"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg> Active (Directive Mode) &nbsp; ' +
        '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false" style="color: #9ca3af; vertical-align: middle;"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg> Inactive (Monitoring)</div>';
    
    container.innerHTML = html;
}

/**
 * Update the statistics display with fetched data
 * @param {Object} stats - Statistics data object
 */
function updateStatisticsDisplay(stats) {
    const statisticsSection = document.getElementById('statistics-section');
    if (!statisticsSection) {
        return;
    }
    
    // Show the section if we have data
    if (stats.totalSessions > 0) {
        statisticsSection.setAttribute('style', 'display: block;');
    } else {
        statisticsSection.setAttribute('style', 'display: none;');
        return;
    }
    
    // Update stat values
    const totalStudentsEl = document.getElementById('stat-total-students');
    const totalSessionsEl = document.getElementById('stat-total-sessions');
    const avgSessionLengthEl = document.getElementById('stat-avg-session-length');
    const avgMessageLengthEl = document.getElementById('stat-avg-message-length');
    
    if (totalStudentsEl) totalStudentsEl.textContent = stats.totalStudents || 0;
    if (totalSessionsEl) totalSessionsEl.textContent = stats.totalSessions || 0;
    if (avgSessionLengthEl) avgSessionLengthEl.textContent = stats.averageSessionLength || '0s';
    if (avgMessageLengthEl) avgMessageLengthEl.textContent = stats.averageMessageLength || 0;
    
    // Update mode distribution
    const tutorCount = stats.modeDistribution?.tutor || 0;
    const protegeCount = stats.modeDistribution?.protege || 0;
    const totalModes = tutorCount + protegeCount;
    
    const tutorCountEl = document.getElementById('tutor-count');
    const protegeCountEl = document.getElementById('protege-count');
    const tutorBarEl = document.getElementById('tutor-bar');
    const protegeBarEl = document.getElementById('protege-bar');
    
    if (tutorCountEl) tutorCountEl.textContent = tutorCount;
    if (protegeCountEl) protegeCountEl.textContent = protegeCount;
    
    if (totalModes > 0) {
        const tutorPercentage = Math.round((tutorCount / totalModes) * 100);
        const protegePercentage = Math.round((protegeCount / totalModes) * 100);
        
        if (tutorBarEl) tutorBarEl.style.width = `${tutorPercentage}%`;
        if (protegeBarEl) protegeBarEl.style.width = `${protegePercentage}%`;
    } else {
        if (tutorBarEl) tutorBarEl.style.width = '0%';
        if (protegeBarEl) protegeBarEl.style.width = '0%';
    }
}

/**
 * Load flagged content count for all instructor courses
 */
async function loadFlaggedContent() {
    try {
        const courseId = getSelectedCourseId();
        
        // If a course is selected, only get flags for that course
        if (courseId) {
            try {
                const flagsResponse = await fetch(`/api/flags/course/${courseId}?status=pending`, {
                    credentials: 'include'
                });
                if (flagsResponse.ok) {
                    const flagsData = await flagsResponse.json();
                    if (flagsData.success && flagsData.data && flagsData.data.flags) {
                        updateFlaggedCount(flagsData.data.flags.length);
                        return;
                    }
                }
            } catch (error) {
                console.error(`Error fetching flags for course ${courseId}:`, error);
            }
            updateFlaggedCount(0);
            return;
        }
        
        // Otherwise, get flags for all courses
        const coursesResponse = await fetch('/api/courses', {
            credentials: 'include'
        });
        if (!coursesResponse.ok) {
            throw new Error('Failed to fetch courses');
        }
        
        const coursesData = await coursesResponse.json();
        if (!coursesData.success || !coursesData.data) {
            console.log('No courses found');
            updateFlaggedCount(0);
            return;
        }
        
        const courses = coursesData.data;
        let totalPendingFlags = 0;
        
        // Get flags for each course
        for (const course of courses) {
            try {
                const flagsResponse = await fetch(`/api/flags/course/${course.id}?status=pending`, {
                    credentials: 'include'
                });
                if (flagsResponse.ok) {
                    const flagsData = await flagsResponse.json();
                    if (flagsData.success && flagsData.data && flagsData.data.flags) {
                        totalPendingFlags += flagsData.data.flags.length;
                    }
                }
            } catch (error) {
                console.error(`Error fetching flags for course ${course.id}:`, error);
                // Continue with other courses
            }
        }
        
        updateFlaggedCount(totalPendingFlags);
    } catch (error) {
        console.error('Error loading flagged content:', error);
        updateFlaggedCount(0);
    }
}

/**
 * Update the flagged count display
 * @param {number} count - Number of pending flags
 */
function updateFlaggedCount(count) {
    const flagCountElement = document.getElementById('pending-flags-count');
    if (flagCountElement) {
        flagCountElement.textContent = count;
        
        // Add visual indicator if there are pending flags
        const flaggedSection = document.querySelector('.flagged-section');
        if (count > 0 && flaggedSection) {
            flaggedSection.classList.add('has-pending-flags');
        } else if (flaggedSection) {
            flaggedSection.classList.remove('has-pending-flags');
        }
    }
}

/**
 * Check for missing course content in all units
 */
async function checkMissingContent() {
    try {
        const courseId = getSelectedCourseId();
        
        // If a course is selected, only check that course
        if (courseId) {
            try {
                const courseDetailResponse = await fetch(`/api/courses/${courseId}`, {
                    credentials: 'include'
                });
                if (!courseDetailResponse.ok) {
                    // Course not found or not accessible
                    document.getElementById('missing-items-section')?.setAttribute('style', 'display: none;');
                    document.getElementById('complete-section')?.setAttribute('style', 'display: none;');
                    return;
                }
                
                const courseDetailData = await courseDetailResponse.json();
                if (!courseDetailData.success || !courseDetailData.data || !courseDetailData.data.lectures) {
                    document.getElementById('missing-items-section')?.setAttribute('style', 'display: none;');
                    document.getElementById('complete-section')?.setAttribute('style', 'display: none;');
                    return;
                }
                
                const course = courseDetailData.data;
                const lectures = course.lectures;
                const missingItems = [];
                
                // Check each unit/lecture for missing items
                for (const lecture of lectures) {
                    const unitMissingItems = checkUnitMissingItems(courseId, course.courseName || courseId, lecture);
                    if (unitMissingItems.length > 0) {
                        missingItems.push(...unitMissingItems);
                    }
                }
                
                // Display results
                displayMissingItems(missingItems);
                return;
            } catch (error) {
                console.error(`Error checking course ${courseId}:`, error);
                document.getElementById('missing-items-section')?.setAttribute('style', 'display: none;');
                document.getElementById('complete-section')?.setAttribute('style', 'display: none;');
                return;
            }
        }
        
        // Otherwise, check all courses
        const coursesResponse = await fetch('/api/courses', {
            credentials: 'include'
        });
        if (!coursesResponse.ok) {
            throw new Error('Failed to fetch courses');
        }
        
        const coursesData = await coursesResponse.json();
        if (!coursesData.success || !coursesData.data || coursesData.data.length === 0) {
            // No courses, hide both sections
            document.getElementById('missing-items-section')?.setAttribute('style', 'display: none;');
            document.getElementById('complete-section')?.setAttribute('style', 'display: none;');
            return;
        }
        
        const courses = coursesData.data;
        const missingItems = [];
        
        // Check each course for missing content
        for (const course of courses) {
            try {
                // Get detailed course data with lectures
                const courseDetailResponse = await fetch(`/api/courses/${course.id}`, {
                    credentials: 'include'
                });
                if (!courseDetailResponse.ok) {
                    continue; // Skip this course if we can't get details
                }
                
                const courseDetailData = await courseDetailResponse.json();
                if (!courseDetailData.success || !courseDetailData.data || !courseDetailData.data.lectures) {
                    continue;
                }
                
                const lectures = courseDetailData.data.lectures;
                
                // Check each unit/lecture for missing items
                for (const lecture of lectures) {
                    const unitMissingItems = checkUnitMissingItems(course.id, course.name, lecture);
                    if (unitMissingItems.length > 0) {
                        missingItems.push(...unitMissingItems);
                    }
                }
            } catch (error) {
                console.error(`Error checking course ${course.id}:`, error);
                // Continue with other courses
            }
        }
        
        // Display results
        displayMissingItems(missingItems);
    } catch (error) {
        console.error('Error checking missing content:', error);
        // Hide both sections on error
        document.getElementById('missing-items-section')?.setAttribute('style', 'display: none;');
        document.getElementById('complete-section')?.setAttribute('style', 'display: none;');
    }
}

/**
 * Check a single unit for missing required items
 * @param {string} courseName - Name of the course
 * @param {Object} lecture - Lecture/unit object
 * @returns {Array} Array of missing item descriptions
 */
function checkUnitMissingItems(courseId, courseName, lecture) {
    const missingItems = [];
    const unitName = lecture.name || 'Unknown Unit';
    
    // Check for learning objectives
    const hasLearningObjectives = lecture.learningObjectives && 
                                   Array.isArray(lecture.learningObjectives) && 
                                   lecture.learningObjectives.length > 0;
    
    // Check for lecture notes: require at least one document tagged as lecture notes
    const hasLectureNotes = Array.isArray(lecture.documents) && lecture.documents.some(doc => {
        const t = (doc.documentType || '').toLowerCase();
        return t === 'lecture-notes' || t === 'lecture_notes' || t === 'notes';
    });
    
    // Check for practice questions: require at least one practice/tutorial document
    const hasPracticeDocs = Array.isArray(lecture.documents) && lecture.documents.some(doc => {
        const t = (doc.documentType || '').toLowerCase();
        return t === 'practice-quiz' || t === 'practice_q_tutorials' || t === 'practice' || t === 'tutorial';
    });
    const hasPracticeQuestions = hasPracticeDocs;
    
    // Build missing items list
    if (!hasLearningObjectives) {
        missingItems.push({ courseId, courseName, unitName, missingItem: 'Learning Objective' });
    }
    
    if (!hasLectureNotes) {
        missingItems.push({ courseId, courseName, unitName, missingItem: 'Lecture Note' });
    }
    
    if (!hasPracticeQuestions) {
        missingItems.push({ courseId, courseName, unitName, missingItem: 'Practice Question/Tutorial' });
    }
    
    return missingItems;
}

/**
 * Display missing items in the UI
 * @param {Array} missingItems - Array of missing item objects
 */
function displayMissingItems(missingItems) {
    const missingSection = document.getElementById('missing-items-section');
    const completeSection = document.getElementById('complete-section');
    const missingList = document.getElementById('missing-items-list');
    
    if (!missingSection || !completeSection || !missingList) {
        return;
    }
    
    if (missingItems.length === 0) {
        // All units are complete
        missingSection.setAttribute('style', 'display: none;');
        completeSection.setAttribute('style', 'display: block;');
    } else {
        // Show missing items
        missingSection.setAttribute('style', 'display: block;');
        completeSection.setAttribute('style', 'display: none;');
        
        // Clear existing list
        missingList.innerHTML = '';
        
        // Group missing items by course and unit
        const groupedItems = {};
        missingItems.forEach(item => {
            const key = `${item.courseName}|${item.unitName}`;
            if (!groupedItems[key]) {
                groupedItems[key] = {
                    courseId: item.courseId,
                    courseName: item.courseName,
                    unitName: item.unitName,
                    missingItems: []
                };
            }
            groupedItems[key].missingItems.push(item.missingItem);
        });
        
        // Create list items
        Object.values(groupedItems).forEach(group => {
            const listItem = document.createElement('div');
            listItem.className = 'missing-item';
            
            const missingItemsText = group.missingItems.join(', ');
            listItem.innerHTML = `
                <div class="missing-item-header">
                    <span class="missing-item-course">${escapeHtml(group.courseName)}</span>
                    <span class="missing-item-unit">${escapeHtml(group.unitName)}</span>
                </div>
                <div class="missing-item-details">
                    Missing: ${escapeHtml(missingItemsText)}
                </div>
                <div class="missing-item-actions">
                    <a class="action-btn primary" href="/instructor/documents?courseId=${encodeURIComponent(group.courseId)}&unit=${encodeURIComponent(group.unitName)}">Go to this unit</a>
                </div>
            `;
            
            missingList.appendChild(listItem);
        });
    }
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function normalizeTopicLabel(topic) {
    if (typeof topic === 'string') {
        return topic.replace(/\s+/g, ' ').trim();
    }

    if (topic && typeof topic === 'object') {
        return normalizeTopicLabel(topic.topic);
    }

    return '';
}

function normalizeTopicSource(source, fallback = 'manual') {
    return source === 'scraped' || source === 'manual' ? source : fallback;
}

function normalizeTopicUnitId(unitId) {
    return typeof unitId === 'string' && unitId.trim() ? unitId.trim() : null;
}

function normalizeApprovedTopicDetails(topics = [], defaults = {}) {
    const seen = new Set();
    const output = [];

    (Array.isArray(topics) ? topics : []).forEach((topicEntry) => {
        const topic = normalizeTopicLabel(topicEntry);
        if (!topic) return;

        const key = topic.toLowerCase();
        if (seen.has(key)) return;

        const rawObject = topicEntry && typeof topicEntry === 'object' ? topicEntry : {};
        seen.add(key);
        output.push({
            topic,
            unitId: normalizeTopicUnitId(rawObject.unitId ?? defaults.unitId),
            source: normalizeTopicSource(rawObject.source, defaults.source || 'manual'),
            createdAt: rawObject.createdAt || defaults.createdAt || new Date().toISOString()
        });
    });

    return output;
}

function getApprovedTopicLabels(topics = []) {
    return normalizeApprovedTopicDetails(topics).map((topic) => topic.topic);
}

function setApprovedTopicGlobals(courseId, topics = []) {
    if (!courseId) return;

    const details = normalizeApprovedTopicDetails(topics);
    const labels = details.map((topic) => topic.topic);

    window.courseApprovedTopicDetailsByCourse = window.courseApprovedTopicDetailsByCourse || {};
    window.courseApprovedTopicDetailsByCourse[courseId] = details;
    window.courseApprovedTopicDetails = details;

    window.courseApprovedTopicsByCourse = window.courseApprovedTopicsByCourse || {};
    window.courseApprovedTopicsByCourse[courseId] = labels;
    window.courseApprovedTopics = labels;
}

async function fetchApprovedTopicDetails(courseId) {
    const response = await authenticatedFetch(`/api/courses/${courseId}/approved-topics`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    const topics = Array.isArray(result?.data?.topics)
        ? result.data.topics
        : result?.data?.topicLabels || [];

    setApprovedTopicGlobals(courseId, topics);
    return window.courseApprovedTopicDetails || [];
}

function getCurrentCourseUnits() {
    const courseData = window.selectedCourseData || window.currentCourseData || {};
    return Array.isArray(courseData.lectures) ? courseData.lectures : [];
}

function renderUnitOptions(selectedUnitId = '', includeUnassigned = true) {
    const units = getCurrentCourseUnits();
    const selected = normalizeTopicUnitId(selectedUnitId) || '';
    const options = [];

    if (includeUnassigned) {
        options.push(`<option value=""${selected ? '' : ' selected'}>Unassigned</option>`);
    }

    units.forEach((unit) => {
        if (!unit || !unit.name) return;
        const unitName = String(unit.name);
        options.push(`<option value="${escapeHtml(unitName)}"${unitName === selected ? ' selected' : ''}>${escapeHtml(unitName)}</option>`);
    });

    return options.join('');
}

function findApprovedTopicByLabel(topicLabel) {
    const normalized = normalizeTopicLabel(topicLabel).toLowerCase();
    return (window.courseApprovedTopicDetails || []).find(
        (topic) => topic.topic.toLowerCase() === normalized
    ) || null;
}

// ===========================
// LIVE STRUGGLE TABLE & SOCKET.IO
// ===========================

/**
 * Global variables for Socket.IO and live struggle data
 */
let pollingInterval = null; // Polling interval ID
let struggleActivityData = []; // Array to store all struggle activity
const MAX_TABLE_ENTRIES = 100; // Limit stored entries to prevent memory issues
const POLLING_INTERVAL_MS = 10000; // Poll every 10 seconds

// Weekly struggle chart state
let weeklyStruggleChart = null;   // Chart.js instance
let weeklyChartOffset = 0;        // Navigation offset (0 = most recent page)
const WEEKS_PER_PAGE = 8;         // Weeks shown per page
let chartTooltipHideTimer = null; // Delayed-hide timer for the HTML tooltip
let chartTooltipHovered = false;  // True while the pointer sits inside the tooltip

/**
 * Start polling for struggle activity updates
 * Called when a course is selected
 */
function startPollingStruggleActivity() {
    const courseId = getSelectedCourseId();
    if (!courseId) {
        console.warn('Cannot start polling: No course selected');
        return;
    }
    
    // Stop existing polling if any
    stopPollingStruggleActivity();
    
    console.log(`\ud83d\udd04 Starting struggle activity polling for course: ${courseId}`);
    
    // Poll immediately once, then set interval
    pollStruggleActivity();
    pollingInterval = setInterval(pollStruggleActivity, POLLING_INTERVAL_MS);
}

/**
 * Stop polling for struggle activity updates
 */
function stopPollingStruggleActivity() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        console.log('\u274c Stopped struggle activity polling');
    }
}

/**
 * Poll the server for new struggle activity data
 */
async function pollStruggleActivity() {
    try {
        const courseId = getSelectedCourseId();
        if (!courseId) return;
        
        // Fetch latest activity from API
        const response = await authenticatedFetch(struggleActivityEndpoint(100));

        if (!response.ok) {
            console.warn('Failed to poll struggle activity');
            return;
        }
        
        const result = await response.json();
        const newActivities = result.data || [];
        
        // Update data array (replace entirely)
        struggleActivityData = newActivities;
        
        // Re-render table
        renderLiveStruggleTable();
        
    } catch (error) {
        console.error('Error polling struggle activity:', error);
    }
}

/**
 * Load initial struggle activity data from server
 * Fetches from persistent MongoDB history collection
 */
async function loadInitialStruggleActivity() {
    try {
        const courseId = getSelectedCourseId();
        if (!courseId) return;
        
        // Fetch from persistent history API
        const response = await authenticatedFetch(struggleActivityEndpoint(100));

        if (!response.ok) {
            console.warn('Failed to load struggle activity history');
            return;
        }
        
        const result = await response.json();
        const activities = result.data || [];
        
        // Activities are already sorted by timestamp (newest first) from backend
        struggleActivityData = activities;
        
        // Show the table container
        const container = document.getElementById('live-struggle-container');
        if (container) {
            container.style.display = 'block';
        }
        
        renderLiveStruggleTable();
        
        console.log(`📊 Loaded ${struggleActivityData.length} struggle activity entries from history`);
        
    } catch (error) {
        console.error('Error loading struggle activity history:', error);
    }
}


/**
 * Render the live struggle table
 * Respects the "Show only active" filter
 */
function renderLiveStruggleTable() {
    const tbody = document.getElementById('live-struggle-tbody');
    if (!tbody) return;
    
    const filterActive =document.getElementById('filter-active-only')?.checked || false;
    
    // Filter data if needed
    let dataToDisplay = struggleActivityData;
    if (filterActive) {
        dataToDisplay = struggleActivityData.filter(item => item.state === 'Active');
    }
    
    // Hide/show Name column header based on anonymize setting
    const nameHeader = document.getElementById('struggle-name-th');
    if (nameHeader) nameHeader.style.display = anonymizeStudentsEnabled ? 'none' : '';

    const colSpan = anonymizeStudentsEnabled ? 3 : 4;

    if (dataToDisplay.length === 0) {
        tbody.innerHTML = `
            <tr class="no-data-row">
                <td colspan="${colSpan}" style="text-align: center; color: #666; padding: 20px;">
                    ${filterActive ? 'No active struggle activity.' : 'No struggle activity yet. Activity will appear here as students interact with topics.'}
                </td>
            </tr>
        `;
        return;
    }

    // Build table rows
    let html = '';
    dataToDisplay.forEach(item => {
        const timestamp = formatTimestampPST(item.timestamp);
        const stateBadge = item.state === 'Active'
            ? '<span class="state-badge active">Active</span>'
            : '<span class="state-badge inactive">Inactive</span>';

        // Distinguish struggles that originated in the cross-course Super Chat
        // (attributed here) from ones raised in this course's own chat.
        const sourceBadge = item.source === 'superCourse'
            ? ' <span class="state-badge" style="background:#6f42c1; color:#fff;" title="Raised in the cross-course Super Chat">via Super Chat</span>'
            : '';

        html += `
            <tr>
                <td>${timestamp}</td>
                ${anonymizeStudentsEnabled ? '' : `<td>${escapeHtml(item.studentName)}</td>`}
                <td>${escapeHtml(capitalizeFirst(item.topic))}${sourceBadge}</td>
                <td>${stateBadge}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

/**
 * Format timestamp to PST timezone
 * @param {Date|string} timestamp - Timestamp to format
 * @returns {string} Formatted timestamp in PST (e.g., "February 13, 2024, 7:25 PM")
 */
function formatTimestampPST(timestamp) {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    
    // Format to PST (America/Los_Angeles) - automatically handles PST/PDT
    const options = {
        timeZone: 'America/Los_Angeles',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    };
    
    const formatter = new Intl.DateTimeFormat('en-US', options);
    return formatter.format(date);
}

/**
 * Capitalize first letter of string
 * @param {string} str - String to capitalize
 * @returns {string} Capitalized string
 */
function capitalizeFirst(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Download table data as CSV
 * Respects the "Show only active" filter
 */
function downloadStruggleActivityCSV() {
    const filterActive = document.getElementById('filter-active-only')?.checked || false;
    let dataToExport = struggleActivityData;
    
    if (filterActive) {
        dataToExport = struggleActivityData.filter(item => item.state === 'Active');
    }
    
    if (dataToExport.length === 0) {
        alert('No data to export');
        return;
    }
    
    // Build CSV
    let csv = anonymizeStudentsEnabled
        ? 'Time (PST),Topic,Status\n'
        : 'Time (PST),Name,Topic,Status\n';

    dataToExport.forEach(item => {
        const timestamp = formatTimestampPST(item.timestamp);
        const topic = capitalizeFirst(item.topic).replace(/"/g, '""');
        const status = item.state;

        if (anonymizeStudentsEnabled) {
            csv += `"${timestamp}","${topic}","${status}"\n`;
        } else {
            const name = item.studentName.replace(/"/g, '""');
            csv += `"${timestamp}","${name}","${topic}","${status}"\n`;
        }
    });
    
    // Create download link
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `struggle_activity_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log(`📥 Downloaded CSV with ${dataToExport.length} entries`);
}

// ===========================
// END OF LIVE STRUGGLE TABLE
// ===========================

// ===========================
// WEEKLY STRUGGLE CHART
// ===========================

/**
 * Load weekly active struggle data and render chart.
 * Generates a continuous weekly timeline (no gaps) and merges sparse backend data into it.
 */
async function loadWeeklyStruggleChart() {
    try {
        const courseId = getSelectedCourseId();
        if (!courseId) return;

        // Always fetch a generous window so we can paginate client-side
        const fetchWeeks = Math.max(52, (weeklyChartOffset + 1) * WEEKS_PER_PAGE + WEEKS_PER_PAGE);

        const response = await authenticatedFetch(weeklyStruggleEndpoint(fetchWeeks));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();
        const sparseWeeks = result.data || [];

        if (sparseWeeks.length === 0) {
            renderWeeklyStruggleChart([], 0);
            return;
        }

        // Build lookup by milliseconds. Backend $dateTrunc returns stable timestamps.
        const weekMap = new Map();
        sparseWeeks.forEach(w => {
            weekMap.set(new Date(w.weekStart).getTime(), w);
        });

        // Generate continuous timeline from first backend week to now, stepping +7 days
        const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const firstWeekMs = new Date(sparseWeeks[0].weekStart).getTime();
        const lastWeekMs = new Date(sparseWeeks[sparseWeeks.length - 1].weekStart).getTime();
        const endMs = Math.max(lastWeekMs, Date.now());

        const allWeeks = [];
        for (let ms = firstWeekMs; ms <= endMs; ms += WEEK_MS) {
            if (weekMap.has(ms)) {
                allWeeks.push(weekMap.get(ms));
            } else {
                allWeeks.push({ weekStart: new Date(ms).toISOString(), topics: [], totalCount: 0 });
            }
        }

        // Paginate: offset 0 = most recent WEEKS_PER_PAGE weeks
        const endIdx = allWeeks.length - (weeklyChartOffset * WEEKS_PER_PAGE);
        const sliceStart = Math.max(0, endIdx - WEEKS_PER_PAGE);
        const pageData = allWeeks.slice(sliceStart, Math.max(endIdx, 0));

        renderWeeklyStruggleChart(pageData, allWeeks.length);
    } catch (error) {
        console.error('Error loading weekly struggle chart:', error);
    }
}

/**
 * Render the weekly struggle stacked bar chart
 * @param {Array} weekData - Array of week objects with topics
 * @param {number} totalWeeksAvailable - Total weeks of data available
 */
function renderWeeklyStruggleChart(weekData, totalWeeksAvailable) {
    const container = document.getElementById('weekly-struggle-chart-container');
    const canvas = document.getElementById('weekly-struggle-chart');
    const rangeLabel = document.getElementById('chart-week-range');
    const prevBtn = document.getElementById('chart-prev-weeks');
    const nextBtn = document.getElementById('chart-next-weeks');

    if (!container || !canvas) return;

    if (weekData.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';

    // Collect all unique topics across displayed weeks
    const allTopics = new Set();
    weekData.forEach(w => w.topics.forEach(t => allTopics.add(t.topic)));
    const topicList = Array.from(allTopics).sort();

    // Color palette
    const palette = [
        '#dc3545', '#4a90e2', '#ffc107', '#28a745', '#6f42c1',
        '#fd7e14', '#20c997', '#e83e8c', '#17a2b8', '#6c757d',
        '#8b5cf6', '#f59e0b', '#ef4444', '#10b981', '#3b82f6'
    ];

    // Build labels (week start dates)
    const labels = weekData.map(w => {
        const d = new Date(w.weekStart);
        return d.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric',
            timeZone: 'America/Los_Angeles'
        });
    });

    // Build datasets (one per topic, stacked)
    const datasets = topicList.map((topic, i) => ({
        label: capitalizeFirst(topic),
        data: weekData.map(w => {
            const found = w.topics.find(t => t.topic === topic);
            return found ? found.studentCount : 0;
        }),
        backgroundColor: palette[i % palette.length],
        borderWidth: 0,
        borderRadius: 2
    }));

    // Update range label
    if (rangeLabel && weekData.length > 0) {
        const firstDate = new Date(weekData[0].weekStart);
        const lastDate = new Date(weekData[weekData.length - 1].weekStart);
        const lastEndDate = new Date(lastDate);
        lastEndDate.setDate(lastEndDate.getDate() + 6);
        const fmt = { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' };
        rangeLabel.textContent = `${firstDate.toLocaleDateString('en-US', fmt)} – ${lastEndDate.toLocaleDateString('en-US', fmt)}`;
    }

    // Update navigation buttons
    if (prevBtn) {
        prevBtn.disabled = (weeklyChartOffset + 1) * WEEKS_PER_PAGE >= totalWeeksAvailable;
    }
    if (nextBtn) {
        nextBtn.disabled = weeklyChartOffset === 0;
    }

    // Destroy previous chart instance
    if (weeklyStruggleChart) {
        weeklyStruggleChart.destroy();
        weeklyStruggleChart = null;
    }
    hideWeeklyStruggleTooltip(canvas.parentElement, true);

    // A page can legitimately contain only gap-filled (zero-struggle) weeks when an
    // earlier week pushed the timeline back. Drawing an empty chart looks like a crash,
    // so show a clear message instead and keep the panel (and its nav) visible.
    const wrapper = canvas.parentElement;
    let emptyState = wrapper ? wrapper.querySelector('.chart-empty-state') : null;
    if (topicList.length === 0) {
        canvas.style.display = 'none';
        if (wrapper && !emptyState) {
            emptyState = document.createElement('div');
            emptyState.className = 'chart-empty-state';
            wrapper.appendChild(emptyState);
        }
        if (emptyState) {
            emptyState.textContent = 'No active struggles recorded during this period.';
            emptyState.style.display = 'flex';
        }
        return;
    }
    if (emptyState) {
        emptyState.style.display = 'none';
    }
    canvas.style.display = 'block';

    // Create stacked bar chart
    weeklyStruggleChart = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { padding: 15, usePointStyle: true, pointStyle: 'rect' }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    // Canvas-drawn tooltips cannot scroll, and a week can easily carry
                    // more topics than fit on screen, so render an HTML tooltip instead.
                    enabled: false,
                    external: renderWeeklyStruggleTooltip,
                    callbacks: {
                        title: (items) => `Week of ${items[0].label}`
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false },
                    title: { display: true, text: 'Week Starting', font: { weight: 'bold' } }
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { stepSize: 1, precision: 0 },
                    title: { display: true, text: 'Active Students', font: { weight: 'bold' } }
                }
            }
        }
    });
}

/**
 * Get (or lazily create) the HTML tooltip element for the weekly struggle chart.
 * It lives inside the canvas wrapper so it scrolls with the page.
 * @param {HTMLElement} wrapper - The chart canvas wrapper
 * @returns {HTMLElement} The tooltip element
 */
function getWeeklyStruggleTooltip(wrapper) {
    let el = wrapper.querySelector('.chart-tooltip');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'chart-tooltip';
    el.setAttribute('role', 'tooltip');

    // Track the pointer so a tooltip the instructor is scrolling never disappears
    // underneath them when the cursor leaves the canvas.
    el.addEventListener('mouseenter', () => {
        chartTooltipHovered = true;
        if (chartTooltipHideTimer) {
            clearTimeout(chartTooltipHideTimer);
            chartTooltipHideTimer = null;
        }
    });
    el.addEventListener('mouseleave', () => {
        chartTooltipHovered = false;
        hideWeeklyStruggleTooltip(wrapper, true);
    });

    wrapper.appendChild(el);
    return el;
}

/**
 * Hide the weekly struggle tooltip
 * @param {HTMLElement} wrapper - The chart canvas wrapper
 * @param {boolean} immediate - Skip the grace period that lets the pointer reach the tooltip
 */
function hideWeeklyStruggleTooltip(wrapper, immediate) {
    if (!wrapper) return;
    const el = wrapper.querySelector('.chart-tooltip');
    if (!el) return;

    if (chartTooltipHideTimer) {
        clearTimeout(chartTooltipHideTimer);
        chartTooltipHideTimer = null;
    }

    const hide = () => {
        chartTooltipHideTimer = null;
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
    };

    if (immediate) {
        chartTooltipHovered = false;
        hide();
        return;
    }

    // Grace period: the pointer needs a moment to travel from the bar to the tooltip.
    chartTooltipHideTimer = setTimeout(() => {
        if (!chartTooltipHovered) hide();
    }, 250);
}

/**
 * Chart.js external tooltip handler: renders a scrollable HTML tooltip.
 * @param {Object} context - Chart.js external tooltip context
 */
function renderWeeklyStruggleTooltip(context) {
    const { chart, tooltip } = context;
    const wrapper = chart.canvas.parentElement;
    if (!wrapper) return;

    if (tooltip.opacity === 0) {
        hideWeeklyStruggleTooltip(wrapper, false);
        return;
    }

    // While the pointer is inside the tooltip, leave it exactly where it is.
    if (chartTooltipHovered) return;

    const el = getWeeklyStruggleTooltip(wrapper);
    if (chartTooltipHideTimer) {
        clearTimeout(chartTooltipHideTimer);
        chartTooltipHideTimer = null;
    }

    const points = tooltip.dataPoints || [];

    // Every topic in the page is a dataset, so most weeks carry a long tail of
    // zero-count topics. Show only the topics actually present that week, busiest first.
    const rows = points
        .map((point, i) => {
            const colors = tooltip.labelColors && tooltip.labelColors[i];
            return {
                label: point.dataset.label,
                value: Number(point.raw) || 0,
                text: point.formattedValue,
                color: (colors && colors.backgroundColor) || point.dataset.backgroundColor
            };
        })
        .filter(row => row.value > 0)
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

    const titleEl = document.createElement('div');
    titleEl.className = 'chart-tooltip-title';
    titleEl.textContent = (tooltip.title && tooltip.title[0]) || '';

    const body = document.createElement('div');
    body.className = 'chart-tooltip-body';

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chart-tooltip-empty';
        empty.textContent = 'No active struggles this week.';
        body.appendChild(empty);
    }

    rows.forEach((rowData) => {
        const row = document.createElement('div');
        row.className = 'chart-tooltip-row';

        const swatch = document.createElement('span');
        swatch.className = 'chart-tooltip-swatch';
        swatch.style.backgroundColor = rowData.color;

        const label = document.createElement('span');
        label.textContent = `${rowData.label}: ${rowData.text}`;

        row.appendChild(swatch);
        row.appendChild(label);
        body.appendChild(row);
    });

    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const footer = document.createElement('div');
    footer.className = 'chart-tooltip-footer';
    footer.textContent = `Total active: ${total} student${total !== 1 ? 's' : ''}`;

    el.replaceChildren(titleEl, body, footer);

    // Measure at the origin, then place so the tooltip stays inside the chart area.
    el.style.opacity = '1';
    el.style.pointerEvents = 'auto';
    el.style.left = '0px';
    el.style.top = '0px';

    const { offsetWidth: tipWidth, offsetHeight: tipHeight } = el;
    let left = tooltip.caretX + 12;
    if (left + tipWidth > wrapper.clientWidth) {
        left = tooltip.caretX - tipWidth - 12;
    }
    left = Math.max(0, left);
    const top = Math.max(0, Math.min(tooltip.caretY - tipHeight / 2, wrapper.clientHeight - tipHeight));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

// ===========================
// END OF WEEKLY STRUGGLE CHART
// ===========================


/**
 * Show info message
 * @param {string} message - Info message
 */
function showInfoMessage(message) {
    showNotificationMessage(message, 'info');
}

/**
 * Show error message
 * @param {string} message - Error message
 */
function showErrorMessage(message) {
    showNotificationMessage(message, 'error');
}

/**
 * Show success message
 * @param {string} message - Success message
 */
function showSuccessMessage(message) {
    showNotificationMessage(message, 'success');
}

function getNotificationContainer() {
    let container = document.querySelector('.notification-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'notification-container';
        document.body.appendChild(container);
    }

    return container;
}

function showNotificationMessage(message, type) {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;

    const closeButton = document.createElement('button');
    closeButton.className = 'notification-close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => notification.remove());

    notification.appendChild(messageSpan);
    notification.appendChild(closeButton);

    getNotificationContainer().appendChild(notification);

    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);
}

function animateFieldError(input) {
    if (!input) {
        return;
    }

    input.classList.remove('field-error-shake');
    void input.offsetWidth;
    input.classList.add('field-error-shake');
}

function setJoinCourseCodeFeedback(message) {
    const codeInput = document.getElementById('instructor-course-code-input');
    const feedback = document.getElementById('instructor-course-code-feedback');

    if (codeInput) {
        codeInput.classList.add('input-error');
        codeInput.setAttribute('aria-invalid', 'true');
        animateFieldError(codeInput);
        codeInput.focus();
    }

    if (feedback) {
        feedback.textContent = message;
        feedback.style.display = 'block';
    }
}

function clearJoinCourseCodeFeedback() {
    const codeInput = document.getElementById('instructor-course-code-input');
    const feedback = document.getElementById('instructor-course-code-feedback');

    if (codeInput) {
        codeInput.classList.remove('input-error', 'field-error-shake');
        codeInput.removeAttribute('aria-invalid');
    }

    if (feedback) {
        feedback.textContent = '';
        feedback.style.display = 'none';
    }
}

/**
 * Initialize course selection functionality
 */
async function initializeCourseSelection() {
    // Set up event listeners
    const changeCourseBtn = document.getElementById('change-course-btn');
    const cancelCourseSelectBtn = document.getElementById('cancel-course-select-btn');
    const joinCourseBtn = document.getElementById('join-course-btn');
    const courseSelectDropdown = document.getElementById('course-select-dropdown');
    const joinCourseSelectDropdown = document.getElementById('join-course-select-dropdown');
    const instructorCodeInput = document.getElementById('instructor-course-code-input');
    const isTAUser = typeof isTA === 'function' && isTA();

    if (isTAUser) {
        const joinCourseGroup = joinCourseSelectDropdown?.closest('div');
        if (joinCourseGroup) {
            joinCourseGroup.style.display = 'none';
        }
        if (joinCourseBtn) {
            joinCourseBtn.style.display = 'none';
        }
        applyInstructorCodeJoinPermissions();
    } else {
        canBypassInstructorCourseCodes = await checkCourseCodeBypassPermission();
        applyInstructorCodeJoinPermissions();
    }
    
    // "Set Up Another Section" lets an instructor create more than one course,
    // which only applies when the academic API is enabled. Hide it otherwise so
    // onboarding stays single-course, matching the pre-feature behavior.
    applyAcademicApiGateToHome();

    if (changeCourseBtn) {
        changeCourseBtn.addEventListener('click', showCourseSelector);
    }

    if (cancelCourseSelectBtn) {
        cancelCourseSelectBtn.addEventListener('click', hideCourseSelector);
    }
    
    if (joinCourseBtn) {
        joinCourseBtn.addEventListener('click', handleJoinCourse);
    }
    
    if (courseSelectDropdown) {
        addKeyboardPickerActivation(courseSelectDropdown);
        courseSelectDropdown.addEventListener('change', async (event) => {
            const courseId = event.target.value;
            if (!courseId) return;

            const selectedOption = event.target.options[event.target.selectedIndex];
            await setSelectedCourse(courseId, selectedOption ? selectedOption.textContent : courseId);
        });
    }

    if (joinCourseSelectDropdown) {
        addKeyboardPickerActivation(joinCourseSelectDropdown);
        joinCourseSelectDropdown.addEventListener('change', handleJoinCourseSelectionChange);
    }

    if (instructorCodeInput) {
        instructorCodeInput.addEventListener('input', clearJoinCourseCodeFeedback);
    }
    
    await Promise.all([
        loadAvailableCourses(),
        isTAUser ? Promise.resolve() : loadJoinableCourses()
    ]);
    
    // Load and display current course
    await loadCurrentCourse();
    
    // Update navigation links to include course ID
    updateNavigationLinks();
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

function isCourseInactive(course = {}) {
    return (course.status || 'active') === 'inactive';
}

function getCourseDisplayName(course = {}) {
    const courseName = course.courseName || course.courseId || 'Untitled Course';
    return isCourseInactive(course) ? `${courseName} (Inactive)` : courseName;
}

function dedupeCourses(courses = []) {
    return courses.filter((course, index, self) =>
        index === self.findIndex(candidate => candidate.courseId === course.courseId)
    );
}

function appendCourseGroup(selectElement, label, courses) {
    if (!courses.length) {
        return;
    }

    const optgroup = document.createElement('optgroup');
    optgroup.label = label;

    courses.forEach(course => {
        const option = document.createElement('option');
        option.value = course.courseId;
        option.textContent = getCourseDisplayName(course);
        option.dataset.status = course.status || 'active';
        optgroup.appendChild(option);
    });

    selectElement.appendChild(optgroup);
}

// Add the cross-course "Super Chat" filters as their own option group at the end
// of the course dropdown (only on the main course selector, not the join one):
// one "all buckets" aggregate plus one entry per superchat bucket.
async function appendSuperCourseOption(selectElement) {
    if (!selectElement) return;

    const optgroup = document.createElement('optgroup');
    optgroup.label = 'Super Chat';

    // All-buckets aggregate (legacy/global view).
    const allOption = document.createElement('option');
    allOption.value = SUPER_COURSE_FILTER_ID;
    allOption.textContent = 'Super Chat (all buckets)';
    optgroup.appendChild(allOption);

    // One entry per bucket.
    try {
        const response = await fetch('/api/superchats', { credentials: 'include' });
        const result = await response.json();
        if (response.ok && result.success && Array.isArray(result.superchats)) {
            result.superchats.forEach(bucket => {
                const option = document.createElement('option');
                option.value = `${SUPER_COURSE_BUCKET_PREFIX}${bucket.superchatId}`;
                option.textContent = bucket.name;
                optgroup.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading superchat buckets for filter:', error);
    }

    selectElement.appendChild(optgroup);
}

function populateCourseDropdown(selectElement, courses, placeholderText) {
    selectElement.innerHTML = '';

    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = placeholderText;
    selectElement.appendChild(placeholderOption);

    const uniqueCourses = dedupeCourses(courses);
    const activeCourses = uniqueCourses.filter(course => !isCourseInactive(course));
    const inactiveCourses = uniqueCourses.filter(isCourseInactive);

    appendCourseGroup(selectElement, 'Active Courses', activeCourses);
    appendCourseGroup(selectElement, 'Inactive Courses', inactiveCourses);
}

async function checkCourseCodeBypassPermission() {
    try {
        const response = await fetch('/api/settings/can-delete-all', {
            credentials: 'include'
        });

        const result = await response.json();
        return !!(result.success && result.canDeleteAll);
    } catch (error) {
        console.error('Error checking instructor course-code bypass permission:', error);
        return false;
    }
}

// Hide "Set Up Another Section" unless the academic API is enabled for this
// instance. The button is hidden by default and only revealed once we confirm
// the feature is on, so a slow/failed check fails to the safe (hidden) state.
async function applyAcademicApiGateToHome() {
    const setupBtn = document.getElementById('setup-section-btn');
    const container = setupBtn ? setupBtn.closest('div') : null;
    const target = container || setupBtn;
    if (!target) return;

    target.style.display = 'none';
    try {
        const response = await fetch('/api/settings/academic-api-enabled', {
            credentials: 'include'
        });
        const result = await response.json();
        if (result && result.success && result.enabled) {
            target.style.display = '';
        }
    } catch (error) {
        console.error('Error checking academic API gate:', error);
    }
}

function applyInstructorCodeJoinPermissions() {
    const codeEntryGroup = document.getElementById('instructor-code-entry-group');
    const codeHelp = document.getElementById('instructor-course-code-help');

    if (codeEntryGroup) {
        codeEntryGroup.style.display = 'none';
    }

    if (codeHelp) {
        codeHelp.textContent = canBypassInstructorCourseCodes
            ? 'You have admin access, so no instructor code is required for you to join this course.'
            : 'Ask the course owner for the instructor code for this course.';
    }
}

function updateCourseCodeDisplay(courseData = {}) {
    const studentCodeLabel = document.getElementById('student-course-code-label');
    const studentCodeDisplay = document.getElementById('student-course-code-display');
    const instructorCodeLabel = document.getElementById('instructor-course-code-label');
    const instructorCodeDisplay = document.getElementById('instructor-course-code-display');

    const studentCode = courseData.studentCourseCode || courseData.courseCode;
    const instructorCode = courseData.instructorCourseCode;

    if (studentCodeLabel && studentCodeDisplay) {
        if (studentCode) {
            studentCodeDisplay.textContent = studentCode;
            studentCodeDisplay.style.display = 'inline-block';
            studentCodeLabel.style.display = 'inline-block';
        } else {
            studentCodeDisplay.style.display = 'none';
            studentCodeLabel.style.display = 'none';
        }
    }

    if (instructorCodeLabel && instructorCodeDisplay) {
        if (instructorCode) {
            instructorCodeDisplay.textContent = instructorCode;
            instructorCodeDisplay.style.display = 'inline-block';
            instructorCodeLabel.style.display = 'inline-block';
        } else {
            instructorCodeDisplay.style.display = 'none';
            instructorCodeLabel.style.display = 'none';
        }
    }
}

/**
 * Load available courses for selection
 */
async function loadAvailableCourses() {
    try {
        const courseSelectDropdown = document.getElementById('course-select-dropdown');
        if (!courseSelectDropdown) return;
        
        // Fetch courses from the API
        const response = await fetch('/api/courses/available/all', {
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to fetch courses');
        }
        
        const courses = result.data || [];

        populateCourseDropdown(courseSelectDropdown, courses, 'Choose one of your courses...');
        await appendSuperCourseOption(courseSelectDropdown);

        console.log('Available courses loaded:', dedupeCourses(courses).length);
        
    } catch (error) {
        console.error('Error loading available courses:', error);
        // Keep the placeholder option if API fails
        const courseSelectDropdown = document.getElementById('course-select-dropdown');
        if (courseSelectDropdown) {
            courseSelectDropdown.innerHTML = '<option value="">Error loading courses</option>';
        }
    }
}

async function loadJoinableCourses() {
    try {
        const joinCourseSelectDropdown = document.getElementById('join-course-select-dropdown');
        if (!joinCourseSelectDropdown) return;

        const response = await fetch('/api/courses/available/joinable', {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to fetch joinable courses');
        }

        const courses = result.data || [];
        populateCourseDropdown(joinCourseSelectDropdown, courses, 'Choose a course to join...');
    } catch (error) {
        console.error('Error loading joinable courses:', error);
        const joinCourseSelectDropdown = document.getElementById('join-course-select-dropdown');
        if (joinCourseSelectDropdown) {
            joinCourseSelectDropdown.innerHTML = '<option value="">Error loading joinable courses</option>';
        }
    }
}

/**
 * Load and display the current selected course
 */
async function loadCurrentCourse() {
    try {
        // Get course ID from localStorage or URL params
        const urlParams = new URLSearchParams(window.location.search);
        const courseIdFromUrl = urlParams.get('courseId');
        const courseIdFromStorage = localStorage.getItem('selectedCourseId');
        let courseId = courseIdFromUrl || courseIdFromStorage;

        // When the candidate came only from localStorage (no URL override),
        // verify it against the user's owned courses BEFORE issuing any
        // per-course API request. A stale storage value (e.g. from a different
        // role or revoked access) must not drive requests to that course's
        // endpoints — those would leak the existence of the course and might
        // bypass authorization checks downstream.
        if (!courseIdFromUrl && courseIdFromStorage) {
            const userId = getCurrentInstructorId();
            if (userId) {
                const isTAUser = typeof isTA === 'function' && isTA();
                const response = await authenticatedFetch(
                    isTAUser ? `/api/courses/ta/${userId}` : `/api/onboarding/instructor/${userId}`
                );
                if (response.ok) {
                    const result = await response.json();
                    const ownedCourses = dedupeCourses(
                        isTAUser ? (result.data || []) : (result.data?.courses || [])
                    );
                    if (!ownedCourses.some((c) => c.courseId === courseId)) {
                        console.log(`Ignoring unauthorized selectedCourseId ${courseId} (not in instructor's courses)`);
                        if (ownedCourses.length > 0) {
                            const firstCourse = ownedCourses[0];
                            await setSelectedCourse(firstCourse.courseId, getCourseDisplayName(firstCourse));
                            return;
                        }
                        // No owned courses at all — clear the stale value so
                        // the rest of the flow falls through to the empty
                        // selector instead of fetching the stale courseId.
                        try { localStorage.removeItem('selectedCourseId'); } catch (_) {}
                        courseId = null;
                    }
                }
            }
        }

        if (!courseId) {
            // Try to get the first course from the user's courses
            const userId = getCurrentInstructorId();
            if (userId) {
                const isTAUser = typeof isTA === 'function' && isTA();
                const response = await authenticatedFetch(
                    isTAUser ? `/api/courses/ta/${userId}` : `/api/onboarding/instructor/${userId}`
                );
                if (response.ok) {
                    const result = await response.json();
                    const courses = isTAUser ? (result.data || []) : (result.data?.courses || []);
                    if (courses.length > 0) {
                        const firstCourse = dedupeCourses(courses)[0];
                        await setSelectedCourse(firstCourse.courseId, getCourseDisplayName(firstCourse));
                        return;
                    }
                }
            }

            // No course found, show course selector
            showCourseSelector();
            return;
        }

        // Fetch course details
        const response = await authenticatedFetch(`/api/courses/${courseId}`);
        if (response.ok) {
            const result = await response.json();
            if (result.success && result.data) {
                await setSelectedCourse(courseId, getCourseDisplayName({
                    courseId,
                    courseName: result.data.courseName || result.data.name || courseId,
                    status: result.data.status
                }), result.data);
            } else {
                // Course not found, clear selection
                clearSelectedCourse();
                showCourseSelector();
            }
        } else {
            // Course not accessible, clear selection
            clearSelectedCourse();
            showCourseSelector();
        }

    } catch (error) {
        console.error('Error loading current course:', error);
        showCourseSelector();
    }
}

/**
 * Set the selected course and update UI
 * @param {string} courseId - Course ID to set
 * @param {string} courseName - Course name to display
 * @param {Object|null} courseData - Optional course details payload
 */
async function setSelectedCourse(courseId, courseName, courseData = null) {
    let resolvedCourseData = courseData;
    // Pin the courseId for the duration of this cascade so child loaders
    // (loadStatistics, loadFlaggedContent, loadStruggleTopics, ...) all see
    // the same value, even if localStorage gets mutated externally before
    // the async tail finishes.
    _pinnedCourseId = courseId;

    // Store in localStorage
    localStorage.setItem('selectedCourseId', courseId);
    
    // Update URL if not already set
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('courseId') !== courseId) {
        urlParams.set('courseId', courseId);
        window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
    }

    // Cross-course Super Chat struggle view: skip every per-course loader (they
    // would 404 against the sentinel id) and show only the aggregated widgets.
    if (courseId === SUPER_COURSE_FILTER_ID) {
        await enterSuperCourseStruggleView();
        if (_pinnedCourseId === courseId) {
            _pinnedCourseId = null;
        }
        return;
    }

    // Returning to a real course: restore the flagged card the Super Chat view
    // hides (other cards are re-shown by their own loaders below).
    const flaggedSectionEl = document.querySelector('.flagged-section');
    if (flaggedSectionEl) {
        flaggedSectionEl.style.display = '';
    }

    if (!resolvedCourseData) {
        const response = await authenticatedFetch(`/api/courses/${courseId}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch course details for ${courseId}`);
        }

        const result = await response.json();
        if (!result.success || !result.data) {
            throw new Error(result.message || `Course ${courseId} is not accessible`);
        }

        resolvedCourseData = result.data;
    }

    window.selectedCourseData = resolvedCourseData;
    window.currentCourseData = resolvedCourseData;
    
    // Update UI
    const courseNameDisplay = document.getElementById('course-name-display');
    if (courseNameDisplay) {
        courseNameDisplay.textContent = courseName || resolvedCourseData.courseName || resolvedCourseData.name || courseId;
    }
    updateCourseCodeDisplay(resolvedCourseData);
    
    // Show course selection container
    const courseSelectionContainer = document.getElementById('course-selection-container');
    if (courseSelectionContainer) {
        courseSelectionContainer.style.display = 'block';
    }
    
    // Hide course selector, show current course display
    hideCourseSelector();
    
    // Update course context in auth system
    if (typeof setCurrentCourseId === 'function') {
        await setCurrentCourseId(courseId);
    }
    
    // Update navigation links
    updateNavigationLinks();
    
    // Clear any cached course data
    if (typeof courseIdCache !== 'undefined') {
        courseIdCache = null;
    }
    
    // Fetch anonymize students setting for this course
    try {
        const anonRes = await fetch(`/api/settings/anonymize-students?courseId=${courseId}`);
        const anonData = await anonRes.json();
        anonymizeStudentsEnabled = anonData.success && anonData.enabled;
    } catch (e) {
        anonymizeStudentsEnabled = false;
    }

    // Reload page data with new course
    await loadStatistics();
    await loadFlaggedContent();
    await checkMissingContent();
    await loadStruggleTopics();
    await loadApprovedGlobalTopics();
    await loadPersistenceTopics();
    
    // Start polling for struggle activity updates
    startPollingStruggleActivity();

    // Load initial struggle activity data for the live table
    await loadInitialStruggleActivity();

    // Reset and load weekly struggle chart
    weeklyChartOffset = 0;
    await loadWeeklyStruggleChart();

    // Only release the pin once every dependent loader has run. After this
    // point getSelectedCourseId() falls back to localStorage/URL as usual.
    if (_pinnedCourseId === courseId) {
        _pinnedCourseId = null;
    }
}

/**
 * Enter the cross-course Super Chat struggle view.
 * Hides per-course cards and shows the struggle widgets fed by the
 * source: 'superCourse' aggregate endpoints.
 */
async function enterSuperCourseStruggleView() {
    const courseNameDisplay = document.getElementById('course-name-display');
    if (courseNameDisplay) {
        courseNameDisplay.textContent = 'Super Chat (all courses)';
    }

    const courseSelectionContainer = document.getElementById('course-selection-container');
    if (courseSelectionContainer) {
        courseSelectionContainer.style.display = 'block';
    }

    hideCourseSelector();
    updateNavigationLinks();

    // Names span courses here, so default to anonymized to avoid cross-course
    // exposure in the aggregated table.
    anonymizeStudentsEnabled = true;

    // Hide course-specific cards that don't apply to a cross-course view.
    ['statistics-section', 'approved-topics-section', 'persistence-topics-section', 'missing-items-section']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    const flaggedSection = document.querySelector('.flagged-section');
    if (flaggedSection) flaggedSection.style.display = 'none';

    // Show the struggle section; swap the per-student snapshot for an explainer.
    const struggleSection = document.getElementById('struggle-topics-section');
    if (struggleSection) struggleSection.style.display = 'block';
    const struggleContent = document.getElementById('struggle-topics-content');
    if (struggleContent) {
        struggleContent.innerHTML = '<p style="color:#666; padding:10px 0;">Struggles students raised in the cross-course Super Chat, aggregated across all courses. Each is also recorded on the course that owns the topic.</p>';
    }

    // Aggregated Super Chat widgets.
    startPollingStruggleActivity();
    await loadInitialStruggleActivity();
    weeklyChartOffset = 0;
    await loadWeeklyStruggleChart();
}

/**
 * Clear the selected course
 */
function clearSelectedCourse() {
    localStorage.removeItem('selectedCourseId');
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.delete('courseId');
    window.history.replaceState({}, '', window.location.pathname);
    // Drop any pinned course so subsequent getSelectedCourseId() calls
    // reflect the cleared state immediately.
    _pinnedCourseId = null;
}

/**
 * Show the course selector UI
 */
function showCourseSelector() {
    const currentCourseDisplay = document.querySelector('.current-course-display');
    const courseSelector = document.getElementById('course-selector');
    
    if (currentCourseDisplay) {
        currentCourseDisplay.style.display = 'none';
    }
    
    if (courseSelector) {
        courseSelector.style.display = 'flex';
    }

    resetJoinCourseSelection();
    loadAvailableCourses();
    loadJoinableCourses();
}

/**
 * Hide the course selector UI
 */
function hideCourseSelector() {
    const currentCourseDisplay = document.querySelector('.current-course-display');
    const courseSelector = document.getElementById('course-selector');
    const courseSelectDropdown = document.getElementById('course-select-dropdown');
    
    if (currentCourseDisplay) {
        currentCourseDisplay.style.display = 'flex';
    }
    
    if (courseSelector) {
        courseSelector.style.display = 'none';
    }
    
    if (courseSelectDropdown) {
        courseSelectDropdown.value = '';
    }

    resetJoinCourseSelection();
}

/**
 * Reset join-course selection state
 */
function resetJoinCourseSelection() {
    const selectedCourseDetails = document.getElementById('selected-course-details');
    const joinCourseBtn = document.getElementById('join-course-btn');
    const joinCourseSelectDropdown = document.getElementById('join-course-select-dropdown');
    const codeEntryGroup = document.getElementById('instructor-code-entry-group');
    const codeInput = document.getElementById('instructor-course-code-input');
    selectedCourseRequiresInstructorCode = !canBypassInstructorCourseCodes;

    if (selectedCourseDetails) {
        selectedCourseDetails.style.display = 'none';
    }
    
    if (joinCourseBtn) {
        joinCourseBtn.style.display = 'none';
        joinCourseBtn.disabled = false;
        joinCourseBtn.textContent = 'Join Course';
        delete joinCourseBtn.dataset.courseId;
        delete joinCourseBtn.dataset.courseName;
    }

    if (joinCourseSelectDropdown) {
        joinCourseSelectDropdown.value = '';
    }

    if (codeEntryGroup) {
        codeEntryGroup.style.display = 'none';
    }

    if (codeInput) {
        codeInput.value = '';
    }

    clearJoinCourseCodeFeedback();
}

/**
 * Handle join-course dropdown change
 */
async function handleJoinCourseSelectionChange(event) {
    const courseId = event.target.value;
    const selectedCourseDetails = document.getElementById('selected-course-details');
    const joinCourseBtn = document.getElementById('join-course-btn');
    const selectedCourseName = document.getElementById('selected-course-name');
    const selectedCourseId = document.getElementById('selected-course-id');
    const joinCourseDescription = document.getElementById('join-course-description');
    const codeEntryGroup = document.getElementById('instructor-code-entry-group');
    clearJoinCourseCodeFeedback();

    if (!courseId) {
        resetJoinCourseSelection();
        return;
    }

    const selectedOption = event.target.options[event.target.selectedIndex];
    const courseName = selectedOption ? selectedOption.textContent : courseId;
    selectedCourseRequiresInstructorCode = !canBypassInstructorCourseCodes;

    if (selectedCourseDetails) {
        selectedCourseDetails.style.display = 'block';
    }

    if (selectedCourseName) {
        selectedCourseName.textContent = courseName;
    }

    if (selectedCourseId) {
        selectedCourseId.textContent = courseId;
    }

    if (joinCourseDescription) {
        joinCourseDescription.textContent = canBypassInstructorCourseCodes
            ? 'You have admin access, so you can join this course without entering an instructor code.'
            : 'Enter the instructor course code to join this course.';
    }

    if (codeEntryGroup) {
        codeEntryGroup.style.display = canBypassInstructorCourseCodes ? 'none' : 'block';
    }

    if (joinCourseBtn) {
        joinCourseBtn.style.display = 'inline-block';
        joinCourseBtn.disabled = false;
        joinCourseBtn.textContent = 'Join Course';
        joinCourseBtn.dataset.courseId = courseId;
        joinCourseBtn.dataset.courseName = courseName;
    }

    if (!canBypassInstructorCourseCodes) {
        if (joinCourseBtn) joinCourseBtn.disabled = true;
        try {
            const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/instructor-join-status`, {
                credentials: 'include'
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to check instructor access');
            }
            if (joinCourseBtn?.dataset.courseId !== courseId) return;

            selectedCourseRequiresInstructorCode = result.data?.requiresCode !== false;
            if (joinCourseDescription) {
                joinCourseDescription.textContent = selectedCourseRequiresInstructorCode
                    ? 'Enter the instructor course code to join this course.'
                    : (result.data?.reason === 'instructorOfRecord'
                        ? 'Another instructor has created this course shell. Since you are an instructor of record, you can join it without an instructor code.'
                        : 'No instructor code is required for you to join this course.');
            }
            if (codeEntryGroup) {
                codeEntryGroup.style.display = selectedCourseRequiresInstructorCode ? 'block' : 'none';
            }
        } catch (error) {
            console.error('Error checking instructor-of-record access:', error);
            selectedCourseRequiresInstructorCode = true;
            if (codeEntryGroup) codeEntryGroup.style.display = 'block';
        } finally {
            if (joinCourseBtn?.dataset.courseId === courseId) joinCourseBtn.disabled = false;
        }
    }
}

/**
 * Handle joining a course
 */
async function handleJoinCourse() {
    const joinCourseBtn = document.getElementById('join-course-btn');
    const instructorCodeInput = document.getElementById('instructor-course-code-input');
    if (!joinCourseBtn) return;
    
    const courseId = joinCourseBtn.dataset.courseId;
    const courseName = joinCourseBtn.dataset.courseName;
    const code = instructorCodeInput ? instructorCodeInput.value.trim().toUpperCase() : '';

    if (!courseId) {
        showErrorMessage('No course selected');
        return;
    }

    if (selectedCourseRequiresInstructorCode && !code) {
        setJoinCourseCodeFeedback('Instructor course code is required to join this course.');
        return;
    }

    clearJoinCourseCodeFeedback();
    
    try {
        // Show loading state
        const originalText = joinCourseBtn.textContent;
        joinCourseBtn.textContent = 'Joining Course...';
        joinCourseBtn.disabled = true;
        
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            throw new Error('No instructor ID found. User not authenticated.');
        }
        
        const result = await BiocBotCourseJoin.joinInstructorCourse({
            courseId,
            instructorId,
            code
        });
        console.log('Successfully joined course:', result);

        await Promise.all([
            loadAvailableCourses(),
            loadJoinableCourses()
        ]);

        // Mark instructor's onboarding as complete since they joined an existing course
        if (typeof markInstructorOnboardingComplete === 'function') {
            await markInstructorOnboardingComplete(courseId);
        } else {
            // Fallback: call the API directly
            try {
                await authenticatedFetch('/api/onboarding/complete', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        courseId: courseId,
                        instructorId: instructorId
                    })
                });
            } catch (error) {
                console.warn('Failed to mark onboarding as complete:', error);
            }
        }
        
        // Set the selected course
        await setSelectedCourse(courseId, courseName);
        
        // Show success message
        showSuccessMessage('Successfully joined the course!');
        
        // Reload page data
        await loadStatistics();
        await loadFlaggedContent();
        await checkMissingContent();
        
    } catch (error) {
        console.error('Error joining course:', error);
        if (instructorCodeInput && /course code|required|invalid/i.test(error.message)) {
            setJoinCourseCodeFeedback(error.message);
        } else {
            showErrorMessage(`Error joining course: ${error.message}`);
        }
        
        // Reset button state
        if (joinCourseBtn) {
            joinCourseBtn.textContent = 'Join Course';
            joinCourseBtn.disabled = false;
        }
    }
}

/**
 * Get the currently selected course ID
 * @returns {string|null} Current course ID or null
 */
function getSelectedCourseId() {
    // During a setSelectedCourse(courseId) cascade we pin the courseId so
    // dependent loaders all use the same value even if localStorage gets
    // mutated mid-flight.
    if (_pinnedCourseId) return _pinnedCourseId;
    const urlParams = new URLSearchParams(window.location.search);
    const courseIdFromUrl = urlParams.get('courseId');
    const courseIdFromStorage = localStorage.getItem('selectedCourseId');
    return courseIdFromUrl || courseIdFromStorage || null;
}

/**
 * Update navigation links to include course ID
 */
function updateNavigationLinks() {
    const courseId = getSelectedCourseId();
    if (!courseId) return;
    
    // List of navigation link IDs and their base paths
    const navLinks = {
        'nav-home': '/instructor/home',
        'nav-documents': '/instructor/documents',
        'nav-onboarding': '/instructor/onboarding',
        'nav-flagged': '/instructor/flagged',
        'nav-student-hub': '/instructor/student-hub',
        'nav-downloads': '/instructor/downloads',
        'nav-ta-hub': '/instructor/ta-hub',
        'nav-settings': '/instructor/settings'
    };
    
    // Update each navigation link
    Object.keys(navLinks).forEach(linkId => {
        const link = document.getElementById(linkId);
        if (link) {
            const basePath = navLinks[linkId];
            const url = new URL(basePath, window.location.origin);
            url.searchParams.set('courseId', courseId);
            link.href = url.pathname + url.search;
        }
    });
    
    // Also update the "View Flagged Questions" button
    const viewFlagsBtn = document.getElementById('view-flags-btn');
    if (viewFlagsBtn) {
        const url = new URL('/instructor/flagged', window.location.origin);
        url.searchParams.set('courseId', courseId);
        viewFlagsBtn.href = url.pathname + url.search;
    }
} 

/**
 * Load persistence (all-time) struggle topics for the selected course
 */
async function loadPersistenceTopics() {
    try {
        const courseId = getSelectedCourseId();
        if (!courseId) return;

        const [response, approvedTopics] = await Promise.all([
            authenticatedFetch(`/api/struggle-activity/persistence/${courseId}`),
            fetchApprovedTopicDetails(courseId).catch((error) => {
                console.warn('Could not load approved topic details for persistence cards:', error);
                return window.courseApprovedTopicDetails || [];
            })
        ]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const result = await response.json();
        const topics = result.data || [];

        window.persistenceTopics = topics;
        renderPersistenceTopics(topics, courseId, approvedTopics);

    } catch (error) {
        console.error('Error loading persistence topics:', error);
        document.getElementById('persistence-topics-section')?.setAttribute('style', 'display: none;');
    }
}

/**
 * Load approved global topics for the selected course
 */
async function loadApprovedGlobalTopics() {
    try {
        const courseId = getSelectedCourseId();
        if (!courseId) return;

        const topics = await fetchApprovedTopicDetails(courseId);

        renderApprovedGlobalTopics(topics, courseId);
    } catch (error) {
        console.error('Error loading approved global topics:', error);
        document.getElementById('approved-topics-section')?.setAttribute('style', 'display: none;');
    }
}

/**
 * Render approved global topics list with inline editing capabilities
 * @param {Array<string|Object>} topics - Approved topic entries
 * @param {string} courseId - Current course ID
 */
function renderApprovedGlobalTopics(topics, courseId) {
    const container = document.getElementById('approved-topics-content');
    const section = document.getElementById('approved-topics-section');
    if (!container || !section) return;

    section.style.display = 'block';

    const cleanTopics = normalizeApprovedTopicDetails(topics);
    setApprovedTopicGlobals(courseId, cleanTopics);

    // Build editable chips
    const chips = cleanTopics.map((topicEntry, index) => {
        const unitBadge = topicEntry.unitId
            ? `<span class="topic-unit-badge mapped">${escapeHtml(topicEntry.unitId)}</span>`
            : '<span class="topic-unit-badge unassigned">Unassigned</span>';

        return `
        <span class="approved-topic-chip" data-index="${index}" data-topic="${escapeHtml(topicEntry.topic)}">
            <span class="topic-chip-label" ondblclick="startEditTopic(this)">${escapeHtml(topicEntry.topic)}</span>
            ${unitBadge}
            <button class="topic-chip-remove" onclick="removeApprovedTopic(${index})" title="Remove topic">&times;</button>
        </span>
    `;
    }).join('');

    const emptyMessage = cleanTopics.length === 0
        ? '<p class="no-data-message" style="text-align: center; color: #666; font-style: italic; padding: 10px;">No approved global topics set yet. Add one below.</p>'
        : '';

    container.innerHTML = `
        <div class="approved-topics-chips-container" id="approved-topics-chips">
            ${emptyMessage}
            ${chips}
        </div>
        <div class="approved-topics-add-row">
            <input
                type="text"
                id="new-topic-input"
                class="approved-topic-input"
                placeholder="Type a new topic and press Enter..."
                onkeydown="handleNewTopicKeydown(event)"
            />
            <select id="new-topic-unit-select" class="approved-topic-unit-select" title="Assign this topic to a unit">
                ${renderUnitOptions('', true)}
            </select>
            <button class="approved-topic-add-btn" onclick="addApprovedTopic()" title="Add topic">+ Add</button>
        </div>
        <div class="approved-topics-footer">
            <span>Total topics: <strong>${cleanTopics.length}</strong></span>
            <span class="approved-topics-hint">Double-click a topic to edit it</span>
        </div>
    `;

    const newTopicUnitSelect = container.querySelector('#new-topic-unit-select');
    if (newTopicUnitSelect) {
        newTopicUnitSelect.setAttribute('aria-label', 'Unit for new topic');
        addKeyboardPickerActivation(newTopicUnitSelect);
    }
}

// ===========================
// APPROVED TOPICS CRUD
// ===========================

/**
 * Save the current approved topics list to the server
 * @param {string} [courseId] - Course ID (falls back to selected course)
 * @returns {Promise<boolean>} Whether save succeeded
 */
async function saveApprovedTopics(courseId) {
    courseId = courseId || getSelectedCourseId();
    if (!courseId) return false;

    const topics = window.courseApprovedTopicDetails || window.courseApprovedTopics || [];

    try {
        const response = await authenticatedFetch(`/api/courses/${courseId}/approved-topics`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topics })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP ${response.status}`);
        }

        const result = await response.json().catch(() => ({}));
        if (result?.data?.topics) {
            setApprovedTopicGlobals(courseId, result.data.topics);
        }

        return true;
    } catch (error) {
        console.error('Error saving approved topics:', error);
        showErrorMessage(`Failed to save topics: ${error.message}`);
        return false;
    }
}

/**
 * Add a new approved topic from the input field
 */
async function addApprovedTopic() {
    const input = document.getElementById('new-topic-input');
    if (!input) return;

    const value = input.value.trim();
    if (!value) {
        input.focus();
        return;
    }

    const topics = window.courseApprovedTopicDetails || [];

    // Check for duplicates (case-insensitive)
    if (topics.some(t => t.topic.toLowerCase() === value.toLowerCase())) {
        showErrorMessage('This topic already exists.');
        input.focus();
        input.select();
        return;
    }

    const unitSelect = document.getElementById('new-topic-unit-select');
    const newTopic = {
        topic: value,
        unitId: normalizeTopicUnitId(unitSelect?.value),
        source: 'manual',
        createdAt: new Date().toISOString()
    };

    topics.push(newTopic);
    setApprovedTopicGlobals(getSelectedCourseId(), topics);

    const courseId = getSelectedCourseId();

    // Optimistically re-render
    renderApprovedGlobalTopics(topics, courseId);
    showSuccessMessage(`Added topic "${value}"`);

    // Persist to server
    const saved = await saveApprovedTopics(courseId);
    if (!saved) {
        // Revert on failure
        topics.pop();
        setApprovedTopicGlobals(courseId, topics);
        renderApprovedGlobalTopics(topics, courseId);
    } else {
        // Focus the input for rapid entry
        const newInput = document.getElementById('new-topic-input');
        if (newInput) newInput.focus();
    }
}

/**
 * Remove an approved topic by index
 * @param {number} index - Index in the approved topics array
 */
async function removeApprovedTopic(index) {
    const topics = window.courseApprovedTopicDetails || [];
    if (index < 0 || index >= topics.length) return;

    const removedTopic = topics[index];
    const removedLabel = removedTopic.topic;

    if (!confirm(`Remove the topic "${removedLabel}"?`)) return;

    topics.splice(index, 1);
    setApprovedTopicGlobals(getSelectedCourseId(), topics);

    const courseId = getSelectedCourseId();

    // Optimistically re-render
    renderApprovedGlobalTopics(topics, courseId);
    showSuccessMessage(`Removed topic "${removedLabel}"`);

    // Persist to server
    const saved = await saveApprovedTopics(courseId);
    if (!saved) {
        // Revert on failure
        topics.splice(index, 0, removedTopic);
        setApprovedTopicGlobals(courseId, topics);
        renderApprovedGlobalTopics(topics, courseId);
    }
}

/**
 * Start inline editing a topic chip label
 * Triggered by double-clicking the label text
 * @param {HTMLElement} labelEl - The .topic-chip-label span
 */
function startEditTopic(labelEl) {
    const chip = labelEl.closest('.approved-topic-chip');
    if (!chip || chip.classList.contains('editing')) return;

    const index = parseInt(chip.dataset.index, 10);
    const currentTopic = (window.courseApprovedTopicDetails || [])[index];
    const currentValue = currentTopic?.topic;
    if (!currentValue) return;

    chip.classList.add('editing');

    // Replace label with an input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'topic-chip-edit-input';
    input.value = currentValue;

    // Save on Enter, cancel on Escape
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitEditTopic(chip, index, input.value.trim());
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEditTopic(chip, currentValue);
        }
    });

    // Save on blur (clicking away)
    input.addEventListener('blur', () => {
        // Small delay so that pressing Escape can fire first
        setTimeout(() => {
            if (chip.classList.contains('editing')) {
                commitEditTopic(chip, index, input.value.trim());
            }
        }, 100);
    });

    labelEl.replaceWith(input);
    input.focus();
    input.select();
}

/**
 * Commit an inline topic edit
 * @param {HTMLElement} chip - The .approved-topic-chip element
 * @param {number} index - Index in the topics array
 * @param {string} newValue - New topic text
 */
async function commitEditTopic(chip, index, newValue) {
    if (!chip.classList.contains('editing')) return;
    chip.classList.remove('editing');

    const topics = window.courseApprovedTopicDetails || [];
    const oldTopic = topics[index];
    const oldValue = oldTopic?.topic;

    // If empty or unchanged, just restore
    if (!newValue || newValue === oldValue) {
        cancelEditTopic(chip, oldValue);
        return;
    }

    // Check for duplicates
    if (topics.some((t, i) => i !== index && t.topic.toLowerCase() === newValue.toLowerCase())) {
        showErrorMessage('A topic with that name already exists.');
        cancelEditTopic(chip, oldValue);
        return;
    }

    // Apply change
    topics[index] = {
        ...oldTopic,
        topic: newValue
    };
    setApprovedTopicGlobals(getSelectedCourseId(), topics);

    const courseId = getSelectedCourseId();
    renderApprovedGlobalTopics(topics, courseId);
    showSuccessMessage(`Renamed "${oldValue}" to "${newValue}"`);

    // Persist
    const saved = await saveApprovedTopics(courseId);
    if (!saved) {
        topics[index] = oldTopic;
        setApprovedTopicGlobals(courseId, topics);
        renderApprovedGlobalTopics(topics, courseId);
    }
}

/**
 * Cancel an inline edit and restore the original label
 * @param {HTMLElement} chip - The .approved-topic-chip element
 * @param {string} originalValue - Original topic text to restore
 */
function cancelEditTopic(chip, originalValue) {
    chip.classList.remove('editing');
    const input = chip.querySelector('.topic-chip-edit-input');
    if (input) {
        const label = document.createElement('span');
        label.className = 'topic-chip-label';
        label.setAttribute('ondblclick', 'startEditTopic(this)');
        label.textContent = originalValue;
        input.replaceWith(label);
    }
}

/**
 * Handle keydown in the "add new topic" input
 * @param {KeyboardEvent} event
 */
function handleNewTopicKeydown(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        addApprovedTopic();
    }
}

/**
 * Render persistence topics list
 * @param {Array} topics - Array of persistence topic objects
 */
function renderPersistenceTopics(topics, courseId = getSelectedCourseId(), approvedTopics = window.courseApprovedTopicDetails || []) {
    const container = document.getElementById('persistence-topics-content');
    const section = document.getElementById('persistence-topics-section');
    
    if (!container || !section) return;

    if (topics.length === 0) {
        section.style.display = 'block';
        container.innerHTML = '<p class="no-data-message" style="text-align: center; color: #666; font-style: italic; padding: 20px;">No struggle data recorded yet.</p>';
        return;
    }

    section.style.display = 'block';
    setApprovedTopicGlobals(courseId, approvedTopics);
    
    // Sort by count (descending)
    const sortedTopics = [...topics].sort((a, b) => b.studentCount - a.studentCount);

    let html = '<div class="persistence-topics-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 15px;">';
    
    sortedTopics.forEach(topicData => {
        const displayTopic = topicData.topic.charAt(0).toUpperCase() + topicData.topic.slice(1);
        const count = topicData.studentCount;
        const approvedTopic = findApprovedTopicByLabel(topicData.topic);
        const unitBadge = approvedTopic?.unitId
            ? `<span class="topic-unit-badge mapped">${escapeHtml(approvedTopic.unitId)}</span>`
            : '<span class="topic-unit-badge unassigned">Unassigned</span>';
        
        // Determine severity color
        let severityColor = '#28a745'; // Green (low)
        if (count >= 5) severityColor = '#ffc107'; // Yellow (medium)
        if (count >= 10) severityColor = '#dc3545'; // Red (high)
        
        html += `
            <div class="persistence-topic-card clickable-topic-card" data-topic="${escapeHtml(topicData.topic)}" role="button" tabindex="0" title="Assign this topic to a unit" style="background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); border-top: 4px solid ${severityColor}; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center;">
                <div style="font-size: 2.5em; font-weight: bold; color: #333; margin-bottom: 5px;">${count}</div>
                <div style="font-size: 0.9em; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">Students</div>
                <h3 style="margin: 0; font-size: 1.1em; color: #333; word-break: break-word;">${displayTopic}</h3>
                ${unitBadge}
            </div>
        `;
    });
    
    html += '</div>';
    
    container.innerHTML = html;

    container.querySelectorAll('.clickable-topic-card').forEach((card) => {
        const openAssignment = () => openTopicUnitAssignmentModal(card.dataset.topic);
        card.addEventListener('click', openAssignment);
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openAssignment();
            }
        });
    });
}

/**
 * Download cumulative (persistence) topics as a .txt file
 */
async function downloadPersistenceTopics() {
    const courseId = getSelectedCourseId();
    if (!courseId) {
        showNotification?.('No course selected', 'error');
        return;
    }

    const topics = window.persistenceTopics || [];
    if (topics.length === 0) {
        showNotification?.('No cumulative topics to download', 'info');
        return;
    }

    const courseNameEl = document.getElementById('course-name-display');
    const courseName = (courseNameEl?.textContent || courseId).trim();

    const sorted = [...topics].sort((a, b) => b.studentCount - a.studentCount);

    const lines = [];
    lines.push(`Course: ${courseName}`);
    lines.push(`Course ID: ${courseId}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Total Topics: ${sorted.length}`);
    lines.push('');
    lines.push('Cumulative Struggle Topics (All Unique Students)');
    lines.push('='.repeat(50));
    sorted.forEach(t => {
        const topicLabel = t.topic.charAt(0).toUpperCase() + t.topic.slice(1);
        lines.push(`${topicLabel}\t${t.studentCount} student${t.studentCount === 1 ? '' : 's'}`);
    });

    const content = lines.join('\n');
    const safeName = courseName.replace(/[^a-z0-9_\-]+/gi, '_');
    const filename = `${safeName}_cumulative_topics.txt`;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function ensureTopicUnitAssignmentModal() {
    let modal = document.getElementById('topic-unit-assignment-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'topic-unit-assignment-modal';
    modal.className = 'topic-unit-modal';
    modal.innerHTML = `
        <div class="topic-unit-modal-card">
            <div class="topic-unit-modal-header">
                <h3>Assign Topic to Unit</h3>
                <button type="button" class="topic-unit-modal-close" aria-label="Close">&times;</button>
            </div>
            <div class="topic-unit-modal-body">
                <p class="topic-unit-modal-topic" id="topic-unit-modal-topic"></p>
                <label for="topic-unit-select">Unit</label>
                <select id="topic-unit-select" class="topic-unit-select"></select>
                <p class="topic-unit-modal-hint">This uses the stable unit name, such as Unit 1, not the renamed display title.</p>
            </div>
            <div class="topic-unit-modal-actions">
                <button type="button" class="approved-topic-add-btn secondary" id="topic-unit-cancel-btn">Cancel</button>
                <button type="button" class="approved-topic-add-btn" id="topic-unit-save-btn">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => {
        modal.classList.remove('show');
        modal.dataset.topic = '';
    };

    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
    });
    modal.querySelector('.topic-unit-modal-close')?.addEventListener('click', closeModal);
    modal.querySelector('#topic-unit-cancel-btn')?.addEventListener('click', closeModal);
    modal.querySelector('#topic-unit-save-btn')?.addEventListener('click', saveTopicUnitAssignment);

    return modal;
}

async function openTopicUnitAssignmentModal(topicLabel) {
    const courseId = getSelectedCourseId();
    if (!courseId) {
        showErrorMessage('No course selected.');
        return;
    }

    if (!window.courseApprovedTopicDetails) {
        await fetchApprovedTopicDetails(courseId);
    }

    const approvedTopic = findApprovedTopicByLabel(topicLabel);
    if (!approvedTopic) {
        showErrorMessage('This cumulative topic is not in the approved topic list yet.');
        return;
    }

    const modal = ensureTopicUnitAssignmentModal();
    modal.dataset.topic = approvedTopic.topic;
    modal.querySelector('#topic-unit-modal-topic').textContent = approvedTopic.topic;
    modal.querySelector('#topic-unit-select').innerHTML = renderUnitOptions(approvedTopic.unitId || '', true);
    modal.classList.add('show');
}

async function saveTopicUnitAssignment() {
    const modal = ensureTopicUnitAssignmentModal();
    const courseId = getSelectedCourseId();
    const topic = modal.dataset.topic;
    const unitId = normalizeTopicUnitId(modal.querySelector('#topic-unit-select')?.value);
    const saveButton = modal.querySelector('#topic-unit-save-btn');

    if (!courseId || !topic) return;

    const originalText = saveButton?.textContent || 'Save';
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
    }

    try {
        const response = await authenticatedFetch(`/api/courses/${courseId}/approved-topics/unit`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic, unitId })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP ${response.status}`);
        }

        const result = await response.json();
        setApprovedTopicGlobals(courseId, result?.data?.topics || []);
        renderApprovedGlobalTopics(window.courseApprovedTopicDetails || [], courseId);
        renderPersistenceTopics(window.persistenceTopics || [], courseId, window.courseApprovedTopicDetails || []);

        modal.classList.remove('show');
        showSuccessMessage(unitId
            ? `Assigned "${topic}" to ${unitId}.`
            : `Marked "${topic}" as unassigned.`);
    } catch (error) {
        console.error('Error assigning topic to unit:', error);
        showErrorMessage(`Failed to assign topic: ${error.message}`);
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = originalText;
        }
    }
}

/**
 * Toggle visibility of struggle topic content
 * @param {HTMLElement} headerElement - The header element clicked
 */
function toggleTopic(headerElement) {
    const topicItem = headerElement.closest('.struggle-topic-item');
    if (topicItem) {
        topicItem.classList.toggle('collapsed');
    }
}

/**
 * Toggle visibility of an entire home section
 * @param {HTMLElement} headerElement - The header clicked
 */
function toggleSection(headerElement) {
    const section = headerElement.closest('.home-section');
    if (section) {
        section.classList.toggle('section-collapsed');
        headerElement.setAttribute('aria-expanded', String(!section.classList.contains('section-collapsed')));
    }
}

document.addEventListener('keydown', (event) => {
    const header = event.target.closest('[role="button"].section-header');
    if (!header || (event.key !== 'Enter' && event.key !== ' ')) return;
    if (event.target.closest('button')) return;
    event.preventDefault();
    toggleSection(header);
});
