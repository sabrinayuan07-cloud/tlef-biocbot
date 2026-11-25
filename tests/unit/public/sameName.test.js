/**
 * Position suffixes for list items that share a name
 * (public/common/scripts/same-name.js).
 */
const SameName = require('../../../public/common/scripts/same-name.js');

const units = [
    { id: 'Unit 1', title: 'Cell Structure' },
    { id: 'Unit 2', title: 'Cell Structure' },
    { id: 'Unit 3', title: '3. Metabolism' },
];

describe('getOrdinal', () => {
    test('two same-named items get 1 of 2 and 2 of 2 in list order', () => {
        expect(SameName.getOrdinal(units, 'Unit 1')).toBe('1 of 2');
        expect(SameName.getOrdinal(units, 'Unit 2')).toBe('2 of 2');
    });

    test('list order decides the numbering, not the id', () => {
        const reordered = [units[1], units[0], units[2]];
        expect(SameName.getOrdinal(reordered, 'Unit 2')).toBe('1 of 2');
        expect(SameName.getOrdinal(reordered, 'Unit 1')).toBe('2 of 2');
    });

    test('a unique name gets no suffix', () => {
        expect(SameName.getOrdinal(units, 'Unit 3')).toBe('');
    });

    test('names differing only by surrounding spaces count as the same name', () => {
        const items = [{ id: 'a', title: 'lecture.pdf' }, { id: 'b', title: '  lecture.pdf ' }];
        expect(SameName.getOrdinal(items, 'a')).toBe('1 of 2');
        expect(SameName.getOrdinal(items, 'b')).toBe('2 of 2');
    });

    test('names differing only by case stay unique', () => {
        const items = [{ id: 'a', title: 'Week 1' }, { id: 'b', title: 'week 1' }];
        expect(SameName.getOrdinal(items, 'a')).toBe('');
        expect(SameName.getOrdinal(items, 'b')).toBe('');
    });

    test('three of a kind are numbered out of three', () => {
        const items = ['a', 'b', 'c'].map((id) => ({ id, title: 'Explain osmosis' }));
        expect(items.map((item) => SameName.getOrdinal(items, item.id))).toEqual(['1 of 3', '2 of 3', '3 of 3']);
    });

    test('an unknown id returns ""', () => {
        expect(SameName.getOrdinal(units, 'Unit 9')).toBe('');
        expect(SameName.getOrdinal([], 'Unit 1')).toBe('');
    });
});

describe('formats', () => {
    test('display name', () => {
        expect(SameName.getDisplayName(units, 'Unit 1')).toBe('Cell Structure (1 of 2)');
        expect(SameName.getDisplayName(units, 'Unit 3')).toBe('3. Metabolism');
    });

    test('quoted name keeps the suffix outside the quotes', () => {
        expect(SameName.getQuotedName(units, 'Unit 2')).toBe('"Cell Structure" (2 of 2)');
        expect(SameName.getQuotedName(units, 'Unit 3')).toBe('"3. Metabolism"');
    });

    test('button name, for text already inside parentheses', () => {
        expect(SameName.getButtonName(units, 'Unit 1')).toBe('Cell Structure - 1 of 2');
        expect(SameName.getButtonName(units, 'Unit 3')).toBe('3. Metabolism');
    });

    test('quoted button name, for free text the user typed', () => {
        expect(SameName.getQuotedButtonName(units, 'Unit 2')).toBe('"Cell Structure" - 2 of 2');
        expect(SameName.getQuotedButtonName(units, 'Unit 3')).toBe('"3. Metabolism"');
    });

    test('every format returns the title alone for an unknown id', () => {
        expect(SameName.getDisplayName(units, 'nope')).toBe('');
        expect(SameName.getButtonName(units, 'nope')).toBe('');
    });
});
