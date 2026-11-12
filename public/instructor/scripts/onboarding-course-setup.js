/**
 * Onboarding: course selection, join-by-code, creation, and validation.
 * Part of the instructor onboarding page. Loads after onboarding-state.js.
 */

async function checkCourseCodeBypassPermission() {
    try {
        const response = await fetch('/api/settings/can-delete-all', {
            credentials: 'include'
        });

        const result = await response.json();
        return !!(result.success && result.canDeleteAll);
    } catch (error) {
        console.error('Error checking onboarding instructor-code bypass permission:', error);
        return false;
    }
}

function applyJoinCourseCodePermission() {
    const codeHelp = document.getElementById('instructor-course-code-help');
    const codeGroup = document.getElementById('instructor-course-code-group');

    if (codeHelp) {
        codeHelp.textContent = canBypassOnboardingInstructorCourseCodes
            ? 'You have admin access, so no instructor code is required for you to join this course.'
            : 'Ask the course owner for the instructor course code.';
    }

    if (codeGroup && onboardingState.existingCourseId) {
        codeGroup.style.display = canBypassOnboardingInstructorCourseCodes ? 'none' : 'block';
    }

    if (canBypassOnboardingInstructorCourseCodes) {
        clearOnboardingJoinCourseCodeFeedback();
    }
}

async function refreshOnboardingInstructorJoinStatus(courseId) {
    const codeGroup = document.getElementById('instructor-course-code-group');
    const codeHelp = document.getElementById('instructor-course-code-help');
    const joinButton = document.getElementById('join-course-btn');

    onboardingSelectedCourseRequiresCode = !canBypassOnboardingInstructorCourseCodes;
    onboardingSelectedCourseJoinReason = canBypassOnboardingInstructorCourseCodes ? 'admin' : 'courseCode';
    if (canBypassOnboardingInstructorCourseCodes || !courseId) return;

    if (joinButton) joinButton.disabled = true;
    try {
        const response = await authenticatedFetch(`/api/courses/${encodeURIComponent(courseId)}/instructor-join-status`);
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to check instructor access');
        }
        if (onboardingState.existingCourseId !== courseId) return;

        onboardingSelectedCourseRequiresCode = result.data?.requiresCode !== false;
        onboardingSelectedCourseJoinReason = result.data?.reason || 'courseCode';
        if (codeGroup) codeGroup.style.display = onboardingSelectedCourseRequiresCode ? 'block' : 'none';
        if (codeHelp && !onboardingSelectedCourseRequiresCode) {
            codeHelp.textContent = result.data?.reason === 'instructorOfRecord'
                ? 'Your teaching assignment was verified, so no instructor code is required.'
                : 'No instructor code is required for you to join this course.';
        }
        populateSelectedCourseDetails(courseId);
    } catch (error) {
        console.error('Error checking instructor-of-record access:', error);
        // Fail closed in the UI as well: keep the normal code requirement.
        onboardingSelectedCourseRequiresCode = true;
        onboardingSelectedCourseJoinReason = 'courseCode';
        if (codeGroup) codeGroup.style.display = 'block';
    } finally {
        if (joinButton && onboardingState.existingCourseId === courseId) joinButton.disabled = false;
    }
}

// Best-guess id for the current session, used only to preselect an option
// in the populated dropdown — never sent as a fabricated value on its own.
function getPreferredAcademicPeriodId() {
    return `AP-${new Date().getFullYear()}W1`;
}

function getPeriodId(period = {}) {
    return period.academicPeriod?.academicPeriodId || period.academicPeriodId || '';
}

function getPeriodLabel(period = {}) {
    const id = getPeriodId(period);
    const name = period.academicPeriod?.academicPeriodName || period.academicPeriodName || '';
    return [name, id && name ? `(${id})` : id].filter(Boolean).join(' ') || id || 'Unknown session';
}

async function loadAcademicPeriods() {
    const select = document.getElementById('academic-period-input');
    if (!select || select.dataset.loaded === 'true') return;

    try {
        const response = await authenticatedFetch('/api/academic-sync/academic-periods');
        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to load sessions');
        }

        const periods = (Array.isArray(result.data) ? result.data : [])
            .filter(period => getPeriodId(period));

        if (!periods.length) {
            select.innerHTML = '<option value="">No sessions available</option>';
            return;
        }

        const preferredId = getPreferredAcademicPeriodId();
        select.innerHTML = '';
        periods.forEach(period => {
            const option = document.createElement('option');
            option.value = getPeriodId(period);
            option.textContent = getPeriodLabel(period);
            select.appendChild(option);
        });

        // Preselect the current session if present, otherwise the latest period.
        const hasPreferred = periods.some(period => getPeriodId(period) === preferredId);
        select.value = hasPreferred ? preferredId : getPeriodId(periods[periods.length - 1]);
        select.dataset.loaded = 'true';
        onboardingState.academicSync.academicPeriod = select.value;
    } catch (error) {
        console.error('Error loading academic periods:', error);
        select.innerHTML = '<option value="">Could not load sessions</option>';
    }
}

function setAcademicSyncStatus(message, type = 'info') {
    const status = document.getElementById('academic-sync-status');
    if (!status) return;

    status.textContent = message || '';
    status.className = `academic-sync-status ${type ? `academic-sync-status-${type}` : ''}`;
}

function resetAcademicSectionSelection() {
    onboardingState.academicSync.selectedSectionIds = [];
    onboardingState.academicSync.sections = [];

    const list = document.getElementById('academic-sections-list');
    if (list) {
        list.hidden = true;
        list.innerHTML = '';
    }

    setAcademicSyncStatus('');
}

function updateAcademicSyncVisibility() {
    const courseSelect = document.getElementById('course-select');
    const syncSection = document.getElementById('academic-sync-section');

    if (!syncSection || !courseSelect) return;

    // Class List Sync only exists when the academic API is enabled for this
    // instance; otherwise it stays hidden and onboarding is the old manual flow.
    const shouldShow = onboardingAcademicApiEnabled && isCreateModeSelection(courseSelect.value);
    syncSection.style.display = shouldShow ? 'block' : 'none';

    if (shouldShow) {
        loadAcademicPeriods();
    } else {
        resetAcademicSectionSelection();
    }
}

function getSectionId(section = {}) {
    return section.picker?.sectionId || section.courseSectionId || section.id || section.sectionId || section.referenceId || '';
}

function getDisplayValue(value, preferredKeys = ['code', 'description', 'name', 'value', 'id']) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value !== 'object') return '';

    for (const key of preferredKeys) {
        if (value[key] != null && typeof value[key] !== 'object') {
            return String(value[key]);
        }
    }

    return '';
}

function getSectionLabel(section = {}) {
    if (section.picker?.displayName) {
        return section.picker.displayName;
    }

    const subject = getDisplayValue(section.course?.courseSubject || section.courseSubject || section.subjectCode);
    const number = getDisplayValue(section.course?.courseNumber || section.courseNumber);
    const sectionNumber = getDisplayValue(section.sectionNumber || section.courseSectionNumber || section.number);
    const title = getDisplayValue(section.course?.courseTitle || section.courseTitle || section.title, ['description', 'name', 'value', 'code']);
    const pieces = [subject, number, sectionNumber ? `Section ${sectionNumber}` : '']
        .filter(Boolean)
        .join(' ');

    return pieces || title || getSectionId(section) || 'Unnamed section';
}

function getSectionMeta(section = {}) {
    if (section.picker?.meta) {
        return section.picker.meta;
    }

    return [
        section.courseSectionId,
        getDisplayValue(section.sectionStatus || section.status, ['description', 'name', 'code', 'value']),
        getDisplayValue(section.course?.courseTitle || section.courseTitle || section.title, ['description', 'name', 'value', 'code'])
    ].filter(Boolean).join(' · ');
}

function getAcademicCourseNameFromSection(section = {}) {
    const subject = getDisplayValue(section.course?.courseSubject || section.courseSubject || section.subjectCode);
    const number = getDisplayValue(section.course?.courseNumber || section.courseNumber);
    const title = getDisplayValue(section.course?.courseTitle || section.courseTitle || section.course?.title || section.title, ['description', 'name', 'value', 'code']);
    const code = [subject, number].filter(Boolean).join(' ');

    return [code, title].filter(Boolean).join(' - ') || getSectionLabel(section);
}

function maybePopulateCourseNameFromAcademicSelection() {
    const courseSelect = document.getElementById('course-select');
    const customCourseInput = document.getElementById('custom-course-name');

    if (!courseSelect || !customCourseInput || !isCreateModeSelection(courseSelect.value)) {
        return;
    }

    // Don't clobber a name the instructor typed by hand. We only overwrite when
    // the field is empty or still holds a value we previously autofilled, so
    // switching the selected section keeps the name in sync.
    const wasAutofilled = customCourseInput.dataset.autofilled === 'true';
    if (customCourseInput.value.trim() && !wasAutofilled) {
        return;
    }

    const firstSelectedId = onboardingState.academicSync.selectedSectionIds[0];
    if (!firstSelectedId) {
        return;
    }

    const section = onboardingState.academicSync.sections.find(item => getSectionId(item) === firstSelectedId);
    if (!section) {
        return;
    }

    customCourseInput.value = getAcademicCourseNameFromSection(section);
    customCourseInput.dataset.autofilled = 'true';
    onboardingState.courseData.course = customCourseInput.value;
}

// Once the instructor engages the create flow (picks a section or types a name),
// reflect that in the course dropdown so it reads "create a new course" and the
// required-field validation passes instead of demanding a dropdown pick.
function reflectCreateModeInCourseSelect() {
    const courseSelect = document.getElementById('course-select');
    if (courseSelect && courseSelect.value === '') {
        courseSelect.value = 'custom';
    }
}

function syncSelectedAcademicSectionsFromDOM() {
    const checked = Array.from(document.querySelectorAll('input[name="academic-section"]:checked'))
        .map(input => input.value)
        .filter(Boolean);

    onboardingState.academicSync.selectedSectionIds = checked;
    if (checked.length) {
        reflectCreateModeInCourseSelect();
    }
    maybePopulateCourseNameFromAcademicSelection();
}

function renderAcademicSections(sections = []) {
    const list = document.getElementById('academic-sections-list');
    if (!list) return;

    list.innerHTML = '';

    if (!sections.length) {
        list.hidden = true;
        setAcademicSyncStatus('No sections found for that period.', 'warn');
        return;
    }

    // Sections that already have a BiocBot course can't be set up again.
    const selectableSections = sections.filter(section => !section.picker?.alreadySetUp);

    const fragment = document.createDocumentFragment();
    sections.forEach(section => {
        const sectionId = getSectionId(section);
        if (!sectionId) return;

        const alreadySetUp = section.picker?.alreadySetUp === true;

        const label = document.createElement('label');
        label.className = alreadySetUp ? 'academic-section-option is-disabled' : 'academic-section-option';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'academic-section';
        radio.value = sectionId;
        radio.disabled = alreadySetUp;
        // Auto-select only when there's exactly one section you can actually set up.
        radio.checked = !alreadySetUp && selectableSections.length === 1;
        radio.addEventListener('change', syncSelectedAcademicSectionsFromDOM);

        const text = document.createElement('span');
        text.className = 'academic-section-text';

        const title = document.createElement('strong');
        title.textContent = getSectionLabel(section);

        const meta = document.createElement('small');
        meta.textContent = alreadySetUp
            ? `${getSectionMeta(section)} · Already set up`
            : getSectionMeta(section);

        text.appendChild(title);
        text.appendChild(meta);
        label.appendChild(radio);
        label.appendChild(text);
        fragment.appendChild(label);
    });

    list.appendChild(fragment);
    list.hidden = list.children.length === 0;
    syncSelectedAcademicSectionsFromDOM();

    const alreadyCount = sections.length - selectableSections.length;
    const baseMsg = `${sections.length} section${sections.length === 1 ? '' : 's'} found.`;
    setAcademicSyncStatus(alreadyCount ? `${baseMsg} ${alreadyCount} already set up.` : baseMsg, 'success');
}

async function loadAcademicSectionsForOnboarding() {
    const periodInput = document.getElementById('academic-period-input');
    const button = document.getElementById('load-academic-sections-btn');
    const academicPeriod = periodInput ? periodInput.value.trim() : '';

    if (!academicPeriod) {
        showFieldError(periodInput, 'Enter an academic period');
        return;
    }

    onboardingState.academicSync.academicPeriod = academicPeriod;
    onboardingState.academicSync.selectedSectionIds = [];

    const originalText = button ? button.textContent : '';
    if (button) {
        button.disabled = true;
        button.textContent = 'Finding...';
    }
    setAcademicSyncStatus('Finding sections...', 'info');

    try {
        const response = await authenticatedFetch(`/api/academic-sync/instructor-sections?academicPeriod=${encodeURIComponent(academicPeriod)}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to load sections');
        }

        onboardingState.academicSync.sections = Array.isArray(result.data) ? result.data : [];
        renderAcademicSections(onboardingState.academicSync.sections);
    } catch (error) {
        console.error('Error loading academic sections:', error);
        resetAcademicSectionSelection();
        setAcademicSyncStatus(error.message || 'Could not load sections.', 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

async function initializeAcademicSyncPicker() {
    // Gate the whole picker on the instance-wide academic-API setting. When off
    // (the default), leave the section hidden and don't touch the academic API.
    try {
        const response = await authenticatedFetch('/api/settings/academic-api-enabled');
        const result = await response.json();
        onboardingAcademicApiEnabled = !!(result && result.success && result.enabled);
    } catch (error) {
        console.error('Error checking academic API gate:', error);
        onboardingAcademicApiEnabled = false;
    }

    if (!onboardingAcademicApiEnabled) {
        updateAcademicSyncVisibility();
        return;
    }

    const button = document.getElementById('load-academic-sections-btn');
    const periodSelect = document.getElementById('academic-period-input');

    loadAcademicPeriods();

    if (periodSelect) {
        periodSelect.addEventListener('change', () => {
            onboardingState.academicSync.academicPeriod = periodSelect.value.trim();
            resetAcademicSectionSelection();
        });
    }

    if (button) {
        button.addEventListener('click', loadAcademicSectionsForOnboarding);
    }

    // The flag may have arrived after the initial layout ran, so reapply it now.
    updateAcademicSyncVisibility();
}

/**
 * Handle course selection change
 */
// A blank ('') or 'custom' selection both mean "create a new course" — the
// instructor either types a name or finds their section via Class List Sync.
// Any other value is an existing course id, which means "join".
function isCreateModeSelection(value) {
    return value === '' || value === 'custom';
}

/**
 * The AI platform the instructor picked in step 1 of onboarding.
 * Instructors choose a platform label only — never a model.
 */
function selectedOnboardingProvider() {
    if (window.LlmPlatform) return window.LlmPlatform.selectedProvider('onboarding');
    const checked = document.querySelector('input[name="onboarding-llm-provider"]:checked');
    return checked ? checked.value : 'openai';
}

function onboardingProviderLabel(provider) {
    if (window.LlmPlatform) return window.LlmPlatform.providerLabel(provider);
    if (provider === 'ubc-llm-proxy') return 'UBC LLM Proxy';
    return provider === 'ubc-llm-sandbox' ? 'UBC On-Premise LLM' : 'OpenAI Chat GPT';
}

/**
 * Swap the key field's label, placeholder and help text to match the platform.
 */
function refreshOnboardingPlatformHelp() {
    const provider = selectedOnboardingProvider();
    const meta = window.LlmPlatform
        ? window.LlmPlatform.providerMeta(provider)
        : {
            label: onboardingProviderLabel(provider),
            helpText: provider === 'ubc-llm-proxy'
                ? 'Enter the UBC LLM Proxy key issued for this course.'
                : provider === 'ubc-llm-sandbox'
                    ? 'Contact the LTIC team to request a UBC LLM Sandbox API key.'
                    : 'Feel free to use your own OpenAI API key, or contact the support team for assistance.',
            keyPlaceholder: provider === 'ubc-llm-proxy'
                ? 'UBC LLM Proxy API key'
                : provider === 'ubc-llm-sandbox' ? 'UBC LLM Sandbox API key' : 'sk-...'
        };

    const label = document.getElementById('course-api-key-label');
    if (label) label.textContent = `Course ${meta.label} API Key`;

    const input = document.getElementById('course-api-key');
    if (input) input.placeholder = meta.keyPlaceholder;

    const help = document.getElementById('onboarding-llm-platform-help');
    if (help) {
        help.textContent = meta.helpText;
        if (provider === 'openai') {
            help.innerHTML = meta.helpText.replace(
                'the support team',
                '<a href="mailto:LT.hub@ubc.ca">the support team</a>'
            );
        }
    }
}

function initOnboardingPlatformSelector() {
    const radios = document.querySelectorAll('input[name="onboarding-llm-provider"]');
    radios.forEach(radio => radio.addEventListener('change', refreshOnboardingPlatformHelp));
    refreshOnboardingPlatformHelp();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initOnboardingPlatformSelector);
    } else {
        initOnboardingPlatformSelector();
    }
}

function handleCourseSelection(event) {
    const courseSelect = event.target;
    const customCourseSection = document.getElementById('custom-course-section');
    const apiKeySection = document.getElementById('course-api-key-section');
    const courseStructureSection = document.getElementById('course-structure-section');
    const joinCourseSection = document.getElementById('join-course-section');
    const continueBtn = document.getElementById('continue-btn');
    const joinCourseBtn = document.getElementById('join-course-btn');
    const codeGroup = document.getElementById('instructor-course-code-group');
    const codeInput = document.getElementById('instructor-course-code');
    clearOnboardingJoinCourseCodeFeedback();

    const createMode = isCreateModeSelection(courseSelect.value);

    // Course-name field, Class List Sync, API key and structure are all part of
    // the "create a new course" flow; the join panel replaces them otherwise.
    customCourseSection.style.display = createMode ? 'block' : 'none';
    if (apiKeySection) apiKeySection.style.display = createMode ? 'block' : 'none';
    courseStructureSection.style.display = createMode ? 'block' : 'none';
    joinCourseSection.style.display = createMode ? 'none' : 'block';
    continueBtn.style.display = createMode ? 'inline-block' : 'none';
    joinCourseBtn.style.display = createMode ? 'none' : 'inline-block';

    if (createMode) {
        onboardingState.existingCourseId = null;
        onboardingSelectedCourseRequiresCode = true;
        onboardingSelectedCourseJoinReason = 'courseCode';
        if (codeGroup) codeGroup.style.display = 'none';
        if (codeInput) codeInput.value = '';
        // Keep any name already typed/autofilled; otherwise leave it for the
        // Class List Sync picker to populate.
        const customName = document.getElementById('custom-course-name').value.trim();
        onboardingState.courseData.course = customName || null;
        updateAcademicSyncVisibility();
    } else {
        onboardingSelectedCourseRequiresCode = !canBypassOnboardingInstructorCourseCodes;
        onboardingSelectedCourseJoinReason = canBypassOnboardingInstructorCourseCodes ? 'admin' : 'courseCode';
        if (codeGroup) {
            codeGroup.style.display = canBypassOnboardingInstructorCourseCodes ? 'none' : 'block';
        }
        if (codeInput) codeInput.value = '';

        // Store course data and populate course details (also hides Class List Sync)
        onboardingState.courseData.course = courseSelect.value;
        populateSelectedCourseDetails(courseSelect.value);
        refreshOnboardingInstructorJoinStatus(courseSelect.value);
    }
}

/**
 * Handle custom course name input
 */
function handleCustomCourseInput(event) {
    // The instructor typed their own name, so stop auto-syncing it to the
    // selected section.
    event.target.dataset.autofilled = 'false';
    onboardingState.courseData.course = event.target.value;
    if (event.target.value.trim()) {
        reflectCreateModeInCourseSelect();
    }
}

/**
 * Populate selected course details for joining
 */
function populateSelectedCourseDetails(courseId) {
    const courseDetailsContainer = document.getElementById('selected-course-details');
    
    // Find the course data from the available courses
    const courseSelect = document.getElementById('course-select');
    const selectedOption = courseSelect.querySelector(`option[value="${courseId}"]`);
    
    if (selectedOption) {
        const courseName = selectedOption.textContent;
        courseDetailsContainer.innerHTML = `
            <div class="course-info">
                <h4>${courseName}</h4>
                <p><strong>Course ID:</strong> ${courseId}</p>
                <p>${onboardingSelectedCourseJoinReason === 'instructorOfRecord'
                    ? 'Another instructor has created this course shell. Since you are an instructor of record, you can join it without an instructor code.'
                    : (!onboardingSelectedCourseRequiresCode
                        ? 'You have admin access, so you can join this course without entering an instructor code.'
                        : 'Enter the instructor course code to join this course.')}</p>
            </div>
        `;
        
        // Store the course ID for joining
        onboardingState.existingCourseId = courseId;
    }

    updateAcademicSyncVisibility();
}

function animateOnboardingJoinCourseCodeError(field) {
    if (!field) {
        return;
    }

    field.classList.remove('field-error-shake');
    void field.offsetWidth;
    field.classList.add('field-error-shake');
}

function setOnboardingJoinCourseCodeFeedback(message) {
    const codeInput = document.getElementById('instructor-course-code');
    const errorElement = document.getElementById('instructor-course-code-error');

    if (codeInput) {
        codeInput.classList.add('input-error');
        codeInput.setAttribute('aria-invalid', 'true');
        animateOnboardingJoinCourseCodeError(codeInput);
        codeInput.focus();
    }

    if (errorElement) {
        errorElement.textContent = message;
        errorElement.style.display = 'block';
    }
}

function clearOnboardingJoinCourseCodeFeedback() {
    const codeInput = document.getElementById('instructor-course-code');
    const errorElement = document.getElementById('instructor-course-code-error');

    if (codeInput) {
        codeInput.classList.remove('input-error', 'field-error-shake');
        codeInput.removeAttribute('aria-invalid');
    }

    if (errorElement) {
        errorElement.textContent = '';
        errorElement.style.display = 'none';
    }
}

/**
 * Join an existing course
 */
async function joinExistingCourse() {
    if (!onboardingState.existingCourseId) {
        showNotification('No course selected to join.', 'error');
        return;
    }

    const codeInput = document.getElementById('instructor-course-code');
    const code = codeInput ? codeInput.value.trim().toUpperCase() : '';
    if (onboardingSelectedCourseRequiresCode && !code) {
        setOnboardingJoinCourseCodeFeedback('Instructor course code is required to join this course.');
        return;
    }

    clearOnboardingJoinCourseCodeFeedback();
    
    try {
        console.log(`🚀 [ONBOARDING] Joining existing course: ${onboardingState.existingCourseId}`);
        
        // Show loading state
        const joinBtn = document.getElementById('join-course-btn');
        const originalText = joinBtn.textContent;
        joinBtn.textContent = 'Joining Course...';
        joinBtn.disabled = true;
        
        const result = await BiocBotCourseJoin.joinInstructorCourse({
            courseId: onboardingState.existingCourseId,
            instructorId: getCurrentInstructorId(),
            code
        });
        console.log('✅ [ONBOARDING] Successfully joined course:', result);
        
        // Mark instructor's onboarding as complete since they joined an existing course
        await markInstructorOnboardingComplete(onboardingState.existingCourseId);
        
        // Show success message
        showNotification('Successfully joined the course!', 'success');
        
        // Redirect to the course page after a short delay
        setTimeout(() => {
            window.location.href = `/instructor/documents?courseId=${onboardingState.existingCourseId}`;
        }, 2000);
        
    } catch (error) {
        console.error('❌ [ONBOARDING] Error joining course:', error);
        if (codeInput && /course code|required|invalid/i.test(error.message)) {
            setOnboardingJoinCourseCodeFeedback(error.message);
        } else {
            showNotification(`Error joining course: ${error.message}`, 'error');
        }
        
        // Reset button state
        const joinBtn = document.getElementById('join-course-btn');
        joinBtn.textContent = 'Join Course';
        joinBtn.disabled = false;
    }
}

/**
 * Handle course setup form submission
 */
async function handleCourseSetup(event) {
    event.preventDefault();
    
    // Prevent multiple submissions
    if (onboardingState.isSubmitting) {
        return;
    }
    
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    
    // Validate form
    if (!validateCourseSetup()) {
        return;
    }
    
    // Collect form data
    const formData = new FormData(form);
    const weeks = parseInt(formData.get('weeks'));
    const lecturesPerWeek = parseInt(formData.get('lecturesPerWeek'));
    
    onboardingState.courseData = {
        course: isCreateModeSelection(formData.get('course')) ?
            document.getElementById('custom-course-name').value :
            formData.get('course'),
        apiKey: String(formData.get('apiKey') || '').trim(),
        llmProvider: selectedOnboardingProvider(),
        weeks: weeks,
        lecturesPerWeek: lecturesPerWeek,
        totalUnits: weeks * lecturesPerWeek // Calculate total units
    };
    

    
    // Set submitting flag and disable submit button
    onboardingState.isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Creating course...';

    try {
        // Only check for existing courses if not creating a new course
        const courseSelect = document.getElementById('course-select');
        const isCustomCourse = courseSelect && isCreateModeSelection(courseSelect.value);

        if (!isCustomCourse) {
            // Check if course already exists (either for this instructor or globally)
            const existingCourse = await checkExistingCourse();
            if (existingCourse) {
                // If course exists, set the existing course ID and join it
                onboardingState.existingCourseId = existingCourse.courseId;
                onboardingState.createdCourseId = existingCourse.courseId;
                await joinExistingCourse();
                return;
            }
        } else {
            // For custom courses, check if instructor already has an incomplete course
            // If so, use that course instead of creating a new one
            const instructorId = getCurrentInstructorId();
            if (instructorId) {
                const response = await authenticatedFetch(`/api/onboarding/instructor/${instructorId}`);
                if (response.ok) {
                    const result = await response.json();
                    if (result.data && result.data.courses && result.data.courses.length > 0) {
                        // Check for incomplete course (isOnboardingComplete is false)
                        const incompleteCourse = result.data.courses.find(course => 
                            !course.isOnboardingComplete || course.isOnboardingComplete === false
                        );
                        if (incompleteCourse) {
                            // Use the existing incomplete course
                            onboardingState.createdCourseId = incompleteCourse.courseId;
                            onboardingState.existingCourseId = incompleteCourse.courseId;
                            await linkAcademicSectionsForOnboarding(incompleteCourse.courseId);
                            console.log('Using existing incomplete course:', incompleteCourse.courseId);
                            // Continue to next step with existing course
                            nextStep();
                            return;
                        }
                    }
                }
            }
        }
        
        // Create course and save to database
        const response = await createCourse(onboardingState.courseData);
        onboardingState.createdCourseId = response.courseId;
        await linkAcademicSectionsForOnboarding(response.courseId);
        if (response.aiAvailable === false) {
            showNotification(
                'Course created. AI tools are waiting for a system administrator to select compatible models.',
                'warning'
            );
        }
        
        // Move to next step (guided unit setup)
        nextStep();
        
    } catch (error) {
        console.error('Error creating course:', error);
        showNotification('Error creating course. Please try again.', 'error');
    } finally {
        // Reset submitting flag and re-enable submit button
        onboardingState.isSubmitting = false;
        submitButton.disabled = false;
        submitButton.textContent = 'Continue to Unit Setup';
    }
}

async function linkAcademicSectionsForOnboarding(courseId) {
    syncSelectedAcademicSectionsFromDOM();

    const sectionIds = onboardingState.academicSync.selectedSectionIds || [];
    const academicPeriod = onboardingState.academicSync.academicPeriod;

    if (!courseId || !academicPeriod || sectionIds.length === 0) {
        return null;
    }

    try {
        setAcademicSyncStatus('Linking sections...', 'info');

        const linkResponse = await authenticatedFetch(`/api/academic-sync/courses/${encodeURIComponent(courseId)}/link`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ academicPeriod, sectionIds })
        });
        const linkResult = await linkResponse.json();

        if (!linkResponse.ok || !linkResult.success) {
            throw new Error(linkResult.message || 'Failed to link sections');
        }

        const syncResponse = await authenticatedFetch(`/api/academic-sync/courses/${encodeURIComponent(courseId)}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ academicPeriod, sectionIds })
        });
        const syncResult = await syncResponse.json();

        if (!syncResponse.ok || !syncResult.success) {
            throw new Error(syncResult.message || 'Failed to sync roster');
        }

        const summary = syncResult.data || {};
        setAcademicSyncStatus(`Roster synced: ${summary.added || 0} added, ${summary.updated || 0} updated, ${summary.removed || 0} removed.`, 'success');
        return syncResult;
    } catch (error) {
        console.error('Error linking academic sections:', error);
        setAcademicSyncStatus(error.message || 'Could not sync class list.', 'error');
        showNotification(`Course created, but class list sync failed: ${error.message}`, 'error');
        return null;
    }
}

/**
 * Check if course already exists (either for this instructor or globally by name)
 */
async function checkExistingCourse() {
    try {
        const courseSelect = document.getElementById('course-select');
        const selectedCourseId = courseSelect ? courseSelect.value : '';
        if (selectedCourseId && selectedCourseId !== 'custom') {
            const selectedOption = courseSelect.options[courseSelect.selectedIndex];
            return {
                courseId: selectedCourseId,
                courseName: selectedOption ? selectedOption.textContent : selectedCourseId
            };
        }

        const courseName = onboardingState.courseData.course;
        if (!courseName) {
            return null;
        }

        const instructorId = getCurrentInstructorId();
        if (instructorId) {
            const response = await authenticatedFetch(`/api/onboarding/instructor/${instructorId}`);

            if (response.ok) {
                const result = await response.json();
                if (result.data && result.data.courses) {
                    const existingInstructorCourse = result.data.courses.find(course =>
                        course.courseName && course.courseName.toLowerCase() === courseName.toLowerCase()
                    );

                    if (existingInstructorCourse) {
                        return existingInstructorCourse;
                    }
                }
            }
        }

        const joinableCoursesResponse = await authenticatedFetch('/api/courses/available/joinable');
        if (joinableCoursesResponse.ok) {
            const joinableCoursesResult = await joinableCoursesResponse.json();
            if (joinableCoursesResult.success && joinableCoursesResult.data) {
                const existingCourse = joinableCoursesResult.data.find(course =>
                    course.courseName.toLowerCase() === courseName.toLowerCase()
                );
                if (existingCourse) {
                    return existingCourse;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error checking existing course:', error);
        return null;
    }
}

/**
 * Mark instructor's onboarding as complete
 */
async function markInstructorOnboardingComplete(courseId) {
    try {
        console.log(`🔧 [ONBOARDING] Marking instructor onboarding as complete for course: ${courseId}`);
        
        const response = await authenticatedFetch('/api/onboarding/complete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                instructorId: getCurrentInstructorId()
            })
        });
        
        if (response.ok) {
            console.log('✅ [ONBOARDING] Successfully marked onboarding as complete');
        } else {
            console.warn('⚠️ [ONBOARDING] Failed to mark onboarding as complete, but continuing...');
        }
    } catch (error) {
        console.error('❌ [ONBOARDING] Error marking onboarding as complete:', error);
        // Don't throw error here as it's not critical for the join process
    }
}

/**
 * Get detailed course information
 */
async function getCourseDetails(courseId) {
    try {
        const response = await authenticatedFetch(`/api/onboarding/${courseId}`);
        if (response.ok) {
            const result = await response.json();
            return result.data;
        }
        return null;
    } catch (error) {
        console.error('Error getting course details:', error);
        return null;
    }
}

/**
 * Create course and save onboarding data to database
 */
async function createCourse(courseData) {
    try {
        console.log('🚀 [ONBOARDING] Starting course creation process...');
        console.log('📋 [ONBOARDING] Course setup collected');
        
        // Generate a course ID based on the course name
        let courseId = courseData.course.replace(/\s+/g, '-').toUpperCase();
        
        // Ensure the course ID is valid (no special characters, reasonable length)
        courseId = courseId.replace(/[^A-Z0-9-]/g, '');
        if (courseId.length > 20) {
            courseId = courseId.substring(0, 20);
        }
        
        // Add timestamp to ensure uniqueness
        courseId = `${courseId}-${Date.now()}`;
        console.log(`🆔 [ONBOARDING] Generated course ID: ${courseId}`);
        
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        console.log(`👤 [ONBOARDING] Using instructor ID: ${instructorId}`);
        
        // Get learning objectives from the UI
        const learningObjectives = getLearningObjectivesFromUI();
        console.log('📚 [ONBOARDING] Learning objectives from UI:', learningObjectives);
        
        // If no objectives found, show error
        if (learningObjectives.length === 0) {            
            console.warn('⚠️ [ONBOARDING] No learning objectives found in UI');
            // Try to find objectives manually
            const objectivesList = document.getElementById('objectives-list');
            if (objectivesList) {
                const items = objectivesList.querySelectorAll('.objective-display-item');
                items.forEach((item, index) => {
                    const text = item.querySelector('.objective-text')?.textContent;
                });
            }
        }
        
        // Prepare onboarding data with unit structure
        const onboardingData = {
            courseId: courseId,
            courseName: courseData.course,
            instructorId: instructorId,
            courseDescription: '',
            learningOutcomes: learningObjectives,
            assessmentCriteria: '',
            courseMaterials: [],
            unitFiles: {},
            courseStructure: {
                weeks: courseData.weeks,
                lecturesPerWeek: courseData.lecturesPerWeek,
                totalUnits: courseData.totalUnits
            },
            apiKey: courseData.apiKey,
            llmProvider: courseData.llmProvider || 'openai'
        };
        
        console.log('📋 [ONBOARDING] Prepared onboarding course structure');
        
        // Initialize unit structure with Unit 1 learning objectives
        for (let i = 1; i <= courseData.totalUnits; i++) {
            const unitName = `Unit ${i}`;
            onboardingData.unitFiles[unitName] = [];
            
            // Add learning objectives to Unit 1
            if (i === 1 && learningObjectives.length > 0) {
                onboardingData.lectures = [{
                    name: unitName,
                    learningObjectives: learningObjectives,
                    isPublished: false,
                    passThreshold: 2,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }];
            }
        }
        
        console.log('📋 [ONBOARDING] Finalized onboarding unit structure');
        console.log(`📡 [MONGODB] Making API request to /api/onboarding (POST)`);
        console.log(`📡 [MONGODB] Request body size: ${JSON.stringify(onboardingData).length} characters`);
        
        const response = await authenticatedFetch('/api/onboarding', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(onboardingData)
        });
        
        console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
        console.log(`📡 [MONGODB] API response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (!response.ok) {
            const message = await extractErrorMessage(response, 'Failed to create course');
            console.error(`❌ [MONGODB] API error response: ${message}`);
            throw new Error(message);
        }
        
        const result = await response.json();
        console.log('✅ [MONGODB] Course created successfully:', result);
        
        // After successfully creating the course, save Unit 1 data using the same APIs
        // that the course upload functionality expects
        // Note: Learning objectives will be saved together when onboarding is completed
        // to avoid overwriting issues
        
        return {
            courseId: courseId,
            name: courseData.course,
            weeks: courseData.weeks,
            lecturesPerWeek: courseData.lecturesPerWeek,
            createdAt: new Date().toISOString(),
            status: 'active',
            aiAvailable: result.data?.aiAvailable !== false,
            llmConfigurationStatus: result.data?.llmConfigurationStatus || 'ready'
        };
        
    } catch (error) {
        console.error('❌ [ONBOARDING] Error creating course:', error);
        throw error;
    }
}

/**
 * Validate course setup form
 */
function validateCourseSetup() {
    const courseSelect = document.getElementById('course-select');
    const weeksInput = document.getElementById('weeks-count');
    const lecturesInput = document.getElementById('lectures-per-week');
    const apiKeyInput = document.getElementById('course-api-key');
    
    let isValid = true;

    const createMode = isCreateModeSelection(courseSelect.value);

    // In create mode the course name comes from the custom-name field (typed or
    // autofilled from a selected section); require it instead of a dropdown pick.
    if (createMode) {
        const customName = document.getElementById('custom-course-name').value.trim();
        if (!customName) {
            showFieldError(document.getElementById('custom-course-name'), 'Please enter a course name or pick a section above');
            isValid = false;
        }
    }

    // Only validate course structure fields if creating a new course
    if (createMode) {
        if (!apiKeyInput || !apiKeyInput.value.trim()) {
            const platform = onboardingProviderLabel(selectedOnboardingProvider());
            showFieldError(apiKeyInput, `Enter the ${platform} API key for this course`);
            isValid = false;
        }

        // Validate weeks input
        const weeks = parseInt(weeksInput.value);
        if (!weeks || weeks < 1 || weeks > 20) {
            showFieldError(weeksInput, 'Please enter a valid number of weeks (1-20)');
            isValid = false;
        }
        
        // Validate lectures per week input
        const lectures = parseInt(lecturesInput.value);
        if (!lectures || lectures < 1 || lectures > 5) {
            showFieldError(lecturesInput, 'Please enter a valid number of lectures per week (1-5)');
            isValid = false;
        }
    }
    
    return isValid;
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

function populateAvailableCourses(selectElement, courses) {
    selectElement.innerHTML = '<option value="">Choose a course...</option>';

    const uniqueCourses = dedupeCourses(courses);
    const activeCourses = uniqueCourses.filter(course => !isCourseInactive(course));
    const inactiveCourses = uniqueCourses.filter(isCourseInactive);

    appendCourseGroup(selectElement, 'Active Courses', activeCourses);
    appendCourseGroup(selectElement, 'Inactive Courses', inactiveCourses);
}

/**
 * Load available courses for the instructor
 */
async function loadAvailableCourses() {
    try {
        const courseSelect = document.getElementById('course-select');
        
        if (!courseSelect) return;
        
        // Fetch courses from the API
        const response = await fetch('/api/courses/available/joinable');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to fetch courses');
        }
        
        const courses = result.data || [];
        
        console.log('All available courses from API:', courses);

        populateAvailableCourses(courseSelect, courses);
        
        // Add custom course option
        const customOption = document.createElement('option');
        customOption.value = 'custom';
        customOption.textContent = 'Create a new course...';
        courseSelect.appendChild(customOption);
        
        console.log('Available courses loaded and deduplicated:', dedupeCourses(courses));
        updateAcademicSyncVisibility();
        
    } catch (error) {
        console.error('Error loading available courses:', error);
        // Keep the placeholder option if API fails
        const courseSelect = document.getElementById('course-select');
        if (courseSelect) {
            courseSelect.innerHTML = '<option value="">Choose a course...</option>';
            // Add custom course option even if API fails
            const customOption = document.createElement('option');
            customOption.value = 'custom';
            customOption.textContent = 'Create a new course...';
            courseSelect.appendChild(customOption);
        }
        updateAcademicSyncVisibility();
    }
}
