#!/usr/bin/env node
// Asserts every locale catalog has exactly the same key set as en.json (the
// source of truth), and that each message uses the same {placeholders} as its
// English counterpart. Run via `npm run i18n:check`.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');

const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        return typeof v === 'object' && v !== null ? flatten(v, key) : [[key, v]];
    });

// {name} interpolations used in a message; plural forms ("a | b") are unioned.
const placeholders = (msg) => new Set(String(msg).match(/\{[\w]+\}/g) ?? []);

const files = readdirSync(localesDir).filter((f) => f.endsWith('.json')).sort();
if (!files.includes('en.json')) {
    console.error('src/locales/en.json is missing');
    process.exit(1);
}

const en = new Map(flatten(JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'))));
let failed = false;

for (const file of files) {
    if (file === 'en.json') continue;
    const locale = file.replace(/\.json$/, '');
    const catalog = new Map(flatten(JSON.parse(readFileSync(join(localesDir, file), 'utf8'))));

    const missing = [...en.keys()].filter((k) => !catalog.has(k));
    const extra = [...catalog.keys()].filter((k) => !en.has(k));
    const badPlaceholders = [...en.keys()]
        .filter((k) => catalog.has(k))
        .filter((k) => {
            const want = placeholders(en.get(k));
            const got = placeholders(catalog.get(k));
            return want.size !== got.size || [...want].some((p) => !got.has(p));
        });

    if (missing.length || extra.length || badPlaceholders.length) {
        failed = true;
        console.error(`✗ ${locale}`);
        for (const k of missing) console.error(`    missing: ${k}`);
        for (const k of extra) console.error(`    extra:   ${k}`);
        for (const k of badPlaceholders) console.error(`    placeholder mismatch: ${k} (en: ${[...placeholders(en.get(k))].join(' ') || 'none'})`);
    } else {
        console.log(`✓ ${locale} (${catalog.size} keys)`);
    }
}

if (failed) process.exit(1);
console.log(`\nAll ${files.length - 1} locales match en.json (${en.size} keys).`);
