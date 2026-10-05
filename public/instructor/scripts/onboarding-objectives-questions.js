/**
 * Onboarding: learning objectives and assessment question editing
 * (question modal, auto-link, unit-1 persistence helpers).
 */

/**
 * Save Unit 1 learning objectives using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {Array} objectives - Array of learning objectives
 * @param {string} instructorId - The instructor ID
 */
async function saveUnit1LearningObjectives(courseId, lectureName, objectives, instructorId) {
    try {        
        const requestBody = {
            lectureName: lectureName,
            objectives: objectives,
            instructorId: instructorId,
            courseId: courseId
        };
                
        const response = await fetch('/api/learning-objectives', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to save learning objectives: ${response.status} ${errorText}`);
        }
        
        const result = await response.json();
        
    } catch (error) {
        // Don't throw here - we want the course creation to succeed even if this fails
        showNotification('Warning: Learning objectives saved to course but not to learning objectives API. They may not appear in the course upload interface.', 'warning');
    }
}

/**
 * Get learning objectives from the UI
 * @returns {Array} Array of learning objectives
 */
function getLearningObjectivesFromUI() {
    const objectivesList = document.getElementById('objectives-list');
    if (!objectivesList) {
        return [];
    }
    
    const objectives = [];
    const objectiveItems = objectivesList.querySelectorAll('.objective-display-item');    
    objectiveItems.forEach((item, index) => {
        const objectiveText = item.querySelector('.objective-text');
        if (objectiveText && objectiveText.textContent.trim()) {
            const text = objectiveText.textContent.trim();
            objectives.push(text);
            console.log(`Objective ${index + 1}:`, text);
        }
    });
    return objectives;
}

/**
 * Add a new learning objective for a unit (used in onboarding)
 * @param {string} unitName - The unit name (e.g., 'Unit 1')
 */
async function addObjectiveForUnit(unitName) {
    console.log('addObjectiveForUnit called with:', unitName);
    
    const inputField = document.getElementById('objective-input');
    const objectivesList = document.getElementById('objectives-list');
    
    console.log('Input field found:', !!inputField);
    console.log('Objectives list found:', !!objectivesList);
    
    if (!inputField || !objectivesList) {
        console.error('Could not find objective input or list elements');
        showNotification('Error: Could not find objective elements', 'error');
        return;
    }
    
    const objectiveText = inputField.value.trim();
    console.log('Objective text:', objectiveText);
    
    if (!objectiveText) {
        showNotification('Please enter a learning objective.', 'error');
        return;
    }
    
    // Create new objective display item
    const objectiveItem = document.createElement('div');
    objectiveItem.className = 'objective-display-item';
    objectiveItem.innerHTML = `
        <span class="objective-text">${objectiveText}</span>
        <button class="remove-objective" onclick="removeObjective(this)">×</button>
    `;
    
    // Add to the list
    objectivesList.appendChild(objectiveItem);
    
    // Clear the input field
    inputField.value = '';
    inputField.focus();
    
    // Don't save immediately - just add to UI
    // The objectives will be saved together when onboarding is completed
    console.log('Objective added to UI:', objectiveText);
    console.log('Total objectives now:', objectivesList.querySelectorAll('.objective-display-item').length);
    showNotification('Learning objective added successfully!', 'success');
}

/**
 * Add learning objective
 */
async function addObjective() {
    const input = document.getElementById('objective-input');
    const objectiveText = input.value.trim();
    
    if (!objectiveText) {
        showNotification('Please enter a learning objective.', 'error');
        return;
    }
    
    const objectivesList = document.getElementById('objectives-list');
    
    // Create new objective display item
    const objectiveItem = document.createElement('div');
    objectiveItem.className = 'objective-display-item';
    objectiveItem.innerHTML = `
        <span class="objective-text">${objectiveText}</span>
        <button class="remove-objective" onclick="removeObjective(this)">×</button>
    `;
    
    // Add to the list
    objectivesList.appendChild(objectiveItem);
    
    // Clear the input field
    input.value = '';
    input.focus();
    
    // Don't save immediately - just add to UI
    // The objectives will be saved together when onboarding is completed
    showNotification('Learning objective added successfully!', 'success');
}

/**
 * Remove learning objective
 */
function removeObjective(button) {
    const objectiveItem = button.closest('.objective-display-item');
    objectiveItem.remove();
    showNotification('Learning objective removed.', 'info');
}

/**
 * Add probing question
 */
async function addQuestion() {
    console.log('=== ADDING PROBING QUESTION ===');
    const input = document.getElementById('question-input');
    const questionText = input.value.trim();
    
    console.log('Question input value:', questionText);
    console.log('Question input element found:', !!input);
    
    if (!questionText) {
        showNotification('Please enter a probing question.', 'error');
        return;
    }
    
    const questionsList = document.getElementById('assessment-questions-onboarding');
    console.log('Questions list element found:', !!questionsList);
    console.log('Questions list ID:', questionsList?.id);
    
    if (!questionsList) {
        console.error('Questions list not found!');
        showNotification('Error: Questions list not found', 'error');
        return;
    }
    
    // Create new question display item
    const questionItem = document.createElement('div');
    questionItem.className = 'objective-display-item';
    questionItem.innerHTML = `
        <span class="objective-text">${questionText}</span>
        <button class="remove-objective" onclick="removeQuestion(this)">×</button>
    `;
    
    console.log('Created question item:', questionItem);
    console.log('Question item HTML:', questionItem.innerHTML);
    
    // Add to the list
    questionsList.appendChild(questionItem);
    
    console.log('Question added to DOM. Total questions now:', questionsList.querySelectorAll('.objective-display-item').length);
    console.log('All questions in DOM:', Array.from(questionsList.querySelectorAll('.objective-display-item .objective-text')).map(q => q.textContent.trim()));
    
    // Clear the input field
    input.value = '';
    input.focus();
    
    // Don't save immediately - just add to UI
    // The questions will be saved together when onboarding is completed
    console.log('Probing question added to UI:', questionText);
    showNotification('Probing question added successfully!', 'success');
}

/**
 * Remove probing question
 */
async function removeQuestion(button) {
    console.log('=== REMOVING PROBING QUESTION ===');
    const questionItem = button.closest('.objective-display-item');
    const questionText = questionItem.querySelector('.objective-text').textContent.trim();
    
    console.log('Removing question:', questionText);
    console.log('Question item found:', !!questionItem);
    
    // Remove from UI
    questionItem.remove();
    
    const questionsList = document.getElementById('assessment-questions-onboarding');
    console.log('Question removed from DOM. Total questions now:', questionsList?.querySelectorAll('.objective-display-item').length || 0);
    console.log('Remaining questions:', Array.from(questionsList?.querySelectorAll('.objective-display-item .objective-text') || []).map(q => q.textContent.trim()));
    
    // Don't remove from API immediately - the final state will be saved
    // when onboarding is completed
    console.log('Probing question removed from UI:', questionText);
    console.log('Removal will be reflected when onboarding is completed');
    
    showNotification('Probing question removed.', 'info');
}

function getOnboardingLearningObjectives() {
    const objectives = [];
    document.querySelectorAll('#objectives-list .objective-text').forEach(item => {
        const text = item.textContent.trim();
        if (text) {
            objectives.push(text);
        }
    });

    return objectives;
}

function populateLearningObjectiveOptions(selectElement, objectives = [], selectedObjective = '') {
    if (!selectElement) {
        return;
    }

    const normalizedSelected = (selectedObjective || '').trim();
    const uniqueObjectives = [...new Set(objectives.map(objective => objective.trim()).filter(Boolean))];

    selectElement.innerHTML = '<option value="">Leave unassigned</option>';

    uniqueObjectives.forEach(objective => {
        const option = document.createElement('option');
        option.value = objective;
        option.textContent = objective;
        selectElement.appendChild(option);
    });

    if (normalizedSelected && !uniqueObjectives.includes(normalizedSelected)) {
        const savedOption = document.createElement('option');
        savedOption.value = normalizedSelected;
        savedOption.textContent = `${normalizedSelected} (saved)`;
        selectElement.appendChild(savedOption);
    }

    selectElement.value = normalizedSelected;
}

function setLearningObjectiveNote(message = '') {
    const note = document.getElementById('learning-objective-note');
    if (!note) {
        return;
    }

    if (message) {
        note.textContent = message;
        note.style.display = 'block';
        return;
    }

    note.textContent = '';
    note.style.display = 'none';
}

function populateQuestionLearningObjectiveDropdown(selectedObjective = '', noteMessage = '') {
    const select = document.getElementById('learning-objective-select');
    populateLearningObjectiveOptions(select, getOnboardingLearningObjectives(), selectedObjective);
    setLearningObjectiveNote(noteMessage);
}

function getStoredQuestion(week, questionId) {
    return (assessmentQuestions[week] || []).find(question => String(question.id) === String(questionId)) || null;
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
    const weekKey = week || 'Onboarding';
    const questions = assessmentQuestions[weekKey] || [];
    if (questions.length === 0) {
        showNotification('There are no questions to auto-link yet.', 'warning');
        return;
    }

    const learningObjectives = getOnboardingLearningObjectives();
    if (learningObjectives.length === 0) {
        showNotification('Add learning objectives before auto-linking questions.', 'warning');
        return;
    }

    const modal = document.getElementById('auto-link-confirmation-modal');
    const unitLabel = document.getElementById('auto-link-confirmation-unit-label');
    if (!modal) {
        autoLinkQuestionsToLearningObjectives(weekKey, buttonElement);
        return;
    }

    autoLinkConfirmationContext = { week: weekKey, buttonElement };
    if (unitLabel) {
        unitLabel.textContent = weekKey === 'Onboarding' ? 'Unit 1' : weekKey;
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
 * Open question modal for adding assessment questions
 */
function openQuestionModal(week) {
    currentWeek = week;
    const modal = document.getElementById('question-modal');
    if (modal) {
        modal.classList.add('show');
        // Reset form
        resetQuestionForm();
        populateQuestionLearningObjectiveDropdown();
        
        // Check if AI generation should be enabled
        checkAIGenerationInModal();
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
}

/**
 * Update question form based on selected question type
 */
function updateQuestionForm() {
    const questionType = document.getElementById('question-type').value;
    
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
    
    // Check if AI generation is available for this question type
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
 * Save the question from the modal
 */
async function saveQuestion() {
    const questionType = document.getElementById('question-type').value;
    const questionText = document.getElementById('question-text').value.trim();
    const learningObjective = document.getElementById('learning-objective-select')?.value?.trim() || '';
    
    if (!questionType) {
        showNotification('Please select a question type.', 'error');
        return;
    }
    
    if (!questionText) {
        showNotification('Please enter a question.', 'error');
        return;
    }
    
    let question = {
        id: Date.now(),
        questionType,
        question: questionText,
        learningObjective
    };
    
    // Get answer based on question type
    if (questionType === 'true-false') {
        const selectedAnswer = document.querySelector('input[name="tf-answer"]:checked');
        if (!selectedAnswer) {
            showNotification('Please select the correct answer.', 'error');
            return;
        }
        question.correctAnswer = selectedAnswer.value === 'true';
    } else if (questionType === 'multiple-choice') {
        const options = [];
        const mcqInputs = document.querySelectorAll('.mcq-input');
        let hasCorrectAnswer = false;
        
        mcqInputs.forEach(input => {
            if (input.value.trim()) {
                const option = input.dataset.option;
                const isCorrect = document.querySelector(`input[name="mcq-correct"][value="${option}"]`).checked;
                options.push(input.value.trim());
                
                if (isCorrect) {
                    question.correctAnswer = options.length - 1;
                    hasCorrectAnswer = true;
                }
            }
        });
        
        if (options.length < 2) {
            showNotification('Please provide at least 2 answer options.', 'error');
            return;
        }
        
        if (!hasCorrectAnswer) {
            showNotification('Please select the correct answer.', 'error');
            return;
        }
        
        question.options = options;
    } else if (questionType === 'short-answer') {
        const expectedAnswer = document.getElementById('sa-answer').value.trim();
        if (!expectedAnswer) {
            showNotification('Please provide the expected answer or key points.', 'error');
            return;
        }
        question.correctAnswer = expectedAnswer;
    }
    
    // Add question to the assessment
    // During onboarding, we're always working with 'Onboarding' as the week
    const weekKey = currentWeek || 'Onboarding';
    
    if (!assessmentQuestions[weekKey]) {
        assessmentQuestions[weekKey] = [];
    }
    
    assessmentQuestions[weekKey].push(question);

    console.log(`Question added to assessmentQuestions['${weekKey}']:`, question);
    console.log(`Total questions for ${weekKey}:`, assessmentQuestions[weekKey].length);

    // Update the display
    displayAssessmentQuestions(weekKey);

    // Close modal and show success
    closeQuestionModal();
    const learningObjectiveMessage = question.learningObjective
        ? ` Linked to "${question.learningObjective}".`
        : '';
    showNotification(`Question added successfully!${learningObjectiveMessage}`, 'success');

    // Persist immediately so an in-progress onboarding survives refresh /
    // browser-back. completeUnit1Setup skips already-saved questions.
    try {
        const courseId = onboardingState.createdCourseId || onboardingState.existingCourseId;
        const instructorId = typeof getCurrentInstructorId === 'function' ? getCurrentInstructorId() : null;
        if (courseId && instructorId) {
            const result = await saveUnit1AssessmentQuestion(courseId, 'Unit 1', question, instructorId);
            question.saved = true;
            if (result && result.data && result.data.questionId) {
                question.questionId = result.data.questionId;
            }
        }
    } catch (err) {
        console.error('Failed to persist new assessment question immediately:', err);
    }
}

/**
 * Display assessment questions
 */
function displayAssessmentQuestions(week) {
    // During onboarding, we need to handle the 'Onboarding' week specially
    let containerId;
    if (week === 'Onboarding') {
        containerId = 'assessment-questions-onboarding';
    } else {
        containerId = `assessment-questions-${week.toLowerCase()}`;
    }
    
    const questionsContainer = document.getElementById(containerId);
    
    if (!questionsContainer) {
        console.error(`Questions container not found for week '${week}' with ID '${containerId}'`);
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
    
    // Clear container and add questions
    questionsContainer.innerHTML = '';
    
    questions.forEach((question, index) => {
        const questionElement = createQuestionElement(question, index + 1, week);
        questionsContainer.appendChild(questionElement);
    });
}

/**
 * Create question element
 */
function createQuestionElement(question, questionNumber, week) {
    const questionDiv = document.createElement('div');
    questionDiv.className = 'question-item';
    
    const questionType = question.questionType || question.type;
    const typeBadgeClass = questionType === 'multiple-choice' ? 'multiple-choice' :
                          questionType === 'true-false' ? 'true-false' : 'short-answer';
    
    let answerPreview = '';
    
    if (questionType === 'multiple-choice') {
        answerPreview = '<div class="mcq-preview">';
        question.options.forEach((option, index) => {
            const isCorrect = index === question.correctAnswer;
            answerPreview += `<div class="mcq-option-preview ${isCorrect ? 'correct' : ''}">${option}</div>`;
        });
        answerPreview += '</div>';
    } else if (questionType === 'true-false') {
        answerPreview = `<div class="answer-preview">Correct Answer: ${question.correctAnswer ? 'True' : 'False'}</div>`;
    } else {
        answerPreview = `<div class="answer-preview">Sample Answer: ${question.correctAnswer}</div>`;
    }
    
    questionDiv.innerHTML = `
        <div class="question-header">
            <span class="question-type-badge ${typeBadgeClass}">${questionType.replace('-', ' ')}</span>
            <span class="question-number">Question ${questionNumber}</span>
            <div class="question-action-buttons">
                <button class="edit-question-btn" onclick="openQuestionLearningObjectiveModal('${week}', ${question.id})" title="Edit learning objective">${Icons.pencil}</button>
                <button class="delete-question-btn" onclick="deleteAssessmentQuestion('${week}', ${question.id})" title="Delete question">×</button>
            </div>
        </div>
        <div class="question-content">
            ${renderLearningObjectiveDisplay(question.learningObjective)}
            <div class="question-text">${question.question}</div>
            ${answerPreview}
        </div>
    `;
    
    return questionDiv;
}

function openQuestionLearningObjectiveModal(week, questionId) {
    const question = getStoredQuestion(week || 'Onboarding', questionId);
    const modal = document.getElementById('question-learning-objective-modal');
    const questionText = document.getElementById('edit-learning-objective-question-text');
    const select = document.getElementById('edit-learning-objective-select');

    if (!question || !modal || !questionText || !select) {
        showNotification('Could not open the learning objective editor.', 'error');
        return;
    }

    editingQuestionObjectiveContext = { week: week || 'Onboarding', questionId: String(questionId) };
    questionText.textContent = question.question || '';
    populateLearningObjectiveOptions(select, getOnboardingLearningObjectives(), question.learningObjective || '');
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

function saveQuestionLearningObjective() {
    if (!editingQuestionObjectiveContext) {
        showNotification('No question selected for editing.', 'error');
        return;
    }

    const { week, questionId } = editingQuestionObjectiveContext;
    const question = getStoredQuestion(week, questionId);
    if (!question) {
        showNotification('Could not find the selected question.', 'error');
        return;
    }

    question.learningObjective = document.getElementById('edit-learning-objective-select')?.value?.trim() || '';
    displayAssessmentQuestions(week);
    closeQuestionLearningObjectiveModal();
    showNotification('Learning objective updated successfully.', 'success');
}

async function autoLinkQuestionsToLearningObjectives(week, buttonElement = null) {
    const weekKey = week || 'Onboarding';
    const questions = assessmentQuestions[weekKey] || [];
    if (questions.length === 0) {
        showNotification('There are no questions to auto-link yet.', 'warning');
        return;
    }

    const learningObjectives = getOnboardingLearningObjectives();
    if (learningObjectives.length === 0) {
        showNotification('Add learning objectives before auto-linking questions.', 'warning');
        return;
    }

    try {
        setAutoLinkButtonLoading(buttonElement, true);
        showNotification('Auto-linking questions to learning objectives...', 'info');

        const courseId = onboardingState.createdCourseId || onboardingState.existingCourseId;
        const instructorId = getCurrentInstructorId();

        if (!courseId) {
            throw new Error('Course ID not found. Please complete course setup first.');
        }

        const response = await authenticatedFetch(`${API_BASE_URL}/api/questions/auto-link-learning-objectives`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                courseId,
                lectureName: 'Unit 1',
                instructorId,
                learningObjectives,
                questions: questions.map(question => ({
                    questionId: question.questionId || String(question.id),
                    questionType: question.questionType || question.type,
                    question: question.question,
                    options: question.options || [],
                    correctAnswer: question.correctAnswer,
                    learningObjective: question.learningObjective || ''
                }))
            })
        });

        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || 'Failed to auto-link questions');
        }

        const matchesById = new Map((result.data.matchedQuestions || []).map(question => [
            String(question.questionId || question.id),
            question.learningObjective || ''
        ]));

        assessmentQuestions[weekKey] = questions.map(question => ({
            ...question,
            learningObjective: matchesById.get(String(question.questionId || question.id)) || question.learningObjective || ''
        }));

        displayAssessmentQuestions(weekKey);
        const fallbackMessage = result.data?.unassignedCount > 0
            ? `Auto-link complete: ${result.data.linkedCount || 0} linked, ${result.data.unassignedCount} left unassigned.`
            : (result.message || 'Questions auto-linked successfully.');
        showNotification(result.message || fallbackMessage, 'success');
    } catch (error) {
        console.error('Error auto-linking onboarding questions:', error);
        showNotification(`Error auto-linking questions: ${error.message}`, 'error');
    } finally {
        setAutoLinkButtonLoading(buttonElement, false);
    }
}

/**
 * Delete assessment question
 */
async function deleteAssessmentQuestion(week, questionId) {
    if (!confirm('Are you sure you want to delete this question?')) {
        return;
    }
    // During onboarding, we're always working with 'Onboarding' as the week
    const weekKey = week || 'Onboarding';

    if (!assessmentQuestions[weekKey]) {
        console.error(`No assessment questions found for week '${weekKey}'`);
        showNotification('No questions found to delete.', 'error');
        return;
    }

    const matching = assessmentQuestions[weekKey].find(q => q.id === questionId);
    assessmentQuestions[weekKey] = assessmentQuestions[weekKey].filter(q => q.id !== questionId);
    console.log(`Question ${questionId} deleted from assessmentQuestions['${weekKey}']`);
    console.log(`Remaining questions for ${weekKey}:`, assessmentQuestions[weekKey].length);
    displayAssessmentQuestions(weekKey);

    // If we already persisted this question, remove it from the DB too so a
    // mid-onboarding refresh doesn't bring the deleted question back.
    if (matching && matching.questionId && matching.saved) {
        try {
            const courseId = onboardingState.createdCourseId || onboardingState.existingCourseId;
            const instructorId = typeof getCurrentInstructorId === 'function' ? getCurrentInstructorId() : null;
            if (courseId && instructorId) {
                await fetch(`/api/questions/${matching.questionId}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ courseId, lectureName: 'Unit 1', instructorId })
                });
            }
        } catch (err) {
            console.error('Failed to remove persisted question on delete:', err);
        }
    }

    showNotification('Question deleted successfully!', 'success');
}

/**
 * Save assessment
 */
async function saveAssessment(week) {
    console.log(`=== SAVING ASSESSMENT FOR ${week} ===`);
    
    const questions = assessmentQuestions[week] || [];
    const thresholdInput = document.getElementById(`pass-threshold-${week.toLowerCase()}`);
    const threshold = thresholdInput ? parseInt(thresholdInput.value) : 2;
    
    console.log('Questions to save:', questions);
    console.log('Pass threshold:', threshold);
    
    if (questions.length === 0) {
        showNotification('Please add at least one assessment question before saving.', 'error');
        return;
    }
    
    try {
        // Get the current course ID and instructor ID
        const courseId = onboardingState.createdCourseId;
        const instructorId = getCurrentInstructorId();
        if (!instructorId) {
            console.error('No instructor ID found. User not authenticated.');
            return;
        }
        
        if (!courseId) {
            throw new Error('No course ID available. Please complete course setup first.');
        }
        
        console.log(`Saving ${questions.length} questions for course ${courseId}...`);
        
        // Save each question individually to the backend, but skip ones that
        // were already persisted by the per-add fast path so the same question
        // doesn't get POSTed twice (and counted twice as a "save").
        const savedQuestions = [];
        let skippedCount = 0;
        for (let i = 0; i < questions.length; i++) {
            const question = questions[i];
            if (question.saved) {
                skippedCount++;
                console.log(`Skipping question ${i + 1}/${questions.length} (already saved)`);
                continue;
            }
            console.log(`Saving question ${i + 1}/${questions.length}:`, question);

            try {
                // Pass the full question object instead of just the question text
                const result = await saveUnit1AssessmentQuestion(courseId, 'Unit 1', question, instructorId);
                question.saved = true; // Mark as saved to prevent duplicates
                savedQuestions.push(result);
                console.log(`Question ${i + 1} saved successfully:`, result);
            } catch (error) {
                console.error(`Failed to save question ${i + 1}:`, error);
                // Continue with other questions even if one fails
            }
        }
        
        // Save the pass threshold
        try {
            await saveUnit1PassThreshold(courseId, 'Unit 1', threshold, instructorId);
            console.log('Pass threshold saved successfully');
        } catch (error) {
            console.error('Failed to save pass threshold:', error);
        }
        
        console.log(`Assessment saved successfully! ${savedQuestions.length}/${questions.length} questions saved.`);
        showNotification(`Assessment saved for ${week}!\nTotal Questions: ${savedQuestions.length}/${questions.length}\nPass Threshold: ${threshold}`, 'success');
        
    } catch (error) {
        console.error('Error saving assessment:', error);
        showNotification(`Failed to save assessment: ${error.message}`, 'error');
    }
}

/**
 * Save Unit 1 probing question using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {string} questionText - The probing question text
 * @param {string} instructorId - The instructor ID
 */
async function saveUnit1ProbingQuestion(courseId, lectureName, questionText, instructorId) {
    try {
        console.log(`Saving Unit 1 probing question for course ${courseId}:`, { lectureName, questionText });
        
        // Since there's no dedicated probing questions API, we'll save this as a text document
        // with a special type that can be identified later
        const response = await fetch('/api/documents/text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId,
                lectureName,
                documentType: 'probing-question',
                content: questionText,
                title: `Probing Question - Unit 1: ${questionText.substring(0, 50)}${questionText.length > 50 ? '...' : ''}`,
                instructorId
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to save probing question: ${response.status} ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Unit 1 probing question saved successfully:', result);
        
    } catch (error) {
        console.error('Error saving Unit 1 probing question:', error);
        // Don't throw here - we want the question to be added to the UI
        // and the course to be created successfully even if this fails
    }
}

/**
 * Remove Unit 1 probing question using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {string} questionText - The probing question text
 * @param {string} instructorId - The instructor ID
 */
async function removeUnit1ProbingQuestion(courseId, lectureName, questionText, instructorId) {
    try {
        console.log(`Removing Unit 1 probing question for course ${courseId}:`, { lectureName, questionText });
        
        // Note: We don't have a DELETE endpoint for probing questions by content
        // The removal will be handled when the user completes onboarding and the final state is saved
        console.log('Probing question removal logged - will be updated when onboarding is completed');
        
    } catch (error) {
        console.error('Error removing probing question from API:', error);
        // Don't throw here - we want the question to be removed from the UI
        // and the course to be created successfully even if this fails
    }
}

/**
 * Save Unit 1 learning objective using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {string} objectiveText - The learning objective text
 * @param {string} instructorId - The instructor ID
 */
async function saveUnit1LearningObjective(courseId, lectureName, objectiveText, instructorId) {
    try {
        console.log(`Saving Unit 1 learning objective for course ${courseId}:`, { lectureName, objectiveText });
        
        const response = await fetch('/api/learning-objectives', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                lectureName: lectureName,
                objectives: [objectiveText], // Send as array for consistency
                instructorId: instructorId,
                courseId: courseId
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to save learning objective: ${response.status} ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Unit 1 learning objective saved successfully:', result);
        
    } catch (error) {
        console.error('Error saving Unit 1 learning objective:', error);
        // Don't throw here - we want the objective to be added to the UI
        // and the course to be created successfully even if this fails
    }
}

/**
 * Remove Unit 1 learning objective using the same API that course upload expects
 * @param {string} courseId - The course ID
 * @param {string} lectureName - The lecture/unit name (e.g., 'Unit 1')
 * @param {string} objectiveText - The learning objective text
 * @param {string} instructorId - The instructor ID
 */
async function removeUnit1LearningObjective(courseId, lectureName, objectiveText, instructorId) {
    try {
        console.log(`Removing Unit 1 learning objective for course ${courseId}:`, { lectureName, objectiveText });
        
        // Note: We don't have a DELETE endpoint for learning objectives by content
        // The removal will be handled when the user completes onboarding and the final state is saved
        console.log('Learning objective removal logged - will be updated when onboarding is completed');
        
    } catch (error) {
        console.error('Error removing learning objective from API:', error);
        // Don't throw here - we want the objective to be removed from the UI
        // and the course to be created successfully even if this fails
    }
}

/**
 * Save an assessment question using the questions API
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Unit name
 * @param {Object|string} questionObjOrText - The full question object with question, options, correctAnswer, type, etc., OR just a question text string (for probing questions)
 * @param {string} instructorId - Instructor ID
 * @returns {Promise<Object>} API response
 */
async function saveUnit1AssessmentQuestion(courseId, lectureName, questionObjOrText, instructorId) {
    try {
        console.log(`❓ [ASSESSMENT] Starting assessment question creation process...`);
        console.log(`❓ [ASSESSMENT] Course ID: ${courseId}`);
        console.log(`❓ [ASSESSMENT] Lecture/Unit: ${lectureName}`);
        console.log(`❓ [ASSESSMENT] Question data (type: ${typeof questionObjOrText}):`, questionObjOrText);
        console.log(`❓ [ASSESSMENT] Instructor ID: ${instructorId}`);
        
        // Handle case where only question text is provided (probing questions)
        // Convert string to question object format
        let questionObj;
        if (typeof questionObjOrText === 'string') {
            // This is a probing question - just text, no options
            questionObj = {
                question: questionObjOrText,
                type: 'multiple-choice',
                options: ['Option A', 'Option B', 'Option C', 'Option D'],
                correctAnswer: 0
            };
        } else {
            // This is a full question object
            questionObj = questionObjOrText;
        }
        
        // Determine question type - use from question object or default to multiple-choice
        const questionType = questionObj.type || questionObj.questionType || 'multiple-choice';
        
        // Normalize both legacy modal objects and current arrays to the
        // structured API contract: ordered option arrays + numeric answer index.
        let options = [];
        let correctAnswer = questionObj.correctAnswer;
        
        if (questionType === 'multiple-choice') {
            if (Array.isArray(questionObj.options)) {
                const populated = questionObj.options
                    .map((option, originalIndex) => ({ value: String(option).trim(), originalIndex }))
                    .filter(option => option.value);
                options = populated.map(option => option.value);
                if (typeof correctAnswer === 'number') {
                    correctAnswer = populated.findIndex(option => option.originalIndex === correctAnswer);
                }
            } else if (questionObj.options && typeof questionObj.options === 'object') {
                const entries = Object.entries(questionObj.options).sort(([a], [b]) => a.localeCompare(b));
                options = entries.map(([, value]) => String(value).trim()).filter(Boolean);
                if (typeof correctAnswer === 'string') {
                    const answerIndex = entries.findIndex(([key]) => key === correctAnswer);
                    if (answerIndex >= 0) correctAnswer = answerIndex;
                }
            }
        } else if (questionType === 'true-false') {
            correctAnswer = correctAnswer === true || String(correctAnswer).toLowerCase() === 'true';
        } else if (questionType === 'short-answer') {
            options = [];
        }
        
        const requestBody = {
            courseId,
            lectureName,
            instructorId,
            questionType: questionType,
            question: questionObj.question || questionObj.questionText || '',
            options: options,
            correctAnswer: correctAnswer,
            explanation: questionObj.explanation || '',
            difficulty: questionObj.difficulty || 'medium',
            tags: questionObj.tags || [],
            learningObjective: questionObj.learningObjective || '',
            points: questionObj.points || 1
        };
        
        console.log(`📡 [MONGODB] Making API request to /api/questions (POST)`);
        console.log(`📡 [MONGODB] Request endpoint: /api/questions`);
        console.log(`📡 [MONGODB] Request method: POST`);
        console.log(`📡 [MONGODB] Request headers: { 'Content-Type': 'application/json' }`);
        console.log(`📡 [MONGODB] Request body:`, JSON.stringify(requestBody, null, 2));
        console.log(`📡 [MONGODB] Request body size: ${JSON.stringify(requestBody).length} characters`);
        
        const response = await fetch('/api/questions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
        console.log(`📡 [MONGODB] API response status text: ${response.statusText}`);
        console.log(`📡 [MONGODB] API response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ [MONGODB] API error response: ${response.status} ${errorText}`);
            throw new Error(`Failed to save assessment question: ${response.status} ${errorText}`);
        }
        
        const result = await response.json();
        console.log('✅ [MONGODB] API success response:', result);
        console.log('✅ [ASSESSMENT] Assessment question saved successfully!');
        return result;
        
    } catch (error) {
        console.error('❌ [ASSESSMENT] Error saving assessment question:', error);
        throw error;
    }
}

/**
 * Save pass threshold setting for a unit
 * @param {string} courseId - Course identifier
 * @param {string} lectureName - Unit name
 * @param {number} passThreshold - Pass threshold value
 * @param {string} instructorId - Instructor ID
 * @returns {Promise<Object>} API response
 */
async function saveUnit1PassThreshold(courseId, lectureName, passThreshold, instructorId) {
    try {
        console.log(`🎯 [THRESHOLD] Starting pass threshold update process...`);
        console.log(`🎯 [THRESHOLD] Course ID: ${courseId}`);
        console.log(`🎯 [THRESHOLD] Lecture/Unit: ${lectureName}`);
        console.log(`🎯 [THRESHOLD] Pass threshold value: ${passThreshold}`);
        console.log(`🎯 [THRESHOLD] Instructor ID: ${instructorId}`);
        
        const requestBody = {
            courseId,
            lectureName,
            passThreshold,
            instructorId
        };
        
        console.log(`📡 [MONGODB] Making API request to /api/lectures/pass-threshold (POST)`);
        console.log(`📡 [MONGODB] Request endpoint: /api/lectures/pass-threshold`);
        console.log(`📡 [MONGODB] Request body:`, requestBody);
        console.log(`📡 [MONGODB] Request body size: ${JSON.stringify(requestBody).length} characters`);
        
        // Use the lectures API to update the pass threshold
        const response = await fetch(`/api/lectures/pass-threshold`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
        console.log(`📡 [MONGODB] API response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ [MONGODB] Error saving pass threshold: ${response.status} ${errorText}`);
            throw new Error(`Failed to save pass threshold: ${response.status} ${errorText}`);
        }
        
        const result = await response.json();
        console.log('✅ [MONGODB] Pass threshold saved successfully:', result);
        console.log('🎯 [THRESHOLD] Pass threshold update completed successfully!');
        return result;
        
    } catch (error) {
        console.error('❌ [THRESHOLD] Error saving pass threshold:', error);
        throw error;
    }
}
