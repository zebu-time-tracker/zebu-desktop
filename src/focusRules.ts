// Focus rules (board card #512): "github.com/acme/website is Website
// redesign", remembered once the user assigns a row in the Focus tab.
//
// A rule names a place — an app, or a site/document/workspace within an app,
// the same keys the Focus tab's rows show — and the project its time belongs
// to. Rules live in localStorage under `zebu.focusRules`, next to the presets,
// and never leave this Mac: like the spans themselves they describe what the
// user had on screen, which is nobody's business but theirs. Each rule records
// the workspace whose project id it holds, and only the connected workspace's
// rules are used; the others wait for that workspace to be connected again.
//
// Kept apart from the matching in focus.ts so the storage rules are testable
// on their own; focus.ts asks `ruleIndex` which rule a span falls under.

import { isBrowser } from './focus.ts';

/** localStorage key holding every workspace's rules. */
export const RULES_KEY = 'zebu.focusRules';

export interface FocusRule {
    /** The app as it was recorded when the rule was made ("Safari", "Code"). */
    app: string;
    /** The site, document or workspace within the app; '' makes it a rule for the whole app. */
    key: string;
    project_id: string;
    /** The workspace whose project id this is. */
    workspace: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Whatever came out of localStorage, made safe: anything without an app and a project is dropped. */
export const readRules = (stored: unknown): FocusRule[] => {
    if (!Array.isArray(stored)) return [];
    return stored
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({ app: str(r.app).trim(), key: str(r.key).trim(), project_id: str(r.project_id), workspace: str(r.workspace) }))
        .filter((r) => r.app && r.project_id);
};

/**
 * What makes two rules the same rule. A site is the same site in any browser,
 * so a keyed rule made in Safari also covers Chrome; an app-wide rule stays
 * with its app ("all of Safari" is not "all of Chrome").
 */
export const ruleIdentity = (app: string, key: string): string =>
    `${key && isBrowser(app) ? '\u0000browser' : app.trim().toLowerCase()}\n${key.trim().toLowerCase()}`;

/** The rules that belong to `workspace`. */
export const rulesFor = (rules: FocusRule[], workspace: string): FocusRule[] => rules.filter((r) => r.workspace === workspace);

/** `rule` saved, replacing the one for the same place on the same workspace. */
export const putRule = (rules: FocusRule[], rule: FocusRule): FocusRule[] => {
    if (!rule.app.trim() || !rule.project_id) return rules;
    const id = ruleIdentity(rule.app, rule.key);
    const kept = rules.filter((r) => r.workspace !== rule.workspace || ruleIdentity(r.app, r.key) !== id);
    return [...kept, { app: rule.app.trim(), key: rule.key.trim(), project_id: rule.project_id, workspace: rule.workspace }];
};

/** Several places to one project at once (the Unassigned group's picker). */
export const putRules = (rules: FocusRule[], places: { app: string; key: string }[], project_id: string, workspace: string): FocusRule[] =>
    places.reduce((list, p) => putRule(list, { app: p.app, key: p.key, project_id, workspace }), rules);

export const removeRule = (rules: FocusRule[], rule: Pick<FocusRule, 'app' | 'key' | 'workspace'>): FocusRule[] => {
    const id = ruleIdentity(rule.app, rule.key);
    return rules.filter((r) => r.workspace !== rule.workspace || ruleIdentity(r.app, r.key) !== id);
};

/** A lookup from place to project id, for one workspace's rules. */
export type RuleIndex = (app: string, key: string) => string | null;

/**
 * The rules as a lookup, keeping only those whose project the workspace still
 * has: a rule for an archived project matches nothing rather than suggesting
 * an entry the server would refuse.
 */
export const ruleIndex = (rules: FocusRule[], projectIds?: Iterable<string>): RuleIndex => {
    const known = projectIds ? new Set(projectIds) : null;
    const map = new Map<string, string>();
    for (const r of rules) if (!known || known.has(r.project_id)) map.set(ruleIdentity(r.app, r.key), r.project_id);
    return (app, key) => map.get(ruleIdentity(app, key)) ?? null;
};

/** The workspace's rules in the order Settings lists them: by app, then by place, app-wide rules first. */
export const sortedRules = (rules: FocusRule[]): FocusRule[] =>
    [...rules].sort((a, b) => a.app.localeCompare(b.app) || a.key.localeCompare(b.key));

/** Every workspace's rules from localStorage; [] when storage cannot be read. */
export const loadRules = (): FocusRule[] => {
    try {
        return readRules(JSON.parse(localStorage.getItem(RULES_KEY) ?? '[]'));
    } catch {
        return [];
    }
};

/** Writes every workspace's rules back. The Insights window and Settings share this one key. */
export const storeRules = (rules: FocusRule[]): void => {
    try {
        localStorage.setItem(RULES_KEY, JSON.stringify(rules));
    } catch {
        /* storage unavailable: the rule lasts until the window reloads */
    }
};
