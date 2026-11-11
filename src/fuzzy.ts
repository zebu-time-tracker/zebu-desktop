// Small, dependency-free fuzzy matching for the search pickers.
//
// Every word of the query has to match, and each is graded by how it matched,
// best first:
//
//   6  a whole word              "web"  → WEB: Website redesign
//   5  the start of a word       "des"  → Design retainer
//   4  initials of words in a row "wr"  → Website redesign
//   3  anywhere inside a word    "sign" → Design retainer
//   2  one word, abbreviated     "dsgn" → Design retainer
//   1  several, abbreviated      "webre" → Website redesign
//
// An abbreviation is the query's letters in order from the first letter of a
// word, and a later word can only be entered at its first letter. Letters
// scattered across the middle of unrelated words are not a match: the list
// used to accept those, and "dsn" then offered the developer documentation and
// a website beside the design projects.
//
// Between rows that matched equally well, the one whose match sits earlier
// wins (a project named Acme before a project whose client is Acme), and after
// that the order the list came in, which is most recently tracked first.
//
// `hits` says which characters matched, so a row can show why it is there.

/** Letters NFD does not take apart but that people type without the stroke. */
const PLAIN: Record<string, string> = { ø: 'o', ł: 'l', đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i', þ: 'th' };

const foldChar = (ch: string): string => {
    const lower = ch
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
    return lower.replace(/[øłđðßæœıþ]/g, (c) => PLAIN[c]);
};

interface Folded {
    /** Lower case, accents off: what matching runs on. */
    text: string;
    /** For each character of `text`, the index of the code point of the original it came from. */
    from: number[];
    /** The original, one code point per item. */
    points: string[];
    /** Where each word starts and ends in `text` (end exclusive). */
    words: [number, number][];
}

const fold = (source: string): Folded => {
    const points = [...source];
    let text = '';
    const from: number[] = [];
    points.forEach((point, i) => {
        for (const ch of foldChar(point)) {
            text += ch;
            for (let k = 0; k < ch.length; k++) from.push(i);
        }
    });
    const words: [number, number][] = [];
    for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) words.push([m.index, m.index + m[0].length]);
    return { text, from, points, words };
};

const TIER = { word: 6, prefix: 5, initials: 4, inside: 3, abbreviated: 2, abbreviatedAcross: 1 } as const;

interface PartMatch {
    tier: number;
    /** Index of the word the match starts in: earlier is better. */
    word: number;
    /** Matched positions in the folded text. */
    at: number[];
}

const span = (start: number, length: number): number[] => Array.from({ length }, (_, i) => start + i);

/**
 * `part` as an abbreviation: its letters in order, starting at the first
 * letter of a word, skipping freely inside a word but entering a later word
 * only at its first letter — and not at all unless `across`. Returns the
 * positions, or null.
 */
function abbreviation(part: string, hay: Folded, firstWord: number, across: boolean): number[] | null {
    const { text, words } = hay;
    const walk = (p: number, w: number, after: number): number[] | null => {
        if (p === part.length) return [];
        // carry on inside this word
        const inWord = text.indexOf(part[p], after);
        if (inWord >= 0 && inWord < words[w][1]) {
            const rest = walk(p + 1, w, inWord + 1);
            if (rest) return [inWord, ...rest];
        }
        // or move to the start of a later word
        for (let next = w + 1; across && next < words.length; next++) {
            if (text[words[next][0]] !== part[p]) continue;
            const rest = walk(p + 1, next, words[next][0] + 1);
            if (rest) return [words[next][0], ...rest];
        }
        return null;
    };
    if (text[words[firstWord][0]] !== part[0]) return null;
    const rest = walk(1, firstWord, words[firstWord][0] + 1);
    return rest ? [words[firstWord][0], ...rest] : null;
}

/** The best way one query word matches, or null when it does not. */
function matchPart(part: string, hay: Folded): PartMatch | null {
    const { text, words } = hay;
    let prefix: PartMatch | null = null;
    for (let w = 0; w < words.length; w++) {
        const [start, end] = words[w];
        if (!text.startsWith(part, start) || start + part.length > end) continue;
        if (start + part.length === end) return { tier: TIER.word, word: w, at: span(start, part.length) };
        prefix ??= { tier: TIER.prefix, word: w, at: span(start, part.length) };
    }
    if (prefix) return prefix;

    if (part.length > 1) {
        const w = words
            .map(([start]) => text[start])
            .join('')
            .indexOf(part);
        if (w >= 0) return { tier: TIER.initials, word: w, at: span(w, part.length).map((i) => words[i][0]) };
    }

    const inside = text.indexOf(part);
    if (inside >= 0) {
        const w = words.findIndex(([, end]) => inside < end);
        return { tier: TIER.inside, word: Math.max(w, 0), at: span(inside, part.length) };
    }

    for (const across of [false, true]) {
        for (let w = 0; w < words.length; w++) {
            const at = abbreviation(part, hay, w, across);
            if (at) return { tier: across ? TIER.abbreviatedAcross : TIER.abbreviated, word: w, at };
        }
    }
    return null;
}

/**
 * The query's words, folded like the text. Punctuation around a word is
 * dropped, so typing a row as it reads ("WEB: Website") still finds it; a word
 * that is nothing but punctuation is kept as typed.
 */
const parts = (query: string): string[] =>
    [...query]
        .map(foldChar)
        .join('')
        .split(/\s+/)
        .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || word)
        .filter(Boolean);

export interface FuzzyMatch {
    score: number;
    /** Which code points of the text matched, ascending. Index into `[...text]`. */
    hits: number[];
}

/** How well `query` matches `text`, and where; null when it does not. An empty query matches everything, nowhere. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
    const wanted = parts(query);
    if (!wanted.length) return { score: 0, hits: [] };
    const hay = fold(text);
    let score = 0;
    const hits = new Set<number>();
    for (const part of wanted) {
        const match = matchPart(part, hay);
        if (!match) return null;
        // the tier decides; where the match sits only orders rows of the same tier
        score += match.tier * 100 - Math.min(match.word, 50);
        for (const i of match.at) hits.add(hay.from[i]);
    }
    return { score, hits: [...hits].sort((a, b) => a - b) };
}

export const fuzzyScore = (query: string, text: string): number | null => fuzzyMatch(query, text)?.score ?? null;

/** The items that match, best first; equal matches keep the order they came in. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): T[] {
    if (!query.trim()) return items;
    return items
        .map((item, order) => ({ item, order, score: fuzzyScore(query, text(item)) }))
        .filter((r): r is { item: T; order: number; score: number } => r.score !== null)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map((r) => r.item);
}

export interface Segment {
    text: string;
    hit: boolean;
}

/**
 * `text` cut into runs that matched the query and runs that did not, for a row
 * to mark the first kind. Each query word is marked where it matches this text
 * on its own, so a row shown in several pieces (code, name, client heading)
 * marks every piece that had a part in it. A text the query does not touch
 * comes back as one unmarked run.
 */
export function segments(query: string, text: string): Segment[] {
    const wanted = parts(query);
    if (!text) return [];
    const hay = fold(text);
    const hit = new Set<number>();
    for (const part of wanted) {
        const match = matchPart(part, hay);
        if (match) for (const i of match.at) hit.add(hay.from[i]);
    }
    if (!hit.size) return [{ text, hit: false }];

    const folded = new Set(hay.from);
    const out: Segment[] = [];
    let last = false;
    hay.points.forEach((point, i) => {
        // a combining mark folds to nothing: it stays with the letter it sits on
        const on = folded.has(i) ? hit.has(i) : last;
        if (out.length && last === on) out[out.length - 1].text += point;
        else out.push({ text: point, hit: on });
        last = on;
    });
    return out;
}
