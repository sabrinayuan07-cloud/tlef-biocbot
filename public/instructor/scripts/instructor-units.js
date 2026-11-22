/**
 * Instructor: unit rendering, accordion, rename, and placeholder management.
 * (Add/delete-unit handlers live in the boot file's first DOMContentLoaded
 * listener in instructor.js.)
 */

/**
 * Toggle a section's visibility
 * @param {HTMLElement} headerElement - The section header element
 * @param {Event} e - The event object
 */
function toggleSection(headerElement, e) {
    // If an event was passed, prevent it from bubbling up
    if (e) {
        e.stopPropagation();
    }
    
    // If the clicked element is not the section header itself, find the closest section header
    const sectionHeader = headerElement.classList.contains('section-header') ? 
                          headerElement : headerElement.closest('.section-header');
    
    const sectionContent = sectionHeader.nextElementSibling;

    // Toggle the collapsed class
    sectionContent.classList.toggle('collapsed');

    syncSectionToggle(sectionHeader);
}

/**
 * Make a section header's button and caret say whether its content is showing.
 * The button carries the state for assistive technology (aria-expanded); the
 * caret is a picture of the same thing and is hidden from it.
 * @param {HTMLElement} sectionHeader - The .section-header element
 */
function syncSectionToggle(sectionHeader) {
    const sectionContent = sectionHeader.nextElementSibling;
    if (!sectionContent) return;
    const collapsed = sectionContent.classList.contains('collapsed');
    const toggleButton = sectionHeader.querySelector('.toggle-section');
    const toggleIcon = sectionHeader.querySelector('.toggle-section-icon');
    if (toggleButton) toggleButton.setAttribute('aria-expanded', String(!collapsed));
    if (toggleIcon) toggleIcon.textContent = collapsed ? '▶' : '▼';
}

/**
 * The title an instructor sees for a unit (e.g. "2. Enzymes"). Falls back to
 * the internal name when the unit is not on the page.
 * @param {string} unitName - Internal name of the unit (e.g., "Unit 1")
 * @returns {string}
 */
function getUnitLabel(unitName) {
    const title = document.querySelector(`.accordion-item[data-unit-name="${unitName}"] .folder-name`);
    return (title && title.textContent.trim()) || unitName;
}

/**
 * Visually hidden text that finishes a repeated control's name with the unit
 * it belongs to: "Add Question" + " for 1. Cell Structure".
 *
 * Every unit repeats the same controls, so without this a screen-reader user
 * hears "Add Question, Add Question, Add Question" with no way to tell them
 * apart. The name is made of real text inside the control (no aria-label or
 * aria-labelledby), and the unit's title sits in its own .unit-name-ref span
 * so a rename can update every control in the unit in one pass.
 * @param {string} unitLabel - The unit's visible title
 * @param {string} [lead=' for '] - Words between the control's text and the title
 * @returns {string} HTML for the hidden span
 */
function unitContext(unitLabel, lead = ' for ') {
    return `<span class="visually-hidden">${lead}<span class="unit-name-ref">${unitLabel}</span></span>`;
}

/**
 * The list that holds a unit's course material items, created on first use.
 * Material items are list items, so they have to live in a list rather than
 * loose among the section's other content.
 * @param {HTMLElement} sectionContent - The course materials .section-content
 * @returns {HTMLElement} The ul.materials-list element
 */
function getMaterialsList(sectionContent) {
    let list = sectionContent.querySelector(':scope > .materials-list');
    if (!list) {
        list = document.createElement('ul');
        list.className = 'materials-list';
        const before = sectionContent.querySelector(':scope > .add-content-section, :scope > .cleanup-section');
        sectionContent.insertBefore(list, before);
    }
    return list;
}

/**
 * Build one "required material not uploaded yet" placeholder item.
 * @param {string} unitName - Internal name of the unit (e.g., "Unit 1")
 * @param {'lecture-notes'|'practice-quiz'} contentType - Which required material
 * @param {string} [unitLabel] - The unit's visible title, when the unit is not on the page yet
 * @returns {HTMLLIElement}
 */
function createPlaceholderItem(unitName, contentType, unitLabel = getUnitLabel(unitName)) {
    const isLectureNotes = contentType === 'lecture-notes';
    const title = isLectureNotes ? `*Lecture Notes - ${unitName}` : '*Practice Questions/Tutorial';
    const item = document.createElement('li');
    item.className = 'file-item placeholder-item';
    item.dataset.status = 'not-uploaded';
    item.innerHTML = `
        <div class="file-item-row">
            <span class="file-icon">${Icons.file}</span>
            <div class="file-info">
                <h4 class="file-title" ${headingAttrs(title)}>${title}</h4>
                <p>${isLectureNotes
                    ? 'Placeholder for required lecture notes. Please upload content.'
                    : 'Placeholder for required practice questions. Please upload content.'}</p>
                <span class="status-text">Not Uploaded</span>
            </div>
            <div class="file-actions">
                <button type="button" class="action-button upload" onclick="openUploadModal('${unitName}', '${contentType}')">Upload<span class="visually-hidden"> ${isLectureNotes ? 'lecture notes' : 'practice questions or tutorial'}</span>${unitContext(unitLabel)}</button>
            </div>
        </div>
    `;
    return item;
}

/**
 * Helper function to find elements containing specific text
 * @param {string} selector - CSS selector for elements to search within
 * @param {string} text - Text to search for
 * @param {boolean} caseSensitive - Whether the search should be case sensitive
 * @returns {Array} - Array of matching elements
 */
function findElementsContainingText(selector, text, caseSensitive = false) {
    const elements = Array.from(document.querySelectorAll(selector));
    return elements.filter(element => {
        const elementText = element.textContent;
        if (caseSensitive) {
            return elementText.includes(text);
        } else {
            return elementText.toUpperCase().includes(text.toUpperCase());
        }
    });
}

/**
 * Focus and expand a specific unit on the documents page based on URL param
 * Supports /instructor/documents?courseId=...&unit=Unit%203
 */
function focusUnitFromURL() {
    try {
        const params = new URLSearchParams(window.location.search);
        const unitNameParam = params.get('unit');
        if (!unitNameParam) return;
        
        // Find the accordion item using data-unit-name attribute (internal name like "Unit 1")
        const accordionItem = document.querySelector(`.accordion-item[data-unit-name="${unitNameParam}"]`);
        if (!accordionItem) return;
        const header = accordionItem.querySelector('.accordion-header');
        const content = accordionItem.querySelector('.accordion-content');
        
        if (content && content.classList.contains('collapsed') && header) {
            header.click();
        }
        
        // Scroll into view
        accordionItem.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        console.warn('focusUnitFromURL error:', e);
    }
}

/**
 * Build the ordered list of units to render. The lectures array order is the
 * instructor-controlled display order saved by the API. Falls back to the
 * 1..totalUnits numbering only when a course has no lectures yet.
 * @param {Object} courseStructure - Course structure (may carry totalUnits)
 * @param {Array} lectures - The course's lectures/units
 * @returns {Array<{name: string, data: Object|null}>} Units in display order
 */
function getRenderableUnits(courseStructure, lectures) {
    if (Array.isArray(lectures) && lectures.length > 0) {
        return lectures
            .filter(lecture => lecture && lecture.name)
            .map(lecture => ({ name: lecture.name, data: lecture }));
    }

    const totalUnits = (courseStructure && courseStructure.totalUnits) || 0;
    const units = [];
    for (let i = 1; i <= totalUnits; i++) {
        units.push({ name: `Unit ${i}`, data: null });
    }
    return units;
}

/**
 * Read which units are open right now so a re-render can put them back.
 * Adding or deleting a unit reloads the whole course and rebuilds this list;
 * without this the instructor is dropped back on Unit 1 every time.
 * @returns {Set<string>} Internal unit names (e.g. "Unit 3") that are expanded
 */
function captureExpandedUnitNames() {
    const expanded = new Set();
    document.querySelectorAll('#dynamic-units-container .accordion-item[data-unit-name]')
        .forEach(item => {
            const content = item.querySelector('.accordion-content');
            if (content && !content.classList.contains('collapsed')) {
                expanded.add(item.getAttribute('data-unit-name'));
            }
        });
    return expanded;
}

/**
 * Scroll a unit into view by its internal name, if it is on the page.
 * @param {string} unitName - Internal unit name (e.g. "Unit 3")
 */
function scrollUnitIntoView(unitName) {
    if (!unitName) return;
    const item = document.querySelector(`.accordion-item[data-unit-name="${unitName}"]`);
    if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/**
 * Generate units dynamically from onboarding data
 * @param {Object} onboardingData - Onboarding data with course structure
 */
function generateUnitsFromOnboarding(onboardingData) {
    const container = document.getElementById('dynamic-units-container');
    if (!container) {
        console.error('Dynamic units container not found');
        return;
    }
    
    // Hide onboarding navigation item when courses exist
    const onboardingNavItem = document.getElementById('onboarding-nav-item');
    if (onboardingNavItem) {
        onboardingNavItem.style.display = 'none';
    }
    
    // Remember what the instructor had open (and where they were looking) before
    // this render throws the current list away.
    const previouslyExpanded = captureExpandedUnitNames();
    const isRerender = container.querySelector('.accordion-item[data-unit-name]') !== null;
    // Rebuilding the list destroys whatever control had focus. Remember it (the
    // ids are stable per unit) so the keyboard user is not dropped back at the
    // top of the page after reordering, adding, or deleting a unit.
    const focusedElement = document.activeElement;
    const focusId = window.pendingFocusId
        || (focusedElement && container.contains(focusedElement) ? focusedElement.id : null);
    window.pendingFocusId = null;
    const previousScrollY = window.scrollY;
    // Set by addNewUnit() so the unit that was just created is the one we open.
    const focusUnitName = window.pendingFocusUnitName || null;
    window.pendingFocusUnitName = null;
    
    // Clear existing content
    container.innerHTML = '';
    
    const { courseStructure, lectures } = onboardingData;

    // Render the units that actually exist rather than counting 1..totalUnits.
    // Deleting a unit leaves a gap in the numbering (e.g. "Unit 7" is gone while
    // "Unit 19" is still there), so a positional loop invents units that have no
    // record behind them - those can never be deleted, the API 404s on them - and
    // hides real units whose number is past the count.
    const unitList = getRenderableUnits(courseStructure, lectures);

    const expandedNames = new Set(previouslyExpanded);
    if (focusUnitName) {
        expandedNames.add(focusUnitName);
    }

    // The units are a list, so they are marked up as one.
    const unitListElement = document.createElement('ul');
    unitListElement.className = 'unit-list';
    container.appendChild(unitListElement);

    // Generate each unit. On a re-render (add/delete/rename) keep the units the
    // instructor already had open; only a first render falls back to "Unit 1".
    unitList.forEach((unit, index) => {
        const isExpanded = isRerender ? expandedNames.has(unit.name) : index === 0;
        const unitElement = createUnitElement(
            unit.name,
            unit.data,
            isExpanded,
            unitList.length > 1,
            index,
            unitList.length
        );
        unitListElement.appendChild(unitElement);
    });

    // Add "Add Unit" button at the end
    const addUnitContainer = document.createElement('div');
    addUnitContainer.className = 'add-unit-container';
    addUnitContainer.style.marginTop = '20px';
    addUnitContainer.style.textAlign = 'center';
    
    // Check if adding unit is in progress
    const isAdding = container.dataset.addingUnit === 'true';
    
    addUnitContainer.innerHTML = `
        <button id="add-unit-btn" class="btn-secondary" onclick="addNewUnit()" ${isAdding ? 'disabled' : ''}>
            <span class="btn-icon">${Icons.plus}</span>
            ${isAdding ? 'Adding Unit...' : 'Add New Unit'}
        </button>
    `;
    container.appendChild(addUnitContainer);
    
    // Reinitialize event listeners for the new units
    initializeUnitEventListeners();

    if (isRerender) {
        restoreUnitFocus(focusId, focusUnitName);
    }
    
    // Load existing data for the units (learning objectives, publish status, etc.)
    loadExistingUnitData(onboardingData);
    
    // Load assessment questions after units are generated
    setTimeout(() => {
        loadAssessmentQuestionsFromCourseData(onboardingData);
    }, 100);
    
    // Load documents from course structure
    setTimeout(() => {
        loadDocuments().then(() => {
            // After documents are loaded (which creates the accordion items), load thresholds
            setTimeout(() => {
                loadPassThresholds();
            }, 300);
            
            // Update published units summary
            updatePublishedSummary();
        });
    }, 100);
    
    // Also ensure buttons exist immediately (fallback)
    setTimeout(() => {
        ensureActionButtonsExist();
    }, 200); // Reduced timeout since buttons are already there

    setTimeout(() => {
        if (typeof loadFlashcardDecks === 'function') {
            loadFlashcardDecks();
        }
    }, 250);

    // Focus a specific unit if requested via URL (e.g., ?unit=Unit%203).
    // Only on the first render - the ?unit= param sticks around in the address
    // bar, and re-honouring it would drag the page back there after every add or
    // delete.
    if (!isRerender) {
        setTimeout(() => {
            focusUnitFromURL();
        }, 300);
    }

    // Keep the viewport where it was, or move it to the unit that was just added,
    // instead of snapping back to the top of the list.
    if (focusUnitName) {
        // Wait for the document/objective loads above so the new unit is at its
        // final position before scrolling to it.
        setTimeout(() => scrollUnitIntoView(focusUnitName), 400);
    } else if (isRerender) {
        window.requestAnimationFrame(() => window.scrollTo(window.scrollX, previousScrollY));
    }

    applyTASectionPermissions();
}

/**
 * Put keyboard focus back after the unit list has been rebuilt.
 * Tries the control that had focus, then (if it is now disabled or gone) a
 * sibling move button, then the unit's own expand/collapse control.
 * @param {string|null} focusId - Id of the control that had focus before the rebuild
 * @param {string|null} unitName - Unit to fall back to (e.g. one just added)
 */
function restoreUnitFocus(focusId, unitName) {
    const isUsable = element => element && !element.disabled && element.getClientRects().length > 0;
    let target = focusId ? document.getElementById(focusId) : null;

    if (target && !isUsable(target)) {
        const group = target.closest('.unit-order-controls');
        const sibling = group && Array.from(group.querySelectorAll('.unit-move-btn')).find(isUsable);
        target = sibling || target.closest('.accordion-item')?.querySelector('.accordion-trigger') || null;
    }
    if (!isUsable(target) && unitName) {
        target = document.querySelector(`.accordion-item[data-unit-name="${unitName}"] .accordion-trigger`);
    }
    if (isUsable(target)) {
        target.focus({ preventScroll: true });
    }
}

/**
 * Hide unit sub-sections a TA can't act on, so the UI doesn't offer actions
 * the server would reject (materials/questions are independently toggleable
 * now, unlike the old single canAccessCourses boolean that covered both).
 * No-ops for instructors/admins, and for a TA whose permissions haven't
 * loaded yet - instructor-ta.js re-calls this once they have (see
 * updateTANavigationBasedOnPermissions), and this function itself re-runs
 * on every unit re-render, so both orderings end up correct.
 */
function applyTASectionPermissions() {
    if (typeof isTA !== 'function' || !isTA()) return;
    const courseId = typeof getSelectedCourseIdForTA === 'function' ? getSelectedCourseIdForTA() : null;
    const permissions = courseId && window.taPermissions ? window.taPermissions[courseId] : null;
    if (!permissions) return;

    const sectionSelectorsByPermission = {
        materials: ['.course-materials-section', '.learning-objectives-section'],
        questions: ['.assessment-questions-section']
    };

    Object.entries(sectionSelectorsByPermission).forEach(([key, selectors]) => {
        const allowed = window.permissionIsGranted(permissions, key);
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(section => {
                section.style.display = allowed ? '' : 'none';
            });
        });
    });
}
window.applyTASectionPermissions = applyTASectionPermissions;

/**
 * Build the label shown for a unit, honouring the per-unit "show number" choice.
 *
 * The number is the unit's current position among the units that still exist,
 * not a digit parsed out of its internal name - deleting or reordering a unit
 * changes everyone else's position, so a name-derived number would go stale
 * (e.g. "Unit 2" deleted from Unit 1/2/3 would otherwise leave "1." and "3.").
 * @param {string} unitName - Internal name of the unit (e.g., "Unit 1"), used as the fallback label
 * @param {string} displayName - Custom title, or '' / null / undefined if none is set
 * @param {boolean} showUnitNumber - Whether to prefix the title with "<N>. "
 * @param {number} unitPosition - 1-based position among the currently existing units
 * @returns {string}
 */
function formatUnitLabel(unitName, displayName, showUnitNumber, unitPosition) {
    if (!displayName) return unitName;
    if (showUnitNumber === false) return displayName;
    return `${unitPosition}. ${displayName}`;
}

/**
 * Create a unit element with all its sections
 * @param {string} unitName - Name of the unit (e.g., "Unit 1")
 * @param {Object} unitData - Existing unit data from database
 * @param {boolean} isExpanded - Whether the unit should be expanded by default
 * @param {boolean} canDelete - Whether deleting this unit would leave another unit
 * @param {number} unitIndex - Zero-based position in the course
 * @param {number} unitCount - Number of units in the course
 * @returns {HTMLElement} The unit element
 */
function createUnitElement(unitName, unitData, isExpanded = false, canDelete = true, unitIndex = 0, unitCount = 1) {
    // The units are a list (see generateUnitsFromOnboarding), so each is a list item.
    const unitDiv = document.createElement('li');
    unitDiv.className = 'accordion-item';
    unitDiv.setAttribute('data-unit-name', unitName);
    unitDiv.setAttribute('data-unit-position', unitIndex + 1);

    const unitId = unitName.toLowerCase().replace(/\s+/g, '-');

    // Use displayName if available, otherwise just show the unit name
    const displayName = unitData?.displayName || '';
    const showUnitNumber = unitData?.showUnitNumber !== false;
    const formattedName = formatUnitLabel(unitName, displayName, showUnitNumber, unitIndex + 1);

    // Every unit repeats the same controls. `ctx()` finishes each control's
    // name with this unit's title, as visually hidden text inside the control.
    const ctx = lead => unitContext(formattedName, lead);

    // One of the four collapsible sections inside a unit. The heading holds a
    // real button (named by the heading text, state in aria-expanded); the
    // caret beside it is decoration.
    const sectionHeader = (key, title) => `
                <div class="section-header">
                    <h3 ${headingAttrs(title)}><button type="button" class="toggle-section" id="section-${key}-${unitId}" aria-expanded="true" aria-controls="section-${key}-content-${unitId}">${title}${ctx(': ')}</button></h3>
                    <span class="toggle-section-icon" aria-hidden="true">▼</span>
                </div>`;

    unitDiv.innerHTML = `
        <div class="accordion-header">
            <div class="unit-name-container">
                <h2 class="unit-heading" ${headingAttrs(formattedName, `unit-heading-${unitId}`)}>
                    <button type="button" class="accordion-trigger" id="unit-trigger-${unitId}" aria-expanded="${isExpanded}" aria-controls="unit-content-${unitId}">
                        <span class="folder-name">${formattedName}</span>
                    </button>
                </h2>
                <button type="button" class="unit-rename-btn" id="unit-rename-${unitId}" onclick="event.stopPropagation(); openRenameUnitInput('${unitName}')" title="Rename unit">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path></svg>
                    <span class="visually-hidden">Rename unit${ctx(' ')}</span>
                </button>
                <div class="unit-rename-edit" style="display: none;" data-last-saved-name="${displayName}" data-last-saved-show-number="${showUnitNumber}">
                    <label class="unit-rename-label" for="unit-rename-input-${unitId}">Unit title</label>
                    <input type="text" class="unit-rename-input" id="unit-rename-input-${unitId}" placeholder="Enter unit title..." value="${displayName}" data-unit-name="${unitName}">
                    <label class="unit-show-number-label" onclick="event.stopPropagation()">
                        <input type="checkbox" class="unit-show-number-input" data-unit-name="${unitName}" ${showUnitNumber ? 'checked' : ''}>
                        Show unit number
                    </label>
                    <button type="button" class="unit-save-btn" onclick="event.stopPropagation(); saveUnitDisplayName('${unitName}')" title="Save">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>
                        <span class="visually-hidden">Save unit title</span>
                    </button>
                    <button type="button" class="unit-cancel-btn" onclick="event.stopPropagation(); cancelRenameUnit('${unitName}')" title="Cancel">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
                        <span class="visually-hidden">Cancel renaming unit</span>
                    </button>
                </div>
            </div>
            <div class="header-actions">
                <div class="unit-order-controls">
                    <button class="unit-move-btn" type="button" id="unit-move-up-${unitId}"
                            onclick="event.stopPropagation(); moveUnit('${unitName}', 'up')"
                            title="Move up"
                            ${unitIndex === 0 ? 'disabled' : ''}><span aria-hidden="true">↑</span><span class="visually-hidden">Move${ctx(' ')} up</span></button>
                    <button class="unit-move-btn" type="button" id="unit-move-down-${unitId}"
                            onclick="event.stopPropagation(); moveUnit('${unitName}', 'down')"
                            title="Move down"
                            ${unitIndex === unitCount - 1 ? 'disabled' : ''}><span aria-hidden="true">↓</span><span class="visually-hidden">Move${ctx(' ')} down</span></button>
                </div>
                <div class="publish-toggle">
                    <label class="toggle-switch">
                        <input type="checkbox" id="publish-${unitId}" onchange="togglePublish('${unitName}', this.checked)">
                        <span class="toggle-slider"></span>
                        <span class="visually-hidden">Published:${ctx(' ')}</span>
                    </label>
                    <!-- The same word as the label above, shown beside the switch. Hidden
                         from assistive technology so it is not read a second time. -->
                    <span class="toggle-label" aria-hidden="true">Published</span>
                </div>

                <button type="button" class="delete-unit-btn" id="unit-delete-${unitId}" onclick="openDeleteUnitModal('${unitName}')"
                        title="${canDelete ? 'Delete Unit' : 'A course must have at least one unit'}"
                        ${canDelete ? '' : 'disabled'}
                        style="background: none; border: none; cursor: ${canDelete ? 'pointer' : 'not-allowed'}; display: inline-flex; margin-right: 10px; color: ${canDelete ? '#dc3545' : '#6b7280'};">${Icons.trash}<span class="visually-hidden">${canDelete ? `Delete unit${ctx(' ')}` : `Cannot delete${ctx(' ')}: a course must have at least one unit`}</span></button>

                <span class="accordion-toggle" aria-hidden="true">${isExpanded ? '▼' : '▶'}</span>
            </div>
        </div>
        <div class="accordion-content ${isExpanded ? '' : 'collapsed'}" id="unit-content-${unitId}">
            <!-- Learning Objectives Section -->
            <div class="unit-section learning-objectives-section">
                ${sectionHeader('objectives', 'Learning Objectives')}
                <div class="section-content" id="section-objectives-content-${unitId}">
                    <p style="margin-bottom: 10px; color: #666; font-size: 0.9em;">Please provide 3 - 8 learning objectives that are covered by this unit</p>
                    <ol class="objectives-list" id="objectives-list-${unitId}">
                        <!-- Objectives will be added here -->
                    </ol>
                    <div class="objective-input-container">
                        <label class="objective-input-label" for="objective-input-${unitId}">New learning objective${ctx()}</label>
                        <input type="text" id="objective-input-${unitId}" class="objective-input" placeholder="Enter learning objective..." onkeydown="if (event.key === 'Enter') { event.preventDefault(); addObjectiveFromInput('${unitName}'); }">
                        <button type="button" class="add-objective-btn-inline" id="add-objective-${unitId}" onclick="addObjectiveFromInput('${unitName}')"><span aria-hidden="true">+</span> Add objective${ctx(' to ')}</button>
                    </div>
                </div>
            </div>
            
            <!-- Course Materials Section -->
            <div class="unit-section course-materials-section">
                ${sectionHeader('materials', 'Course Materials')}
                <div class="section-content" id="section-materials-content-${unitId}">
                    <div class="content-type-header">
                        <p><strong>Required Materials:</strong> *Lecture Notes and *Practice Questions/Tutorial are mandatory</p>
                    </div>
                    <ul class="materials-list">
                        ${createPlaceholderItem(unitName, 'lecture-notes', formattedName).outerHTML}
                        ${createPlaceholderItem(unitName, 'practice-quiz', formattedName).outerHTML}
                    </ul>
                    <!-- Action buttons will be added dynamically by loadDocuments() -->
                    <!-- Expected order: Documents → Placeholders → Cleanup → Action Buttons -->
                    <!-- This ensures proper positioning below uploaded files -->
                </div>
            </div>

            <!-- Shared Flashcards Section -->
            <div class="unit-section flashcards-section" data-flashcard-unit="${unitName}">
                ${sectionHeader('flashcards', 'Student Flashcards')}
                <div class="section-content" id="section-flashcards-content-${unitId}">
                    <div class="flashcard-intro">
                        <div>
                            <h4 class="flashcard-intro-title" ${headingAttrs('Instructor-curated study deck')}>Instructor-curated study deck</h4>
                            <p>Generate a draft from this unit's uploaded materials, review it, then publish it to students.</p>
                        </div>
                        <span class="flashcard-status-badge" id="flashcard-status-${unitId}">Not generated</span>
                    </div>
                    <div class="flashcard-generation-controls">
                        <label for="flashcard-count-${unitId}">Cards${ctx()}</label>
                        <select id="flashcard-count-${unitId}">
                            <option value="5">5</option>
                            <option value="10" selected>10</option>
                            <option value="15">15</option>
                            <option value="20">20</option>
                        </select>
                        <label class="flashcard-chemistry-toggle" for="flashcard-chemistry-${unitId}" title="Ask for chemical formulas as typeset math and molecules as drawn 2D structures. Turn this off for units without chemistry.">
                            <input type="checkbox" id="flashcard-chemistry-${unitId}" checked>
                            <span>Chemistry notation${ctx()}</span>
                        </label>
                        <button type="button" class="flashcard-generate-btn" id="flashcard-generate-${unitId}" onclick="generateFlashcardDraft('${unitName}', this)">
                            <span aria-hidden="true">${Icons.wand}</span> Generate Draft${ctx()}
                        </button>
                    </div>
                    <p class="flashcard-section-message" id="flashcard-message-${unitId}">Upload course materials to generate a shared deck.</p>
                    <div class="flashcard-draft-editor" id="flashcard-editor-${unitId}" style="display: none;"></div>
                </div>
            </div>
            
            <!-- Assessment Questions Section -->
            <div class="unit-section assessment-questions-section">
                ${sectionHeader('questions', 'Assessment Questions')}
                <div class="section-content" id="section-questions-content-${unitId}">
                    <div class="assessment-info">
                        <p><strong>Assessment Settings:</strong> Assessment questions help BIOCBOT to determine whether to be in protégé or tutor mode. We recommend creating at least 3 questions.</p>
                    </div>
                    
                    <!-- Pass Threshold Setting -->
                    <div class="threshold-setting">
                        <label for="pass-threshold-${unitId}">Number of correct answers required for BIOCBOT to be in protégé mode${ctx()}:</label>
                        <input type="number" id="pass-threshold-${unitId}" min="0" max="10" value="0" class="threshold-input">
                        <span class="threshold-help">out of total questions</span>
                    </div>
                    
                    <!-- Questions List -->
                    <div class="questions-list" id="assessment-questions-${unitId}">
                        <!-- Assessment questions will be displayed here -->
                        <div class="no-questions-message">
                            <p>No assessment questions created yet. Click "Add Question" to get started.</p>
                        </div>
                    </div>
                    
                    <!-- Action Buttons -->
                    <div class="assessment-actions">
                        <button type="button" class="add-question-btn" id="add-question-${unitId}" onclick="openQuestionModal('${unitName}')">
                            <span class="btn-icon">${Icons.plus}</span>
                            Add Question${ctx(' to ')}
                        </button>
                        <button type="button" class="auto-link-btn" id="auto-link-${unitId}" onclick="openAutoLinkConfirmationModal('${unitName}', this)">
                            <span class="btn-icon">${Icons.wand}</span>
                            Auto-link Questions${ctx()}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    return unitDiv;
}

/**
 * Load existing data for the generated units
 * @param {Object} onboardingData - Onboarding data with existing unit information
 */
function loadExistingUnitData(onboardingData) {
    if (!onboardingData.lectures) return;
    
    onboardingData.lectures.forEach(unit => {
        const unitId = unit.name.toLowerCase().replace(/\s+/g, '-');
        
        // Load learning objectives
        if (unit.learningObjectives && unit.learningObjectives.length > 0) {
            const objectivesList = document.getElementById(`objectives-list-${unitId}`);
            if (objectivesList) {
                objectivesList.innerHTML = '';
                unit.learningObjectives.forEach(objective => {
                    objectivesList.appendChild(createObjectiveItem(objective));
                });
            } else {
                console.error(`Could not find objectives list element with ID: objectives-list-${unitId}`);
            }
        }
        
        // Load pass threshold
        const thresholdInput = document.getElementById(`pass-threshold-${unitId}`);
        if (thresholdInput) {
            if (unit.passThreshold) {
                thresholdInput.value = unit.passThreshold;
            } else {
                // If no threshold set, default to 0 but don't save it yet
                thresholdInput.value = 0;
            }
        }
        
        // Load assessment questions
        if (unit.assessmentQuestions && unit.assessmentQuestions.length > 0) {
            // Store questions in the local assessmentQuestions object
            if (!assessmentQuestions[unit.name]) {
                assessmentQuestions[unit.name] = [];
            }
            
            // Convert database questions to local format
            unit.assessmentQuestions.forEach(dbQuestion => {
                const localQuestion = {
                    id: dbQuestion.questionId,
                    questionId: dbQuestion.questionId,
                    type: dbQuestion.questionType,
                    question: dbQuestion.question,
                    answer: dbQuestion.correctAnswer,
                    options: dbQuestion.options || {},
                    learningObjective: dbQuestion.learningObjective || ''
                };
                
                assessmentQuestions[unit.name].push(localQuestion);
            });
            
            // Update the display for this unit
            updateQuestionsDisplay(unit.name);
        }
        
        // Load publish status
        if (unit.isPublished !== undefined) {
            const publishToggle = document.getElementById(`publish-${unitId}`);
            if (publishToggle) {
                publishToggle.checked = unit.isPublished;
            }
        }
        
        // Load documents from course structure
        if (unit.documents && unit.documents.length > 0) {
            // Find the course materials section for this unit
            const unitElement = document.querySelector(`[data-unit-name="${unit.name}"]`);
            if (unitElement) {
                const courseMaterialsSection = unitElement.querySelector('.course-materials-section .section-content');
                if (courseMaterialsSection) {
                    // Clear existing placeholder content
                    const placeholders = courseMaterialsSection.querySelectorAll('.file-item');
                    
                    placeholders.forEach(placeholder => {
                        placeholder.remove();
                    });
                    
                    // Add each document
                    const materialsList = getMaterialsList(courseMaterialsSection);
                    unit.documents.forEach(doc => {
                        const documentItem = createDocumentItem(doc);
                        materialsList.appendChild(documentItem);
                    });
                }
            }
        }
    });
}

/**
 * Initialize event listeners for dynamically generated units
 */
function initializeUnitEventListeners() {
    // Setup accordion toggling. The expand/collapse control is the button in
    // the unit's heading; clicking the empty part of the header bar does the
    // same thing as a convenience for mouse users. The bar itself is not a
    // control: it holds the rename, reorder, publish and delete controls, and a
    // control cannot contain other controls.
    const accordionHeaders = document.querySelectorAll('.accordion-header');
    accordionHeaders.forEach(header => {
        const toggleAccordion = (e) => {
            const trigger = header.querySelector('.accordion-trigger');
            const onTrigger = trigger && trigger.contains(e.target);
            // Keep the unit's own controls independent from the accordion.
            if (!onTrigger && e.target.closest('button, input, label, select, textarea, a')) {
                return;
            }
            
            const accordionItem = header.parentElement;
            const content = accordionItem.querySelector('.accordion-content');
            const toggle = header.querySelector('.accordion-toggle');
            
            if (content.classList.contains('collapsed')) {
                content.classList.remove('collapsed');
                toggle.textContent = '▼';
                if (trigger) trigger.setAttribute('aria-expanded', 'true');
            } else {
                content.classList.add('collapsed');
                toggle.textContent = '▶';
                if (trigger) trigger.setAttribute('aria-expanded', 'false');
            }
        };

        // Enter and Space on the trigger arrive here as clicks.
        header.addEventListener('click', toggleAccordion);
    });
    
    // Setup section toggling
    const sectionHeaders = document.querySelectorAll('.section-header');
    sectionHeaders.forEach(header => {
        header.addEventListener('click', (e) => {
            toggleSection(header, e);
        });
    });
    
    // Setup threshold input listeners
    setupThresholdInputListeners();
}

/**
 * Add required placeholder items for lecture notes and practice questions
 * @param {HTMLElement} container - The container to add placeholders to
 * @param {string} unitName - The name of the unit (e.g., 'Unit 1')
 */
function addRequiredPlaceholders(container, unitName) {
    // Check if lecture notes and practice questions already exist as ACTUAL uploaded content
    let hasLectureNotes = false;
    let hasPracticeQuestions = false;
    
    container.querySelectorAll('.file-item').forEach(item => {
        const title = item.querySelector('.file-title, h3');
        
        if (title) {
            const titleText = title.textContent;
            const isPlaceholder = item.classList.contains('placeholder-item');
            const documentType = item.dataset.documentType || '';
            
            // Check for lecture notes - look for both document type and title patterns
            const isLectureNotes = documentType === 'lecture_notes' || 
                                  documentType === 'lecture-notes' ||
                                  titleText.includes('lecture-notes') ||
                                  (titleText.includes('Lecture Notes') && !isPlaceholder);
            
            // Check for practice questions - look for both document type and title patterns  
            const isPracticeQuestions = documentType === 'practice_q_tutorials' || 
                                      documentType === 'practice-quiz' ||
                                      titleText.includes('practice-quiz') ||
                                      titleText.includes('practice_quiz') ||
                                      ((titleText.includes('Practice Questions') || titleText.includes('Practice Questions/Tutorial')) && !isPlaceholder);
            
            if (isLectureNotes) {
                hasLectureNotes = true;
            }
            
            if (isPracticeQuestions) {
                hasPracticeQuestions = true;
            }
        }
    });
    
    // Remove any existing placeholders first to ensure clean state
    removeExistingPlaceholders(container);
    
    const materialsList = getMaterialsList(container);

    // Add lecture notes placeholder if it doesn't exist
    if (!hasLectureNotes) {
        materialsList.appendChild(createPlaceholderItem(unitName, 'lecture-notes'));
    }
    
    // Add practice questions placeholder if it doesn't exist
    if (!hasPracticeQuestions) {
        materialsList.appendChild(createPlaceholderItem(unitName, 'practice-quiz'));
    }
}

/**
 * Add action buttons only if they don't already exist (prevents duplicates)
 * @param {HTMLElement} container - The container to add buttons to
 * @param {string} unitName - The name of the unit (e.g., 'Unit 1')
 */
function addActionButtonsIfMissing(container, unitName) {
    // Check if the action buttons already exist
    const hasAddContentSection = container.querySelector('.add-content-section');

    // Keep every material category repeatable. Required means at least one
    // document of that type, not that the category is a single upload slot.
    if (!hasAddContentSection) {
        const addContentSection = document.createElement('div');
        addContentSection.className = 'add-content-section';
        const unitId = unitName.toLowerCase().replace(/\s+/g, '-');
        const ctx = unitContext(getUnitLabel(unitName), ' to ');
        addContentSection.innerHTML = `
            <button type="button" class="add-content-btn lecture-notes" id="add-lecture-notes-${unitId}" onclick="openUploadModal('${unitName}', 'lecture-notes')">
                <span class="btn-icon">${Icons.plus}</span>
                Add Lecture Notes${ctx}
            </button>
            <button type="button" class="add-content-btn practice-quiz" id="add-practice-quiz-${unitId}" onclick="openUploadModal('${unitName}', 'practice-quiz')">
                <span class="btn-icon">${Icons.plus}</span>
                Add Practice Questions/Tutorial${ctx}
            </button>
            <button type="button" class="add-content-btn additional-material" id="add-additional-material-${unitId}" onclick="openUploadModal('${unitName}', 'additional')">
                <span class="btn-icon">${Icons.plus}</span>
                Add Additional Material${ctx}
            </button>
        `;
        container.appendChild(addContentSection);
    }
}

/**
 * Ensure action buttons exist for all units (fallback function)
 */
function ensureActionButtonsExist() {
    const accordionItems = document.querySelectorAll('.accordion-item');
    accordionItems.forEach(item => {
        // Use data-unit-name attribute for internal name (e.g., "Unit 1")
        const unitName = item.getAttribute('data-unit-name');
        if (!unitName) return;
        
        const courseMaterialsSection = item.querySelector('.course-materials-section .section-content');
        
        if (courseMaterialsSection) {
            // Check if action buttons already exist
            const hasActionButtons = courseMaterialsSection.querySelector('.add-content-section');

            if (!hasActionButtons) {
                addActionButtonsIfMissing(courseMaterialsSection, unitName);
            }
        }
    });
}

/**
 * Open the inline rename input for a unit
 * @param {string} unitName - Internal name of the unit (e.g., "Unit 1")
 */
function openRenameUnitInput(unitName) {
    const accordionItem = document.querySelector(`.accordion-item[data-unit-name="${unitName}"]`);
    if (!accordionItem) return;
    
    // Hide the heading as a whole: hiding only the title text would leave an
    // empty, nameless expand/collapse button behind it.
    const folderName = accordionItem.querySelector('.unit-heading');
    const renameBtn = accordionItem.querySelector('.unit-rename-btn');
    const editContainer = accordionItem.querySelector('.unit-rename-edit');
    const input = accordionItem.querySelector('.unit-rename-input');
    const checkbox = accordionItem.querySelector('.unit-show-number-input');

    // Hide the folder name and pencil button, show the edit container
    if (folderName) folderName.style.display = 'none';
    if (renameBtn) renameBtn.style.display = 'none';
    if (editContainer) editContainer.style.display = 'flex';

    // Focus and select input
    if (input) {
        input.focus();
        input.select();
    }

    // Enter saves, Escape cancels, from either the text input or the
    // "Show unit number" checkbox - the instructor may tab/click straight to
    // the checkbox without touching the input first.
    const handleEditKeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveUnitDisplayName(unitName);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRenameUnit(unitName);
        }
    };
    if (input) input.onkeydown = handleEditKeydown;
    if (checkbox) checkbox.onkeydown = handleEditKeydown;
}

/**
 * Save the unit display name
 * @param {string} unitName - Internal name of the unit (e.g., "Unit 1")
 */
async function saveUnitDisplayName(unitName) {
    const accordionItem = document.querySelector(`.accordion-item[data-unit-name="${unitName}"]`);
    if (!accordionItem) return;

    const input = accordionItem.querySelector('.unit-rename-input');
    const displayName = input ? input.value.trim() : '';
    const checkbox = accordionItem.querySelector('.unit-show-number-input');
    const showUnitNumber = checkbox ? checkbox.checked : true;

    try {
        const courseId = await getCurrentCourseId();
        const instructorId = getCurrentInstructorId();

        const response = await fetch(`/api/courses/${courseId}/units/${encodeURIComponent(unitName)}/rename`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ displayName, instructorId, showUnitNumber })
        });

        if (!response.ok) {
            throw new Error('Failed to rename unit');
        }

        const result = await response.json();

        // Update the folder name display using the values that were just saved
        const folderName = accordionItem.querySelector('.folder-name');
        const unitPosition = Number(accordionItem.dataset.unitPosition) || 1;
        const formattedName = formatUnitLabel(unitName, displayName, showUnitNumber, unitPosition);

        if (folderName) {
            folderName.textContent = formattedName;
        }
        // The unit's title is also part of the (visually hidden) name of every
        // control in the unit; keep those in step with what is now on screen.
        accordionItem.querySelectorAll('.unit-name-ref').forEach(reference => {
            reference.textContent = formattedName;
        });

        // Remember this as the last-saved state so a future Cancel restores to it
        const editContainer = accordionItem.querySelector('.unit-rename-edit');
        if (editContainer) {
            editContainer.dataset.lastSavedName = displayName;
            editContainer.dataset.lastSavedShowNumber = String(showUnitNumber);
        }

        showNotification(result.message || 'Unit renamed successfully', 'success');
        
    } catch (error) {
        console.error('Error renaming unit:', error);
        showNotification('Failed to rename unit: ' + error.message, 'error');
    }
    
    // Hide edit mode and restore normal display
    cancelRenameUnit(unitName);
}

/**
 * Cancel the rename operation and restore normal display
 * @param {string} unitName - Internal name of the unit (e.g., "Unit 1")
 */
function cancelRenameUnit(unitName) {
    const accordionItem = document.querySelector(`.accordion-item[data-unit-name="${unitName}"]`);
    if (!accordionItem) return;

    const folderName = accordionItem.querySelector('.unit-heading');
    const renameBtn = accordionItem.querySelector('.unit-rename-btn');
    const editContainer = accordionItem.querySelector('.unit-rename-edit');
    const input = accordionItem.querySelector('.unit-rename-input');
    const checkbox = accordionItem.querySelector('.unit-show-number-input');
    // Leaving edit mode hides whatever had focus (the input, Save, or Cancel).
    const hadFocus = editContainer && editContainer.contains(document.activeElement);

    // Reset the input and checkbox back to the last-saved state, discarding
    // whatever the instructor typed/toggled without saving.
    if (editContainer) {
        if (input) input.value = editContainer.dataset.lastSavedName || '';
        if (checkbox) checkbox.checked = editContainer.dataset.lastSavedShowNumber !== 'false';
    }

    // Show the folder name and pencil button, hide the edit container
    if (folderName) folderName.style.display = '';
    if (renameBtn) renameBtn.style.display = '';
    if (editContainer) editContainer.style.display = 'none';
    if (hadFocus && renameBtn) renameBtn.focus();
}

// Make rename functions globally available
window.openRenameUnitInput = openRenameUnitInput;

window.saveUnitDisplayName = saveUnitDisplayName;

window.cancelRenameUnit = cancelRenameUnit;

window.getUnitLabel = getUnitLabel;
window.unitContext = unitContext;
