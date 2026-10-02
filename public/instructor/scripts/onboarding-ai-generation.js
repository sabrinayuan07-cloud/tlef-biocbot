/**
 * Onboarding: AI question generation and regeneration modal.
 */

/**
 * Check AI generation availability in the question modal
 */
function checkAIGenerationInModal() {
    console.log(`🔍 [AI_MODAL_CHECK] Starting check for AI generation`);
    
    const questionType = document.getElementById('question-type').value;
    const aiButton = document.getElementById('ai-generate-btn');
    
    if (!aiButton) return;
    
    if (!questionType) {
        // No question type selected, hide AI button
        aiButton.style.display = 'none';
        return;
    }
    
    // Check if course materials or objectives are available for Unit 1
    // In onboarding, we check the status badges or the objectives list
    const materialsAvailable = checkOnboardingCourseMaterialsAvailable();
    const objectivesAvailable = checkOnboardingObjectivesAvailable();
    
    if (!materialsAvailable && !objectivesAvailable) {
        // No materials/objectives available, disable AI button
        aiButton.style.display = 'flex';
        aiButton.disabled = true;
        aiButton.title = 'Please upload course materials or add learning objectives before generating AI questions.';
        return;
    }
    
    // Materials available and question type selected, enable AI button
    aiButton.style.display = 'flex';
    aiButton.disabled = false;
    aiButton.title = 'Generate AI question based on uploaded course materials and learning objectives.';
}

/**
 * Check if course materials are available in onboarding
 */
function checkOnboardingCourseMaterialsAvailable() {
    const lectureStatus = document.getElementById('lecture-status');
    const practiceStatus = document.getElementById('practice-status');
    
    return isOnboardingMaterialAvailable(lectureStatus) || isOnboardingMaterialAvailable(practiceStatus);
}

/**
 * Check if learning objectives are available in onboarding
 */
function checkOnboardingObjectivesAvailable() {
    const objectivesList = document.getElementById('objectives-list');
    if (!objectivesList) return false;
    
    // Check if there are any objective items
    return objectivesList.querySelectorAll('.objective-display-item').length > 0;
}

/**
 * Generate AI content for the current question in the modal
 */
async function generateAIQuestionContent() {
    const questionType = document.getElementById('question-type').value;
    
    if (!questionType) {
        showNotification('Please select a question type first.', 'error');
        return;
    }
    
    if (!checkOnboardingCourseMaterialsAvailable() && !checkOnboardingObjectivesAvailable()) {
        showNotification('Please upload course materials or add learning objectives before generating AI questions.', 'error');
        return;
    }

    // Check if this is the second click with existing content
    if (aiGenerationCount > 0 && lastGeneratedContent && questionType === currentQuestionType) {
        // Show regenerate modal instead of generating new content
        openRegenerateModal();
        return;
    }

    // Reset tracking if question type changed
    if (questionType !== currentQuestionType) {
        aiGenerationCount = 0;
        lastGeneratedContent = null;
        currentQuestionType = questionType;
    }
    
    // Show loading state
    const aiButton = document.getElementById('ai-generate-btn');
    const originalText = aiButton.innerHTML;
    aiButton.innerHTML = '<span class="ai-icon">⏳</span> Generating...';
    aiButton.disabled = true;
    
    try {
        // Get course ID from onboarding state
        const courseId = onboardingState.createdCourseId || onboardingState.existingCourseId;
        const instructorId = getCurrentInstructorId();
        const lectureName = 'Unit 1'; // Always Unit 1 for onboarding
        
        if (!courseId) {
            throw new Error('Course ID not found. Please ensure course is created.');
        }

        // Get learning objectives from UI
        const objectives = [];
        document.querySelectorAll('#objectives-list .objective-text').forEach(el => {
            const text = el.textContent.trim();
            if (text) objectives.push(text);
        });
        
        console.log('📚 [OBJECTIVES] Learning objectives for AI generation:', objectives);

        // Call the AI question generation API
        const apiUrl = API_BASE_URL + '/api/questions/generate-ai';
        console.log('🔍 [API_CALL] Making request to:', apiUrl);
        const response = await authenticatedFetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                lectureName: lectureName,
                instructorId: instructorId,
                questionType: questionType,
                learningObjectives: objectives.length > 0 ? objectives : undefined
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error(errorData.message || `Failed to generate question: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to generate question');
        }
        
        const aiContent = result.data;
        
        // Store the generated content for potential regeneration
        lastGeneratedContent = aiContent;
        aiGenerationCount++;
        currentQuestionType = questionType;
        
        // Populate form fields with AI content
        populateFormWithAIContent(aiContent);
        
        // Update button text to indicate regeneration is available
        if (aiGenerationCount === 1) {
            aiButton.innerHTML = `<span class="ai-icon">${Icons.refresh}</span> Regenerate with AI`;
        }
        
        // Show success notification
        showNotification('AI question generated successfully! You can now edit and save it.', 'success');
        
    } catch (error) {
        console.error('Error generating AI question:', error);
        showNotification(`Error generating AI question: ${error.message}`, 'error');
        
        // Show fallback content for demo purposes
        const fallbackContent = createFallbackAIContent(questionType, 'Unit 1');
        populateFormWithAIContent(fallbackContent);
        showNotification('Using fallback content due to generation error. Please edit before saving.', 'warning');
        
    } finally {
        // Restore button state
        aiButton.disabled = false;
        
        // If we have generated content, show regenerate button
        if (aiGenerationCount > 0) {
            aiButton.innerHTML = `<span class="ai-icon">${Icons.refresh}</span> Regenerate with AI`;
        } else {
            aiButton.innerHTML = originalText;
        }
    }
}

/**
 * Open the regenerate modal
 */
function openRegenerateModal() {
    const modal = document.getElementById('regenerate-modal');
    const questionModal = document.getElementById('question-modal');
    if (!modal) return;
    
    // Display current question for reference
    const displayContainer = document.getElementById('current-question-display');
    if (displayContainer && lastGeneratedContent) {
        let contentHtml = `<p><strong>Question:</strong> ${lastGeneratedContent.question || ''}</p>`;
        
        if (lastGeneratedContent.options) {
            contentHtml += '<div class="preview-options">';
            const options = lastGeneratedContent.options.choices || lastGeneratedContent.options;
            if (Array.isArray(options)) {
                options.forEach((opt, idx) => {
                    contentHtml += `<div>${String.fromCharCode(65+idx)}) ${opt}</div>`;
                });
            } else {
                Object.entries(options).forEach(([key, val]) => {
                    contentHtml += `<div>${key}) ${val}</div>`;
                });
            }
            contentHtml += '</div>';
        }
        
        if (lastGeneratedContent.answer) {
            contentHtml += `<p><strong>Answer:</strong> ${lastGeneratedContent.answer}</p>`;
        }
        
        displayContainer.innerHTML = contentHtml;
    }
    
    // Suspend the parent dialog without clearing its in-progress form. Native
    // modal dialogs cannot be stacked, so the parent is restored on dismissal.
    if (questionModal && a11yModal.isOpen(questionModal)) {
        a11yModal.suspend(questionModal);
    }

    modal.classList.add('show');
    a11yModal.open(modal, { onRequestClose: closeRegenerateModal });
}

/**
 * Close the regenerate modal
 */
function closeRegenerateModal() {
    const modal = document.getElementById('regenerate-modal');
    if (modal) {
        a11yModal.close(modal, { restoreFocus: false });
        modal.classList.remove('show');
        // Reset feedback
        const feedback = document.getElementById('regenerate-feedback');
        if (feedback) feedback.value = '';
    }

    const questionModal = document.getElementById('question-modal');
    if (questionModal?.classList.contains('show') && !a11yModal.isOpen(questionModal)) {
        a11yModal.resume(questionModal, { onRequestClose: closeQuestionModal });
    }
}

/**
 * Submit regenerate request with feedback
 */
async function submitRegenerate() {
    const feedbackTextarea = document.getElementById('regenerate-feedback');
    const submitButton = document.getElementById('regenerate-submit-btn');
    const feedback = feedbackTextarea.value.trim();
    
    if (!feedback) {
        showNotification('Please provide feedback about what you\'d like to improve.', 'error');
        return;
    }
    
    // Show loading state
    const originalText = submitButton.innerHTML;
    submitButton.innerHTML = '⏳ Regenerating...';
    submitButton.disabled = true;
    
    try {
        // Get current form data
        const questionType = document.getElementById('question-type').value;
        const courseId = onboardingState.createdCourseId || onboardingState.existingCourseId;
        const instructorId = getCurrentInstructorId();
        const lectureName = 'Unit 1';
        
        // Get learning objectives
        const objectives = [];
        document.querySelectorAll('#objectives-list .objective-text').forEach(el => {
            const text = el.textContent.trim();
            if (text) objectives.push(text);
        });
        
        // Call the regenerate API
        const response = await authenticatedFetch(API_BASE_URL + '/api/questions/generate-ai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                lectureName: lectureName,
                instructorId: instructorId,
                questionType: questionType,
                learningObjectives: objectives.length > 0 ? objectives : undefined,
                regenerate: true,
                feedback: feedback,
                previousQuestion: lastGeneratedContent
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error(errorData.message || `Failed to regenerate question: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to regenerate question');
        }
        
        // Update the stored content
        lastGeneratedContent = result.data;
        
        // Populate form with new content
        populateFormWithAIContent(result.data);
        
        // Close modal
        closeRegenerateModal();
        
        // Show success notification
        showNotification('Question regenerated successfully based on your feedback!', 'success');
        
    } catch (error) {
        console.error('Error regenerating question:', error);
        showNotification(`Error regenerating question: ${error.message}`, 'error');
        
    } finally {
        // Restore button state
        submitButton.innerHTML = originalText;
        submitButton.disabled = false;
    }
}

/**
 * Populate the question modal form with AI-generated content
 */
function populateFormWithAIContent(aiContent) {
    if (!aiContent) return;
    
    // Set question text
    const questionText = aiContent.question || aiContent.options?.question || aiContent.prompt || '';
    document.getElementById('question-text').value = questionText;
    
    // Set answer based on type
    const questionType = document.getElementById('question-type').value;
    
    if (questionType === 'true-false') {
        const answer = String(aiContent.answer).toLowerCase();
        const radioButton = document.querySelector(`input[name="tf-answer"][value="${answer}"]`);
        if (radioButton) {
            radioButton.checked = true;
        }
    } else if (questionType === 'multiple-choice') {
        // Set MCQ options
        if (aiContent.options) {
            const choices = aiContent.options.choices || aiContent.options;
            
            if (Array.isArray(choices)) {
                choices.forEach((choice, index) => {
                    const option = String.fromCharCode(65 + index);
                    const input = document.querySelector(`.mcq-input[data-option="${option}"]`);
                    if (input) input.value = choice;
                });
            } else if (typeof choices === 'object') {
                Object.keys(choices).forEach(option => {
                    const input = document.querySelector(`.mcq-input[data-option="${option}"]`);
                    if (input) input.value = choices[option];
                });
            }
        }
        
        // Enable radio buttons
        const radioButtons = document.querySelectorAll('input[name="mcq-correct"]');
        radioButtons.forEach(radio => radio.disabled = false);
        
        // Set correct answer
        const correctAnswer = aiContent.options?.correctAnswer || aiContent.answer || '';
        if (correctAnswer) {
            let correctRadio = document.querySelector(`input[name="mcq-correct"][value="${correctAnswer}"]`) ||
                             document.querySelector(`input[name="mcq-correct"][value="${correctAnswer.toUpperCase()}"]`);
            if (correctRadio) correctRadio.checked = true;
        }
    } else if (questionType === 'short-answer') {
        const expectedAnswer = aiContent.EXPECTED_ANSWER || aiContent.answer || '';
        document.getElementById('sa-answer').value = expectedAnswer;
    }

    if (Object.prototype.hasOwnProperty.call(aiContent, 'selectedLearningObjective')) {
        const selectedLearningObjective = (aiContent.selectedLearningObjective || '').trim();
        let learningObjectiveNote = '';

        if (aiContent.wasRegenerated) {
            learningObjectiveNote = selectedLearningObjective
                ? 'The regenerated question was re-linked to this learning objective. Review it before saving if you want a different one.'
                : 'No clear learning objective match was found for the regenerated question. It is currently unassigned until you choose one.';
        } else if (selectedLearningObjective) {
            learningObjectiveNote = 'AI selected this learning objective for the generated question. Saving will keep this link unless you change it.';
        }

        populateQuestionLearningObjectiveDropdown(
            selectedLearningObjective,
            learningObjectiveNote
        );
    }
}

/**
 * Create fallback AI content when the API fails
 */
function createFallbackAIContent(type, week) {
    if (type === 'true-false') {
        return {
            question: `Based on the ${week} lecture notes, this concept is essential for understanding the course material.`,
            answer: Math.random() > 0.5 ? 'true' : 'false'
        };
    } else if (type === 'multiple-choice') {
        return {
            question: `According to the ${week} lecture notes, which of the following is most accurate?`,
            options: {
                'A': 'Option A based on lecture content',
                'B': 'Option B based on lecture content', 
                'C': 'Option C based on lecture content',
                'D': 'Option D based on lecture content'
            },
            answer: ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)]
        };
    } else if (type === 'short-answer') {
        return {
            question: `Explain a key concept from the ${week} lecture notes and its significance.`,
            answer: 'Students should demonstrate understanding by explaining the concept clearly and showing its relevance to the course material.'
        };
    }
}
