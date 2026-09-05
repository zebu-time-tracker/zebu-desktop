import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzzyFilter, fuzzyScore } from '../src/fuzzy.ts';

const projects = ['WEB: Website (Acme)', 'PMD: Placemat & Menu Design (Bob\'s Waffles)', 'Acme Holdings Europe internal', 'Design retainer (Globex)'];

test('word prefixes beat substrings beat subsequences', () => {
    // both are word-prefix hits; the shorter haystack wins the tie
    assert.deepEqual(fuzzyFilter(projects, 'des', (p) => p).slice(0, 2), ['Design retainer (Globex)', 'PMD: Placemat & Menu Design (Bob\'s Waffles)']);
    assert.equal(fuzzyFilter(projects, 'pmd', (p) => p)[0], 'PMD: Placemat & Menu Design (Bob\'s Waffles)');
    assert.equal(fuzzyFilter(projects, 'acme', (p) => p)[0], 'WEB: Website (Acme)'); // shorter haystack wins the tie
});

test('every query word must match, accents and case are ignored, empty query keeps everything', () => {
    assert.equal(fuzzyScore('menu waffles', 'PMD: Placemat & Menu Design (Bob\'s Waffles)') !== null, true);
    assert.equal(fuzzyScore('menu globex', 'PMD: Placemat & Menu Design (Bob\'s Waffles)'), null);
    assert.equal(fuzzyScore('resume', 'Résumé site') !== null, true);
    assert.equal(fuzzyFilter(projects, '   ', (p) => p).length, projects.length);
});
