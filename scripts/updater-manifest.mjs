#!/usr/bin/env node
// Builds the Tauri updater manifest (latest.json) from a flat directory of
// release bundles, and names the stable download aliases that go beside it.
//
//   node scripts/updater-manifest.mjs \
//     --version 0.2.0 \
//     --dir upload \
//     --base-url https://app-downloads.zebu.work/desktop/0.2.0 \
//     [--notes "..."] [--pub-date 2026-09-11T10:00:00Z] [--aliases-out aliases.tsv]
//
// Prints the manifest on stdout. Nothing is uploaded here: the release
// workflow pipes the output to a file and puts it in R2 *last*, after the
// files it names are already there.
//
// Two rules this file exists to enforce:
//
//   1. Every URL in the manifest points into the immutable per-version
//      prefix, never at a `latest/` alias. The updater checks the minisign
//      signature against the exact bytes it downloads, so an alias that is
//      mid-overwrite (or points at a different build than the manifest
//      assumed) fails with a signature error rather than a 404. Versioned
//      URLs cannot drift, so --base-url must end in the version.
//   2. A platform with no `.sig` beside its artifact is an error. A manifest
//      that quietly omits a platform strands every install on it.
//
// The shape (`version`, `notes`, `pub_date`, `platforms` keyed by
// `<os>-<arch>` with `signature` + `url`) is the "static" format read by
// tauri-plugin-updater's `RemoteRelease` deserializer; see docs/release.md
// for where that was checked.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Updater targets are `<os>-<arch>`: see tauri-plugin-updater's `updater_os()`/`updater_arch()`. */
const MAC_TARGETS = ['darwin-aarch64', 'darwin-x86_64'];

/**
 * Which artifact serves which updater target, most specific suffix first.
 * `rank` breaks a tie within one target: the NSIS installer wins over the
 * MSI, matching the workflow's `updaterJsonPreferNsis`.
 */
const UPDATER_ARTIFACTS = [
    { suffix: '.app.tar.gz', targets: MAC_TARGETS, rank: 0 },
    { suffix: '-setup.exe', targets: ['windows-x86_64'], rank: 0 },
    { suffix: '.msi', targets: ['windows-x86_64'], rank: 1 },
    { suffix: '.AppImage', targets: ['linux-x86_64'], rank: 0 },
];

/** The stable `latest/` names a download page can link to, and what they copy. */
const ALIASES = [
    { name: 'mac.dmg', suffix: '.dmg' },
    { name: 'windows.exe', suffix: '-setup.exe' },
    { name: 'linux.AppImage', suffix: '.AppImage' },
];

class ManifestError extends Error {}

const fail = (message) => {
    throw new ManifestError(message);
};

export function parseArgs(argv) {
    const opts = {};
    const known = new Set(['version', 'dir', 'base-url', 'notes', 'pub-date', 'aliases-out']);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) fail(`unexpected argument '${arg}'`);
        const name = arg.slice(2);
        if (!known.has(name)) fail(`unknown option '--${name}'`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
        opts[name] = value;
        i += 1;
    }
    return opts;
}

export function isVersion(value) {
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

/**
 * RFC 3339 with a `Z` or numeric offset — the only thing
 * `OffsetDateTime::parse(.., Rfc3339)` accepts. An unparseable `pub_date`
 * makes the whole manifest fail to deserialize, taking every platform with
 * it, so it is checked here rather than discovered in the field.
 */
export function isRfc3339(value) {
    if (typeof value !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
    return !Number.isNaN(Date.parse(value));
}

export function nowRfc3339(date = new Date()) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Every regular file directly in `dir`, sorted so output is deterministic. */
function listFiles(dir) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        fail(`cannot read --dir '${dir}'`);
    }
    return names.filter((name) => statSync(join(dir, name)).isFile()).sort();
}

/**
 * Pick the one file ending in `suffix`. More than one is ambiguous and is an
 * error: guessing which `.dmg` is "the" download is how a release ships the
 * wrong bytes.
 */
function pick(files, suffix, label) {
    const matches = files.filter((name) => name.endsWith(suffix));
    if (matches.length > 1) fail(`more than one ${label} artifact (${matches.join(', ')}) — cannot tell which to publish`);
    return matches[0];
}

/**
 * Build the manifest object. `readSignature(name)` returns the contents of
 * `<name>.sig`, or null when it is missing.
 */
export function buildManifest({ version, baseUrl, files, readSignature, notes, pubDate }) {
    if (!isVersion(version)) fail(`--version '${version}' is not X.Y.Z`);

    let url;
    try {
        url = new URL(baseUrl);
    } catch {
        fail(`--base-url '${baseUrl}' is not a URL`);
    }
    if (url.protocol !== 'https:') fail('--base-url must be https (the updater refuses plain http)');
    const segments = url.pathname.split('/').filter(Boolean);
    // Rule 1, mechanically: the manifest can only ever name the immutable
    // per-version prefix. `.../desktop/latest` is rejected here, loudly.
    if (segments[segments.length - 1] !== version) {
        fail(`--base-url must end in the version being released ('${version}'), got '${url.pathname}' — the manifest must never point at a moving alias`);
    }
    const prefix = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;

    if (pubDate !== undefined && !isRfc3339(pubDate)) fail(`--pub-date '${pubDate}' is not RFC 3339`);

    const platforms = {};
    const claimed = new Map(); // target -> rank of the artifact that filled it
    for (const { suffix, targets, rank } of UPDATER_ARTIFACTS) {
        const file = pick(files, suffix, suffix);
        if (!file) continue;
        const signature = readSignature(file);
        // Rule 2: never publish a platform we cannot prove. tauri's bundler
        // writes `<artifact>.sig` next to each updater artifact; its absence
        // means signing did not run, which is a broken release, not a
        // three-platform release minus one.
        if (signature === null || signature.trim() === '') {
            fail(`${file} has no signature beside it (expected ${file}.sig) — refusing to publish a manifest without it`);
        }
        for (const target of targets) {
            const better = claimed.has(target) && claimed.get(target) <= rank;
            if (better) continue;
            claimed.set(target, rank);
            platforms[target] = { signature: signature.trim(), url: `${prefix}/${encodeURIComponent(file)}` };
        }
    }

    if (Object.keys(platforms).length === 0) fail('no updater artifacts found — nothing to publish');

    return {
        version,
        notes: notes ?? `Zebu Desktop ${version}`,
        pub_date: pubDate ?? nowRfc3339(),
        // Sorted so two runs of the same inputs produce byte-identical JSON.
        platforms: Object.fromEntries(Object.keys(platforms).sort().map((k) => [k, platforms[k]])),
    };
}

/** `alias name -> file it is a copy of`, for the files a download page links to. */
export function buildAliases(files) {
    const plan = [];
    for (const { name, suffix } of ALIASES) {
        const file = pick(files, suffix, suffix);
        if (file) plan.push({ name, file });
    }
    return plan;
}

export function main(argv) {
    const opts = parseArgs(argv);
    for (const required of ['version', 'dir', 'base-url']) {
        if (!opts[required]) fail(`--${required} is required`);
    }
    const dir = opts.dir;
    const files = listFiles(dir);

    const manifest = buildManifest({
        version: opts.version,
        baseUrl: opts['base-url'],
        files,
        readSignature: (name) => {
            try {
                return readFileSync(join(dir, `${name}.sig`), 'utf8');
            } catch {
                return null;
            }
        },
        notes: opts.notes,
        pubDate: opts['pub-date'],
    });

    // Always built, even when it is not asked for: an ambiguous download
    // (two .dmg files, say) is a broken release whether or not this run
    // happens to be the one writing the alias plan.
    const plan = buildAliases(files);
    if (opts['aliases-out']) {
        writeFileSync(opts['aliases-out'], plan.map(({ name, file }) => `${name}\t${file}`).join('\n') + (plan.length ? '\n' : ''));
    }

    return `${JSON.stringify(manifest, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'updater-manifest.mjs';
if (invokedDirectly) {
    try {
        process.stdout.write(main(process.argv.slice(2)));
    } catch (error) {
        if (!(error instanceof ManifestError)) throw error;
        process.stderr.write(`updater-manifest: ${error.message}\n`);
        process.exit(1);
    }
}
