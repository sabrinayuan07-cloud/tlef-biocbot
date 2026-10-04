/**
 * Instructor: course id resolution and course data loading.
 */

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
    // Check if we have a courseId from URL parameters (onboarding redirect)
    const urlParams = new URLSearchParams(window.location.search);
    const courseIdFromUrl = urlParams.get('courseId');
    
    if (courseIdFromUrl) {
        return courseIdFromUrl;
    }

    // A selected course is stored for the whole browser origin, so it can
    // survive a logout, an account switch, or revoked course access. Wait for
    // the current user and validate the stored value before any settings
    // loader is allowed to cache and use it.
    if (!getCurrentInstructorId()) {
        await waitForAuth();
    }

    const userId = getCurrentInstructorId(); // This works for instructors and TAs
    const storedCourseId = localStorage.getItem('selectedCourseId');
    let accessibleCourses = null;

    // Resolve the user's accessible courses once. Besides selecting a default,
    // this prevents stale localStorage from causing every settings section to
    // issue its own unauthorized request.
    try {
        if (!userId) {
            console.error('No user ID available');
            return null;
        }
        
        // Check if user is TA or instructor using the proper role check
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
                courses = Array.isArray(result.data) ? result.data : [];
            } else {
                courses = result.data && Array.isArray(result.data.courses) ? result.data.courses : [];
            }

            accessibleCourses = courses;

            if (storedCourseId) {
                const storedCourse = courses.find(course => course.courseId === storedCourseId);
                if (storedCourse) {
                    console.log(`🔍 [GET_COURSE_ID] Found accessible course in localStorage: ${storedCourseId}`);
                    return storedCourseId;
                }

                console.log(`🔍 [GET_COURSE_ID] Clearing stale course from localStorage: ${storedCourseId}`);
                localStorage.removeItem('selectedCourseId');
            }

            if (courses.length > 0) {
                const firstCourse = courses[0];
                localStorage.setItem('selectedCourseId', firstCourse.courseId);
                console.log(`🔍 [GET_COURSE_ID] Selected accessible course:`, firstCourse.courseId);
                return firstCourse.courseId;
            }

            console.log(`🔍 [GET_COURSE_ID] No courses found in response`);
        } else {
            const errorText = await response.text();
            console.error(`🔍 [GET_COURSE_ID] API error: ${response.status} - ${errorText}`);
        }
    } catch (error) {
        console.error('Error fetching instructor courses:', error);
    }

    // Do not trust a stored course when the access check failed. Keeping it in
    // storage is useful for retrying after a temporary network error, but using
    // it here would recreate the unauthorized request cascade this resolver is
    // meant to prevent.
    if (storedCourseId && accessibleCourses === null) {
        return null;
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
 * Load onboarding data and populate the course upload page
 */
async function loadOnboardingData() {
    try {
        // Check if we have a courseId from URL parameters (onboarding redirect)
        const urlParams = new URLSearchParams(window.location.search);
        const courseId = urlParams.get('courseId');
        
        if (!courseId) {
            return;
        }
        
        // Fetch onboarding data from database
        const response = await fetch(`/api/onboarding/${courseId}`);
        
        if (!response.ok) {
            return;
        }
        
        const result = await response.json();
        const onboardingData = result.data;
        window.currentCourseData = onboardingData;
        
        // Generate units dynamically from the course's units (falling back to the
        // structure's count for a course whose units haven't been created yet)
        if (onboardingData.lectures?.length > 0 || onboardingData.courseStructure?.totalUnits > 0) {
            generateUnitsFromOnboarding(onboardingData);
        }
        
        // Load existing data for the units
        loadExistingUnitData(onboardingData);
        
        // Show success notification
        // Notification removed as per user request (was redundant)
        console.log('Onboarding data loaded successfully!');
        
    } catch (error) {
        console.error('Error loading onboarding data:', error);
        showNotification('Error loading onboarding data. Using default values.', 'warning');
    }
}

/**
 * Load course data (either from onboarding redirect or existing course)
 */
async function loadCourseData() {
    try {
        // First check if we have a courseId from URL parameters (onboarding redirect or course selection)
        const urlParams = new URLSearchParams(window.location.search);
        const courseIdFromUrl = urlParams.get('courseId');
        const courseIdFromStorage = localStorage.getItem('selectedCourseId');
        const selectedCourseId = courseIdFromUrl || courseIdFromStorage;
        
        if (selectedCourseId) {
            // Load specific course data
            console.log('Loading course from URL/localStorage:', selectedCourseId);
            await loadSpecificCourse(selectedCourseId);
            
            // Update URL if course ID is from localStorage
            if (courseIdFromStorage && !courseIdFromUrl) {
                urlParams.set('courseId', selectedCourseId);
                window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
            }
            return;
        }
        
        // If no courseId in URL or localStorage, check if instructor has any existing courses
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        const response = await fetch(`/api/onboarding/instructor/${instructorId}`);
        
        if (response.ok) {
            const result = await response.json();
            if (result.data && result.data.courses && result.data.courses.length > 0) {
                // Load the first available course
                const firstCourse = result.data.courses[0];
                console.log('Loading first available course:', firstCourse.courseId);
                await loadSpecificCourse(firstCourse.courseId);
                return;
            }
        }
        
        // If no existing course, show empty state
        showEmptyCourseState();
        
    } catch (error) {
        console.error('Error loading course data:', error);
        showNotification('Error loading course data. Using default values.', 'warning');
        showEmptyCourseState();
    }
}

/**
 * Load a specific course by ID
 */
async function loadSpecificCourse(courseId) {
    try {
        const response = await fetch(`/api/onboarding/${courseId}`);
        
        if (!response.ok) {
            showEmptyCourseState();
            return;
        }
        
        const result = await response.json();
        const courseData = result.data;
        window.currentCourseData = courseData;
        
        // Update the course title in the header
        const courseTitleElement = document.getElementById('course-title');
        if (courseTitleElement && courseData.courseName) {
            courseTitleElement.textContent = courseData.courseName;
        }
        
        // Generate units dynamically from the course's units (falling back to the
        // structure's count for a course whose units haven't been created yet)
        if (courseData.lectures?.length > 0 || courseData.courseStructure?.totalUnits > 0) {
            generateUnitsFromOnboarding(courseData);
            
            // Load existing data for the units (learning objectives, publish status, etc.)
            loadExistingUnitData(courseData);
        }
        
        // Show success notification
        showNotification('Course data loaded successfully!', 'success');
        
    } catch (error) {
        console.error('Error loading specific course:', error);
        showNotification('Error loading course data. Using default values.', 'warning');
        showEmptyCourseState();
    }
}

/**
 * Show empty course state when no course exists
 */
function showEmptyCourseState() {
    // Update the course title to show no course state
    const courseTitleElement = document.getElementById('course-title');
    if (courseTitleElement) {
        courseTitleElement.textContent = 'No Course Found';
    }
    
    const container = document.getElementById('dynamic-units-container');
    if (container) {
        container.innerHTML = `
            <div class="empty-course-state">
                <div class="empty-message">
                    <h2>No Course Found</h2>
                    <p>You haven't set up a course yet. Please complete the onboarding process first.</p>
                    <a href="/instructor/onboarding" class="btn-primary">Go to Onboarding</a>
                </div>
            </div>
        `;
    }
    
    // Show onboarding navigation item when no course exists
    const onboardingNavItem = document.getElementById('onboarding-nav-item');
    if (onboardingNavItem) {
        onboardingNavItem.style.display = 'block';
    }
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
