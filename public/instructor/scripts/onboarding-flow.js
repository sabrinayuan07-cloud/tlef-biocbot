/**
 * Onboarding: step/substep navigation, status check, restore, and the
 * finish/save-all flow. Part of the instructor onboarding page.
 */

/**
 * Determine whether an onboarding material badge represents saved content.
 * @param {HTMLElement|null} statusBadge - Material status badge
 * @returns {boolean} Whether material is available
 */
function isOnboardingMaterialAvailable(statusBadge) {
    const status = (statusBadge?.dataset?.status || '').trim().toLowerCase();
    return status === 'uploaded' || status === 'parsed' || status === 'processed' || status === 'added';
}

/**
 * Check if onboarding is already complete for this instructor
 */
async function checkOnboardingStatus() {
    try {
        console.log('🔍 [ONBOARDING] Checking onboarding status...');
        
        // Check if there's a courseId in URL params (from redirect)
        const urlParams = new URLSearchParams(window.location.search);
        const courseId = urlParams.get('courseId');

        // "Set up another section" from Home: start a fresh onboarding flow even
        // though the instructor already has courses, so they can set up a new
        // course for one of their other sections (via the session/section picker).
        if (!courseId && urlParams.get('addCourse')) {
            console.log('➕ [ONBOARDING] addCourse mode — starting a fresh course setup');
            showOnboardingFlow();
            showStep(1);
            return;
        }

        if (courseId) {
            console.log(`🔍 [ONBOARDING] Found courseId in URL params: ${courseId}`);
            // Check if this course has onboarding complete
            console.log(`📡 [MONGODB] Making API request to /api/onboarding/${courseId}`);
            const response = await authenticatedFetch(`/api/onboarding/${courseId}`);
            console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
            
            if (response.ok) {
                const courseData = await response.json();
                console.log('📡 [MONGODB] Course data retrieved:', courseData);
                if (courseData.data && courseData.data.isOnboardingComplete === true) {
                    console.log('✅ [ONBOARDING] Onboarding already complete for this course');
                    onboardingState.existingCourseId = courseId;
                    showOnboardingComplete();
                    return;
                } else {
                    // Course exists but onboarding is not complete - resume onboarding
                    console.log('⚠️ [ONBOARDING] Course exists but onboarding not complete, resuming...');
                    onboardingState.createdCourseId = courseId;
                    onboardingState.existingCourseId = courseId;

                    // Check Unit 1 content to determine which step to resume at
                    const unit1 = courseData.data?.lectures?.find(lecture => lecture.name === 'Unit 1');
                    const hasObjectives = unit1?.learningObjectives && unit1.learningObjectives.length > 0;
                    const hasDocuments = unit1?.documents && unit1.documents.length > 0;
                    
                    if (!hasObjectives) {
                        console.log('📝 [ONBOARDING] Resuming at Step 3: Learning Objectives');
                        showOnboardingFlow();
                        showStep(3);
                        showSubstep('objectives');
                        return;
                    } else if (!hasDocuments) {
                        console.log('📁 [ONBOARDING] Resuming at Step 3: Course Materials');
                        showOnboardingFlow();
                        showStep(3);
                        showSubstep('materials');
                        return;
                    } else {
                        console.log('❓ [ONBOARDING] Resuming at Step 3: Assessment Questions');
                        showOnboardingFlow();
                        showStep(3);
                        showSubstep('questions');
                        return;
                    }
                }
            }
        }
        
        // Check if instructor has any completed courses
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        console.log(`🔍 [ONBOARDING] Checking for existing courses for instructor: ${instructorId}`);
        console.log(`📡 [MONGODB] Making API request to /api/onboarding/instructor/${instructorId}`);
        const response = await authenticatedFetch(`/api/onboarding/instructor/${instructorId}`);
        console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
            const result = await response.json();
            console.log('📡 [MONGODB] Instructor courses data:', result);
            if (result.data && result.data.courses && result.data.courses.length > 0) {
                // Check if any course has onboarding complete
                const completedCourse = result.data.courses.find(course => course.isOnboardingComplete === true);
                if (completedCourse) {
                    console.log('✅ [ONBOARDING] Found completed course:', completedCourse);
                    // Store the course ID for potential redirect
                    onboardingState.existingCourseId = completedCourse.courseId;
                    showOnboardingComplete();
                    return;
                }
                
                // Check if there's an incomplete course (created but onboarding not finished)
                const incompleteCourse = result.data.courses.find(course => 
                    course.isOnboardingComplete === false || !course.isOnboardingComplete
                );
                
                if (incompleteCourse) {
                    console.log('⚠️ [ONBOARDING] Found incomplete course, resuming onboarding:', incompleteCourse.courseId);
                    // Store the course ID and resume onboarding
                    onboardingState.createdCourseId = incompleteCourse.courseId;
                    onboardingState.existingCourseId = incompleteCourse.courseId;

                    // Check if Unit 1 has the required content to determine which step to resume at
                    const unit1 = incompleteCourse.lectures?.find(lecture => lecture.name === 'Unit 1');
                    const hasObjectives = unit1?.learningObjectives && unit1.learningObjectives.length > 0;
                    const documentTypes = new Set((unit1?.documents || []).map(d => d.documentType));
                    // "Materials substep complete" means BOTH required uploads exist —
                    // a single lecture-notes upload on its own should still resume on
                    // materials so the practice-quiz upload can finish.
                    const hasDocuments = documentTypes.has('lecture-notes') && documentTypes.has('practice-quiz');

                    // Restore previously-saved objectives and questions into the DOM so
                    // that resuming onboarding doesn't visually erase the work the user
                    // already did.
                    if (hasObjectives) {
                        repopulateObjectivesList(unit1.learningObjectives);
                    }
                    if (unit1?.assessmentQuestions && unit1.assessmentQuestions.length > 0) {
                        repopulateOnboardingAssessmentQuestions(unit1.assessmentQuestions);
                    }
                    if (unit1?.documents && unit1.documents.length > 0) {
                        repopulateMaterialStatuses(unit1.documents);
                    }

                    if (!hasObjectives) {
                        // Resume at Step 3, substep 1 (Learning Objectives)
                        console.log('📝 [ONBOARDING] Resuming at Step 3: Learning Objectives');
                        showOnboardingFlow();
                        showStep(3);
                        showSubstep('objectives');
                        return;
                    } else if (!hasDocuments) {
                        // Resume at Step 3, substep 2 (Course Materials)
                        console.log('📁 [ONBOARDING] Resuming at Step 3: Course Materials');
                        showOnboardingFlow();
                        showStep(3);
                        showSubstep('materials');
                        return;
                    } else {
                        // Resume at Step 3, substep 3 (Assessment Questions)
                        console.log('❓ [ONBOARDING] Resuming at Step 3: Assessment Questions');
                        showOnboardingFlow();
                        showStep(3);
                        showSubstep('questions');
                        return;
                    }
                }
            }
        }
        
        console.log('🔍 [ONBOARDING] No courses found, showing normal onboarding flow');
        // If the instructor already started while this async check was running,
        // preserve their progress instead of snapping the UI back to step 1.
        if (onboardingState.currentStep === 1) {
            showOnboardingFlow();
        }
        
    } catch (error) {
        console.error('❌ [ONBOARDING] Error checking onboarding status:', error);
        if (onboardingState.currentStep === 1) {
            showOnboardingFlow();
        }
    }
}

/**
 * Show onboarding complete message
 */
function showOnboardingComplete() {
    // Hide all onboarding steps
    document.querySelectorAll('.onboarding-step').forEach(step => {
        step.style.display = 'none';
    });
    
    // Hide progress bar
    document.querySelector('.onboarding-progress').style.display = 'none';
    
    // Show completion message
    document.getElementById('onboarding-complete').style.display = 'block';
    
    // Update the course upload link to include the existing course ID
    if (onboardingState.existingCourseId) {
        const courseUploadLink = document.querySelector('#onboarding-complete .btn-primary');
        if (courseUploadLink) {
            courseUploadLink.href = `/instructor/documents?courseId=${onboardingState.existingCourseId}`;
        }
    }
    
    // Auto-redirect after 5 seconds to prevent users from staying on onboarding
    setTimeout(() => {
        if (onboardingState.existingCourseId) {
            window.location.href = `/instructor/documents?courseId=${onboardingState.existingCourseId}`;
        } else {
            window.location.href = '/instructor/documents';
        }
    }, 5000);
}

/**
 * Show normal onboarding flow
 */
function showOnboardingFlow() {
    // Hide completion message
    document.getElementById('onboarding-complete').style.display = 'none';
    
    // Show progress bar
    document.querySelector('.onboarding-progress').style.display = 'block';
    
    // Show first step
    showStep(1);
}

/**
 * Initialize all onboarding functionality
 */
function initializeOnboarding() {

    
    // Initialize form handlers
    initializeFormHandlers();
    
    // Initialize file upload handlers
    initializeFileUpload();
    
    // Initialize progress bar
    updateProgressBar();
    
    // Show first step (this will be overridden if onboarding is complete)
    showStep(1);
    
    // Add debugging for learning objectives
    setTimeout(() => {
        const addButton = document.querySelector('.add-objective-btn');
        if (addButton) {
            
            // Remove any existing onclick to avoid conflicts
            addButton.removeAttribute('onclick');
            
            addButton.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                addObjectiveForUnit('Unit 1');
            });
            
        } else {
            // Add objective button not found
        }
    }, 1000); // Wait a bit for DOM to be ready
}

/**
 * Initialize guided substep functionality
 */
function initializeGuidedSubsteps() {
    // Initialize progress card click handlers
    const progressCards = document.querySelectorAll('.progress-card');
    progressCards.forEach(card => {
        card.addEventListener('click', () => {
            const substep = card.dataset.substep;
            if (substep) {
                showSubstep(substep);
            }
        });
    });
    
    // Add click outside modal to close functionality
    document.addEventListener('click', (e) => {
        const uploadModal = document.getElementById('upload-modal');
        const questionModal = document.getElementById('question-modal');
        const questionLearningObjectiveModal = document.getElementById('question-learning-objective-modal');
        const autoLinkConfirmationModal = document.getElementById('auto-link-confirmation-modal');
        
        // Close upload modal if clicking outside
        if (uploadModal && uploadModal.classList.contains('show') && e.target === uploadModal) {
            closeUploadModal();
        }

        if (questionModal && questionModal.classList.contains('show') && e.target === questionModal) {
            closeQuestionModal();
        }

        if (questionLearningObjectiveModal && questionLearningObjectiveModal.classList.contains('show') && e.target === questionLearningObjectiveModal) {
            closeQuestionLearningObjectiveModal();
        }

        if (autoLinkConfirmationModal && autoLinkConfirmationModal.classList.contains('show') && e.target === autoLinkConfirmationModal) {
            closeAutoLinkConfirmationModal();
        }
    });
}

/**
 * Initialize form event handlers
 */
function initializeFormHandlers() {
    // Course selection handler
    const courseSelect = document.getElementById('course-select');
    if (courseSelect) {
        courseSelect.addEventListener('change', handleCourseSelection);
        // Apply the initial layout for the default (blank = create) selection so
        // the create-a-course fields show without waiting for a change event.
        handleCourseSelection({ target: courseSelect });
    }
    
    // Custom course name handler
    const customCourseSection = document.getElementById('custom-course-section');
    const customCourseName = document.getElementById('custom-course-name');
    if (customCourseName) {
        customCourseName.addEventListener('input', handleCustomCourseInput);
    }

    const instructorCourseCode = document.getElementById('instructor-course-code');
    if (instructorCourseCode) {
        instructorCourseCode.addEventListener('input', clearOnboardingJoinCourseCodeFeedback);
    }
    
    // Course setup form handler
    const courseSetupForm = document.getElementById('course-setup-form');
    if (courseSetupForm) {
        courseSetupForm.addEventListener('submit', handleCourseSetup);
    }
}

/**
 * Navigate to next step
 */
function nextStep() {
    if (onboardingState.currentStep < onboardingState.totalSteps) {
        onboardingState.currentStep++;
        showStep(onboardingState.currentStep);
        updateProgressBar();
    }
}

function previousStep() {
    if (onboardingState.currentStep > 1) {
        onboardingState.currentStep--;
        showStep(onboardingState.currentStep);
        updateProgressBar();
    }
}

/**
 * Show specific step
 */
function showStep(stepNumber) {
    onboardingState.currentStep = stepNumber;

    // Hide all steps
    const steps = document.querySelectorAll('.onboarding-step');
    steps.forEach(step => step.classList.remove('active'));
    
    // Show current step
    const currentStep = document.getElementById(`step-${stepNumber}`);
    if (currentStep) {
        currentStep.classList.add('active');
    }
    
    // Update step indicators
    const indicators = document.querySelectorAll('.step-indicator');
    indicators.forEach((indicator, index) => {
        indicator.classList.remove('active', 'completed');
        if (index + 1 < stepNumber) {
            indicator.classList.add('completed');
        } else if (index + 1 === stepNumber) {
            indicator.classList.add('active');
        }
    });
    
    // If we're on step 3, show the first substep
    if (stepNumber === 3) {
        showSubstep('objectives');
    }
}

/**
 * Re-render the learning-objectives list from a server-provided array.
 * Used when resuming an in-progress onboarding so that a refresh preserves
 * what the user already entered.
 */
function repopulateObjectivesList(objectives) {
    const objectivesList = document.getElementById('objectives-list');
    if (!objectivesList) return;
    objectivesList.innerHTML = '';
    (objectives || []).forEach((objective) => {
        const objectiveItem = document.createElement('div');
        objectiveItem.className = 'objective-display-item';
        const span = document.createElement('span');
        span.className = 'objective-text';
        span.textContent = String(objective);
        const btn = document.createElement('button');
        btn.className = 'remove-objective';
        btn.setAttribute('onclick', 'removeObjective(this)');
        btn.textContent = '×';
        objectiveItem.appendChild(span);
        objectiveItem.appendChild(btn);
        objectivesList.appendChild(objectiveItem);
    });
}

/**
 * Re-hydrate the onboarding `assessmentQuestions['Onboarding']` cache from
 * server-stored questions (which use the structured wire shape: TF=boolean,
 * MCQ options=array, MCQ correctAnswer=numeric index) and re-render so a
 * refresh on the questions substep preserves prior work.
 */
function repopulateOnboardingAssessmentQuestions(serverQuestions) {
    const restored = (serverQuestions || []).map((q) => ({
        id: q.questionId || q.id || Date.now() + Math.random(),
        questionId: q.questionId,
        questionType: q.questionType || q.type,
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        learningObjective: q.learningObjective || '',
        saved: true, // already in DB — completeUnit1Setup must not re-POST
    }));
    assessmentQuestions['Onboarding'] = restored;
    try {
        displayAssessmentQuestions('Onboarding');
    } catch (_) { /* container may not be in DOM yet */ }
}

function showSubstep(substepName) {
    // Hide all substeps
    const substeps = document.querySelectorAll('.guided-substep');
    substeps.forEach(substep => substep.classList.remove('active'));
    
    // Show current substep
    const currentSubstep = document.getElementById(`substep-${substepName}`);
    if (currentSubstep) {
        currentSubstep.classList.add('active');
    }
    
    // Update progress cards
    const progressCards = document.querySelectorAll('.progress-card');
    progressCards.forEach(card => {
        card.classList.remove('active', 'completed');
        const cardSubstep = card.dataset.substep;
        const substepIndex = onboardingState.substeps.indexOf(cardSubstep);
        const currentIndex = onboardingState.substeps.indexOf(substepName);
        
        if (substepIndex < currentIndex) {
            card.classList.add('completed');
        } else if (substepIndex === currentIndex) {
            card.classList.add('active');
        }
    });
    
    // Update current substep in state
    onboardingState.currentSubstep = substepName;
}

/**
 * Navigate to next substep
 */
async function nextSubstep(substepName) {
    if (substepName === 'materials') {
        const objectiveCount = document.querySelectorAll('#objectives-list .objective-display-item').length;
        if (objectiveCount === 0) {
            showNotification('Please add at least one learning objective before continuing.', 'error');
            return;
        }

        // Persist objectives as soon as the user moves on, so a refresh
        // before final completion resumes at materials (not back at
        // objectives) and the entered objectives survive.
        try {
            const courseId = onboardingState.createdCourseId || onboardingState.existingCourseId;
            const instructorId = typeof getCurrentInstructorId === 'function' ? getCurrentInstructorId() : null;
            if (courseId && instructorId) {
                const objectives = Array.from(
                    document.querySelectorAll('#objectives-list .objective-display-item .objective-text')
                ).map(el => el.textContent.trim()).filter(Boolean);
                if (objectives.length > 0) {
                    await saveUnit1LearningObjectives(courseId, 'Unit 1', objectives, instructorId);
                }
            }
        } catch (err) {
            console.error('Failed to persist learning objectives before advancing:', err);
        }
    }

    if (substepName === 'questions') {
        const lectureStatus = document.getElementById('lecture-status');
        const practiceStatus = document.getElementById('practice-status');
        const lectureUploaded = isOnboardingMaterialAvailable(lectureStatus);
        const practiceUploaded = isOnboardingMaterialAvailable(practiceStatus);

        if (!lectureUploaded || !practiceUploaded) {
            showNotification('Please upload required materials (Lecture Notes and Practice Questions) before continuing.', 'error');
            return;
        }
    }

    showSubstep(substepName);
}

/**
 * Navigate to previous substep
 */
function previousSubstep(substepName) {
    showSubstep(substepName);
}

/**
 * Update progress bar
 */
function updateProgressBar() {
    const progressFill = document.getElementById('progress-fill');
    if (progressFill) {
        const progress = (onboardingState.currentStep / onboardingState.totalSteps) * 100;
        progressFill.style.width = `${progress}%`;
        const progressBar = progressFill.closest('.progress-bar');
        progressBar?.setAttribute('aria-valuenow', String(onboardingState.currentStep));
        progressBar?.setAttribute('aria-valuemin', '0');
        progressBar?.setAttribute('aria-valuemax', String(onboardingState.totalSteps));
    }
}

/**
 * Save onboarding data to database
 */
async function saveOnboardingData() {
    try {
        const courseId = onboardingState.createdCourseId;
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        
        // Collect learning objectives
        const objectivesList = document.getElementById('objectives-list');
        const objectives = Array.from(objectivesList.querySelectorAll('.objective-display-item .objective-text'))
            .map(obj => obj.textContent.trim());
        
        // Collect unit files (materials uploaded during onboarding)
        const unitFiles = {};
        
        // Get lecture notes status and content
        const lectureStatus = document.getElementById('lecture-status');
        if (isOnboardingMaterialAvailable(lectureStatus)) {
            unitFiles['Unit 1'] = [{
                name: 'Lecture Notes - Unit 1',
                type: 'lecture-notes',
                status: 'uploaded',
                uploadedAt: new Date().toISOString()
            }];
        }
        
        // Get practice questions status and content
        const practiceStatus = document.getElementById('practice-status');
        if (isOnboardingMaterialAvailable(practiceStatus)) {
            if (!unitFiles['Unit 1']) {
                unitFiles['Unit 1'] = [];
            }
            unitFiles['Unit 1'].push({
                name: 'Practice Questions/Tutorial',
                type: 'practice-quiz', // Keep consistent with course upload functionality
                status: 'uploaded',
                uploadedAt: new Date().toISOString()
            });
        }
        
        // Get additional materials
        const additionalMaterials = document.querySelectorAll('.additional-material-item');
        additionalMaterials.forEach(material => {
            const materialName = material.querySelector('.material-name').textContent;
            if (!unitFiles['Unit 1']) {
                unitFiles['Unit 1'] = [];
            }
            unitFiles['Unit 1'].push({
                name: materialName,
                type: 'additional',
                status: 'uploaded',
                uploadedAt: new Date().toISOString()
            });
        });
        
        // Prepare onboarding data
        const onboardingData = {
            courseId: courseId,
            courseName: onboardingState.courseData.course,
            instructorId: instructorId,
            learningOutcomes: objectives,
            unitFiles: unitFiles
        };
        
        // Update the onboarding data in the database
        const response = await authenticatedFetch(`/api/onboarding/${courseId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(onboardingData)
        });
        
        if (!response.ok) {
            throw new Error(await extractErrorMessage(response, 'Failed to save onboarding data'));
        }
        
        console.log('Onboarding data saved successfully');
        
    } catch (error) {
        console.error('Error saving onboarding data:', error);
        throw error;
    }
}

/**
 * Complete Unit 1 setup
 */
async function completeUnit1Setup() {
    if (onboardingState.isSubmitting) return;
    onboardingState.isSubmitting = true;
    
    console.log('%c--- Starting Final Onboarding Step ---', 'font-weight: bold; color: blue;');

    // Validate that required content has been set up
    const objectivesList = document.getElementById('objectives-list');
    const objectives = objectivesList.querySelectorAll('.objective-display-item');
    
    if (objectives.length === 0) {
        showNotification('Please add at least one learning objective before continuing.', 'error');
        onboardingState.isSubmitting = false;
        return;
    }
    
    // Check if required materials are uploaded
    const lectureStatus = document.getElementById('lecture-status');
    const practiceStatus = document.getElementById('practice-status');
    
    if (!isOnboardingMaterialAvailable(lectureStatus) || !isOnboardingMaterialAvailable(practiceStatus)) {
        showNotification('Please upload required materials (Lecture Notes and Practice Questions) before continuing.', 'error');
        onboardingState.isSubmitting = false;
        return;
    }

    const questions = assessmentQuestions.Onboarding || [];
    if (questions.length === 0) {
        showNotification('Please add at least one assessment question before continuing.', 'error');
        onboardingState.isSubmitting = false;
        return;
    }

    const passThresholdInput = document.getElementById('pass-threshold-onboarding');
    if (passThresholdInput) {
        const passThreshold = parseInt(passThresholdInput.value, 10);
        if (Number.isFinite(passThreshold) && passThreshold > questions.length) {
            showNotification('Pass threshold cannot exceed the number of assessment questions.', 'error');
            onboardingState.isSubmitting = false;
            return;
        }
    }

    try {
        // Save onboarding data to database before redirecting
        console.log('Step 1: Calling saveOnboardingData...');
        await saveOnboardingData();
        console.log('Step 1: saveOnboardingData completed.');
        
        // Also ensure all Unit 1 data is saved using the same APIs that course upload expects
        console.log('Step 2: Calling saveAllUnit1Data...');
        await saveAllUnit1Data();
        console.log('Step 2: saveAllUnit1Data completed.');
        
        // Mark onboarding as complete only after all Unit 1 data is saved
        console.log('Step 3: Marking onboarding as complete...');
        await markInstructorOnboardingComplete(onboardingState.createdCourseId);
        console.log('Step 3: Onboarding marked as complete.');
        
        // Show success message and redirect
        console.log('Step 4: Onboarding save process complete. Redirecting...');
        showNotification('Unit 1 setup completed successfully! Redirecting to course upload...', 'success');
        
        // Wait a moment for the notification to be seen, then redirect with course ID
        setTimeout(() => {
            window.location.href = `/instructor/index.html?courseId=${onboardingState.createdCourseId}`;
        }, 1500);
        
    } catch (error) {
        console.error('Error saving onboarding data:', error);
        showNotification('Error saving onboarding data. Please try again.', 'error');
        onboardingState.isSubmitting = false;
    }
}

/**
 * Save all Unit 1 data using the same APIs that course upload expects
 * This ensures that all data created during onboarding is properly stored
 * and can be loaded by the course upload functionality
 * 
 * IMPORTANT: We save all data together at the end rather than individually
 * to avoid overwriting issues where only the last item gets saved.
 */
async function saveAllUnit1Data() {
    try {
        const courseId = onboardingState.createdCourseId;
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        
        if (!courseId) {
            console.error('No course ID available for saving Unit 1 data');
            return;
        }
        
        console.log('Saving all Unit 1 data for course:', courseId);
        
        // 1. Save all learning objectives together as a batch
        const objectivesList = document.getElementById('objectives-list');
        const objectives = Array.from(objectivesList.querySelectorAll('.objective-display-item .objective-text'))
            .map(obj => obj.textContent.trim())
            .filter(obj => obj.length > 0);
        
        if (objectives.length > 0) {
            console.log('Saving all learning objectives together:', objectives);
            await saveUnit1LearningObjectives(courseId, 'Unit 1', objectives, instructorId);
        }
        
        // 2. Save all assessment questions
        // Use the memory state instead of scraping DOM, and avoid duplicates
        const weekKey = 'Onboarding';
        const questions = assessmentQuestions[weekKey] || [];
        
        console.log(`Checking ${questions.length} questions for saving...`);
        
        if (questions.length > 0) {
            let savedCount = 0;
            let skippedCount = 0;
            
            for (let i = 0; i < questions.length; i++) {
                const question = questions[i];
                
                // Skip if already saved
                if (question.saved) {
                    console.log(`Skipping question ${i + 1} (already saved)`);
                    skippedCount++;
                    continue;
                }
                
                console.log(`Saving question ${i + 1}/${questions.length}:`, question);
                try {
                    const result = await saveUnit1AssessmentQuestion(courseId, 'Unit 1', question, instructorId);
                    question.saved = true; // Mark as saved
                    savedCount++;
                    console.log(`Question ${i + 1} saved successfully`);
                } catch (error) {
                    console.error(`Failed to save question ${i + 1}:`, error);
                }
            }
            console.log(`Assessment questions save complete. Saved: ${savedCount}, Skipped: ${skippedCount}`);
        } else {
            console.log('No assessment questions to save.');
        }
        
        // 3. Save pass threshold setting
        const passThresholdInput = document.getElementById('pass-threshold-onboarding');
        if (passThresholdInput) {
            const passThreshold = parseInt(passThresholdInput.value) || 2;
            console.log('Saving pass threshold:', passThreshold);
            try {
                await saveUnit1PassThreshold(courseId, 'Unit 1', passThreshold, instructorId);
                console.log('Pass threshold saved successfully');
            } catch (error) {
                console.error('Failed to save pass threshold:', error);
            }
        } else {
            console.log('Pass threshold input not found');
        }
        
        // 4. Save all uploaded documents (this should already be done during upload, but ensure it's complete)
        console.log('Unit 1 documents should already be saved from upload process');
        
        console.log('All Unit 1 data saved successfully');
        
    } catch (error) {
        console.error('Error saving all Unit 1 data:', error);
        // Don't throw here - we want the onboarding to complete successfully
        // Just log the error for debugging
        showNotification('Warning: Some Unit 1 data may not have been saved properly. Please check the course upload interface.', 'warning');
    }
}

/**
 * Utility functions
 */
function showFieldError(field, message) {
    const formGroup = field.closest('.form-group');
    
    // Remove existing error
    formGroup.classList.remove('success');
    const existingError = formGroup.querySelector('.error-message');
    if (existingError) {
        existingError.remove();
    }
    
    // Add error state
    formGroup.classList.add('error');
    
    // Create error message element
    const errorElement = document.createElement('div');
    errorElement.className = 'error-message';
    errorElement.textContent = message;
    
    // Insert error message after the field
    field.parentNode.insertBefore(errorElement, field.nextSibling);
}

function showSuccessMessage(message) {
    showNotification(message, 'success');
}

function showErrorMessage(message) {
    showNotification(message, 'error');
}
