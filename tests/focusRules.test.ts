import assert from 'node:assert/strict';
import { test } from 'node:test';
import { putRule, putRules, readRules, removeRule, ruleIndex, rulesFor, sortedRules, type FocusRule } from '../src/focusRules.ts';

const ws = 'https://studio.zebu.work';
const rule = (app: string, key: string, project_id: string, workspace = ws): FocusRule => ({ app, key, project_id, workspace });

test('stored rules are read defensively', () => {
    assert.deepEqual(readRules(null), []);
    assert.deepEqual(readRules('nope'), []);
    assert.deepEqual(readRules([{ app: ' Safari ', key: ' GitHub ', project_id: 'p1', workspace: ws }, { app: '', project_id: 'p1' }, { app: 'Code' }, 7, null]), [
        rule('Safari', 'GitHub', 'p1'),
    ]);
});

test('a rule for the same place replaces the old one, per workspace', () => {
    let rules = putRule([], rule('Code', 'zebu-desktop', 'p1'));
    rules = putRule(rules, rule('Code', 'Zebu-Desktop', 'p2'));
    assert.deepEqual(rules, [rule('Code', 'Zebu-Desktop', 'p2')]);
    rules = putRule(rules, rule('Code', 'zebu-desktop', 'x9', 'https://other.zebu.work'));
    assert.equal(rules.length, 2);
    assert.deepEqual(rulesFor(rules, ws), [rule('Code', 'Zebu-Desktop', 'p2')]);
    assert.deepEqual(putRule(rules, rule('Code', 'x', '')), rules, 'no project, no rule');
});

test('a site rule covers every browser; an app rule stays with its app', () => {
    let rules = putRule([], rule('Safari', 'acme/website · GitHub', 'p1'));
    rules = putRule(rules, rule('Google Chrome', 'acme/website · GitHub', 'p2'));
    assert.equal(rules.length, 1, 'the Chrome rule replaced the Safari one');
    const find = ruleIndex(rules);
    assert.equal(find('Arc', 'acme/website · GitHub'), 'p2');
    assert.equal(find('Code', 'acme/website · GitHub'), null);
    const apps = ruleIndex([rule('Safari', '', 'p3')]);
    assert.equal(apps('Safari', ''), 'p3');
    assert.equal(apps('Firefox', ''), null);
});

test('rules for projects the workspace no longer has match nothing', () => {
    const find = ruleIndex([rule('Figma', '', 'gone'), rule('Slack', 'Acme', 'p1')], ['p1']);
    assert.equal(find('Figma', ''), null);
    assert.equal(find('Slack', 'acme'), 'p1');
});

test('several places can be given one project, and a rule can be removed', () => {
    let rules = putRules([], [{ app: 'Mail', key: '' }, { app: 'Safari', key: 'BBC' }], 'p3', ws);
    assert.equal(rules.length, 2);
    rules = removeRule(rules, { app: 'Chrome', key: 'bbc', workspace: ws });
    assert.deepEqual(rules, [rule('Mail', '', 'p3')]);
    assert.deepEqual(removeRule(rules, { app: 'Mail', key: '', workspace: 'elsewhere' }), rules);
});

test('settings list rules by app, the app-wide rule first', () => {
    const sorted = sortedRules([rule('Safari', 'GitHub', 'a'), rule('Code', 'zebu', 'b'), rule('Safari', '', 'c')]);
    assert.deepEqual(
        sorted.map((r) => `${r.app}/${r.key}`),
        ['Code/zebu', 'Safari/', 'Safari/GitHub'],
    );
});
