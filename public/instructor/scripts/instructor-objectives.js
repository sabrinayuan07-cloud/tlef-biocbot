/**
 * Instructor: learning objectives CRUD and option population.
 */

/**
 * Load the saved learning objectives for all lectures from the database
 */
async function loadLearningObjectives() {
    try {
        console.log('📚 [LEARNING_OBJECTIVES] Starting to load learning objectives...');
        const courseId = await getCurrentCourseId();
        console.log(`📚 [LEARNING_OBJECTIVES] Course ID: ${courseId}`);
        
        // Get all accordion items (units/weeks)
        const accordionItems = document.querySelectorAll('.accordion-item');
        console.log(`📚 [LEARNING_OBJECTIVES] Found ${accordionItems.length} accordion items (units/weeks)`);
        
        for (const item of accordionItems) {
            // Use data-unit-name attribute for internal name (e.g., "Unit 1")
            const lectureName = item.getAttribute('data-unit-name');
            if (!lectureName) continue;
            
            console.log(`📚 [LEARNING_OBJECTIVES] Processing lecture/unit: ${lectureName}`);
            
            console.log(`📡 [MONGODB] Making API request to /api/learning-objectives?week=${encodeURIComponent(lectureName)}&courseId=${courseId}`);
            const response = await fetch(`/api/learning-objectives?week=${encodeURIComponent(lectureName)}&courseId=${courseId}`);
            console.log(`📡 [MONGODB] API response status: ${response.status} ${response.statusText}`);
            console.log(`📡 [MONGODB] API response headers:`, Object.fromEntries(response.headers.entries()));
            
            if (response.ok) {
                const result = await response.json();
                console.log(`📡 [MONGODB] Learning objectives data for ${lectureName}:`, result);
                const objectives = result.data.objectives;
                
                if (objectives && objectives.length > 0) {
                    console.log(`📚 [LEARNING_OBJECTIVES] Found ${objectives.length} objectives for ${lectureName}:`, objectives);
                    // Clear existing objectives
                    const objectivesList = item.querySelector('.objectives-list');
                    if (objectivesList) {
                        objectivesList.innerHTML = '';
                        
                        // Add each objective
                        objectives.forEach((objective, index) => {
                            console.log(`📚 [LEARNING_OBJECTIVES] Adding objective ${index + 1} to UI: ${objective}`);
                            const objectiveItem = document.createElement('div');
                            objectiveItem.className = 'objective-display-item';
                            objectiveItem.innerHTML = `
                                <span class="objective-text">${objective}</span>
                                <button class="remove-objective" onclick="removeObjective(this)">×</button>
                            `;
                            objectivesList.appendChild(objectiveItem);
                        });
                        console.log(`✅ [LEARNING_OBJECTIVES] Successfully added ${objectives.length} objectives to UI for ${lectureName}`);
                    } else {
                        console.warn(`⚠️ [LEARNING_OBJECTIVES] No objectives list found for ${lectureName}`);
                    }
                } else {
                    console.log(`📚 [LEARNING_OBJECTIVES] No objectives found for ${lectureName}`);
                }
            } else {
                console.warn(`⚠️ [MONGODB] Failed to load learning objectives for ${lectureName}: ${response.status} ${response.statusText}`);
            }
        }
        
        console.log('✅ [LEARNING_OBJECTIVES] Learning objectives loading process completed');
        
    } catch (error) {
        console.error('❌ [LEARNING_OBJECTIVES] Error loading learning objectives:', error);
        showNotification('Error loading learning objectives. Using default values.', 'warning');
    }
}

/**
 * Add a new learning objective from the input field
 * @param {string} week - The week identifier (e.g., 'Week 1')
 */
function addObjectiveFromInput(week) {
    // Find the week element using data-unit-name attribute (internal name like "Unit 1")
    const weekElement = document.querySelector(`.accordion-item[data-unit-name="${week}"]`);
    if (!weekElement) {
        console.error('Could not find week element for:', week);
        showNotification('Error: Could not find unit element', 'error');
        return;
    }
    
    // Convert unit name to ID format (e.g., "Unit 1" -> "Unit-1")
    const unitId = week.toLowerCase().replace(/\s+/g, '-');
    
    const inputField = weekElement.querySelector(`#objective-input-${unitId}`);
    
    if (!inputField) {
        console.error('Could not find input field for:', week, 'with ID:', `objective-input-${unitId}`);
        showNotification('Error: Could not find input field', 'error');
        return;
    }
    
    const objectiveText = inputField.value.trim();
    
    if (!objectiveText) {
        showNotification('Please enter a learning objective.', 'error');
        return;
    }
    
    // Get the objectives list
    const objectivesList = weekElement.querySelector(`#objectives-list-${unitId}`);
    
    if (!objectivesList) {
        console.error('Could not find objectives list for:', week);
        showNotification('Error: Could not find objectives list', 'error');
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
    
    showNotification('Learning objective added successfully!', 'success');
}

/**
 * Remove a learning objective
 * @param {HTMLElement} button - The remove button element
 */
function removeObjective(button) {
    const objectiveItem = button.closest('.objective-display-item');
    if (objectiveItem) {
        objectiveItem.remove();
        showNotification('Learning objective removed.', 'error');
    } else {
        console.error('Could not find objective item to remove');
    }
}

/**
 * Save learning objectives for a week
 * @param {string} week - The week identifier (e.g., 'Week 1')
 */
async function saveObjectives(week) {
    // Find the week element using data-unit-name attribute (internal name like "Unit 1")
    const weekElement = document.querySelector(`.accordion-item[data-unit-name="${week}"]`);
    if (!weekElement) {
        console.error('Could not find week element for:', week);
        showNotification('Error: Could not find unit element', 'error');
        return;
    }
    
    const objectiveItems = weekElement.querySelectorAll('.objective-text');
    
    // Collect all objectives
    const objectives = Array.from(objectiveItems).map(item => item.textContent.trim()).filter(value => value);
    
    if (objectives.length === 0) {
        showNotification('Please add at least one learning objective.', 'error');
        return;
    }
    
    try {
        // Get the current course ID
        const courseId = await getCurrentCourseId();
        
        const requestBody = {
            lectureName: week, // Use lectureName for consistency
            objectives: objectives,
            instructorId: getCurrentInstructorId(),
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
            const message = await extractErrorMessage(response, 'Failed to save learning objectives');
            console.error('Error response:', message);
            throw new Error(message);
        }
        
        const result = await response.json();
        showNotification(result.message, 'success');
        
    } catch (error) {
        console.error('Error saving learning objectives:', error);
        showNotification('Error saving learning objectives. Please try again.', 'error');
    }
}

function getObjectivesForUnit(unitName) {
    const accordionItem = document.querySelector(`.accordion-item[data-unit-name="${unitName}"]`);
    if (!accordionItem) {
        return [];
    }

    const objectives = [];
    accordionItem.querySelectorAll('.objectives-list .objective-text').forEach(item => {
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

function populateQuestionLearningObjectiveDropdown(unitName, selectedObjective = '', noteMessage = '') {
    const select = document.getElementById('learning-objective-select');
    populateLearningObjectiveOptions(select, getObjectivesForUnit(unitName), selectedObjective);
    setLearningObjectiveNote(noteMessage);
}
