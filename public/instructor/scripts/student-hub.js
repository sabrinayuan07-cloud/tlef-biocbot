/**
 * Student Hub JavaScript
 * Allows instructors to view students per course and toggle enrollment
 */

let instructorCourses = [];
let currentStudents = [];
let currentTAs = []; // Store TAs for the current course
let anonymizeStudentsEnabled = false;
let currentSurveyCourseId = null;
let currentSurveyResponses = [];
let currentSurveyStats = null;
let currentGradeCourseId = null;
let currentGradeSources = [];
let currentGradeView = null;
let currentRosterMatch = null;
// LMS grades keyed by BiocBot user id so a student card can find its own row.
let gradesByLocalUserId = new Map();
const dirtyEnrollment = new Map(); // studentId -> boolean (enrolled)

document.addEventListener('DOMContentLoaded', async function() {
    await waitForAuth();

    initializeStudentHub();
    await initializePseudonymManager();
    await loadInstructorCourses();
});

let pseudonymScopes = { courses: [], superchats: [] };
let pseudonymModalReturnFocus = null;

async function initializePseudonymManager() {
    if (typeof isSystemAdmin !== 'function' || !isSystemAdmin()) return;

    const manager = document.getElementById('pseudonym-manager');
    const launchButton = document.getElementById('open-pseudonym-manager');
    if (!manager || !launchButton) return;
    launchButton.hidden = false;

    launchButton.addEventListener('click', openPseudonymManager);
    document.getElementById('close-pseudonym-manager')?.addEventListener('click', closePseudonymManager);
    document.getElementById('close-pseudonym-manager-footer')?.addEventListener('click', closePseudonymManager);
    manager.addEventListener('click', event => {
        if (event.target === manager) closePseudonymManager();
    });
    manager.addEventListener('keydown', handlePseudonymModalKeydown);

    document.getElementById('pseudonym-scope-type')?.addEventListener('change', populatePseudonymScopeOptions);
    document.getElementById('pseudonym-scope-id')?.addEventListener('change', loadPseudonymStatus);
    document.getElementById('generate-pseudonyms')?.addEventListener('click', generatePseudonyms);
    document.getElementById('pseudonym-csv-file')?.addEventListener('change', importPseudonymCsv);
    document.getElementById('download-pseudonym-mapping')?.addEventListener('click', downloadPseudonymMapping);

    try {
        const response = await authenticatedFetch('/api/student-pseudonyms/scopes');
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || `HTTP ${response.status}`);
        pseudonymScopes = result.data || pseudonymScopes;
        const requestedType = new URLSearchParams(window.location.search).get('pseudonymScope');
        const typeSelect = document.getElementById('pseudonym-scope-type');
        if (typeSelect && (requestedType === 'course' || requestedType === 'superchat')) {
            typeSelect.value = requestedType;
        }
        populatePseudonymScopeOptions();
        if (requestedType === 'course' || requestedType === 'superchat') openPseudonymManager();
    } catch (error) {
        setPseudonymStatus(`Could not load anonymization scopes: ${error.message}`, 'error');
    }
}

function openPseudonymManager() {
    const manager = document.getElementById('pseudonym-manager');
    if (!manager) return;
    pseudonymModalReturnFocus = document.activeElement;
    manager.hidden = false;
    document.body.classList.add('pseudonym-modal-open');
    document.getElementById('close-pseudonym-manager')?.focus();
}

function closePseudonymManager() {
    const manager = document.getElementById('pseudonym-manager');
    if (!manager || manager.hidden) return;
    manager.hidden = true;
    document.body.classList.remove('pseudonym-modal-open');
    if (pseudonymModalReturnFocus && typeof pseudonymModalReturnFocus.focus === 'function') {
        pseudonymModalReturnFocus.focus();
    }
}

function handlePseudonymModalKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closePseudonymManager();
        return;
    }
    if (event.key !== 'Tab') return;

    const manager = document.getElementById('pseudonym-manager');
    const focusable = Array.from(manager.querySelectorAll(
        'button:not([disabled]):not([hidden]), select:not([disabled]), input:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'
    )).filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function currentPseudonymScope() {
    return {
        type: document.getElementById('pseudonym-scope-type')?.value || 'course',
        id: document.getElementById('pseudonym-scope-id')?.value || ''
    };
}

function populatePseudonymScopeOptions() {
    const type = document.getElementById('pseudonym-scope-type')?.value || 'course';
    const select = document.getElementById('pseudonym-scope-id');
    const importControls = document.getElementById('pseudonym-import-controls');
    if (!select) return;

    const selectedCourseId = new URLSearchParams(window.location.search).get('courseId') || localStorage.getItem('selectedCourseId');
    const requestedScopeId = new URLSearchParams(window.location.search).get('pseudonymScopeId');
    const options = type === 'course' ? pseudonymScopes.courses : pseudonymScopes.superchats;
    select.innerHTML = '';
    options.forEach(scope => {
        const id = type === 'course' ? scope.courseId : scope.superchatId;
        const label = type === 'course' ? (scope.courseName || scope.courseId) : (scope.name || scope.superchatId);
        appendOption(select, id, `${label} (${id})`, {
            selected: id === requestedScopeId || (type === 'course' && !requestedScopeId && id === selectedCourseId)
        });
    });
    if (!select.value && select.options.length) select.selectedIndex = 0;
    if (importControls) importControls.querySelector('.pseudonym-file-label').hidden = type !== 'course';
    loadPseudonymStatus();
}

function setPseudonymStatus(message, state = '') {
    const status = document.getElementById('pseudonym-status');
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
}

async function loadPseudonymStatus() {
    const scope = currentPseudonymScope();
    const body = document.getElementById('pseudonym-table-body');
    if (!scope.id) {
        setPseudonymStatus(`No ${scope.type === 'course' ? 'courses' : 'superchat buckets'} are available.`, 'error');
        if (body) body.innerHTML = '';
        return;
    }

    setPseudonymStatus('Loading student IDs…');
    try {
        const response = await authenticatedFetch(`/api/student-pseudonyms/${scope.type}/${encodeURIComponent(scope.id)}`);
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || `HTTP ${response.status}`);
        const data = result.data;
        setPseudonymStatus(
            data.complete
                ? `Ready for anonymized downloads: ${data.mappingCount} of ${data.studentCount} students have IDs.`
                : `${data.mappingCount} of ${data.studentCount} students have IDs; ${data.missingStudentIds.length} still need one.`,
            data.complete ? 'complete' : 'incomplete'
        );
        if (body) {
            body.innerHTML = data.mappings.length
                ? data.mappings.map(row => `
                    <tr>
                        <td class="pseudonym-code">${escapeHTML(row.student)}</td>
                        <td>${escapeHTML(row.displayName || '—')}</td>
                        <td>${escapeHTML(row.studentId)}</td>
                        <td>${escapeHTML(row.puid || '—')}</td>
                        <td>${escapeHTML(row.source)}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="5">No IDs have been assigned yet.</td></tr>';
        }
    } catch (error) {
        setPseudonymStatus(`Could not load student IDs: ${error.message}`, 'error');
        if (body) body.innerHTML = '';
    }
}

async function generatePseudonyms() {
    const scope = currentPseudonymScope();
    if (!scope.id) return;
    const button = document.getElementById('generate-pseudonyms');
    if (button) button.disabled = true;
    setPseudonymStatus('Generating IDs for students who do not already have one…');
    try {
        const response = await authenticatedFetch(
            `/api/student-pseudonyms/${scope.type}/${encodeURIComponent(scope.id)}/generate`,
            { method: 'POST' }
        );
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || `HTTP ${response.status}`);
        showNotification(
            result.data.createdCount
                ? `Generated ${result.data.createdCount} student IDs.`
                : 'Every student already has an ID; nothing was changed.',
            'success'
        );
        await loadPseudonymStatus();
    } catch (error) {
        setPseudonymStatus(`Generation failed: ${error.message}`, 'error');
        showNotification(`Could not generate student IDs: ${error.message}`, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function importPseudonymCsv(event) {
    const file = event.target.files?.[0];
    const scope = currentPseudonymScope();
    if (!file || scope.type !== 'course' || !scope.id) return;
    setPseudonymStatus(`Validating ${file.name}…`);
    try {
        const response = await authenticatedFetch(
            `/api/student-pseudonyms/course/${encodeURIComponent(scope.id)}/import`,
            { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() }
        );
        const result = await response.json();
        if (!response.ok || !result.success) {
            const details = (result.errors || []).map(error => `Line ${error.line}: ${error.message}`).join('\n');
            throw new Error([result.message, details].filter(Boolean).join('\n'));
        }
        showNotification(`Imported ${result.data.importedCount} historical student IDs.`, 'success');
        await loadPseudonymStatus();
    } catch (error) {
        setPseudonymStatus(`Import failed: ${error.message}`, 'error');
        showNotification(error.message, 'error');
    } finally {
        event.target.value = '';
    }
}

function downloadPseudonymMapping() {
    const scope = currentPseudonymScope();
    if (!scope.id) return;
    window.location.assign(`/api/student-pseudonyms/${scope.type}/${encodeURIComponent(scope.id)}/mapping.csv`);
}

function initializeStudentHub() {
    // Course selection is now handled by the home page
    // No need for dropdown change handler
    const surveyStatusFilter = document.getElementById('survey-status-filter');
    if (surveyStatusFilter) {
        addKeyboardPickerActivation(surveyStatusFilter);
        surveyStatusFilter.addEventListener('change', () => {
            if (currentSurveyCourseId) {
                loadChatSurveyResponses(currentSurveyCourseId);
            }
        });
    }

    const refreshSurveyButton = document.getElementById('refresh-survey-responses');
    if (refreshSurveyButton) {
        refreshSurveyButton.addEventListener('click', () => {
            if (currentSurveyCourseId) {
                loadChatSurveyResponses(currentSurveyCourseId);
            }
        });
    }

    const downloadSurveyButton = document.getElementById('download-survey-responses');
    if (downloadSurveyButton) {
        downloadSurveyButton.addEventListener('click', downloadChatSurveyResponses);
    }

    const providerSelect = document.getElementById('lms-grade-provider');
    if (providerSelect) {
        addKeyboardPickerActivation(providerSelect);
        providerSelect.addEventListener('change', () => {
            if (currentGradeCourseId) loadLmsGrades(currentGradeCourseId, providerSelect.value);
        });
    }

    const gradeCourseSelect = document.getElementById('lms-grade-course');
    if (gradeCourseSelect) {
        addKeyboardPickerActivation(gradeCourseSelect);
        gradeCourseSelect.addEventListener('change', updateLinkCourseButton);
    }

    document.getElementById('link-lms-grade-course')?.addEventListener('click', linkLmsGradeCourse);
    document.getElementById('connect-lms-grade-provider')?.addEventListener('click', connectLmsGradeProvider);
    document.getElementById('match-lms-students')?.addEventListener('click', matchLmsStudents);
    document.getElementById('import-lms-grades')?.addEventListener('click', importLmsGrades);
}

function addKeyboardPickerActivation(selectElement) {
    selectElement.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;

        try {
            if (typeof selectElement.showPicker === 'function') {
                selectElement.showPicker();
                event.preventDefault();
            }
        } catch (error) {
            // Preserve the browser's native select behavior when unavailable.
        }
    });
}

function appendOption(select, value, label, { disabled = false, selected = false } = {}) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    item.disabled = disabled;
    item.selected = selected;
    select.appendChild(item);
}

async function readLmsJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        // A reverse proxy that gives up on a request answers with its own HTML
        // page, and BiocBot may still finish the work behind it.
        if (response.status === 502 || response.status === 504) {
            throw new Error(
                `BiocBot did not answer (HTTP ${response.status}). If this was a long import or sync, it may `
                + 'still be finishing — wait a minute and reload the page before trying again.'
            );
        }
        throw new Error(
            `LMS endpoint returned HTTP ${response.status} with a non-JSON response. ` +
            'Check the server\'s LMS startup diagnostics to confirm its routes were mounted.'
        );
    }
}

async function loadInstructorCourses() {
    try {
        // Get selected course ID from URL or localStorage
        const urlParams = new URLSearchParams(window.location.search);
        const courseIdFromUrl = urlParams.get('courseId');
        const courseIdFromStorage = localStorage.getItem('selectedCourseId');
        const selectedCourseId = courseIdFromUrl || courseIdFromStorage;
        
        // Hide the course selector dropdown
        const courseSelect = document.getElementById('student-course-select');
        const controlsRow = courseSelect?.closest('.controls-row');
        if (controlsRow) {
            controlsRow.style.display = 'none';
        }
        
        if (selectedCourseId) {
            // Load the selected course
            await loadStudents(selectedCourseId);
        } else {
            // Fallback: try to get first course from instructor's courses
            const instructorId = getCurrentInstructorId();
            if (!instructorId) {
                showNotification('No course selected. Please select a course from the home page.', 'error');
                return;
            }

            const response = await authenticatedFetch(`/api/onboarding/instructor/${instructorId}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const result = await response.json();
            instructorCourses = result.data?.courses || [];

            if (instructorCourses.length > 0) {
                await loadStudents(instructorCourses[0].courseId);
            } else {
                showNotification('No courses found. Please complete onboarding or select a course from the home page.', 'error');
            }
        }
    } catch (err) {
        console.error('Error loading instructor courses:', err);
        showNotification('Error loading courses. Please try again.', 'error');
    }
}

async function loadStudents(courseId) {
    try {
        await loadAnonymizeStudentsSetting(courseId);

        // 1. Fetch Students
        const studentsResponse = await authenticatedFetch(`/api/courses/${courseId}/students`);
        if (!studentsResponse.ok) throw new Error(`HTTP ${studentsResponse.status}`);
        const studentsResult = await studentsResponse.json();
        const students = studentsResult.data?.students || [];
        console.log('🔍 [STUDENT_HUB] Loaded students:', students);

        // 2. Fetch TAs for this course
        // We need to get the course details to see the TA list, then fetch TA details
        // Or we can fetch all TAs and filter. Let's try to be efficient.
        // Since we don't have a direct "get TAs for course" endpoint that returns full details,
        // we'll use the same approach as ta-hub.js: fetch all TAs and filter.
        
        let courseTAs = [];
        try {
            // Get course details to find assigned TA IDs
            const courseResponse = await authenticatedFetch(`/api/onboarding/${courseId}`);
            if (courseResponse.ok) {
                const courseResult = await courseResponse.json();
                const taIds = courseResult.data?.tas || [];
                
                if (taIds.length > 0) {
                    // Fetch all TAs to get details
                    const allTAsResponse = await authenticatedFetch('/api/auth/tas');
                    if (allTAsResponse.ok) {
                        const allTAsResult = await allTAsResponse.json();
                        const allTAs = allTAsResult.data || [];
                        courseTAs = allTAs.filter(ta => taIds.includes(ta.userId));
                    }
                }
            }
        } catch (taErr) {
            console.error('Error loading TAs:', taErr);
            // Continue with just students if TA load fails
        }

        // 3. Merge lists
        // Mark TAs with isTA property
        currentTAs = courseTAs.map(ta => ({ ...ta, isTA: true }));
        
        // Filter out students who are also TAs (to avoid duplicates if backend returns them in both)
        // or if we want to show them as TAs.
        const taIds = new Set(currentTAs.map(ta => ta.userId));
        const uniqueStudents = students.filter(s => !taIds.has(s.userId));
        
        // Combine: TAs first or mixed? User said "keep the student box from the TA in there".
        // Let's put TAs at the top for visibility, or sort alphabetically.
        // Let's just combine them.
        currentStudents = [...currentTAs, ...uniqueStudents];
        
        renderStudents(courseId);
        await loadLmsGrades(courseId);
        await loadChatSurveyResponses(courseId);
    } catch (err) {
        console.error('Error loading students:', err);
        showNotification('Error loading students. Please try again.', 'error');
    }
}

function gradeLabel(value) {
    if (!value) return '—';
    if (typeof value.score === 'number' && typeof value.maxScore === 'number') {
        return `${value.score.toFixed(1).replace(/\.0$/, '')}/${value.maxScore.toFixed(1).replace(/\.0$/, '')}`;
    }
    if (typeof value.score === 'number') return value.score.toFixed(1).replace(/\.0$/, '');
    return value.grade || '—';
}

const MATCH_STRATEGY_LABELS = {
    integration: 'PUID (Canvas integration ID)',
    email: 'email'
};

function providerLabel(provider) {
    return provider === 'canvas' ? 'Canvas' : (provider === 'moodle' ? 'Moodle' : 'LMS');
}

/**
 * Stores the grade view and re-renders the student cards, which is where the
 * grades actually live — a student's LMS scores belong next to their name, not
 * in a separate table the instructor has to cross-reference by hand.
 */
function applyLmsGradeView(view) {
    currentGradeView = view;
    gradesByLocalUserId = new Map((view?.students || []).map((student) => [String(student.localUserId), student]));

    const status = document.getElementById('lms-grades-status');
    if (status) {
        if (!view?.source) {
            status.textContent = `Not linked — connect ${providerLabel(view?.provider)} when you are ready to choose a course.`;
        } else if (!view.students?.length) {
            status.textContent = `Linked to ${view.source.code || view.source.name || view.source.courseId}. No students matched yet — run “Sync roster”.`;
        } else if (view.importedAt) {
            status.textContent = `${view.students.length} students matched · snapshot imported ${new Date(view.importedAt).toLocaleString()}`;
        } else {
            status.textContent = `${view.students.length} students matched · no grades imported yet`;
        }
    }

    if (currentGradeCourseId) renderStudents(currentGradeCourseId);
}

/** The LMS grade block shown inside one student card. */
function renderStudentGrades(userId) {
    const student = gradesByLocalUserId.get(String(userId));
    const provider = providerLabel(currentGradeView?.provider);
    if (!currentGradeView?.source) return '';

    if (!student) {
        return `
                    <div class="student-lms-grades" data-state="unmatched">
                        <strong>${escapeHTML(provider)} grades</strong>
                        <p class="lms-grade-empty">Not matched to a ${escapeHTML(provider)} student.</p>
                    </div>
        `;
    }

    const items = currentGradeView.gradeItems || [];
    const chips = items.map((item) => `
                            <div class="lms-grade-chip">
                                <span class="lms-grade-chip-name">${escapeHTML(item.name)}</span>
                                <span class="lms-grade-chip-value">${escapeHTML(gradeLabel(student.grades?.[item.key]))}</span>
                            </div>
    `).join('');
    const matchNote = student.matchedBy
        ? `Matched by ${escapeHTML(MATCH_STRATEGY_LABELS[student.matchedBy] || student.matchedBy)}${student.externalEmail ? ` · ${escapeHTML(student.externalEmail)}` : ''}`
        : `Matched to ${escapeHTML(student.externalLabel || `${provider} user ${student.externalUserId}`)}`;

    return `
                    <div class="student-lms-grades" data-state="matched">
                        <div class="lms-grade-heading">
                            <strong>${escapeHTML(provider)} grades</strong>
                            <span class="lms-grade-total">${escapeHTML(gradeLabel(student.total))}</span>
                        </div>
                        ${items.length
                            ? `<div class="lms-grade-chips">${chips}</div>`
                            : '<p class="lms-grade-empty">No grade items imported yet.</p>'}
                        <p class="lms-grade-match">${matchNote}</p>
                    </div>
    `;
}

function renderUnmatchedPanel(match) {
    const panel = document.getElementById('lms-unmatched-panel');
    const summary = document.getElementById('lms-unmatched-summary');
    const body = document.getElementById('lms-unmatched-body');
    if (!panel || !summary || !body) return;

    const lms = match?.unmatchedLmsStudents || [];
    const noBiocBotAccount = lms.filter((entry) => entry.reason === 'no-biocbot-account');
    const identityConflicts = lms.filter((entry) => entry.reason !== 'no-biocbot-account');
    const local = match?.unmatchedBiocBotStudents || [];
    const dropCandidates = match?.dropCandidates || [];
    const dropCandidateIds = new Set(dropCandidates.map((entry) => String(entry.localUserId)));
    const accessDisabled = local.filter((entry) => entry.accessDisabled);
    const notOnRoster = local.filter((entry) => !entry.accessDisabled && !dropCandidateIds.has(String(entry.localUserId)));
    if (!lms.length && !local.length) {
        panel.hidden = true;
        return;
    }

    const provider = providerLabel(match.provider);
    currentRosterMatch = match;
    panel.hidden = false;
    summary.textContent = `${lms.length + local.length} students could not be matched`;
    const list = (entries, describe) => entries.map((entry) => `<li>${describe(entry)}</li>`).join('');
    const coverage = match.coverage || {};
    const coveragePercent = coverage.total
        ? Math.round(((coverage.integrationId || 0) / coverage.total) * 100)
        : 0;
    const canDrop = match.prune?.allowed && match.syncToken && dropCandidates.length > 0;
    body.innerHTML = `
        ${match.provider === 'canvas' ? `
            <p class="lms-roster-coverage"><strong>Canvas integration_id coverage:</strong> ${coveragePercent}% (${coverage.integrationId || 0}/${coverage.total || 0})</p>
        ` : ''}
        ${noBiocBotAccount.length ? `
            <section class="lms-unmatched-group">
            <p><strong>In ${escapeHTML(provider)}, not in BiocBot (${noBiocBotAccount.length})</strong></p>
            <p>These students have not signed in to BiocBot yet. No action is needed; their account is created on first CWL login.</p>
            <ul>${list(noBiocBotAccount, (entry) => `${escapeHTML(entry.name)}${entry.email ? ` &lt;${escapeHTML(entry.email)}&gt;` : ' (no email visible to BiocBot)'}`)}</ul>
            </section>
        ` : ''}
        ${identityConflicts.length ? `
            <section class="lms-unmatched-group">
            <p><strong>Identity conflicts (${identityConflicts.length})</strong></p>
            <p>More than one LMS row claimed the same BiocBot account. Review these accounts before importing grades.</p>
            <ul>${list(identityConflicts, (entry) => `${escapeHTML(entry.name)}${entry.email ? ` &lt;${escapeHTML(entry.email)}&gt;` : ''}`)}</ul>
            </section>
        ` : ''}
        ${dropCandidates.length ? `
            <section class="lms-unmatched-group">
            <p><strong>Left the ${escapeHTML(provider)} course (${dropCandidates.length})</strong></p>
            <p>An earlier sync put these students on this course from ${escapeHTML(provider)}, and ${escapeHTML(provider)} confirms they are no longer enrolled in it, in any section. Disabling access keeps their account and history intact.</p>
            <ul>${list(dropCandidates, (entry) => `${escapeHTML(entry.displayName)}${entry.email ? ` &lt;${escapeHTML(entry.email)}&gt;` : ' (no email on file)'}`)}</ul>
            ${canDrop ? `
                <button id="drop-unmatched-lms-students" class="btn-small btn-danger" type="button">
                    Disable access for ${dropCandidates.length} student${dropCandidates.length === 1 ? '' : 's'}
                </button>
            ` : `
                <p class="lms-prune-disabled">Drop action unavailable: ${match.provider !== 'canvas'
                    ? 'soft-drop sync is only available for Canvas.'
                    : (match.prune?.reason === 'empty-roster'
                        ? 'the Canvas roster was empty.'
                        : (match.prune?.reason === 'already-applied'
                            ? 'these changes were already applied.'
                            : 'integration_id coverage is below the safety threshold.'))}</p>
            `}
            </section>
        ` : ''}
        ${notOnRoster.length ? `
            <section class="lms-unmatched-group">
            <p><strong>In BiocBot, not on the synced ${escapeHTML(provider)} roster (${notOnRoster.length})</strong></p>
            <p>Nothing shows these students left the ${escapeHTML(provider)} course. They may have joined with a course code, have no PUID or email that matches a ${escapeHTML(provider)} student, or be in a section your ${escapeHTML(provider)} account cannot see. Syncing does not change their access.</p>
            <ul>${list(notOnRoster, (entry) => `${escapeHTML(entry.displayName)}${entry.email ? ` &lt;${escapeHTML(entry.email)}&gt;` : ' (no email on file)'}`)}</ul>
            </section>
        ` : ''}
        ${accessDisabled.length ? `
            <section class="lms-unmatched-group">
            <p><strong>Access already disabled (${accessDisabled.length})</strong></p>
            <p>These students are not on the synced ${escapeHTML(provider)} roster, and their BiocBot access for this course is already off.</p>
            <ul>${list(accessDisabled, (entry) => `${escapeHTML(entry.displayName)}${entry.email ? ` &lt;${escapeHTML(entry.email)}&gt;` : ' (no email on file)'}`)}</ul>
            </section>
        ` : ''}
    `;
    document.getElementById('drop-unmatched-lms-students')?.addEventListener('click', dropUnmatchedLmsStudents);
}

async function dropUnmatchedLmsStudents() {
    const match = currentRosterMatch;
    const button = document.getElementById('drop-unmatched-lms-students');
    if (!match?.syncToken || !currentGradeCourseId || !button) return;
    const count = match.dropCandidates?.length || 0;
    if (!confirm(`Disable course access for ${count} student${count === 1 ? '' : 's'} who left the Canvas course? Their accounts and history will be kept.`)) return;

    button.disabled = true;
    button.textContent = 'Disabling access…';
    try {
        const response = await authenticatedFetch(
            `/api/lms/roster/courses/${encodeURIComponent(currentGradeCourseId)}/drop-unmatched`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ syncToken: match.syncToken })
            }
        );
        const result = await readLmsJson(response);
        if (!response.ok || !result.success) throw new Error(result.message || `HTTP ${response.status}`);

        currentRosterMatch = { ...match, prune: { ...match.prune, allowed: false, reason: 'already-applied' } };
        renderUnmatchedPanel(currentRosterMatch);
        showNotification(result.message, 'success');
        await loadStudents(currentGradeCourseId);
    } catch (error) {
        console.error('Error soft-dropping unmatched Canvas students:', error);
        showNotification(`Could not update enrollment: ${error.message}`, 'error');
        button.disabled = false;
        button.textContent = 'Disable access';
    }
}

/**
 * Fills the course picker from the provider's own course list and preselects
 * whichever course grades currently come from. Only an `interactive` call —
 * one the instructor started with a click — may send them off to Canvas to
 * connect; a page load just offers the Connect button.
 */
async function loadGradeCourseOptions(courseId, provider, { interactive = false } = {}) {
    const select = document.getElementById('lms-grade-course');
    const note = document.getElementById('lms-grades-source-note');
    const connectButton = document.getElementById('connect-lms-grade-provider');
    if (!select) return;

    select.replaceChildren();
    if (!provider) {
        appendOption(select, '', 'No LMS configured');
        select.disabled = true;
        updateLinkCourseButton();
        return;
    }

    select.disabled = true;
    appendOption(select, '', 'Loading courses…');
    try {
        const response = await authenticatedFetch(
            `/api/lms/grades/courses/${encodeURIComponent(courseId)}/available-courses?provider=${encodeURIComponent(provider)}`
        );
        const result = await readLmsJson(response);
        if (!response.ok || !result.success) {
            if (isCanvasNotConnected(provider, response, result)) {
                if (interactive) {
                    reauthorizeCanvas(provider, response, result);
                } else {
                    showUnlinkedGradeCourse(provider, `Connect ${providerLabel(provider)} to see or change the course grades come from.`);
                }
                return;
            }
            throw new Error(result.message || `HTTP ${response.status}`);
        }

        const current = result.data.current;
        const courses = result.data.courses || [];
        select.replaceChildren();
        appendOption(select, '', courses.length ? 'Select a course…' : 'No courses available to this account');
        for (const course of courses) {
            appendOption(select, course.id, course.code ? `${course.code} — ${course.name}` : course.name, {
                selected: current && String(current.courseId) === course.id
            });
        }
        select.disabled = courses.length === 0;

        if (note) {
            note.textContent = !current
                ? `No ${providerLabel(provider)} course is linked for grades yet — pick one above.`
                : (current.inherited
                    ? `Using ${current.code || current.name || current.courseId}, inherited from the course linked for file import. Pick a different one to override it.`
                    : `Grades come from ${current.code || current.name || current.courseId}.`);
        }
        if (connectButton) connectButton.hidden = true;
    } catch (error) {
        console.error('Error loading LMS grade courses:', error);
        select.replaceChildren();
        appendOption(select, '', 'Could not load courses');
        select.disabled = true;
        if (note) note.textContent = `Could not list ${providerLabel(provider)} courses: ${error.message}`;
    }
    updateLinkCourseButton();
}

function showUnlinkedGradeCourse(provider, noteText) {
    const select = document.getElementById('lms-grade-course');
    const note = document.getElementById('lms-grades-source-note');
    const connectButton = document.getElementById('connect-lms-grade-provider');
    if (!select) return;

    select.replaceChildren();
    appendOption(select, '', provider
        ? `Connect ${providerLabel(provider)} to choose a course`
        : 'No LMS configured');
    select.disabled = true;
    if (note) {
        note.textContent = provider
            ? (noteText || `Connect ${providerLabel(provider)} when you are ready to choose a grade source.`)
            : '';
    }
    if (connectButton) {
        connectButton.hidden = !provider;
        connectButton.textContent = provider ? `Connect ${providerLabel(provider)}` : 'Connect LMS';
        connectButton.disabled = false;
    }
    updateLinkCourseButton();
}

async function connectLmsGradeProvider() {
    const provider = document.getElementById('lms-grade-provider')?.value;
    const button = document.getElementById('connect-lms-grade-provider');
    if (!provider || !currentGradeCourseId || !button) return;

    button.disabled = true;
    button.textContent = `Connecting ${providerLabel(provider)}…`;
    await loadGradeCourseOptions(currentGradeCourseId, provider, { interactive: true });
    button.disabled = false;
    button.textContent = `Connect ${providerLabel(provider)}`;
}

function updateLinkCourseButton() {
    const select = document.getElementById('lms-grade-course');
    const button = document.getElementById('link-lms-grade-course');
    if (button) button.disabled = !select?.value;
}

async function linkLmsGradeCourse() {
    const provider = document.getElementById('lms-grade-provider')?.value;
    const externalCourseId = document.getElementById('lms-grade-course')?.value;
    const button = document.getElementById('link-lms-grade-course');
    const status = document.getElementById('lms-grades-status');
    if (!provider || !externalCourseId || !currentGradeCourseId || !button) return;

    button.disabled = true;
    button.textContent = 'Linking…';
    try {
        const response = await authenticatedFetch(
            `/api/lms/grades/courses/${encodeURIComponent(currentGradeCourseId)}/source`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, externalCourseId })
            }
        );
        const result = await readLmsJson(response);
        if (!response.ok || !result.success) {
            if (reauthorizeCanvas(provider, response, result)) return;
            throw new Error(result.message || `HTTP ${response.status}`);
        }

        currentGradeSources = result.data.sources || currentGradeSources;
        applyLmsGradeView(result.data);
        renderUnmatchedPanel(null);
        await loadGradeCourseOptions(currentGradeCourseId, provider);
        showNotification(
            `Grades will now come from ${result.data.source.code || result.data.source.name}. Run “Match students” next.`,
            'success'
        );
    } catch (error) {
        console.error('Error linking LMS grade course:', error);
        if (status) status.textContent = `Could not link the course: ${error.message}`;
        showNotification(`Could not link the ${providerLabel(provider)} course.`, 'error');
    } finally {
        button.textContent = 'Use this course';
        updateLinkCourseButton();
    }
}

function updateGradeProviderOptions(sources, selectedProvider) {
    const select = document.getElementById('lms-grade-provider');
    const importButton = document.getElementById('import-lms-grades');
    const matchButton = document.getElementById('match-lms-students');
    const bar = document.getElementById('lms-grades-bar');
    if (!select || !importButton || !matchButton) return;

    // Nothing to offer when the deployment has no LMS configured at all.
    const usable = sources.filter((source) => source.configured);
    if (bar) bar.hidden = usable.length === 0;

    select.replaceChildren();
    for (const source of usable) {
        // An unlinked provider stays selectable — choosing it is how you get to
        // the course picker that links it.
        appendOption(select, source.provider, `${providerLabel(source.provider)}${source.linked ? '' : ' — not linked'}`, {
            selected: source.provider === selectedProvider
        });
    }
    const selected = usable.find((source) => source.provider === select.value);
    matchButton.disabled = !selected?.linked;
    importButton.disabled = !selected?.linked;
}

async function loadLmsGrades(courseId, provider = '') {
    currentGradeCourseId = courseId;
    const status = document.getElementById('lms-grades-status');
    const params = new URLSearchParams();
    if (provider) params.set('provider', provider);
    if (status) status.textContent = 'Loading LMS grade snapshot…';

    try {
        const suffix = params.toString() ? `?${params}` : '';
        const response = await authenticatedFetch(`/api/lms/grades/courses/${encodeURIComponent(courseId)}${suffix}`);
        const result = await readLmsJson(response);
        if (!response.ok || !result.success) throw new Error(result.message || `HTTP ${response.status}`);
        currentGradeSources = result.data.sources || [];
        updateGradeProviderOptions(currentGradeSources, result.data.provider);
        applyLmsGradeView(result.data);
        const selectedProvider = document.getElementById('lms-grade-provider')?.value;
        const selectedSource = currentGradeSources.find((source) => source.provider === selectedProvider);
        if (selectedSource?.linked) {
            await loadGradeCourseOptions(courseId, selectedProvider);
        } else {
            // Listing Canvas courses requires Canvas OAuth. A passive visit to
            // Student Hub must not start that flow before the course is linked.
            showUnlinkedGradeCourse(selectedProvider);
        }
    } catch (error) {
        console.error('Error loading LMS grades:', error);
        if (status) status.textContent = `Could not load LMS grades: ${error.message}`;
        applyLmsGradeView(null);
    }
}

/**
 * Whether the server said BiocBot holds no usable Canvas connection for this
 * instructor. Canvas refusing a request (403, CANVAS_ACCESS_DENIED) is not
 * this: connecting again cannot fix a permission, and a redirect would loop.
 */
function isCanvasNotConnected(provider, response, result) {
    return provider === 'canvas' && response.status === 401 && result?.connected === false;
}

/**
 * Canvas access can lapse while the page is open. When an action the
 * instructor started finds it gone, bouncing through Canvas's OAuth flow and
 * back is the only way to recover, so it is handled here rather than
 * surfacing a bare 401 the instructor cannot act on.
 */
function reauthorizeCanvas(provider, response, result) {
    if (!isCanvasNotConnected(provider, response, result)) return false;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/lms/canvas/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    return true;
}

async function matchLmsStudents() {
    const provider = document.getElementById('lms-grade-provider')?.value;
    const button = document.getElementById('match-lms-students');
    const status = document.getElementById('lms-grades-status');
    if (!provider || !currentGradeCourseId || !button) return;

    button.disabled = true;
    button.textContent = 'Syncing…';
    if (status) status.textContent = `Reading the ${providerLabel(provider)} roster…`;
    try {
        const endpoint = provider === 'canvas'
            ? `/api/lms/roster/courses/${encodeURIComponent(currentGradeCourseId)}/sync`
            : `/api/lms/grades/courses/${encodeURIComponent(currentGradeCourseId)}/match-students`;
        const response = await authenticatedFetch(
            endpoint,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider })
            }
        );
        const result = await readLmsJson(response);
        if (!response.ok || !result.success) {
            if (reauthorizeCanvas(provider, response, result)) return;
            throw new Error(result.message || result.error || `HTTP ${response.status}`);
        }

        const match = provider === 'canvas' ? result.data : result.data.match;
        if (provider === 'canvas') {
            await loadLmsGrades(currentGradeCourseId, provider);
        } else {
            applyLmsGradeView(result.data);
        }
        renderUnmatchedPanel(match);
        showNotification(
            `Matched ${match.matchedCount} of ${match.rosterSize} ${providerLabel(provider)} students.`,
            match.matchedCount ? 'success' : 'error'
        );
    } catch (error) {
        console.error('Error matching LMS students:', error);
        if (status) status.textContent = `Student matching failed: ${error.message}`;
        showNotification(`Could not match ${providerLabel(provider)} students.`, 'error');
    } finally {
        button.disabled = false;
        button.textContent = '1. Sync roster';
    }
}

async function importLmsGrades() {
    const provider = document.getElementById('lms-grade-provider')?.value;
    const button = document.getElementById('import-lms-grades');
    const status = document.getElementById('lms-grades-status');
    if (!provider || !currentGradeCourseId || !button) return;

    button.disabled = true;
    button.textContent = 'Importing…';
    if (status) status.textContent = `Reading grades from ${providerLabel(provider)}…`;
    try {
        const response = await authenticatedFetch(
            `/api/lms/grades/courses/${encodeURIComponent(currentGradeCourseId)}/import`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider })
            }
        );
        const result = await readLmsJson(response);
        if (!response.ok || !result.success) {
            if (reauthorizeCanvas(provider, response, result)) return;
            throw new Error(result.message || result.error || `HTTP ${response.status}`);
        }
        applyLmsGradeView(result.data);
        const summary = result.data.summary;
        if (!summary.mappedStudents) {
            showNotification(
                `No grades were stored — no ${providerLabel(provider)} student is matched to a BiocBot account yet. Run “Match students” first.`,
                'error'
            );
            return;
        }
        showNotification(
            `Imported ${summary.importedGrades} grades for ${summary.mappedStudents} students from ${providerLabel(provider)}.`,
            'success'
        );
    } catch (error) {
        console.error('Error importing LMS grades:', error);
        if (status) status.textContent = `Grade import failed: ${error.message}`;
        showNotification(`Could not import ${providerLabel(provider)} grades.`, 'error');
    } finally {
        button.disabled = false;
        button.textContent = '2. Import grades';
    }
}

async function loadChatSurveyResponses(courseId) {
    currentSurveyCourseId = courseId;
    const statusEl = document.getElementById('survey-responses-status');
    const container = document.getElementById('survey-responses-container');
    const downloadButton = document.getElementById('download-survey-responses');

    if (statusEl) {
        statusEl.textContent = 'Loading survey responses...';
        statusEl.classList.remove('error');
        statusEl.style.display = 'block';
    }
    if (container) {
        container.innerHTML = '';
    }
    if (downloadButton) {
        downloadButton.disabled = true;
    }

    try {
        const statusFilter = document.getElementById('survey-status-filter')?.value || 'all';
        const params = new URLSearchParams({ limit: '100' });
        if (statusFilter !== 'all') {
            params.set('status', statusFilter);
        }

        const response = await authenticatedFetch(`/api/chat/survey/course/${encodeURIComponent(courseId)}?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'Failed to load survey responses');
        }

        currentSurveyResponses = result.data?.responses || [];
        currentSurveyStats = result.data?.stats || null;
        renderSurveyStats(currentSurveyStats);
        renderSurveyResponses(currentSurveyResponses);
    } catch (err) {
        console.error('Error loading chat survey responses:', err);
        currentSurveyResponses = [];
        currentSurveyStats = null;
        renderSurveyStats(null);
        if (statusEl) {
            statusEl.textContent = 'Could not load survey responses. Please try again.';
            statusEl.classList.add('error');
            statusEl.style.display = 'block';
        }
    } finally {
        if (downloadButton) {
            downloadButton.disabled = !currentSurveyCourseId;
        }
    }
}

function renderSurveyStats(stats) {
    const shownEl = document.getElementById('survey-stat-shown');
    const submittedEl = document.getElementById('survey-stat-submitted');
    const dismissedEl = document.getElementById('survey-stat-dismissed');
    const accuracyEl = document.getElementById('survey-stat-average-accuracy');
    const satisfactionEl = document.getElementById('survey-stat-average-satisfaction');

    if (shownEl) shownEl.textContent = String(stats?.shown || 0);
    if (submittedEl) submittedEl.textContent = String(stats?.submitted || 0);
    if (dismissedEl) dismissedEl.textContent = String(stats?.dismissed || 0);
    if (accuracyEl) {
        accuracyEl.textContent = typeof stats?.averageAccuracy === 'number'
            ? `${stats.averageAccuracy.toFixed(1)}/5`
            : '--';
    }
    if (satisfactionEl) {
        satisfactionEl.textContent = typeof stats?.averageSatisfaction === 'number'
            ? `${stats.averageSatisfaction.toFixed(1)}/5`
            : '--';
    }
}

function renderSurveyResponses(responses) {
    const statusEl = document.getElementById('survey-responses-status');
    const container = document.getElementById('survey-responses-container');
    if (!container) return;

    if (!responses.length) {
        container.innerHTML = '';
        if (statusEl) {
            statusEl.textContent = 'No survey responses for this course yet.';
            statusEl.classList.remove('error');
            statusEl.style.display = 'block';
        }
        return;
    }

    if (statusEl) {
        statusEl.style.display = 'none';
    }

    container.innerHTML = responses.map(response => {
        const status = response.submittedAt ? 'Submitted' : response.dismissedAt ? 'Dismissed' : 'Shown';
        const formatRating = (value) => typeof value === 'number' ? `${value}/5` : '--';
        const accuracyRating = formatRating(response.ratingAccuracy);
        const satisfactionRating = formatRating(response.ratingSatisfaction);
        const accuracyPrompt = response.accuracyPrompt || response.settingsSnapshot?.accuracyPrompt || 'Accuracy';
        const satisfactionPrompt = response.satisfactionPrompt || response.settingsSnapshot?.satisfactionPrompt || 'Satisfaction';
        const studentName = response.studentName || response.studentId || 'Unknown student';
        const updatedAt = response.updatedAt || response.submittedAt || response.dismissedAt || response.shownAt || response.createdAt;
        const comment = response.comment || '';

        return `
            <article class="survey-response-card">
                <div class="survey-response-main">
                    <div>
                        <h3>${escapeHTML(studentName)}</h3>
                        <p class="survey-response-meta">
                            ${escapeHTML(response.unitName || 'Unknown unit')} &middot; Session ${escapeHTML(shortenId(response.conversationId))}
                        </p>
                    </div>
                    <div class="survey-response-rating">
                        <span class="survey-status-pill ${status.toLowerCase()}">${escapeHTML(status)}</span>
                    </div>
                </div>
                <dl class="survey-response-details">
                    <div>
                        <dt>${escapeHTML(accuracyPrompt)}</dt>
                        <dd>${escapeHTML(accuracyRating)}</dd>
                    </div>
                    <div>
                        <dt>${escapeHTML(satisfactionPrompt)}</dt>
                        <dd>${escapeHTML(satisfactionRating)}</dd>
                    </div>
                    <div>
                        <dt>Messages at prompt</dt>
                        <dd>${response.messageCountAtPrompt ?? '—'}</dd>
                    </div>
                    <div>
                        <dt>Last updated</dt>
                        <dd>${escapeHTML(formatDateTime(updatedAt))}</dd>
                    </div>
                </dl>
                ${comment ? `<p class="survey-response-comment">${escapeHTML(comment)}</p>` : ''}
            </article>
        `;
    }).join('');
}

async function downloadChatSurveyResponses() {
    if (!currentSurveyCourseId) {
        showNotification('No course selected for survey export.', 'warning');
        return;
    }

    const downloadButton = document.getElementById('download-survey-responses');
    const previousText = downloadButton ? downloadButton.textContent : '';
    if (downloadButton) {
        downloadButton.disabled = true;
        downloadButton.textContent = 'Downloading...';
    }

    try {
        const statusFilter = document.getElementById('survey-status-filter')?.value || 'all';
        const params = new URLSearchParams({ limit: '1000' });
        if (statusFilter !== 'all') {
            params.set('status', statusFilter);
        }

        const response = await authenticatedFetch(`/api/chat/survey/course/${encodeURIComponent(currentSurveyCourseId)}/export?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const csv = await response.blob();
        const url = URL.createObjectURL(csv);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-survey-responses-${currentSurveyCourseId}-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showNotification('Survey responses downloaded.', 'success');
    } catch (err) {
        console.error('Error downloading chat survey responses:', err);
        showNotification('Failed to download survey responses. Please try again.', 'error');
    } finally {
        if (downloadButton) {
            downloadButton.disabled = false;
            downloadButton.textContent = previousText || 'Download CSV';
        }
    }
}

async function loadAnonymizeStudentsSetting(courseId) {
    anonymizeStudentsEnabled = false;

    if (!courseId) {
        return;
    }

    try {
        const anonRes = await fetch(`/api/settings/anonymize-students?courseId=${courseId}`);
        const anonData = await anonRes.json();
        anonymizeStudentsEnabled = anonData.success && anonData.enabled === true;
    } catch (e) {
        anonymizeStudentsEnabled = false;
    }
}

function renderStudents(courseId) {
    const container = document.getElementById('students-container');
    if (!container) return;

    if (currentStudents.length === 0) {
        container.innerHTML = '<p>No students found for this course yet.</p>';
        return;
    }

    container.innerHTML = currentStudents.map(s => {
        const enrolled = dirtyEnrollment.has(s.userId) ? dirtyEnrollment.get(s.userId) : !!s.enrolled;
        const isTA = !!s.isTA;
        const hasPendingTAInvite = !isTA && s.role === 'ta' && Array.isArray(s.invitedCourses) && s.invitedCourses.includes(courseId);
        const taInviteButtonLabel = s.role === 'ta' ? 'Invite to TA Course' : 'Promote to TA';
        const struggleTopicsSection = anonymizeStudentsEnabled ? '' : `
                    <div class="struggle-topics-section" style="margin-top: 15px; border-top: 1px solid #eee; padding-top: 10px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <strong>Struggle Topics</strong>
                            ${s.struggleState && s.struggleState.topics && s.struggleState.topics.length > 0
                                ? `<button class="btn-small btn-secondary download-struggle-btn"
                                     onclick="downloadStruggleReport('${escapeHTML(s.userId)}', '${escapeHTML(s.displayName || s.username)}')">
                                     Download Report
                                   </button>`
                                : ''
                            }
                        </div>

                        ${renderStruggleTopics(s.struggleState)}
                    </div>
        `;
        
        return `
            <div class="student-card ${isTA ? 'ta-card' : ''}" style="${isTA ? 'border-left: 4px solid #17a2b8;' : ''}">
                <div class="student-header">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <h3 class="student-name">${escapeHTML(s.displayName || s.username || s.userId)}</h3>
                        ${isTA ? '<span class="badge badge-info" style="background: #117a8b; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.8em;">TA</span>' : ''}
                    </div>
                </div>
                <div class="student-info">
                    <p><strong>Username:</strong> ${escapeHTML(s.username || '—')}</p>
                    <p><strong>Email:</strong> ${escapeHTML(s.email || '—')}</p>
                    <p><strong>Last Login:</strong> ${s.lastLogin ? new Date(s.lastLogin).toLocaleString() : '—'}</p>
                    ${isTA ? '' : renderStudentGrades(s.userId)}
                    ${struggleTopicsSection}
                </div>
                <div class="student-actions">
                    <label class="enroll-toggle">
                        <input type="checkbox" ${enrolled ? 'checked' : ''} 
                               onchange="toggleEnrollment('${courseId}','${s.userId}', this.checked)">
                        <span>Enrolled</span>
                    </label>
                    <button class="btn-small btn-secondary" id="save-${s.userId}" disabled
                            onclick="saveEnrollment('${courseId}','${s.userId}')">Save</button>
                    
                    ${isTA ? `
                        <button class="btn-small btn-danger" onclick="demoteFromTA('${s.userId}', '${escapeHTML(s.displayName || s.username)}', '${courseId}')">
                            Demote from TA
                        </button>
                    ` : hasPendingTAInvite ? `
                         <button class="btn-small btn-secondary" disabled style="opacity: 0.7; cursor: default;">
                            Pending TA joining course
                        </button>
                    ` : `
                        <button class="btn-small btn-primary" onclick="promoteToTA('${s.userId}', '${escapeHTML(s.displayName || s.username)}', '${courseId}')">
                            ${taInviteButtonLabel}
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.enroll-toggle input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            checkbox.click();
        });
    });
}

window.promoteToTA = async function(studentId, studentName, courseId) {
    if (!courseId) {
        courseId = localStorage.getItem('selectedCourseId');
    }

    const isExistingTA = currentStudents.some(s => s.userId === studentId && s.role === 'ta');
    const confirmMessage = isExistingTA
        ? `Invite ${studentName} to join this course as a Teaching Assistant?`
        : `Are you sure you want to promote ${studentName} to a Teaching Assistant? This will give them TA permissions.`;

    if (!confirm(confirmMessage)) {
        return;
    }

    try {
        const resp = await authenticatedFetch('/api/auth/promote-to-ta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: studentId, courseId: courseId })
        });

        if (!resp.ok) {
            const errorData = await resp.json();
            throw new Error(errorData.message || `HTTP ${resp.status}`);
        }

        showNotification(isExistingTA ? `Successfully invited ${studentName} to join this course as TA` : `Successfully promoted ${studentName} to TA`, 'success');
        
        // Reload students list to reflect changes (promoted student should ideally disappear or be marked)
        // Since this view shows "students", a TA might not show up here anymore depending on backend logic, 
        // or will show up but now have role='ta'. 
        // For now, we reload the list.
        const selectedCourseId = localStorage.getItem('selectedCourseId');
        if (selectedCourseId) {
            await loadStudents(selectedCourseId);
        }

    } catch (err) {
        console.error('Error promoting to TA:', err);
        showNotification(`Failed to promote to TA: ${err.message}`, 'error');
    }
};

window.demoteFromTA = async function(studentId, studentName, courseId) {
    // Prefer the courseId passed in from the rendered card (matches the
    // visible URL course), then fall back to URL ?courseId=, then to storage.
    let selectedCourseId = courseId;
    if (!selectedCourseId) {
        const urlParams = new URLSearchParams(window.location.search);
        selectedCourseId = urlParams.get('courseId') || localStorage.getItem('selectedCourseId');
    }

    if (!selectedCourseId) {
        showNotification('No course selected. Please select a course first.', 'error');
        return;
    }

    if (!confirm(`Remove ${studentName} as a Teaching Assistant from this course? They will stay a TA in any other courses.`)) {
        return;
    }

    try {
        const resp = await authenticatedFetch(`/api/courses/${selectedCourseId}/tas/${studentId}`, {
            method: 'DELETE'
        });

        if (!resp.ok) {
            const errorData = await resp.json();
            throw new Error(errorData.message || `HTTP ${resp.status}`);
        }

        showNotification(`Successfully removed ${studentName} as TA from this course`, 'success');

        await loadStudents(selectedCourseId);

    } catch (err) {
        console.error('Error demoting from TA:', err);
        showNotification(`Failed to demote from TA: ${err.message}`, 'error');
    }
};

window.toggleEnrollment = function(courseId, studentId, value) {
    dirtyEnrollment.set(studentId, !!value);
    const btn = document.getElementById(`save-${studentId}`);
    if (btn) btn.disabled = false;
};

window.saveEnrollment = async function(courseId, studentId) {
    try {
        const value = dirtyEnrollment.has(studentId) ? dirtyEnrollment.get(studentId) : true;
        const resp = await authenticatedFetch(`/api/courses/${courseId}/student-enrollment/${studentId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enrolled: value })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        showNotification(`Enrollment ${value ? 'enabled' : 'disabled'} for ${studentId}`, 'success');
        const btn = document.getElementById(`save-${studentId}`);
        if (btn) btn.disabled = true;
    } catch (err) {
        console.error('Error saving enrollment:', err);
        showNotification('Failed to save enrollment. Please try again.', 'error');
    }
};

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str).replace(/[&<>"']/g, (character) => map[character]);
}

function shortenId(value) {
    const text = String(value || '');
    if (!text) return 'unknown';
    if (text.length <= 16) return text;
    return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
}

async function waitForAuth() {
    let attempts = 0;
    const maxAttempts = 50;
    while (attempts < maxAttempts) {
        if (typeof getCurrentInstructorId === 'function' && getCurrentInstructorId()) return;
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }
}

/**
 * Render struggle topics list
 */
function renderStruggleTopics(struggleState) {
    if (!struggleState || !struggleState.topics || struggleState.topics.length === 0) {
        return '<p style="color: #666; font-style: italic; font-size: 0.9em;">No active struggle topics.</p>';
    }

    const sortedTopics = struggleState.topics.sort((a, b) => new Date(b.lastStruggle) - new Date(a.lastStruggle));

    return `
        <ul style="list-style: none; padding: 0; margin: 0; max-height: 150px; overflow-y: auto;">
            ${sortedTopics.map(t => `
                <li style="padding: 4px 8px; margin-bottom: 4px; background: #f8f9fa; border-radius: 4px; border-left: 3px solid ${t.isActive ? '#dc3545' : '#28a745'}; font-size: 0.9em; display: flex; justify-content: space-between; align-items: center;">
                    <span>${capitalize(t.topic)}</span>
                    <div style="display: flex; gap: 8px; font-size: 0.85em; color: #555;">
                        <span>Count: ${t.count}</span>
                        <span>${t.lastStruggle ? new Date(t.lastStruggle).toLocaleDateString() : 'N/A'}</span>
                    </div>
                </li>
            `).join('')}
        </ul>
    `;
}

/**
 * Handle download of struggle report
 */
window.downloadStruggleReport = function(studentId, studentName) {
    const student = currentStudents.find(s => s.userId === studentId);
    if (!student || !student.struggleState || !student.struggleState.topics) {
        showNotification('No struggle data available for this student.', 'warning');
        return;
    }

    const topics = student.struggleState.topics.sort((a, b) => new Date(b.lastStruggle) - new Date(a.lastStruggle));
    
    let markdown = `# Struggle Report: ${studentName}\n`;
    markdown += `Generated on: ${new Date().toLocaleString()}\n\n`;
    
    if (topics.length === 0) {
        markdown += `No struggle topics recorded.\n`;
    } else {
        markdown += `## Active Struggle Topics\n\n`;
        markdown += `| Topic | Struggle Count | Last Occurred | Status |\n`;
        markdown += `|-------|----------------|---------------|--------|\n`;
        
        topics.forEach(t => {
            const status = t.isActive ? '**Directive Mode Active**' : 'Monitoring';
            const date = new Date(t.lastStruggle).toLocaleString();
            markdown += `| ${capitalize(t.topic)} | ${t.count} | ${date} | ${status} |\n`;
        });
        
        markdown += `\n## Details\n\n`;
        topics.forEach(t => {
            markdown += `### ${capitalize(t.topic)}\n`;
            markdown += `- **Count**: ${t.count}\n`;
            markdown += `- **Last Struggle**: ${new Date(t.lastStruggle).toLocaleString()}\n`;
            markdown += `- **Status**: ${t.isActive ? 'Active' : 'Resolved/Monitoring'}\n\n`;
        });
    }

    // Trigger download
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Struggle_Report_${studentName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotification('Report downloaded successfully.', 'success');
};

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
