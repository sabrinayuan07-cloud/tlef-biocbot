/**
 * Instructor: learning objectives CRUD and option population.
 */

/**
 * Build one learning objective list item.
 *
 * The remove control is named after the objective it removes ("Remove
 * objective: Explain osmosis") so the controls in a list can be told apart,
 * and its "×" is hidden from assistive technology so it is not read out.
 * The objective is set as text, never as HTML.
 * @param {string} objectiveText - The objective as the instructor wrote it
 * @returns {HTMLLIElement}
 */
function createObjectiveItem(objectiveText) {
    const item = document.createElement('li');
    item.className = 'objective-display-item';

    const text = document.createElement('span');
    text.className = 'objective-text';
    text.textContent = objectiveText;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-objective';
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '×';
    const name = document.createElement('span');
    name.className = 'visually-hidden';
    name.textContent = `Remove objective: ${objectiveText}`;
    remove.append(icon, name);
    remove.addEventListener('click', () => removeObjective(remove));

    // The list item keeps its list-item display (which is what makes it a list
    // item to Safari); the row inside it does the flex layout.
    const row = document.createElement('div');
    row.className = 'objective-display-row';
    row.append(text, remove);
    item.append(row);
    return item;
}

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
                            objectivesList.appendChild(createObjectiveItem(objective));
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
 * Persist the current set of learning objectives shown for a unit to the
 * server. Called automatically after every add/remove - there's no
 * separate "Save" step, so this always sends the full current list
 * (including an empty array, if the instructor has removed them all).
 * @param {string} week - The week identifier (e.g., 'Week 1')
 * @returns {Promise<boolean>} Whether the save succeeded
 */
async function persistObjectivesForWeek(week) {
    const weekElement = document.querySelector(`.accordion-item[data-unit-name="${week}"]`);
    if (!weekElement) {
        console.error('Could not find week element for:', week);
        return false;
    }

    const objectives = Array.from(weekElement.querySelectorAll('.objective-text'))
        .map(item => item.textContent.trim())
        .filter(value => value);

    try {
        const courseId = await getCurrentCourseId();
        const response = await fetch('/api/learning-objectives', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lectureName: week,
                objectives,
                instructorId: getCurrentInstructorId(),
                courseId
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to save learning objectives: ${response.status} ${errorText}`);
        }
        return true;
    } catch (error) {
        console.error('Error saving learning objectives:', error);
        showNotification('Error saving learning objective. Please try again.', 'error');
        return false;
    }
}

/**
 * Add a new learning objective from the input field, and immediately save
 * it - there's no separate Save button, so a failed save rolls the
 * addition back out of the list rather than leaving the page and the
 * database out of sync.
 * @param {string} week - The week identifier (e.g., 'Week 1')
 */
async function addObjectiveFromInput(week) {
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
    const objectiveItem = createObjectiveItem(objectiveText);

    // Add to the list
    objectivesList.appendChild(objectiveItem);

    // Clear the input field
    inputField.value = '';
    inputField.focus();

    const saved = await persistObjectivesForWeek(week);
    if (!saved) {
        objectiveItem.remove();
        return;
    }

    showNotification('Learning objective added successfully!', 'success');
}

/**
 * Remove a learning objective, then immediately save the updated list.
 * @param {HTMLElement} button - The remove button element
 */
async function removeObjective(button) {
    const objectiveItem = button.closest('.objective-display-item');
    const week = button.closest('.accordion-item[data-unit-name]')?.getAttribute('data-unit-name');
    if (!objectiveItem || !week) {
        console.error('Could not find objective item or unit to remove from');
        return;
    }

    // Removing the item takes the focused button with it. Move focus to the
    // neighbouring objective's remove button, or to the "new objective" field
    // when the list is now empty, so a keyboard user keeps their place.
    const neighbour = objectiveItem.nextElementSibling || objectiveItem.previousElementSibling;
    const nextFocus = neighbour?.querySelector('.remove-objective')
        || button.closest('.section-content')?.querySelector('.objective-input');

    objectiveItem.remove();
    nextFocus?.focus();
    await persistObjectivesForWeek(week);
    showNotification('Learning objective removed.', 'info');
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
