/**
 * Instructor: assessment questions, thresholds, question modal,
 * extraction review modal, and learning-objective linking.
 */

// Native select controls are focused with Tab. Enter and Space should then
// reveal their options where the browser supports the picker API; Space keeps
// its normal native behavior as a fallback for browsers without that API.
function enableQuestionModalSelectKeyboard(selectElement) {
    if (!selectElement) return;

    selectElement.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;

        try {
            if (typeof selectElement.showPicker === 'function') {
                selectElement.showPicker();
                event.preventDefault();
            }
        } catch {
            // Keep the browser's built-in Space-key behavior available.
        }
    });
}

enableQuestionModalSelectKeyboard(document.getElementById('question-type'));
enableQuestionModalSelectKeyboard(document.getElementById('struggle-topic-select'));
enableQuestionModalSelectKeyboard(document.getElementById('learning-objective-select'));

/**
 * Load assessment questions directly from course data (for initial load)
 * @param {Object} courseData - Course data with lectures and assessment questions
 */
function loadAssessmentQuestionsFromCourseData(courseData) {
    if (!courseData.lectures) return;
    
    courseData.lectures.forEach(unit => {
        if (unit.assessmentQuestions && unit.assessmentQuestions.length > 0) {
            // Store questions in the local assessmentQuestions object
            if (!assessmentQuestions[unit.name]) {
                assessmentQuestions[unit.name] = [];
            }
            
            // Clear existing questions and add new ones
            assessmentQuestions[unit.name] = [];
            
            // Keep the API/storage question shape in local state.
            unit.assessmentQuestions.forEach(dbQuestion => {
                const localQuestion = {
                    id: dbQuestion.questionId,
                    questionId: dbQuestion.questionId,
                    questionType: dbQuestion.questionType,
                    question: dbQuestion.question,
                    correctAnswer: dbQuestion.correctAnswer,
                    options: dbQuestion.options || {},
                    learningObjective: dbQuestion.learningObjective || ''
                };
                
                assessmentQuestions[unit.name].push(localQuestion);
            });
            
            // Update the display for this unit
            updateQuestionsDisplay(unit.name);
        }
    });
}

/**
 * Load the saved assessment questions for all lectures from the database
 */
async function loadAssessmentQuestions() {
    try {
        const courseId = await getCurrentCourseId();
        
        // Get all accordion items (units/weeks)
        const accordionItems = document.querySelectorAll('.accordion-item');
        
        if (accordionItems.length === 0) {
            return;
        }
        
        for (const item of accordionItems) {
            // Use data-unit-name attribute for internal name (e.g., "Unit 1")
            const lectureName = item.getAttribute('data-unit-name');
            if (!lectureName) {
                continue;
            }

            const response = await fetch(`${API_BASE_URL}/api/questions/lecture?courseId=${courseId}&lectureName=${encodeURIComponent(lectureName)}`);
            
            if (response.ok) {
                const result = await response.json();
                const questions = result.data.questions;
                
                if (questions && questions.length > 0) {
                    // Store questions in the assessmentQuestions object
                    if (!assessmentQuestions[lectureName]) {
                        assessmentQuestions[lectureName] = [];
                    }
                    
                    // Clear existing questions first to prevent duplicates
                    assessmentQuestions[lectureName] = [];
                    
                    // Keep the API/storage question shape in local state.
                    questions.forEach((dbQuestion) => {
                        const localQuestion = {
                            id: dbQuestion.questionId,
                            questionId: dbQuestion.questionId,
                            questionType: dbQuestion.questionType,
                            question: dbQuestion.question,
                            correctAnswer: dbQuestion.correctAnswer,
                            options: dbQuestion.options || {},
                            learningObjective: dbQuestion.learningObjective || ''
                        };
                        assessmentQuestions[lectureName].push(localQuestion);
                    });
                    
                    // Update the display for this lecture
                    updateQuestionsDisplay(lectureName);
                } else {
                    // No questions found - explicitly set threshold to 0 for this unit
                    const weekId = lectureName.toLowerCase().replace(/\s+/g, '-');
                    const thresholdInput = document.getElementById(`pass-threshold-${weekId}`);
                    if (thresholdInput) {
                        thresholdInput.value = 0;
                    }
                }
            } else {
                console.warn(`⚠️ [MONGODB] Failed to load assessment questions for ${lectureName}: ${response.status} ${response.statusText}`);
            }
        }
        
        // After all questions are loaded, force-check and update all thresholds
        // This ensures units with 0 questions have threshold set to 0
        forceUpdateThresholdsForZeroQuestions();
        
    } catch (error) {
        console.error('❌ [ASSESSMENT_QUESTIONS] Error loading assessment questions:', error);
        showNotification('Error loading assessment questions. Using default values.', 'warning');
    }
}

/**
 * Force update all thresholds to 0 for units with no questions
 */
function forceUpdateThresholdsForZeroQuestions() {
    const thresholdInputs = document.querySelectorAll('input[id^="pass-threshold-"]');
    
    thresholdInputs.forEach(thresholdInput => {
        const weekId = thresholdInput.id.replace('pass-threshold-', '');
        const lectureName = weekId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        
        // Check both DOM and object
        const questionsContainer = document.getElementById(`assessment-questions-${weekId}`);
        const domQuestions = questionsContainer ? questionsContainer.querySelectorAll('.question-item').length : 0;
        const objectQuestions = assessmentQuestions[lectureName] ? assessmentQuestions[lectureName].length : 0;
        const totalQuestions = Math.max(domQuestions, objectQuestions);
        
        if (totalQuestions === 0) {
            thresholdInput.value = 0;
        }
    });
}

/**
 * Delete an assessment question
 * @param {string} questionId - Question identifier
 * @param {string} week - Week identifier
 */
async function deleteAssessmentQuestion(questionId, week) {
    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        
        const response = await fetch(`${API_BASE_URL}/api/questions/${questionId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                lectureName: week,
                instructorId: instructorId
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Delete failed: ${response.status} ${errorText}`);
        }
        
        // Reload questions from database to ensure consistency
        await reloadQuestionsForUnit(week);
        
        // Update the display
        updateQuestionsDisplay(week);
        
        showNotification('Question deleted successfully!', 'success');
        
    } catch (error) {
        console.error('Error deleting question:', error);
        showNotification(`Error deleting question: ${error.message}`, 'error');
    }
}

/**
 * Save the pass threshold for a specific lecture
 * @param {string} lectureName - Name of the lecture/unit
 * @param {number} threshold - Number of questions required to pass
 */
async function savePassThreshold(lectureName, threshold) {
    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        
        console.log(`[SAVE_PASS_THRESHOLD] Saving threshold for ${lectureName}: ${threshold} (courseId: ${courseId}, instructorId: ${instructorId})`);
        
        const response = await fetch('/api/lectures/pass-threshold', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                lectureName: lectureName,
                passThreshold: threshold,
                instructorId: instructorId
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to save threshold: ${response.status} ${errorText}`);
        }
        
        const result = await response.json();
        console.log(`[SAVE_PASS_THRESHOLD] Success response:`, result);
        
        // Show success notification
        showNotification(result.message, 'success');
        
        // No need to reload all thresholds - the UI is already updated
        // and the database has the correct value
        
    } catch (error) {
        console.error('Error saving pass threshold:', error);
        showNotification(`Error saving pass threshold: ${error.message}`, 'error');
    }
}

/**
 * Reload pass thresholds from the database (for use after updates)
 */
async function reloadPassThresholds() {
    try {
        const courseId = await getCurrentCourseId();
        
        // Get all accordion items (units/weeks)
        const accordionItems = document.querySelectorAll('.accordion-item');
        
        for (const item of accordionItems) {
            // Use data-unit-name attribute for internal name (e.g., "Unit 1")
            const lectureName = item.getAttribute('data-unit-name');
            if (!lectureName) continue;
            
            const response = await fetch(`/api/lectures/pass-threshold?courseId=${courseId}&lectureName=${encodeURIComponent(lectureName)}`);
            
            if (response.ok) {
                const result = await response.json();
                const passThreshold = result.data.passThreshold;
                
                // Find and update the threshold input for this lecture
                // Convert lecture name to ID format (e.g., "Unit 1" -> "unit-1")
                const thresholdId = `pass-threshold-${lectureName.toLowerCase().replace(/\s+/g, '-')}`;
                const thresholdInput = item.querySelector(`#${thresholdId}`);
                
                if (thresholdInput) {
                    thresholdInput.value = passThreshold;
                    // Threshold input updated
                }
            }
        }
        
    } catch (error) {
        console.error('Error reloading pass thresholds:', error);
        showNotification('Error reloading pass thresholds.', 'warning');
    }
}

/**
 * Load the saved pass thresholds for all lectures from the database
 */
async function loadPassThresholds() {
    try {
        const courseId = await getCurrentCourseId();
        
        // Get all accordion items (units/weeks)
        const accordionItems = document.querySelectorAll('.accordion-item');
        
        for (const item of accordionItems) {
            // Use data-unit-name attribute for internal name (e.g., "Unit 1")
            const lectureName = item.getAttribute('data-unit-name');
            if (!lectureName) continue;
            
            const response = await fetch(`/api/lectures/pass-threshold?courseId=${courseId}&lectureName=${encodeURIComponent(lectureName)}`);
            
            // Find the threshold input for this lecture (regardless of whether API call succeeded)
            // Convert lecture name to ID format (e.g., "Unit 1" -> "unit-1")
            const thresholdId = `pass-threshold-${lectureName.toLowerCase().replace(/\s+/g, '-')}`;
            const thresholdInput = item.querySelector(`#${thresholdId}`);
            
            if (thresholdInput) {
                const weekId = thresholdInput.id.replace('pass-threshold-', '');
                
                // Check how many questions exist for this unit (check both the assessmentQuestions object and DOM)
                const questionsContainer = document.getElementById(`assessment-questions-${weekId}`);
                const domQuestions = questionsContainer ? questionsContainer.querySelectorAll('.question-item').length : 0;
                const objectQuestions = assessmentQuestions[lectureName] ? assessmentQuestions[lectureName].length : 0;
                const totalQuestions = Math.max(domQuestions, objectQuestions);
                
                // If there are no questions, ALWAYS set threshold to 0 (ignore any saved value)
                if (totalQuestions === 0) {
                    thresholdInput.value = 0;
                } else if (response.ok) {
                    const result = await response.json();
                    const passThreshold = result.data.passThreshold;
                    
                    // Update threshold input with loaded value (but only if questions exist)
                    thresholdInput.value = passThreshold;
                } else {
                    // No threshold set yet, default to 0 but don't save it
                    thresholdInput.value = 0;
                }
            }
        }
        
        // Force update thresholds again after loading (to catch any units with 0 questions)
        forceUpdateThresholdsForZeroQuestions();
        
    } catch (error) {
        console.error('Error loading pass thresholds:', error);
        showNotification('Error loading pass thresholds. Using default values.', 'warning');
    }
}

/**
 * Set up event listeners for threshold inputs
 */
function setupThresholdInputListeners() {
    // Get all threshold inputs
    const thresholdInputs = document.querySelectorAll('input[id^="pass-threshold-"]');
    
    thresholdInputs.forEach(input => {
        // Add change event listener
        input.addEventListener('change', function(event) {
            const threshold = parseInt(this.value);

            // Update the display first
            handleThresholdInputChange(event);

            // IDs are normalized to lowercase for DOM use, so rebuilding the
            // lecture name from the ID turns "Unit 1" into "unit 1" and fails
            // MongoDB's case-sensitive lecture lookup. Read the stable name
            // stored on the enclosing unit instead.
            const unitItem = this.closest('.accordion-item[data-unit-name]');
            const lectureName = unitItem?.getAttribute('data-unit-name');
            if (!lectureName) {
                console.warn('Cannot save pass threshold: unit name is missing');
                return;
            }
            
            // Save the threshold to MongoDB
            savePassThreshold(lectureName, threshold);
        });
        
        // Add input event listener for real-time updates
        input.addEventListener('input', handleThresholdInputChange);
    });
}

function getStoredQuestion(week, questionId) {
    return (assessmentQuestions[week] || []).find(question => (question.questionId || question.id) === questionId) || null;
}

function renderLearningObjectiveDisplay(learningObjective) {
    const value = (learningObjective || '').trim();
    const className = value
        ? 'question-learning-objective-value'
        : 'question-learning-objective-value unassigned';
    const label = value || 'Unassigned';

    return `
        <div class="question-learning-objective">
            <span class="question-learning-objective-label">Learning Objective</span>
            <span class="${className}">${label}</span>
        </div>
    `;
}

function setAutoLinkButtonLoading(button, isLoading) {
    if (!button) {
        return;
    }

    if (isLoading) {
        button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
        button.classList.add('is-loading');
        button.innerHTML = '<span class="btn-icon">⏳</span> Auto-linking...';
        return;
    }

    button.disabled = false;
    button.classList.remove('is-loading');
    if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
    }
}

function openAutoLinkConfirmationModal(week, buttonElement = null) {
    const questions = assessmentQuestions[week] || [];
    if (questions.length === 0) {
        showNotification('There are no questions to auto-link yet.', 'warning');
        return;
    }

    const objectives = getObjectivesForUnit(week);
    if (objectives.length === 0) {
        showNotification('Add learning objectives for this unit before auto-linking questions.', 'warning');
        return;
    }

    const modal = document.getElementById('auto-link-confirmation-modal');
    const unitLabel = document.getElementById('auto-link-confirmation-unit-label');
    if (!modal) {
        autoLinkQuestionsToLearningObjectives(week, buttonElement);
        return;
    }

    autoLinkConfirmationContext = { week, buttonElement };
    if (unitLabel) {
        unitLabel.textContent = week || 'this unit';
    }
    modal.classList.add('show');
    a11yModal.open(modal, { onRequestClose: closeAutoLinkConfirmationModal });
}

function closeAutoLinkConfirmationModal() {
    autoLinkConfirmationContext = null;
    const modal = document.getElementById('auto-link-confirmation-modal');
    if (modal) {
        a11yModal.close(modal);
        modal.classList.remove('show');
    }
}

function confirmAutoLinkQuestions() {
    if (!autoLinkConfirmationContext) {
        closeAutoLinkConfirmationModal();
        return;
    }

    const { week, buttonElement } = autoLinkConfirmationContext;
    closeAutoLinkConfirmationModal();
    autoLinkQuestionsToLearningObjectives(week, buttonElement);
}

/**
 * Open the question creation modal
 * @param {string} week - Week identifier (e.g., 'Week 1')
 */
function openQuestionModal(week) {
    currentWeek = week;
    const modal = document.getElementById('question-modal');
    if (modal) {
        modal.classList.add('show');
        // Reset form
        resetQuestionForm();
        populateQuestionLearningObjectiveDropdown(week);
        populateStruggleTopicDropdown(week, false);
        a11yModal.open(modal, { onRequestClose: closeQuestionModal });
    }
}

/**
 * Close the question creation modal
 */
function closeQuestionModal() {
    const modal = document.getElementById('question-modal');
    if (modal) {
        a11yModal.close(modal);
        modal.classList.remove('show');
        resetQuestionForm();
    }
}

/**
 * Reset the question form to initial state
 */
function resetQuestionForm() {
    document.getElementById('question-type').value = '';
    document.getElementById('question-text').value = '';
    const learningObjectiveSelect = document.getElementById('learning-objective-select');
    if (learningObjectiveSelect) {
        learningObjectiveSelect.innerHTML = '<option value="">Leave unassigned</option>';
        learningObjectiveSelect.value = '';
    }
    const struggleTopicSelect = document.getElementById('struggle-topic-select');
    if (struggleTopicSelect) {
        struggleTopicSelect.innerHTML = '<option value="">Select a struggle topic...</option>';
        struggleTopicSelect.value = '';
    }
    const showAllStruggleTopicsToggle = document.getElementById('show-all-struggle-topics-toggle');
    if (showAllStruggleTopicsToggle) {
        showAllStruggleTopicsToggle.dataset.showAll = 'false';
        showAllStruggleTopicsToggle.textContent = 'Show all unit-linked topics';
        showAllStruggleTopicsToggle.classList.remove('active');
    }
    const struggleTopicPanel = document.getElementById('struggle-topic-panel');
    if (struggleTopicPanel) {
        struggleTopicPanel.open = false;
    }
    setLearningObjectiveNote('');
    
    // Hide all answer sections
    document.getElementById('tf-answer-section').style.display = 'none';
    document.getElementById('mcq-answer-section').style.display = 'none';
    document.getElementById('sa-answer-section').style.display = 'none';
    
    // Clear radio buttons
    const radioButtons = document.querySelectorAll('input[type="radio"]');
    radioButtons.forEach(radio => radio.checked = false);
    
    // Clear MCQ inputs
    const mcqInputs = document.querySelectorAll('.mcq-input');
    mcqInputs.forEach(input => input.value = '');
    
    // Clear short answer
    document.getElementById('sa-answer').value = '';
    
    // Reset AI generation tracking
    aiGenerationCount = 0;
    lastGeneratedContent = null;
    currentQuestionType = null;
    
    // Hide AI generation button
    const aiButton = document.getElementById('ai-generate-btn');
    if (aiButton) {
        aiButton.style.display = 'none';
        aiButton.disabled = false;
        aiButton.innerHTML = `<span class="ai-icon">${Icons.bot}</span> Generate with AI`; // Reset button text
        console.log(`🔍 [RESET_FORM] AI button hidden and reset`);
    } else {
        console.warn(`🔍 [RESET_FORM] AI button not found during reset`);
    }
}

/**
 * Clear all form fields (question text and answers for all types)
 */
function clearAllFormFields() {
    console.log('🧹 [CLEAR_FORM] Clearing all form fields due to question type change');
    
    // Clear question text
    const questionTextInput = document.getElementById('question-text');
    if (questionTextInput) {
        questionTextInput.value = '';
    }
    
    // Clear True/False answers
    const tfRadios = document.querySelectorAll('input[name="tf-answer"]');
    tfRadios.forEach(radio => radio.checked = false);
    
    // Clear Multiple Choice answers
    const mcqInputs = document.querySelectorAll('.mcq-input');
    mcqInputs.forEach(input => input.value = '');
    
    const mcqRadios = document.querySelectorAll('input[name="mcq-correct"]');
    mcqRadios.forEach(radio => radio.checked = false);
    
    // Clear Short Answer
    const saAnswer = document.getElementById('sa-answer');
    if (saAnswer) {
        saAnswer.value = '';
    }
    
    console.log('✅ [CLEAR_FORM] All form fields cleared');
}

/**
 * Update question form based on selected question type
 */
function updateQuestionForm() {
    const questionType = document.getElementById('question-type').value;
    
    // Reset AI generation tracking and clear form if question type changed
    if (questionType !== currentQuestionType) {
        aiGenerationCount = 0;
        lastGeneratedContent = null;
        currentQuestionType = questionType;
        
        // Reset button text if it exists
        const aiButton = document.getElementById('ai-generate-btn');
        if (aiButton) {
            aiButton.innerHTML = `<span class="ai-icon">${Icons.bot}</span> Generate with AI`;
        }
        
        // Clear all form fields when switching question types
        clearAllFormFields();
    }
    
    // Hide all sections first
    document.getElementById('tf-answer-section').style.display = 'none';
    document.getElementById('mcq-answer-section').style.display = 'none';
    document.getElementById('sa-answer-section').style.display = 'none';
    
    // Show relevant section
    if (questionType === 'true-false') {
        document.getElementById('tf-answer-section').style.display = 'block';
    } else if (questionType === 'multiple-choice') {
        document.getElementById('mcq-answer-section').style.display = 'block';
        // Add event listeners for MCQ inputs
        setupMCQValidation();
    } else if (questionType === 'short-answer') {
        document.getElementById('sa-answer-section').style.display = 'block';
    }
    
    // Check if AI generation should be available
    console.log(`🔍 [UPDATE_FORM] Calling checkAIGenerationInModal...`);
    
    // Debug: Check if AI button exists at this point
    const aiButtonDebug = document.getElementById('ai-generate-btn');
    console.log(`🔍 [UPDATE_FORM] AI button found during update: ${!!aiButtonDebug}`);
    
    checkAIGenerationInModal();
}

/**
 * Setup validation for multiple choice inputs
 */
function setupMCQValidation() {
    const mcqInputs = document.querySelectorAll('.mcq-input');
    const radioButtons = document.querySelectorAll('input[name="mcq-correct"]');
    
    // Clear all radio buttons initially
    radioButtons.forEach(radio => {
        radio.checked = false;
        radio.disabled = true;
    });
    
    // Add event listeners to inputs
    mcqInputs.forEach(input => {
        input.addEventListener('input', function() {
            const option = this.dataset.option;
            const radioButton = document.querySelector(`input[name="mcq-correct"][value="${option}"]`);
            
            if (this.value.trim()) {
                radioButton.disabled = false;
            } else {
                radioButton.disabled = true;
                radioButton.checked = false;
            }
        });
    });
}

/**
 * Save the created question
 */
async function saveQuestion() {
    // Check authentication first
    const currentUser = getCurrentUser();
    if (!currentUser) {
        showNotification('Authentication error. Please refresh the page and try again.', 'error');
        return;
    }
    
    const questionType = document.getElementById('question-type').value;
    const questionText = document.getElementById('question-text').value.trim();
    const learningObjective = document.getElementById('learning-objective-select')?.value?.trim() || '';
    
    // Validation
    if (!questionType) {
        showNotification('Please select a question type.', 'error');
        return;
    }
    
    if (!questionText) {
        showNotification('Please enter a question.', 'error');
        return;
    }
    
    let question = {
        questionType: questionType,
        question: questionText,
        learningObjective
    };
    
    // Get answer based on type
    if (questionType === 'true-false') {
        const tfAnswer = document.querySelector('input[name="tf-answer"]:checked');
        if (!tfAnswer) {
            showNotification('Please select the correct answer (True/False).', 'error');
            return;
        }
        question.correctAnswer = tfAnswer.value;
    } else if (questionType === 'multiple-choice') {
        // Get all options
        const options = {};
        const mcqInputs = document.querySelectorAll('.mcq-input');
        let hasOptions = false;
        let hasCorrectAnswer = false;
        
        mcqInputs.forEach(input => {
            if (input.value.trim()) {
                options[input.dataset.option] = input.value.trim();
                hasOptions = true;
                
                // Check if this option is selected as correct
                const radioButton = input.parentElement.querySelector('input[name="mcq-correct"]');
                if (radioButton && radioButton.checked) {
                    hasCorrectAnswer = true;
                }
            }
        });
        
        if (!hasOptions) {
            showNotification('Please enter at least one answer option.', 'error');
            return;
        }
        
        if (!hasCorrectAnswer) {
            showNotification('Please select the correct answer for the options you have entered.', 'error');
            return;
        }
        
        const correctAnswer = document.querySelector('input[name="mcq-correct"]:checked');
        question.options = options;
        question.correctAnswer = correctAnswer.value;
    } else if (questionType === 'short-answer') {
        const saAnswer = document.getElementById('sa-answer').value.trim();
        if (!saAnswer) {
            showNotification('Please provide expected answer or key points.', 'error');
            return;
        }
        question.correctAnswer = saAnswer;
    }
    
    try {
        // Save question to MongoDB
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        const lectureName = currentWeek;
        
        // Debug logging
        console.log('🔍 [SAVE_QUESTION] Debug info:', {
            courseId,
            instructorId,
            lectureName,
            currentWeek
        });
        
        // Validation
        if (!courseId) {
            throw new Error('No course selected. Please select a course first.');
        }
        
        if (!instructorId) {
            throw new Error('Authentication error. Please refresh the page and try again.');
        }
        
        if (!lectureName) {
            throw new Error('No lecture selected. Please select a lecture first.');
        }
        
        // Convert modal state to the structured wire shape that matches what
        // the rest of the stack now expects (FINDINGS #1-#3 / Phase 2b):
        //   true-false:      correctAnswer is a boolean
        //   multiple-choice: options is an ordered array of option strings,
        //                    correctAnswer is the numeric index into that array
        //   short-answer:    correctAnswer stays a string
        let wireOptions = question.options || {};
        let wireCorrectAnswer = question.correctAnswer;
        if (question.questionType === 'true-false') {
            wireCorrectAnswer = question.correctAnswer === true
                || String(question.correctAnswer).toLowerCase() === 'true';
        } else if (question.questionType === 'multiple-choice') {
            const optionEntries = Object.entries(question.options || {})
                .sort(([a], [b]) => a.localeCompare(b));
            wireOptions = optionEntries.map(([, value]) => value);
            const letterToIndex = new Map(optionEntries.map(([letter], idx) => [letter, idx]));
            wireCorrectAnswer = typeof question.correctAnswer === 'number'
                ? question.correctAnswer
                : (letterToIndex.has(question.correctAnswer)
                    ? letterToIndex.get(question.correctAnswer)
                    : question.correctAnswer);
        }

        const response = await fetch(`${API_BASE_URL}/api/questions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                lectureName: lectureName,
                instructorId: instructorId,
                questionType: question.questionType,
                question: question.question,
                options: wireOptions,
                correctAnswer: wireCorrectAnswer,
                explanation: '',
                difficulty: 'medium',
                tags: [],
                learningObjective: question.learningObjective,
                points: 1
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ [SAVE_QUESTION] API Error:', {
                status: response.status,
                statusText: response.statusText,
                errorText: errorText
            });
            
            // Check if it's an authentication error
            if (response.status === 401) {
                throw new Error('Authentication expired. Please refresh the page and try again.');
            }
            
            throw new Error(`Failed to save question: ${response.status} ${errorText}`);
        }
        
        const result = await response.json();
        
        // Add the new question to local state immediately
        if (!assessmentQuestions[currentWeek]) {
            assessmentQuestions[currentWeek] = [];
        }
        
        const savedQuestion = {
            id: result.data.questionId,
            questionId: result.data.questionId,
            questionType: question.questionType,
            question: question.question,
            correctAnswer: wireCorrectAnswer,
            options: wireOptions,
            learningObjective: question.learningObjective || ''
        };
        
        assessmentQuestions[currentWeek].push(savedQuestion);
        
        // Update the display
        updateQuestionsDisplay(currentWeek);
        
        // Close modal
        closeQuestionModal();
        
        // Check if we should enable AI generation
        checkAIGenerationAvailability(currentWeek);
        
        const learningObjectiveMessage = question.learningObjective
            ? ` Linked to "${question.learningObjective}".`
            : '';
        showNotification(`Question saved successfully!${learningObjectiveMessage}`, 'success');
        
    } catch (error) {
        console.error('Error saving question:', error);
        showNotification(`Error saving question: ${error.message}`, 'error');
    }
}

/**
 * Reload questions for a specific unit from the database
 * @param {string} unitName - Unit name (e.g., 'Unit 1')
 */
async function reloadQuestionsForUnit(unitName) {
    try {
        const courseId = await getCurrentCourseId();
        
        const response = await fetch(`${API_BASE_URL}/api/questions/lecture?courseId=${courseId}&lectureName=${encodeURIComponent(unitName)}`);
        
        if (response.ok) {
            const result = await response.json();
            const questions = result.data.questions;
            
            // Store questions in the local assessmentQuestions object
            if (!assessmentQuestions[unitName]) {
                assessmentQuestions[unitName] = [];
            }
            
            // Clear existing questions and add new ones
            assessmentQuestions[unitName] = [];
            
            // Keep the API/storage question shape in local state.
            questions.forEach(dbQuestion => {
                const localQuestion = {
                    id: dbQuestion.questionId,
                    questionId: dbQuestion.questionId,
                    questionType: dbQuestion.questionType,
                    question: dbQuestion.question,
                    correctAnswer: dbQuestion.correctAnswer,
                    options: dbQuestion.options || {},
                    learningObjective: dbQuestion.learningObjective || ''
                };
                
                assessmentQuestions[unitName].push(localQuestion);
            });
            
        } else {
            console.error('Failed to reload questions for unit:', unitName);
        }
    } catch (error) {
        console.error('Error reloading questions for unit:', unitName, error);
    }
}

/**
 * Update the questions display for a week
 * @param {string} week - Week identifier
 */
function updateQuestionsDisplay(week) {
    const containerId = `assessment-questions-${week.toLowerCase().replace(/\s+/g, '-')}`;
    
    const questionsContainer = document.getElementById(containerId);
    if (!questionsContainer) {
        console.error(`Container not found for week: ${week}, ID: ${containerId}`);
        return;
    }
    
    const questions = assessmentQuestions[week] || [];
    
    if (questions.length === 0) {
        questionsContainer.innerHTML = `
            <div class="no-questions-message">
                <p>No assessment questions created yet. Click "Add Question" to get started.</p>
            </div>
        `;
        return;
    }
    
    let html = '';
    questions.forEach((question, index) => {
        const questionType = question.questionType || question.type;
        html += `
            <div class="question-item" data-question-id="${question.questionId || question.id}">
                <div class="question-header">
                    <span class="question-type-badge ${questionType}">${getQuestionTypeLabel(questionType)}</span>
                    <span class="question-number">Question ${index + 1}</span>
                    <div class="question-action-buttons">
                        <button class="edit-question-btn" onclick="openQuestionLearningObjectiveModal('${week}', '${question.questionId || question.id}')" title="Edit learning objective">${Icons.pencil}</button>
                        <button class="delete-question-btn" onclick="deleteQuestion('${week}', '${question.questionId || question.id}')" title="Delete question">×</button>
                    </div>
                </div>
                <div class="question-content">
                    ${renderLearningObjectiveDisplay(question.learningObjective)}
                    <p class="question-text">${question.question}</p>
                    ${getQuestionAnswerDisplay(question)}
                </div>
            </div>
        `;
    });
    
    questionsContainer.innerHTML = html;
    
    // Update pass threshold max value
    const weekId = week.toLowerCase().replace(/\s+/g, '-');
    const thresholdInput = document.getElementById(`pass-threshold-${weekId}`);
    
    if (thresholdInput) {
        thresholdInput.max = questions.length;
        // If there are no questions, always set threshold to 0
        if (questions.length === 0) {
            thresholdInput.value = 0;
        } else {
            // If threshold exceeds question count, adjust it
            if (parseInt(thresholdInput.value) > questions.length) {
                thresholdInput.value = questions.length;
            }
            // If threshold hasn't been set (is empty or invalid), default to 0
            if (thresholdInput.value === '' || thresholdInput.value === null || thresholdInput.value === undefined) {
                thresholdInput.value = 0;
            }
        }
    }
    
    // Event listeners for threshold input are handled by setupThresholdInputListeners()
    // No need to add them here to avoid duplicates
}

/**
 * Handle threshold input change events
 * @param {Event} event - The input event
 */
function handleThresholdInputChange(event) {
    const thresholdInput = event.target;
    const weekId = thresholdInput.id.replace('pass-threshold-', '');
    
    // Get the current total questions count for validation
    const questionsContainer = document.getElementById(`assessment-questions-${weekId}`);
    const totalQuestions = questionsContainer ? questionsContainer.querySelectorAll('.question-item').length : 0;
    
    console.log(`Threshold input changed: ${thresholdInput.value}/${totalQuestions}`);
}

/**
 * Get question type label for display
 * @param {string} type - Question type
 * @returns {string} Display label
 */
function getQuestionTypeLabel(type) {
    switch (type) {
        case 'true-false': return 'T/F';
        case 'multiple-choice': return 'MCQ';
        case 'short-answer': return 'SA';
        default: return type;
    }
}

/**
 * Get question answer display HTML
 * @param {object} question - Question object
 * @returns {string} HTML string
 */
function getQuestionAnswerDisplay(question) {
    const questionType = question.questionType || question.type;
    const answer = Object.prototype.hasOwnProperty.call(question, 'correctAnswer')
        ? question.correctAnswer
        : question.answer;

    if (questionType === 'true-false') {
        const isTrue = answer === true || String(answer).toLowerCase() === 'true';
        return `<p class="answer-preview"><strong>Answer:</strong> ${isTrue ? 'True' : 'False'}</p>`;
    } else if (questionType === 'multiple-choice') {
        let optionsHtml = '';
        const entries = Array.isArray(question.options)
            ? question.options.map((value, index) => [String.fromCharCode(65 + index), value])
            : Object.entries(question.options || {});
        entries.forEach(([key, value], index) => {
            const isCorrect = typeof answer === 'number' ? index === answer : key === answer;
            optionsHtml += `<span class="mcq-option-preview ${isCorrect ? 'correct' : ''}">${key}) ${value}</span>`;
        });
        return `<div class="mcq-preview">${optionsHtml}</div>`;
    } else if (questionType === 'short-answer') {
        return `<p class="answer-preview"><strong>Expected:</strong> ${answer}</p>`;
    }
    return '';
}

function openQuestionLearningObjectiveModal(week, questionId) {
    const question = getStoredQuestion(week, questionId);
    const modal = document.getElementById('question-learning-objective-modal');
    const questionText = document.getElementById('edit-learning-objective-question-text');
    const select = document.getElementById('edit-learning-objective-select');

    if (!question || !modal || !questionText || !select) {
        showNotification('Could not open the learning objective editor.', 'error');
        return;
    }

    editingQuestionObjectiveContext = { week, questionId };
    questionText.textContent = question.question || '';
    populateLearningObjectiveOptions(select, getObjectivesForUnit(week), question.learningObjective || '');
    modal.classList.add('show');
    a11yModal.open(modal, { onRequestClose: closeQuestionLearningObjectiveModal });
}

function closeQuestionLearningObjectiveModal() {
    const modal = document.getElementById('question-learning-objective-modal');
    const questionText = document.getElementById('edit-learning-objective-question-text');
    const select = document.getElementById('edit-learning-objective-select');

    editingQuestionObjectiveContext = null;

    if (questionText) {
        questionText.textContent = '';
    }

    if (select) {
        select.innerHTML = '<option value="">Leave unassigned</option>';
        select.value = '';
    }

    if (modal) {
        a11yModal.close(modal);
        modal.classList.remove('show');
    }
}

async function saveQuestionLearningObjective() {
    if (!editingQuestionObjectiveContext) {
        showNotification('No question selected for editing.', 'error');
        return;
    }

    try {
        const { week, questionId } = editingQuestionObjectiveContext;
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        const learningObjective = document.getElementById('edit-learning-objective-select')?.value?.trim() || '';

        const response = await fetch(`${API_BASE_URL}/api/questions/${questionId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                courseId,
                lectureName: week,
                instructorId,
                learningObjective
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Update failed: ${response.status} ${errorText}`);
        }

        await reloadQuestionsForUnit(week);
        updateQuestionsDisplay(week);
        closeQuestionLearningObjectiveModal();
        showNotification('Learning objective updated successfully.', 'success');
    } catch (error) {
        console.error('Error updating question learning objective:', error);
        showNotification(`Error updating learning objective: ${error.message}`, 'error');
    }
}

async function autoLinkQuestionsToLearningObjectives(week, buttonElement = null) {
    const questions = assessmentQuestions[week] || [];
    if (questions.length === 0) {
        showNotification('There are no questions to auto-link yet.', 'warning');
        return;
    }

    const objectives = getObjectivesForUnit(week);
    if (objectives.length === 0) {
        showNotification('Add learning objectives for this unit before auto-linking questions.', 'warning');
        return;
    }

    try {
        setAutoLinkButtonLoading(buttonElement, true);
        showNotification('Auto-linking questions to learning objectives...', 'info');

        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();

        const response = await fetch(`${API_BASE_URL}/api/questions/auto-link-learning-objectives`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                courseId,
                lectureName: week,
                instructorId
            })
        });

        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to auto-link questions');
        }

        await reloadQuestionsForUnit(week);
        updateQuestionsDisplay(week);
        const fallbackMessage = result.data?.unassignedCount > 0
            ? `Auto-link complete: ${result.data.linkedCount || 0} linked, ${result.data.unassignedCount} left unassigned.`
            : (result.message || 'Questions auto-linked successfully.');
        showNotification(result.message || fallbackMessage, 'success');
    } catch (error) {
        console.error('Error auto-linking questions:', error);
        showNotification(`Error auto-linking questions: ${error.message}`, 'error');
    } finally {
        setAutoLinkButtonLoading(buttonElement, false);
    }
}

/**
 * Delete a question
 * @param {string} week - Week identifier
 * @param {string} questionId - Question ID
 */
async function deleteQuestion(week, questionId) {
    if (confirm('Are you sure you want to delete this question?')) {
        try {
            await deleteAssessmentQuestion(questionId, week);
            checkAIGenerationAvailability(week);
        } catch (error) {
            console.error('Error deleting question:', error);
        }
    }
}

/**
 * Save assessment settings for a week
 * @param {string} week - Week identifier
 */
function saveAssessment(week) {
    const weekLower = week.toLowerCase().replace(/\s+/g, '-');
    const thresholdInput = document.getElementById(`pass-threshold-${weekLower}`);
    
    if (!thresholdInput) {
        console.error(`Threshold input not found for week: ${week}, ID: pass-threshold-${weekLower}`);
        alert('Error: Could not find threshold input for this assessment.');
        return;
    }
    
    const threshold = parseInt(thresholdInput.value);
    const questions = assessmentQuestions[week] || [];
    
    if (questions.length === 0) {
        alert('Please add at least one question before saving the assessment.');
        return;
    }
    
    if (threshold > questions.length) {
        alert(`Pass threshold cannot be greater than the total number of questions (${questions.length}).`);
        return;
    }
    
    // Save the pass threshold to the backend
    savePassThreshold(week, threshold).then(() => {
        // Show success message
        alert(`Assessment saved for ${week}!\nTotal Questions: ${questions.length}\nPass Threshold: ${threshold}`);
    }).catch((error) => {
        console.error('Error saving assessment:', error);
        alert(`Error saving assessment: ${error.message}`);
    });
}

// Initialize assessment system - this will be called from the main DOMContentLoaded listener
function initializeAssessmentSystem() {
    // Initialize questions display for all units
    // Note: This will be updated dynamically based on actual course structure
    // The updateQuestionsDisplay function will be called for each unit as they are loaded
}

/**
 * Extract assessment questions from a practice quiz document via LLM
 */
async function extractAssessmentQuestions(documentId, lectureName, courseId) {
    // Replace the document modal footer with a loading state
    const footer = document.querySelector('.document-modal .modal-footer');
    if (footer) {
        footer.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; width: 100%; justify-content: center; padding: 8px 0;">
                <div class="spinner" style="
                    width: 20px; height: 20px;
                    border: 3px solid #e5e7eb;
                    border-top: 3px solid #2563eb;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                "></div>
                <span style="color: #555; font-size: 14px;">Scanning for assessment questions...</span>
            </div>
            <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
        `;
    }

    try {
        const response = await fetch(`/api/documents/${documentId}/extract-questions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to extract questions');
        }

        const questions = result.data.questions || [];
        if (questions.length === 0) {
            showNotification('No questions found in this document.', 'info');
            closeDocumentModal();
            return;
        }

        // Close document modal and open review modal
        closeDocumentModal();
        showQuestionReviewModal(questions, lectureName, courseId, result.data.wasChunked);

    } catch (error) {
        console.error('Error extracting questions:', error);
        showNotification(`Error: ${error.message}`, 'error');
        closeDocumentModal();
    }
}

/**
 * Build the appropriate missing-answer input based on question type
 * - MC: dropdown of the options (A, B, C, D...)
 * - T/F: dropdown with True / False
 * - SA: text input
 */
function buildMissingAnswerInput(q, index) {
    const selectStyle = `
        width: 100%; padding: 8px 10px; border: 1px solid #f59e0b; border-radius: 4px;
        font-size: 13px; box-sizing: border-box; background: white; cursor: pointer;
    `;
    const inputStyle = `
        width: 100%; padding: 8px 10px; border: 1px solid #f59e0b; border-radius: 4px;
        font-size: 13px; box-sizing: border-box;
    `;

    if (q.questionType === 'multiple-choice' && q.options && Object.keys(q.options).length > 0) {
        const optionEntries = Object.entries(q.options).map(([k, v]) =>
            `<option value="${k.toUpperCase()}">${k.toUpperCase()}. ${escapeHTML(v)}</option>`
        ).join('');
        return `
            <div style="margin-top: 8px;">
                <select class="missing-answer-input" data-index="${index}" style="${selectStyle}">
                    <option value="">-- Select the correct answer --</option>
                    ${optionEntries}
                </select>
            </div>
        `;
    } else if (q.questionType === 'true-false') {
        return `
            <div style="margin-top: 8px;">
                <select class="missing-answer-input" data-index="${index}" style="${selectStyle}">
                    <option value="">-- Select the correct answer --</option>
                    <option value="True">True</option>
                    <option value="False">False</option>
                </select>
            </div>
        `;
    } else {
        // Short answer — keep as text input
        return `
            <div style="margin-top: 8px;">
                <input type="text" class="missing-answer-input" data-index="${index}" placeholder="Enter the correct answer..." style="${inputStyle}" />
            </div>
        `;
    }
}

/**
 * Show the question review modal with extracted questions
 */
function showQuestionReviewModal(questions, lectureName, courseId, wasChunked) {
    // Remove existing review modal if any
    const existing = document.querySelector('.question-review-modal');
    if (existing) existing.remove();

    const questionsHTML = questions.map((q, i) => {
        const missingAnswer = !q.hasAnswer;
        const borderColor = missingAnswer ? '#f59e0b' : '#e5e7eb';
        const warningHTML = missingAnswer ? `
            <div class="missing-answer-warning" style="
                background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
                padding: 6px 10px; margin-top: 8px; font-size: 12px; color: #92400e;
                display: flex; align-items: center; gap: 6px;
            ">
                ${Icons.warning}
                <span>No correct answer found — cannot be saved. Please provide an answer to include this question.</span>
            </div>
        ` : '';

        let answerPreview = '';
        if (q.questionType === 'multiple-choice' && q.options) {
            const optionsStr = Object.entries(q.options).map(([k, v]) => `<strong>${k}.</strong> ${v}`).join(' &nbsp; ');
            answerPreview = `<div style="margin-top: 6px; font-size: 13px; color: #555;">${optionsStr}</div>`;
            if (q.correctAnswer) {
                answerPreview += `<div style="margin-top: 4px; font-size: 13px; color: #059669;"><strong>Answer:</strong> ${q.correctAnswer}</div>`;
            }
        } else if (q.questionType === 'true-false') {
            answerPreview = q.correctAnswer ? `<div style="margin-top: 6px; font-size: 13px; color: #059669;"><strong>Answer:</strong> ${q.correctAnswer}</div>` : '';
        } else if (q.questionType === 'short-answer') {
            answerPreview = q.correctAnswer ? `<div style="margin-top: 6px; font-size: 13px; color: #059669;"><strong>Expected answer:</strong> ${q.correctAnswer}</div>` : '';
        }

        const typeLabel = q.questionType === 'multiple-choice' ? 'MC' : q.questionType === 'true-false' ? 'T/F' : 'SA';
        const typeBg = q.questionType === 'multiple-choice' ? '#dbeafe' : q.questionType === 'true-false' ? '#fce7f3' : '#d1fae5';
        const typeColor = q.questionType === 'multiple-choice' ? '#1e40af' : q.questionType === 'true-false' ? '#9d174d' : '#065f46';

        return `
            <div class="question-review-item" data-index="${i}" data-selected="${missingAnswer ? 'false' : 'true'}" style="
                border: 2px solid ${borderColor};
                border-radius: 8px;
                padding: 14px;
                margin-bottom: 10px;
                transition: border-color 0.2s, opacity 0.2s;
                ${missingAnswer ? 'opacity: 0.7;' : ''}
            ">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
                    <div style="flex: 1;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                            <span style="
                                background: ${typeBg}; color: ${typeColor};
                                padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
                            ">${typeLabel}</span>
                            <span style="font-size: 13px; color: #888;">Q${i + 1}</span>
                        </div>
                        <div style="font-size: 14px; color: #1f2937; line-height: 1.5;">${escapeHTML(q.question)}</div>
                        ${answerPreview}
                        ${q.explanation ? `<div style="margin-top: 4px; font-size: 12px; color: #6b7280;"><em>Explanation: ${escapeHTML(q.explanation)}</em></div>` : ''}
                        ${warningHTML}
                        ${missingAnswer ? buildMissingAnswerInput(q, i) : ''}
                    </div>
                    <div style="display: flex; gap: 6px; flex-shrink: 0;">
                        <button class="qr-yes-btn" data-index="${i}" onclick="toggleQuestionSelection(${i}, true)" style="
                            padding: 6px 14px; border-radius: 4px; border: 2px solid #059669;
                            background: ${missingAnswer ? 'white' : '#059669'}; color: ${missingAnswer ? '#059669' : 'white'};
                            cursor: pointer; font-weight: 600; font-size: 13px;
                            ${missingAnswer ? 'opacity: 0.5; pointer-events: none;' : ''}
                        ">Yes</button>
                        <button class="qr-no-btn" data-index="${i}" onclick="toggleQuestionSelection(${i}, false)" style="
                            padding: 6px 14px; border-radius: 4px; border: 2px solid #dc2626;
                            background: ${missingAnswer ? '#dc2626' : 'white'}; color: ${missingAnswer ? 'white' : '#dc2626'};
                            cursor: pointer; font-weight: 600; font-size: 13px;
                        ">No</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    const chunkedWarning = wasChunked ? `
        <div style="
            background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px;
            padding: 10px 14px; margin-bottom: 14px; font-size: 13px; color: #92400e;
        ">
            <strong>Note:</strong> This document was large and had to be processed in chunks.
            For better results, consider uploading smaller files.
        </div>
    ` : '';

    const selectedCount = questions.filter(q => q.hasAnswer).length;

    const modalHTML = `
        <div class="question-review-modal" style="
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.6);
            display: flex; justify-content: center; align-items: center;
            z-index: 1100;
        ">
            <div style="
                background: white; border-radius: 10px;
                width: 90%; max-width: 750px; max-height: 85vh;
                display: flex; flex-direction: column;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            ">
                <div style="
                    padding: 18px 20px; border-bottom: 1px solid #e5e7eb;
                    display: flex; justify-content: space-between; align-items: center;
                ">
                    <div>
                        <h2 style="margin: 0; font-size: 18px; color: #1f2937;">Review Extracted Questions</h2>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">${lectureName} — ${questions.length} question${questions.length === 1 ? '' : 's'} found</p>
                    </div>
                    <button onclick="closeQuestionReviewModal()" style="
                        background: none; border: none; font-size: 24px;
                        cursor: pointer; color: #666; line-height: 1;
                    ">&times;</button>
                </div>

                <div style="padding: 18px 20px; overflow-y: auto; flex: 1;">
                    ${chunkedWarning}
                    <p style="margin: 0 0 14px; font-size: 13px; color: #6b7280;">
                        Select which questions to add to the assessments for <strong>${escapeHTML(lectureName)}</strong>.
                        Questions without a correct answer (marked in yellow) need an answer before they can be saved.
                    </p>
                    <div id="question-review-list">
                        ${questionsHTML}
                    </div>
                </div>

                <div style="
                    padding: 14px 20px; border-top: 1px solid #e5e7eb;
                    display: flex; justify-content: space-between; align-items: center;
                ">
                    <span id="qr-selected-count" style="font-size: 13px; color: #6b7280;">
                        ${selectedCount} question${selectedCount === 1 ? '' : 's'} selected
                    </span>
                    <div style="display: flex; gap: 10px;">
                        <button onclick="closeQuestionReviewModal()" style="
                            background: #6c757d; color: white; border: none;
                            padding: 8px 18px; border-radius: 4px; cursor: pointer;
                        ">Cancel</button>
                        <button id="qr-save-btn" onclick="saveSelectedQuestions('${(lectureName || '').replace(/'/g, "\\'")}', '${courseId}')" style="
                            background: #2563eb; color: white; border: none;
                            padding: 8px 18px; border-radius: 4px; cursor: pointer; font-weight: 600;
                        ">Save Selected</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Store questions data for saving
    window._extractedQuestions = questions;
    window._extractedLectureName = lectureName;
    window._extractedCourseId = courseId;

    // Attach listeners for missing answer inputs (selects and text inputs)
    document.querySelectorAll('.missing-answer-input').forEach(el => {
        const eventType = el.tagName === 'SELECT' ? 'change' : 'input';
        el.addEventListener(eventType, function() {
            const idx = parseInt(this.dataset.index);
            const item = document.querySelector(`.question-review-item[data-index="${idx}"]`);
            const yesBtn = document.querySelector(`.qr-yes-btn[data-index="${idx}"]`);
            const val = this.value.trim();
            if (val) {
                window._extractedQuestions[idx].correctAnswer = val;
                window._extractedQuestions[idx].hasAnswer = true;
                item.style.borderColor = '#e5e7eb';
                item.style.opacity = '1';
                yesBtn.style.opacity = '1';
                yesBtn.style.pointerEvents = 'auto';
                toggleQuestionSelection(idx, true);
            } else {
                window._extractedQuestions[idx].correctAnswer = null;
                window._extractedQuestions[idx].hasAnswer = false;
                item.style.borderColor = '#f59e0b';
                item.style.opacity = '0.7';
                yesBtn.style.opacity = '0.5';
                yesBtn.style.pointerEvents = 'none';
                toggleQuestionSelection(idx, false);
            }
        });
    });

    // Click outside to close
    const modal = document.querySelector('.question-review-modal');
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeQuestionReviewModal();
    });
}

/**
 * Toggle a question's selection state (Yes/No)
 */
function toggleQuestionSelection(index, selected) {
    const item = document.querySelector(`.question-review-item[data-index="${index}"]`);
    if (!item) return;

    const q = window._extractedQuestions[index];
    // Don't allow selecting questions without answers
    if (selected && !q.hasAnswer) return;

    item.dataset.selected = selected ? 'true' : 'false';

    const yesBtn = document.querySelector(`.qr-yes-btn[data-index="${index}"]`);
    const noBtn = document.querySelector(`.qr-no-btn[data-index="${index}"]`);

    if (selected) {
        item.style.borderColor = '#059669';
        yesBtn.style.background = '#059669';
        yesBtn.style.color = 'white';
        noBtn.style.background = 'white';
        noBtn.style.color = '#dc2626';
    } else {
        item.style.borderColor = q.hasAnswer ? '#e5e7eb' : '#f59e0b';
        yesBtn.style.background = 'white';
        yesBtn.style.color = '#059669';
        noBtn.style.background = '#dc2626';
        noBtn.style.color = 'white';
    }

    updateSelectedCount();
}

/**
 * Update the selected question count display
 */
function updateSelectedCount() {
    const items = document.querySelectorAll('.question-review-item');
    let count = 0;
    items.forEach(item => {
        if (item.dataset.selected === 'true') count++;
    });
    const countEl = document.getElementById('qr-selected-count');
    if (countEl) {
        countEl.textContent = `${count} question${count === 1 ? '' : 's'} selected`;
    }
}

/**
 * Save selected questions to the assessment
 */
async function saveSelectedQuestions(lectureName, courseId) {
    const items = document.querySelectorAll('.question-review-item');
    const selectedQuestions = [];

    items.forEach(item => {
        if (item.dataset.selected === 'true') {
            const idx = parseInt(item.dataset.index);
            const q = window._extractedQuestions[idx];
            if (q && q.hasAnswer) {
                selectedQuestions.push(q);
            }
        }
    });

    if (selectedQuestions.length === 0) {
        showNotification('No questions selected. Please select at least one question.', 'warning');
        return;
    }

    // Disable save button
    const saveBtn = document.getElementById('qr-save-btn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        saveBtn.style.opacity = '0.6';
    }

    try {
        const instructorId = currentUser?.userId || currentUser?._id || 'unknown';

        const response = await fetch('/api/questions/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                courseId,
                lectureName,
                instructorId,
                questions: selectedQuestions.map(question => ({
                    ...question,
                    metadata: {
                        source: 'ai-extracted',
                        aiGenerated: true,
                        reviewStatus: 'approved'
                    }
                }))
            })
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to save questions');
        }

        // Close all modals
        closeQuestionReviewModal();
        closeDocumentModal();

        const autoLinkedCount = result.data.autoLinkedCount || 0;
        const autoLinkedMessage = autoLinkedCount > 0
            ? ` ${autoLinkedCount} question${autoLinkedCount === 1 ? ' was' : 's were'} auto-linked to learning objectives.`
            : '';
        showNotification(`${result.data.addedCount} question${result.data.addedCount === 1 ? '' : 's'} added to the assessments of ${lectureName}.${autoLinkedMessage}`, 'success');

        // Refresh the page content to show updated assessment questions
        if (typeof loadCourseData === 'function') {
            loadCourseData();
        }

    } catch (error) {
        console.error('Error saving questions:', error);
        showNotification(`Error saving questions: ${error.message}`, 'error');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Selected';
            saveBtn.style.opacity = '1';
        }
    }
}

/**
 * Close the question review modal
 */
function closeQuestionReviewModal() {
    const modal = document.querySelector('.question-review-modal');
    if (modal) modal.remove();
    window._extractedQuestions = null;
    window._extractedLectureName = null;
    window._extractedCourseId = null;
}
