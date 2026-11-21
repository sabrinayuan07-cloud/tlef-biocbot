/**
 * Student Dashboard Script
 * Handles fetching and managing struggle topics.
 */

document.addEventListener('DOMContentLoaded', async () => {
    // Auth check first
    if (!await checkAuth()) return;

    // Enrollment check
    const courseId = localStorage.getItem('selectedCourseId');
    if (courseId) {
        try {
            const resp = await fetch(`/api/courses/${courseId}/student-enrollment`, { credentials: 'include' });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.success && data.data && data.data.status === 'banned') {
                    renderRevokedAccessUI();
                    return;
                }
            }
        } catch (e) {
            console.warn('Enrollment check failed:', e);
        }
    }

    const topicsContainer = document.getElementById('topics-list-container');
    const courseTopicsContainer = document.getElementById('course-topics-container');
    const activeCountEl = document.getElementById('active-topics-count');
    const directiveStatusEl = document.getElementById('directive-mode-status');
    const resetAllBtn = document.getElementById('reset-all-btn');
    
    // Modal elements
    const modal = document.getElementById('confirm-modal');
    const modalTitle = document.getElementById('dashboard-confirm-modal-title');
    const modalMessage = document.getElementById('modal-message');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');

    let currentStruggleState = null;
    let topicToReset = null;
    let currentApprovedTopics = [];

    // Initialize
    fetchStruggleState();
    loadApprovedCourseTopicsGlobal();

    // Event Listeners
    resetAllBtn.addEventListener('click', () => showConfirmModal('ALL'));
    modalCancelBtn.addEventListener('click', hideModal);
    modalConfirmBtn.addEventListener('click', confirmReset);

    // Logout handling
    document.getElementById('logout-btn').addEventListener('click', (e) => {
        e.preventDefault();
        Auth.logout();
    });

    /**
     * Fetch struggle state from API
     */
    async function fetchStruggleState() {
        const courseId = localStorage.getItem('selectedCourseId');
        
        if (!courseId) {
            topicsContainer.innerHTML = '<p class="empty-state">Please select a course to view your dashboard.</p>';
            activeCountEl.textContent = '-';
            directiveStatusEl.textContent = 'Inactive';
            directiveStatusEl.className = 'summary-status inactive';
            return;
        }

        try {
            const response = await fetch(`/api/student/struggle?courseId=${courseId}`);
            const data = await response.json();

            if (data.success) {
                currentStruggleState = data.struggleState;
                renderDashboard(currentStruggleState);
            } else {
                console.error('Failed to fetch struggle state:', data.message);
                topicsContainer.innerHTML = '<p class="error-message">Failed to load topics. Please try again.</p>';
            }
        } catch (error) {
            console.error('Error fetching struggle state:', error);
            topicsContainer.innerHTML = '<p class="error-message">Error connecting to server.</p>';
        }
    }

    /**
     * Render the dashboard with current state
     */
    function renderDashboard(state) {
        if (!state || !state.topics || state.topics.length === 0) {
            topicsContainer.innerHTML = '<p class="empty-state">No struggle topics recorded yet. Great job!</p>';
            activeCountEl.textContent = '0';
            directiveStatusEl.textContent = 'Inactive';
            directiveStatusEl.className = 'summary-status inactive';
            return;
        }

        // Filter and sort topics (most recent struggle first)
        const sortedTopics = state.topics.sort((a, b) => new Date(b.lastStruggle) - new Date(a.lastStruggle));

        const activeTopics = sortedTopics.filter(t => t.isActive);
        activeCountEl.textContent = activeTopics.length;

        if (activeTopics.length > 0) {
            directiveStatusEl.textContent = 'Active';
            directiveStatusEl.className = 'summary-status active';
        } else {
            directiveStatusEl.textContent = 'Inactive';
            directiveStatusEl.className = 'summary-status inactive';
        }

        topicsContainer.innerHTML = '';

        sortedTopics.forEach(topic => {
            const card = document.createElement('div');
            card.className = `topic-card ${topic.isActive ? 'active-struggle' : ''}`;
            
            const lastDate = topic.lastStruggle ? new Date(topic.lastStruggle).toLocaleDateString() : 'N/A';

            card.innerHTML = `
                <div class="topic-info">
                    <h3>${capitalize(topic.topic)}</h3>
                    <div class="topic-meta">
                        <span class="struggle-count">Count: ${topic.count}</span>
                        <span class="last-seen">Last: ${lastDate}</span>
                    </div>
                </div>
                <div class="topic-status">
                    ${topic.isActive 
                        ? '<span class="status-badge alert">Directive Mode On</span>' 
                        : '<span class="status-badge normal">Monitoring</span>'}
                </div>
                <div class="topic-actions">
                    <button class="reset-btn" data-topic="${topic.topic}">Reset</button>
                </div>
            `;

            // Add listener to button
            card.querySelector('.reset-btn').addEventListener('click', () => showConfirmModal(topic.topic));
            
            topicsContainer.appendChild(card);
        });
    }

    /**
     * Show confirmation modal
     */
    function showConfirmModal(topic) {
        topicToReset = topic;

        if (topic === 'ALL') {
            modalTitle.textContent = 'Reset All Topics?';
            modalMessage.textContent = 'This will clear all your struggle history and disable Directive Mode for all topics. Are you sure?';
            modalConfirmBtn.textContent = 'Reset All';
        } else {
            modalTitle.textContent = `Reset "${capitalize(topic)}"?`;
            modalMessage.textContent = 'This will reset the struggle count for this topic and disable Directive Mode if active. Are you sure?';
            modalConfirmBtn.textContent = `I understand ${capitalize(topic)} now`;
        }

        a11yModal.open(modal, { onRequestClose: hideModal });
    }

    function hideModal() {
        a11yModal.close(modal);
        topicToReset = null;
    }

    /**
     * Execute reset API call
     */
    async function confirmReset() {
        if (!topicToReset) return;

        const courseId = localStorage.getItem('selectedCourseId');
        if (!courseId) return;

        try {
            const response = await fetch('/api/student/struggle/reset', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    topic: topicToReset,
                    courseId: courseId
                })
            });

            const result = await response.json();

            if (result.success) {
                // Refresh data
                await fetchStruggleState();
                hideModal();
            } else {
                alert('Failed to reset: ' + result.message);
            }
        } catch (error) {
            console.error('Error resetting topic:', error);
            alert('Error connecting to server.');
        }
    }

    /**
     * Helper: Check Auth
     */
    async function checkAuth() {
        if (window.Auth && typeof window.Auth.checkAuth === 'function') {
            try {
                const user = await window.Auth.checkAuth();
                if (!user) {
                    window.location.href = '/login.html';
                    return false;
                }
                // Update specific UI if needed
                const nameEl = document.getElementById('user-display-name');
                if (nameEl && user.displayName) nameEl.textContent = user.displayName;
                return true;
            } catch (e) {
                window.location.href = '/login.html';
                return false;
            }
        }
        return true;
    }

    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function renderRevokedAccessUI() {
        const dashboardContent = document.querySelector('.dashboard-content');
        if (dashboardContent) dashboardContent.style.display = 'none';
        
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            const notice = document.createElement('div');
            notice.style.padding = '24px';
            notice.innerHTML = `
                <div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:16px;border-radius:8px;">
                    <h2 style="margin-top:0;margin-bottom:8px;">Access disabled</h2>
                    <p>Your access in this course is revoked.</p>
                    <p>Please select another course from the course selector at the top if available.</p>
                </div>
            `;
            mainContent.appendChild(notice);
        }
    }
    // Load Course Topics
    loadCourseTopics();
    
    // Update Sidebar with Course Name
    updateSidebarCourseInfo();

    function updateSidebarCourseInfo() {
        const storedCourseName = localStorage.getItem('selectedCourseName');
        if (storedCourseName) {
            const userRoleElement = document.querySelector('.user-role');
            if (userRoleElement) {
                userRoleElement.textContent = `Student - ${storedCourseName}`;
            }
        }
    }

    /**
     * Load course topics and check status
     */
    async function loadCourseTopics() {
        if (!courseTopicsContainer) return;

        const courseId = localStorage.getItem('selectedCourseId');
        if (!courseId) {
            courseTopicsContainer.innerHTML = '<p>Please select a course to view topics.</p>';
            return;
        }

        try {
            // 1. Get current user for ID
            const user = getCurrentUser();
            
            if (!user || !user.userId) {
                console.error('User not found');
                return;
            }

            // 2. Fetch Course Data (for published units)
            const courseResp = await fetch(`/api/courses/${courseId}`);
            const courseResult = await courseResp.json();
            
            if (!courseResult.success) throw new Error('Failed to load course');
            const course = courseResult.data;

            // 3. Fetch Student Sessions (to check what's done)
            const sessionsResp = await fetch(`/api/students/${courseId}/${user.userId}/sessions/own`);
            const sessionsResult = await sessionsResp.json();
            const sessions = sessionsResult.success && sessionsResult.data ? sessionsResult.data.sessions : [];

            // 4. Render
            renderCourseTopics(course, sessions);

        } catch (error) {
            console.error('Error loading course topics:', error);
            courseTopicsContainer.innerHTML = '<p class="error-message">Failed to load course topics.</p>';
        }
    }

    /**
     * Render the course topics grid
     */
    function renderCourseTopics(course, sessions) {
        if (!course || !course.lectures) {
             courseTopicsContainer.innerHTML = '<p>No topics found.</p>';
             return;
        }

        // Get published units only
        // Note: Logic matches backend expectations (lectures array)
        // Check both direct lectures array or structure
        const lectures = course.lectures || [];
        const publishedUnits = lectures.filter(l => l.isPublished);

        if (publishedUnits.length === 0) {
            courseTopicsContainer.innerHTML = '<p>No published topics yet.</p>';
            return;
        }

        // Create a Set of unit names the student has chatted about
        // Normalize names to handle potential casing issues, though backend is usually consistent
        const chattedUnitNames = new Set(
            sessions.map(s => (s.unitName || '').trim().toLowerCase())
        );

        courseTopicsContainer.innerHTML = publishedUnits.map(unit => {
            const isChatted = chattedUnitNames.has((unit.name || '').trim().toLowerCase());
            // Use displayName if available, otherwise name
            const displayTitle = unit.displayName || capitalize(unit.name);
            
            return `
                <div class="topic-item-card">
                    <div class="topic-header">
                        <h3 class="topic-title">${displayTitle}</h3>
                        ${isChatted
                            ? `<span class="topic-status-icon" title="Completed">${Icons.checkCircle}</span>`
                            : '<span class="topic-status-icon not-started" title="Not Started"></span>'
                        }
                    </div>
                    <div class="topic-footer">
                        <span class="topic-status-text ${isChatted ? 'status-completed' : 'status-explore'}">
                            ${isChatted ? 'Chatted' : 'Explore'}
                        </span>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Get current user helper
     */
    function getCurrentUser() {
        if (window.currentUser) return window.currentUser;
        if (typeof window.getCurrentUser === 'function') return window.getCurrentUser();
        try {
            const stored = localStorage.getItem('currentUser');
            if (stored) return JSON.parse(stored);
        } catch (e) { console.error(e); }
        return null;
    }

    async function loadApprovedCourseTopicsGlobal() {
        const courseId = localStorage.getItem('selectedCourseId');
        if (!courseId) return;

        try {
            const response = await fetch(`/api/courses/${courseId}/approved-topics`);
            if (!response.ok) return;

            const result = await response.json();
            const topicEntries = Array.isArray(result?.data?.topics) ? result.data.topics : [];
            currentApprovedTopics = Array.isArray(result?.data?.topicLabels)
                ? result.data.topicLabels
                : topicEntries.map(topic => {
                    if (typeof topic === 'string') return topic;
                    if (topic && typeof topic === 'object') return topic.topic;
                    return '';
                }).filter(Boolean);

            window.courseApprovedTopicsByCourse = window.courseApprovedTopicsByCourse || {};
            window.courseApprovedTopicsByCourse[courseId] = currentApprovedTopics;
            window.courseApprovedTopics = currentApprovedTopics;
        } catch (error) {
            console.warn('Unable to load approved course topics:', error);
        }
    }

    /**
     * Capitalize first letter helper
     */
    function capitalize(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }
});
