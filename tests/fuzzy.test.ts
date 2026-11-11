import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzzyFilter, fuzzyMatch, fuzzyScore, segments } from '../src/fuzzy.ts';

// what the project picker searches: "CODE Name Client", most recently tracked first
const projects = [
    'WEB Website redesign Acme Holdings',
    "PMD Placemat & Menu Design Bob's Waffles",
    'Design retainer Globex',
    'APP Mobile app Acme Holdings',
    'DOCS Developer documentation Initech',
    "WLR Wine list redesign Bob's Waffles",
    'Résumé site Dana Søndergaard',
    'Acme anniversary book Globex',
];
const find = (query: string) => fuzzyFilter(projects, query, (p) => p);
const marked = (query: string, text: string) =>
    segments(query, text)
        .map((s) => (s.hit ? `[${s.text}]` : s.text))
        .join('');

test('a whole word beats the start of a word, which beats a match inside one', () => {
    // "web" is the code of one project and only the start of "Website" in it, never a whole word elsewhere
    assert.equal(find('web')[0], 'WEB Website redesign Acme Holdings');
    // "des" starts Design twice and sits inside "redesign" twice
    assert.deepEqual(find('des'), [
        'Design retainer Globex',
        "PMD Placemat & Menu Design Bob's Waffles",
        'WEB Website redesign Acme Holdings',
        "WLR Wine list redesign Bob's Waffles",
    ]);
    assert.ok(fuzzyScore('site', 'Résumé site Dana')! > fuzzyScore('site', 'WEB Website redesign')!);
});

test('between equal matches the earlier one wins: a project named for the word, before a client', () => {
    assert.equal(find('acme')[0], 'Acme anniversary book Globex');
    // the same word in the same place: the order the list came in, which is most recent first
    assert.deepEqual(find('acme').slice(1), ['WEB Website redesign Acme Holdings', 'APP Mobile app Acme Holdings']);
});

test('initials of words in a row find a project', () => {
    // Website Redesign in a row; Wine (list) Redesign skips a word, so it is an abbreviation and ranks below
    assert.deepEqual(find('wr'), ['WEB Website redesign Acme Holdings', "WLR Wine list redesign Bob's Waffles"]);
    assert.deepEqual(find('wlr'), ["WLR Wine list redesign Bob's Waffles"]); // its code, a whole word
    assert.deepEqual(find('ah'), ['WEB Website redesign Acme Holdings', 'APP Mobile app Acme Holdings']);
    // initials rank above a match inside a word
    assert.ok(fuzzyScore('ma', 'APP Mobile app')! > fuzzyScore('ma', 'Placemat')!);
});

test('an abbreviation matches: letters in order, a new word entered only at its first letter', () => {
    assert.deepEqual(find('dsgn'), ['Design retainer Globex', "PMD Placemat & Menu Design Bob's Waffles"]);
    assert.deepEqual(find('webre'), ['WEB Website redesign Acme Holdings']);
    assert.deepEqual(find('plmenu'), ["PMD Placemat & Menu Design Bob's Waffles"]);
    assert.notEqual(fuzzyScore('rtnr', 'Design retainer'), null);
});

test('one word abbreviated beats letters gathered from several', () => {
    // "dsn" is De-S-ig-N; it is also Dana Søndergaard's D, S and n
    assert.deepEqual(find('dsn'), ['Design retainer Globex', "PMD Placemat & Menu Design Bob's Waffles", 'Résumé site Dana Søndergaard']);
});

test('letters scattered through the middle of unrelated words are not a match', () => {
    // these all used to be listed for "dsn": D…S…N somewhere in the row
    assert.equal(fuzzyScore('dsn', 'WEB Website redesign Acme Holdings'), null);
    assert.equal(fuzzyScore('dsn', 'DOCS Developer documentation Initech'), null);
    assert.equal(fuzzyScore('acme', "PMD Placemat & Menu Design Bob's Waffles"), null);
    assert.equal(find('dsn')[0], 'Design retainer Globex');
    assert.deepEqual(find('acme mob'), ['APP Mobile app Acme Holdings']);
});

test('every query word must match; accents, case and stroked letters are ignored; an empty query keeps everything', () => {
    assert.notEqual(fuzzyScore('menu waffles', "PMD Placemat & Menu Design Bob's Waffles"), null);
    assert.equal(fuzzyScore('menu globex', "PMD Placemat & Menu Design Bob's Waffles"), null);
    assert.notEqual(fuzzyScore('resume', 'Résumé site'), null);
    assert.notEqual(fuzzyScore('RÉSUMÉ', 'Resume site'), null);
    assert.notEqual(fuzzyScore('sondergaard', 'Dana Søndergaard'), null);
    assert.notEqual(fuzzyScore('lodz', 'Łódź office'), null);
    assert.notEqual(fuzzyScore('strasse', 'Hauptstraße 5'), null);
    assert.deepEqual(find('   '), projects);
    assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, hits: [] });
});

test('a row can be typed as it reads: punctuation around a word is ignored', () => {
    assert.equal(find('web:')[0], 'WEB Website redesign Acme Holdings');
    assert.equal(find('(acme)').length, 3);
    assert.notEqual(fuzzyScore("bob's", "Bob's Waffles"), null);
    assert.notEqual(fuzzyScore('r&d', 'R&D budget'), null);
    assert.notEqual(fuzzyScore('&', 'Placemat & Menu'), null);
});

test('names without spaces or in other scripts match too', () => {
    assert.notEqual(fuzzyScore('デザイン', 'ウェブデザイン刷新'), null); // inside an unbroken run
    assert.notEqual(fuzzyScore('диз', 'Новый дизайн сайта'), null); // the start of a Cyrillic word
    assert.ok(fuzzyScore('диз', 'Новый дизайн сайта')! > fuzzyScore('зайн', 'Новый дизайн сайта')!);
    assert.notEqual(fuzzyScore('한', '한글 프로젝트'), null);
});

test('the matched characters are reported, so a row can show why it is listed', () => {
    assert.equal(marked('des', 'Design retainer'), '[Des]ign retainer');
    assert.equal(marked('des', 'Website redesign'), 'Website re[des]ign');
    assert.equal(marked('wr', 'Website redesign'), '[W]ebsite [r]edesign');
    assert.equal(marked('dsgn', 'Design retainer'), '[D]e[s]i[gn] retainer');
    assert.equal(marked('acme mob', 'Mobile app'), '[Mob]ile app');
    assert.equal(marked('acme mob', 'Acme Holdings'), '[Acme] Holdings');
    assert.equal(marked('resume', 'Résumé site'), '[Résumé] site');
    assert.equal(marked('strasse', 'Hauptstraße 5'), 'Haupt[straße] 5');
    // nothing typed, or nothing of the query in this piece: one plain run
    assert.deepEqual(segments('', 'Design retainer'), [{ text: 'Design retainer', hit: false }]);
    assert.deepEqual(segments('globex', 'Design retainer'), [{ text: 'Design retainer', hit: false }]);
    assert.deepEqual(segments('des', ''), []);
});

test('a combining accent stays with its letter, and an emoji is one character', () => {
    assert.equal(marked('resume', 'Résumé site'), '[Résumé] site');
    assert.equal(marked('launch', '🚀 Launch plan'), '🚀 [Launch] plan');
    assert.deepEqual(fuzzyMatch('launch', '🚀 Launch plan')?.hits, [2, 3, 4, 5, 6, 7]);
});
