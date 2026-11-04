// How far behind the running build is, for the update prompt ("You are
// running 0.2.0 (3 versions behind)"). The updater only says what the newest
// release is; latest.json also carries `releases`, every published version
// (scripts/updater-manifest.mjs), and the count is the ones after ours up to
// the one on offer. A manifest from before that field, or one that does not
// make sense, gives null and the prompt leaves the count out rather than guess.

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1, 0 or 1 for two X.Y.Z versions, compared numerically. */
export function compareVersions(a: string, b: string): number {
    const pa = a.match(VERSION)!.slice(1).map(Number);
    const pb = b.match(VERSION)!.slice(1).map(Number);
    for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    return 0;
}

/** Releases after `current`, up to and including `offered`; null when it can't be told. */
export function versionsBehind(current: string, offered: string, releases: unknown): number | null {
    if (!VERSION.test(current) || !VERSION.test(offered) || compareVersions(offered, current) <= 0) return null;
    if (!Array.isArray(releases)) return null;
    const known = new Set(releases.filter((r): r is string => typeof r === 'string' && VERSION.test(r)));
    if (!known.has(offered)) return null;
    return [...known].filter((r) => compareVersions(r, current) > 0 && compareVersions(r, offered) <= 0).length;
}
