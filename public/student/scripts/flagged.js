/**
 * Student Flagged Content Page
 * Lists the flags created by the authenticated student and shows instructor responses
 */

const studentFlagsState = {
    all: [],
    filtered: [],
    status: 'all'
};

document.addEventListener('DOMContentLoaded', async function() {
    // Dynamic User Role Update for Footer
    const storedCourseName = localStorage.getItem('selectedCourseName');
    if (storedCourseName) {
        const userRoleElement = document.querySelector('.user-role');
        if (userRoleElement) {
            userRoleElement.textContent = `Student - ${storedCourseName}`;
        }
    }

    try {
        const courseId = localStorage.getItem('selectedCourseId');
        if (courseId) {
            const resp = await fetch(`/api/courses/${courseId}/student-enrollment`, { credentials: 'include' });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.success && data.data && data.data.status === 'banned') {
                    // Keep header/subtitle, hide controls and list
                    const controls = document.querySelector('.filter-controls');
                    const container = document.querySelector('.flagged-content-container');
                    if (controls) controls.style.display = 'none';
                    if (container) container.style.display = 'none';
                    const mainContent = document.querySelector('.main-content');
                    if (mainContent) {
                        const notice = document.createElement('div');
                        notice.style.padding = '24px';
                        notice.innerHTML = `
                            <div style=\"background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:16px;border-radius:8px;\">
                                <h2 style=\"margin-top:0;margin-bottom:8px;\">Access disabled</h2>
                                <p>Your access in this course is revoked.</p>
                                <p>Please select another course from the course selector at the top if available.</p>
                            </div>
                        `;
                        mainContent.appendChild(notice);
                    }
                    return;
                }
            }
        }
    } catch (e) { console.warn('Enrollment check failed, proceeding:', e); }
    const statusSelect = document.getElementById('status-filter');
    if (statusSelect) {
        statusSelect.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            // Use the picker API where available. Otherwise, preserve the
            // browser's native keyboard behavior for selects.
            try {
                if (typeof statusSelect.showPicker === 'function') {
                    statusSelect.showPicker();
                    event.preventDefault();
                    return;
                }
            } catch (error) {
                // Fall through to the browser's native select behavior.
            }
        });

        statusSelect.addEventListener('change', () => {
            studentFlagsState.status = statusSelect.value;
            applyStudentFlagFilters();
            renderStudentFlags();
        });
    }
    const refreshBtn = document.getElementById('refresh-flags');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => loadStudentFlags());
    }
    await loadStudentFlags();

    // Initialize Idle Timer
    if (window.initializeIdleTimer) {
        window.initializeIdleTimer();
    }
});

async function loadStudentFlags() {
    const courseId = localStorage.getItem('selectedCourseId');
    
    if (!courseId) {
        showStudentFlagsError('Please select a course to view your flags.');
        return;
    }

    showStudentFlagsLoading();
    try {
        let url = '/api/flags/my';
        if (courseId) {
            url += `?courseId=${encodeURIComponent(courseId)}`;
        }
        
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load flags');
        const result = await response.json();
        if (!result.success) throw new Error(result.message || 'Failed to load flags');
        studentFlagsState.all = result.data.flags || [];
        applyStudentFlagFilters();
        renderStudentFlags();
    } catch (err) {
        showStudentFlagsError('Unable to load your flags. Please try again.');
        console.error(err);
    }
}

function applyStudentFlagFilters() {
    const status = studentFlagsState.status;
    studentFlagsState.filtered = studentFlagsState.all.filter(f => status === 'all' || f.flagStatus === status);
}

function renderStudentFlags() {
    const list = document.getElementById('flagged-list');
    const empty = document.getElementById('empty-state');
    const loading = document.getElementById('loading-state');
    if (loading) loading.style.display = 'none';
    if (!list) return;
    list.innerHTML = '';
    if (studentFlagsState.filtered.length === 0) {
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';
    studentFlagsState.filtered.forEach(flag => list.appendChild(renderStudentFlagItem(flag)));
}

function renderStudentFlagItem(flag) {
    const div = document.createElement('div');
    div.className = 'flag-card';
    const ts = formatStudentTimestamp(flag.createdAt);
    
    // Determine card status class for styling. Stored values are escaped,
    // and reduced to a plain word where they become a class name.
    const statusClass = toClassName(flag.flagStatus || 'pending');
    
    // Header Section
    let headerHtml = `
        <div class="flag-card-header">
            <div class="flag-type-badge ${toClassName(flag.flagReason)}">${escapeHtml(mapReason(flag.flagReason))}</div>
            <div class="flag-meta-info">
                <span class="flag-date">${ts}</span>
                <span class="flag-status-badge ${statusClass}">${escapeHtml(mapStatus(flag.flagStatus))}</span>
            </div>
        </div>
    `;

    // Content Body
    let bodyHtml = `<div class="flag-card-body">`;
    
    // 1. Question Context
    const questionText = flag.questionContent && flag.questionContent.question ? flag.questionContent.question : 'Question content not available';
    const unitName = flag.unitName || 'Unknown Unit';
    const botMode = getBotModeDisplay(flag.botMode);
    
    bodyHtml += `
        <div class="flag-section context-section">
            <h4 class="flag-section-title">Flagged Content</h4>
            <div class="flag-context-meta">
                <span class="context-tag">${escapeHtml(unitName)}</span>
                <span class="context-tag">${escapeHtml(botMode)} mode</span>
            </div>
            <div class="flag-quote">
                "${escapeHtml(questionText)}"
            </div>
        </div>
    `;
    
    // 2. Student Note
    bodyHtml += `
        <div class="flag-section note-section">
            <h4 class="flag-section-title">Your Report</h4>
            <div class="flag-note">
                ${escapeHtml(flag.flagDescription)}
            </div>
        </div>
    `;
    
    // 3. Instructor Response (if exists)
    if (flag.instructorResponse) {
        const responseTs = formatStudentTimestamp(flag.updatedAt);
        const instructorName = flag.instructorName ? flag.instructorName : 'Instructor';
        
        bodyHtml += `
            <div class="flag-section response-section">
                <h4 class="flag-section-title">Instructor Response</h4>
                <div class="response-content">
                    ${escapeHtml(flag.instructorResponse)}
                </div>
                <div class="response-footer">
                    Responded by ${escapeHtml(instructorName)} • ${responseTs}
                </div>
            </div>
        `;
    } else {
        bodyHtml += `
            <div class="flag-section pending-section">
                <p><em>No response from instructor yet.</em></p>
            </div>
        `;
    }

    bodyHtml += `</div>`; // End card body

    div.innerHTML = headerHtml + bodyHtml;
    return div;
}

function showStudentFlagsLoading() {
    const loading = document.getElementById('loading-state');
    const empty = document.getElementById('empty-state');
    const list = document.getElementById('flagged-list');
    if (loading) loading.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (list) list.innerHTML = '';
}

function showStudentFlagsError(message) {
    const loading = document.getElementById('loading-state');
    const empty = document.getElementById('empty-state');
    const list = document.getElementById('flagged-list');
    if (loading) loading.style.display = 'none';
    if (empty) { empty.textContent = message; empty.style.display = 'block'; }
    if (list) list.innerHTML = '';
}

function formatStudentTimestamp(ts) {
    try {
        const d = new Date(ts);
        return d.toLocaleString();
    } catch (e) {
        return 'Unknown';
    }
}

function mapReason(r) {
    const m = { incorrect: 'Incorrect', inappropriate: 'Inappropriate', unclear: 'Unclear', confusing: 'Confusing', typo: 'Typo/Error', offensive: 'Offensive', irrelevant: 'Irrelevant' };
    return m[r] || r;
}

function mapStatus(s) {
    const m = { pending: 'Pending Review', reviewed: 'Reviewed', resolved: 'Resolved', dismissed: 'Dismissed' };
    return m[s] || s;
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
        'tutor': 'Tutor'
    };
    
    return modeMap[botMode.toLowerCase()] || botMode;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

/**
 * A stored value as one plain class name: lowercase letters, digits, "-" and
 * "_" only. The known values ("incorrect", "pending") pass unchanged.
 * @param {*} value
 * @returns {string}
 */
function toClassName(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}
