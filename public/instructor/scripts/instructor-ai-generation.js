/**
 * Instructor: AI question generation (struggle topics, regenerate modal).
 */

/**
 * Check AI generation availability in the question modal
 */
function checkAIGenerationInModal() {
    console.log(`🔍 [AI_MODAL_CHECK] Starting check for currentWeek: ${currentWeek}`);
    
    const questionType = document.getElementById('question-type').value;
    const aiButton = document.getElementById('ai-generate-btn');
    
    console.log(`🔍 [AI_MODAL_CHECK] Question type: ${questionType}`);
    console.log(`🔍 [AI_MODAL_CHECK] AI button found: ${!!aiButton}`);
    
    if (!questionType) {
        // No question type selected, hide AI button
        console.log(`🔍 [AI_MODAL_CHECK] No question type selected, hiding AI button`);
        aiButton.style.display = 'none';
        return;
    }
    
    // Check if course materials are available for the current week
    const materialsAvailable = checkCourseMaterialsAvailable(currentWeek);
    console.log(`🔍 [AI_MODAL_CHECK] Course materials available: ${materialsAvailable}`);
    
    if (!materialsAvailable) {
        // No course materials available, disable AI button
        console.log(`🔍 [AI_MODAL_CHECK] No materials available, disabling AI button`);
        aiButton.style.display = 'flex';
        aiButton.disabled = true;
        aiButton.title = 'Please upload course materials (lecture notes, practice questions, etc.) before generating AI questions.';
        return;
    }
    
    // Course materials available and question type selected, enable AI button
    console.log(`🔍 [AI_MODAL_CHECK] Materials available, enabling AI button`);
    aiButton.style.display = 'flex';
    aiButton.disabled = false;
    aiButton.title = 'Generate AI question based on uploaded course materials.';
}

async function getApprovedStruggleTopicDetailsForEditor() {
    const courseId = await getCurrentCourseId();
    if (!courseId) return [];

    const cachedTopics = window.courseApprovedTopicDetailsByCourse?.[courseId];
    if (Array.isArray(cachedTopics)) {
        return cachedTopics;
    }

    return fetchCourseApprovedTopics(courseId);
}

async function getCumulativeStruggleTopicsForEditor() {
    const courseId = await getCurrentCourseId();
    if (!courseId) return [];

    if (Array.isArray(window.cumulativeStruggleTopicsByCourse?.[courseId])) {
        return window.cumulativeStruggleTopicsByCourse[courseId];
    }

    const response = await fetch(`/api/struggle-activity/persistence/${courseId}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch cumulative topics: ${response.status}`);
    }

    const result = await response.json();
    const topics = Array.isArray(result?.data) ? result.data : [];
    window.cumulativeStruggleTopicsByCourse = window.cumulativeStruggleTopicsByCourse || {};
    window.cumulativeStruggleTopicsByCourse[courseId] = topics;
    return topics;
}

async function populateStruggleTopicDropdown(week = currentWeek, showAll = false) {
    const select = document.getElementById('struggle-topic-select');
    const note = document.getElementById('struggle-topic-note');
    const scopeButton = document.getElementById('show-all-struggle-topics-toggle');
    if (!select) return;

    if (scopeButton) {
        scopeButton.dataset.showAll = showAll ? 'true' : 'false';
        scopeButton.textContent = showAll ? `Back to ${week || 'unit'} topics` : 'Show all unit-linked topics';
        scopeButton.classList.toggle('active', showAll);
    }

    select.innerHTML = '<option value="">Loading topics...</option>';
    select.disabled = true;

    try {
        const [approvedTopics, cumulativeTopics] = await Promise.all([
            getApprovedStruggleTopicDetailsForEditor(),
            getCumulativeStruggleTopicsForEditor()
        ]);
        const cumulativeTopicMap = new Map(
            cumulativeTopics
                .map(topic => [normalizeTopicLabel(topic.topic).toLowerCase(), topic])
                .filter(([label]) => label)
        );
        const topics = approvedTopics
            .filter(topic => cumulativeTopicMap.has(topic.topic.toLowerCase()))
            .map(topic => ({
                ...topic,
                studentCount: cumulativeTopicMap.get(topic.topic.toLowerCase())?.studentCount || 0
            }));
        const unitLinkedTopics = topics.filter(topic => topic.unitId);
        const filteredTopics = showAll
            ? unitLinkedTopics
            : unitLinkedTopics.filter(topic => topic.unitId === week);

        if (filteredTopics.length === 0) {
            select.innerHTML = `<option value="">${showAll ? 'No unit-linked cumulative topics available' : `No cumulative topics assigned to ${week || 'this unit'}`}</option>`;
            if (note) {
                note.textContent = showAll
                    ? 'No triggered struggle topics have been assigned to a unit yet.'
                    : `Default: showing cumulative topics assigned to ${week || 'this unit'}. Use "Show all unit-linked topics" to choose from other units.`;
            }
            return;
        }

        select.innerHTML = '<option value="">Select a struggle topic...</option>' + filteredTopics.map(topic => {
            const suffix = showAll && topic.unitId ? ` (${topic.unitId})` : '';
            const countSuffix = topic.studentCount ? ` - ${topic.studentCount} student${topic.studentCount === 1 ? '' : 's'}` : '';
            return `<option value="${escapeHTML(topic.topic)}">${escapeHTML(topic.topic + suffix + countSuffix)}</option>`;
        }).join('');
        select.disabled = false;

        if (note) {
            note.textContent = showAll
                ? 'Showing all cumulative struggle topics that are linked to any unit.'
                : `Default: showing cumulative struggle topics assigned to ${week || 'this unit'}.`;
        }
    } catch (error) {
        console.error('Error loading struggle topics for question generation:', error);
        select.innerHTML = '<option value="">Could not load topics</option>';
        if (note) note.textContent = 'Could not load approved struggle topics.';
    }
}

function toggleStruggleTopicScope() {
    const scopeButton = document.getElementById('show-all-struggle-topics-toggle');
    const showAll = scopeButton?.dataset.showAll !== 'true';
    populateStruggleTopicDropdown(currentWeek, showAll);
}

function getCurrentWeekLearningObjectives() {
    const weekAccordionItem = document.querySelector(`.accordion-item[data-unit-name="${currentWeek}"]`);
    const objectives = [];

    if (weekAccordionItem) {
        const objectivesList = weekAccordionItem.querySelector('.objectives-list');
        if (objectivesList) {
            objectivesList.querySelectorAll('.objective-text').forEach(obj => {
                const text = obj.textContent.trim();
                if (text) objectives.push(text);
            });
        }
    }

    return objectives;
}

async function generateAIQuestionFromStruggleTopic() {
    const questionType = document.getElementById('question-type').value;
    const topicSelect = document.getElementById('struggle-topic-select');
    const struggleTopic = topicSelect?.value?.trim() || '';

    if (!questionType) {
        showNotification('Please select a question type first.', 'error');
        return;
    }

    if (!struggleTopic) {
        showNotification('Please select a struggle topic first.', 'error');
        return;
    }

    if (!checkCourseMaterialsAvailable(currentWeek)) {
        showNotification('Please upload course materials for this unit before generating from a struggle topic.', 'error');
        return;
    }

    const button = document.getElementById('topic-generate-btn');
    const originalText = button?.innerHTML || 'Generate from Topic';

    if (button) {
        button.innerHTML = '<span class="ai-icon">⏳</span> Generating...';
        button.disabled = true;
    }

    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        const objectives = getCurrentWeekLearningObjectives();

        const response = await fetch(API_BASE_URL + '/api/questions/generate-ai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId,
                lectureName: currentWeek,
                instructorId,
                questionType,
                struggleTopic,
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
        lastGeneratedContent = aiContent;
        aiGenerationCount = 1;
        currentQuestionType = questionType;

        populateFormWithAIContent(aiContent);
        showNotification(`Generated a ${getQuestionTypeLabel(questionType).toLowerCase()} question from "${struggleTopic}". Review it before saving.`, 'success');
    } catch (error) {
        console.error('Error generating question from struggle topic:', error);
        showNotification(`Error generating from struggle topic: ${error.message}`, 'error');
    } finally {
        if (button) {
            button.innerHTML = originalText;
            button.disabled = false;
        }
    }
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
    
    if (!checkCourseMaterialsAvailable(currentWeek)) {
        showNotification('Please upload course materials (lecture notes, practice questions, etc.) before generating AI questions.', 'error');
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
        // Get current course ID and instructor ID
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        
        // Get course materials and learning objectives for the current week
        // Use data-unit-name attribute selector instead of folder-name text (which shows formatted name)
        const weekAccordionItem = document.querySelector(`.accordion-item[data-unit-name="${currentWeek}"]`);

        if (!weekAccordionItem) {
            throw new Error(`Could not find accordion item for week: ${currentWeek}`);
        }

        // Get materials
        const materials = [];
        const fileItems = weekAccordionItem.querySelectorAll('.course-materials-section .file-item');
        fileItems.forEach(item => {
            const title = item.querySelector('.file-info h3')?.textContent;
            const status = item.querySelector('.status-text')?.textContent;
            const docId = item.dataset.documentId;
            materials.push({ title, status, documentId: docId });
        });
        console.log('📚 [MATERIALS] Available materials for AI generation:', materials);

        // Get learning objectives
        const objectives = [];
        const objectivesList = weekAccordionItem.querySelector('.objectives-list');
        if (objectivesList) {
            objectivesList.querySelectorAll('.objective-text').forEach(obj => {
                const text = obj.textContent.trim();
                if (text) {
                    objectives.push(text);
                }
            });
        }
        console.log('📚 [OBJECTIVES] Learning objectives for AI generation:', objectives);

        // Call the AI question generation API
        const apiUrl = API_BASE_URL + '/api/questions/generate-ai';
        console.log('🔍 [API_CALL] Making request to:', apiUrl);
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                lectureName: currentWeek,
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
        console.log('🤖 [AI_RESPONSE] Raw response:', result);
        console.log('🤖 [AI_RESPONSE] Full data structure:', JSON.stringify(result, null, 2));
        
        if (!result.success) {
            throw new Error(result.message || 'Failed to generate question');
        }
        
        const aiContent = result.data;
        console.log('🤖 [AI_CONTENT] Processed content to populate form:', aiContent);
        console.log('🤖 [AI_CONTENT] Content keys:', Object.keys(aiContent));
        console.log('🤖 [AI_CONTENT] Options structure:', aiContent.options ? JSON.stringify(aiContent.options, null, 2) : 'No options');
        
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
        const fallbackContent = createFallbackAIContent(questionType, currentWeek);
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
 * Create fallback AI content when the API fails
 * @param {string} type - Question type
 * @param {string} week - Week identifier
 * @returns {Object} Fallback content object
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

/**
 * Populate the question modal form with AI-generated content
 * @param {Object} aiContent - The AI-generated question content
 */
function populateFormWithAIContent(aiContent) {
    console.log('🎯 [FORM_POPULATION] Starting to populate form with content:', aiContent);
    console.log('🎯 [FORM_POPULATION] Content structure:', {
        hasQuestion: 'question' in aiContent,
        hasOptions: 'options' in aiContent,
        optionsType: aiContent.options ? typeof aiContent.options : 'none',
        allKeys: Object.keys(aiContent)
    });
    
    // Set question text - check multiple possible locations
    const questionText = aiContent.question || aiContent.options?.question || aiContent.prompt || '';
    console.log('🎯 [FORM_POPULATION] Setting question text:', questionText);
    document.getElementById('question-text').value = questionText;
    
    // Set answer based on type
    const questionType = document.getElementById('question-type').value;
    console.log('🎯 [FORM_POPULATION] Question type:', questionType);
    
    if (questionType === 'true-false') {
        console.log('🎯 [FORM_POPULATION] Handling true-false question');
        console.log('🎯 [FORM_POPULATION] Answer value:', aiContent.answer);
        
        // Set radio button
        const radioButton = document.querySelector(`input[name="tf-answer"][value="${aiContent.answer}"]`);
        console.log('🎯 [FORM_POPULATION] Found radio button:', !!radioButton);
        if (radioButton) {
            radioButton.checked = true;
        }
    } else if (questionType === 'multiple-choice') {
        console.log('🎯 [FORM_POPULATION] Handling multiple-choice question');
        console.log('🎯 [FORM_POPULATION] Options:', aiContent.options);
        
        // Set MCQ options
        if (aiContent.options && typeof aiContent.options === 'object') {
            // Check if options are in the expected format or in choices array
            const choices = aiContent.options.choices || aiContent.options;
            console.log('🎯 [FORM_POPULATION] Processed choices:', choices);
            
            // Map choices to A, B, C, D if they're in an array
            if (Array.isArray(choices)) {
                choices.forEach((choice, index) => {
                    const option = String.fromCharCode(65 + index); // Convert 0 to 'A', 1 to 'B', etc.
                    console.log(`🎯 [FORM_POPULATION] Setting array option ${option}:`, choice);
                    const input = document.querySelector(`.mcq-input[data-option="${option}"]`);
                    if (input) {
                        input.value = choice;
                    }
                });
            } else {
                // Handle object format
                Object.keys(choices).forEach(option => {
                    console.log(`🎯 [FORM_POPULATION] Setting object option ${option}:`, choices[option]);
                    const input = document.querySelector(`.mcq-input[data-option="${option}"]`);
                    if (input) {
                        input.value = choices[option];
                    }
                });
            }
        }
        
        // Enable all radio buttons since we have content
        const radioButtons = document.querySelectorAll('input[name="mcq-correct"]');
        radioButtons.forEach(radio => {
            radio.disabled = false;
        });
        
        // Set correct answer - might be in different places in the response
        const correctAnswer = aiContent.options?.correctAnswer || aiContent.answer || '';
        console.log('🎯 [FORM_POPULATION] Correct answer:', correctAnswer);
        
        if (correctAnswer) {
            // Try both the original answer and uppercase version
            let correctRadio = document.querySelector(`input[name="mcq-correct"][value="${correctAnswer}"]`) ||
                             document.querySelector(`input[name="mcq-correct"][value="${correctAnswer.toUpperCase()}"]`);
            
            console.log('🎯 [FORM_POPULATION] Found correct answer radio:', !!correctRadio);
            if (correctRadio) {
                correctRadio.checked = true;
            }
        }
    } else if (questionType === 'short-answer') {
        console.log('🎯 [FORM_POPULATION] Handling short-answer question');
        console.log('🎯 [FORM_POPULATION] Full content:', aiContent);
        
        // For short answer, check both EXPECTED_ANSWER and answer fields
        const expectedAnswer = aiContent.EXPECTED_ANSWER || aiContent.answer || '';
        console.log('🎯 [FORM_POPULATION] Expected answer sources:', {
            fromExpectedAnswer: aiContent.EXPECTED_ANSWER,
            fromAnswer: aiContent.answer,
            final: expectedAnswer
        });
        
        // Set short answer
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
            currentWeek,
            selectedLearningObjective,
            learningObjectiveNote
        );
    }
}

/**
 * Check AI generation availability and update button state
 * @param {string} week - Week identifier
 */
function checkAIGenerationAvailability(week) {
    // This function is now primarily used for external AI generation buttons
    // The modal AI generation is handled by checkAIGenerationInModal()
    const weekLower = week.toLowerCase().replace(' ', '');
    const aiButton = document.getElementById(`generate-ai-${weekLower}`);
    
    if (aiButton) {
        const lectureNotesUploaded = checkLectureNotesUploaded(week);
        aiButton.disabled = !lectureNotesUploaded;
        
        if (lectureNotesUploaded) {
            aiButton.title = 'Generate questions using AI based on uploaded lecture notes';
        } else {
            aiButton.title = 'Upload lecture notes first to enable AI generation';
        }
    }
}

/**
 * Open the regenerate modal with current question content
 */
function openRegenerateModal() {
    const modal = document.getElementById('regenerate-modal');
    const questionModal = document.getElementById('question-modal');
    const currentQuestionDisplay = document.getElementById('current-question-display');
    const feedbackTextarea = document.getElementById('regenerate-feedback');
    
    if (!modal || !currentQuestionDisplay || !lastGeneratedContent) {
        console.error('Missing elements for regenerate modal');
        return;
    }
    
    // Clear previous feedback
    feedbackTextarea.value = '';
    
    // Display current question content
    displayCurrentQuestion(currentQuestionDisplay, lastGeneratedContent);
    
    // Suspend the parent dialog without clearing its in-progress form. Native
    // modal dialogs cannot be stacked, so the parent is restored on dismissal.
    if (questionModal && a11yModal.isOpen(questionModal)) {
        a11yModal.suspend(questionModal);
    }

    // Show modal
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
    }

    const questionModal = document.getElementById('question-modal');
    if (questionModal?.classList.contains('show') && !a11yModal.isOpen(questionModal)) {
        a11yModal.resume(questionModal, { onRequestClose: closeQuestionModal });
    }
}

/**
 * Display the current question in a readable format
 * @param {HTMLElement} container - The container element to display the question
 * @param {Object} questionContent - The question content object
 */
function displayCurrentQuestion(container, questionContent) {
    const questionType = document.getElementById('question-type').value;
    let html = '';
    
    // Question text
    html += `<div class="question-text">${questionContent.question || 'No question text'}</div>`;
    
    // Show options/answers based on type
    if (questionType === 'multiple-choice' && questionContent.options) {
        html += '<div class="question-options">';
        const options = questionContent.options;
        const correctAnswer = questionContent.answer;
        
        ['A', 'B', 'C', 'D'].forEach(letter => {
            if (options[letter]) {
                const isCorrect = letter === correctAnswer;
                html += `<div class="option ${isCorrect ? 'correct' : ''}">${letter}. ${options[letter]} ${isCorrect ? '(Correct)' : ''}</div>`;
            }
        });
        html += '</div>';
    } else if (questionType === 'true-false') {
        html += `<div class="question-answer">Correct Answer: ${questionContent.answer}</div>`;
    } else if (questionType === 'short-answer') {
        html += `<div class="question-answer">Expected Answer: ${questionContent.answer || 'No answer provided'}</div>`;
    }
    
    container.innerHTML = html;
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
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();
        
        // Get learning objectives (same as original generation)
        const weekAccordionItem = Array.from(document.querySelectorAll('.accordion-item')).find(item => {
            const folderName = item.querySelector('.folder-name')?.textContent;
            return folderName === currentWeek;
        });

        const objectives = [];
        if (weekAccordionItem) {
            const objectivesList = weekAccordionItem.querySelector('.objectives-list');
            if (objectivesList) {
                objectivesList.querySelectorAll('.objective-text').forEach(obj => {
                    const text = obj.textContent.trim();
                    if (text) {
                        objectives.push(text);
                    }
                });
            }
        }
        
        // Call the regenerate API
        const response = await fetch(API_BASE_URL + '/api/questions/generate-ai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                courseId: courseId,
                lectureName: currentWeek,
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
