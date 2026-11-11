// Drives the popover in a real browser and checks the keyboard flows end to end.
// Run: npx vite --port 5199 --host 127.0.0.1, then
//   node verify.mjs http://127.0.0.1:5199 chromium mock.js
// Needs Playwright as installed by the ui-report skill (~/.claude/skills/ui-report).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.HOME + '/.claude/skills/ui-report/node_modules/');
const pw = require('playwright');
const [, , base, engine = 'chromium', mockPath] = process.argv;
const mock = fs.readFileSync(mockPath, 'utf8');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await pw[engine].launch();
// Storage as an install that has already answered the first-run shortcuts card, unless `extra` seeds its own.
const ANSWERED = `if (!localStorage.getItem('zebu.prefs')) localStorage.setItem('zebu.prefs', JSON.stringify({ shortcutDefaults: 1 }));`;
const fresh = async (extra = ANSWERED) => {
    const context = await browser.newContext({ viewport: { width: 475, height: 640 } });
    const page = await context.newPage();
    await page.addInitScript(extra + mock);
    await page.goto(base);
    await page.waitForSelector('.footer');
    await page.waitForTimeout(300);
    return page;
};
const state = (page) => page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.sheet .picker-button')].map((b) => b.textContent.trim().replace(/\s+/g, ' ')),
    open: document.querySelectorAll('.sheet .picker-list').length,
    focus: (() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}${a.type ? '[' + a.type + ']' : ''}${a.className ? '.' + String(a.className).split(' ')[0] : ''}` : ''; })(),
    focusPickerIndex: [...document.querySelectorAll('.sheet .picker')].findIndex((p) => p.contains(document.activeElement)),
    started: window.__started ?? null,
}));
const openSheet = async (page) => { await page.click('.new-timer'); await page.waitForSelector('.sheet .picker input'); await page.waitForTimeout(100); };

// 1. type, Tab, type, Tab, ⌘↵
{
    const page = await fresh();
    await openSheet(page);
    await page.keyboard.type('des');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    let s = await state(page);
    check('Tab after "des" picks Design retainer', s.buttons[0]?.startsWith('Design retainer'), JSON.stringify(s.buttons));
    check('…and the task search is open with focus in it', s.open === 1 && s.focusPickerIndex === 1 && s.focus.startsWith('input'), `${s.focus} picker ${s.focusPickerIndex}`);
    await page.keyboard.type('dev');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    s = await state(page);
    check('Tab after "dev" picks Development', s.buttons[1] === 'Development', JSON.stringify(s.buttons));
    check('…and focus is on the date', s.focus.startsWith('input[date]') && s.open === 0, s.focus);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(200);
    s = await state(page);
    check('⌘↵ starts the timer on that project and task', s.started?.project_id === 'p3' && s.started?.task_id === 't-development', JSON.stringify(s.started));
    await page.context().close();
}
// 2. Tab straight through an untouched sheet changes nothing
{
    const page = await fresh();
    await openSheet(page);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    let s = await state(page);
    check('Tab through an untouched project search keeps the project', s.buttons[0]?.includes('Website redesign') && s.focusPickerIndex === 1 && s.open === 1, JSON.stringify(s));
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    s = await state(page);
    check('Tab through an untouched task search keeps the task and lands on the date', s.buttons[1] === 'Design' && s.focus.startsWith('input[date]'), JSON.stringify(s));
    await page.context().close();
}
// 3. no match: Tab stays
{
    const page = await fresh();
    await openSheet(page);
    await page.keyboard.type('zzz');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    const s = await state(page);
    const typed = await page.inputValue('.sheet .picker input');
    check('Tab with no match stays in the search', s.open === 1 && s.focusPickerIndex === 0 && typed === 'zzz', JSON.stringify(s));
    await page.context().close();
}
// 4. arrows then Tab; Return still works; ⇧Tab walks back
{
    const page = await fresh();
    await openSheet(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    let s = await state(page);
    check('↓ then Tab picks the row walked to', s.buttons[0]?.includes('Mobile app'), JSON.stringify(s.buttons));
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(150);
    s = await state(page);
    check('⇧Tab from the task search reopens the project search, picking nothing', s.open === 1 && s.focusPickerIndex === 0 && s.focus.startsWith('input') && s.buttons[0] === 'Design', JSON.stringify(s));
    await page.keyboard.type('wr');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    s = await state(page);
    check('Return still picks ("wr" → Website redesign)', s.buttons[0]?.includes('Website redesign') && s.focusPickerIndex === 1, JSON.stringify(s));
    await page.context().close();
}
// 5. presets: type, Return
{
    const page = await fresh();
    await page.click('.footer-left button:nth-of-type(2)');
    await page.waitForSelector('.preset-search');
    await page.keyboard.type('acme');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    let started = await page.evaluate(() => window.__started ?? null);
    check('Presets: "acme" + Return starts that preset', started?.project_id === 'p4' && started?.task_id === 't-development', JSON.stringify(started));
    await page.context().close();
    const page2 = await fresh();
    await page2.click('.footer-left button:nth-of-type(2)');
    await page2.waitForSelector('.preset-search');
    await page2.keyboard.press('ArrowDown');
    await page2.keyboard.press('ArrowDown');
    await page2.keyboard.press('Enter');
    await page2.waitForTimeout(200);
    started = await page2.evaluate(() => window.__started ?? null);
    check('Presets: ↓↓ + Return starts the third', started?.project_id === 'p4', JSON.stringify(started));
    await page2.context().close();
}
// 6. the first-run card
const shortcutState = (page) => page.evaluate(() => ({
    card: !!document.querySelector('.shortcut-offer'),
    rows: [...document.querySelectorAll('.shortcut-offer .shortcut-record')].map((b) => b.textContent.trim()),
    taken: [...document.querySelectorAll('.shortcut-offer .pref-shortcut')].map((r) => !!r.querySelector('.shortcut-taken')),
    set: window.__invoked.filter(([c, a]) => c === 'set_shortcut' && a.accelerator).map(([, a]) => `${a.action}=${a.accelerator}`),
    prefs: JSON.parse(localStorage.getItem('zebu.prefs') || '{}'),
    tooltip: window.__invoked.filter(([c]) => c === 'set_tray_state').map(([, a]) => a.entry?.tooltip).pop(),
}));
const firstRun = async (seed = '') => { const page = await fresh(seed || ' '); await page.waitForTimeout(300); return page; };
const relaunch = async (page) => {
    const kept = await page.evaluate(() => localStorage.getItem('zebu.prefs'));
    await page.context().close();
    const again = await fresh(`localStorage.setItem('zebu.prefs', ${JSON.stringify(kept)});`);
    await again.waitForTimeout(300);
    return again;
};
{
    let page = await firstRun();
    let s = await shortcutState(page);
    check('First open on a Mac shows the card with ⌥⌘P, ⌥⌘N, ⌥⌘T', s.card && s.rows.join(' ') === '⌥⌘P ⌥⌘N ⌥⌘T', s.rows.join(' '));
    check('…and nothing is registered until it is answered', s.set.length === 0 && !s.prefs.shortcutDefaults, s.set.join(' '));
    await page.click('.shortcut-offer .btn-primary');
    await page.waitForTimeout(250);
    s = await shortcutState(page);
    check('Turn on registers the three and closes the card', !s.card && s.set.join(' ') === 'toggleTimer=Alt+Super+KeyP newTimer=Alt+Super+KeyN togglePopover=Alt+Super+KeyT', s.set.join(' '));
    check('…stores them, and marks the card answered', s.prefs.shortcutDefaults === 1 && s.prefs.shortcuts.toggleTimer === 'Alt+Super+KeyP' && s.prefs.shortcuts.toggleInsights === '', JSON.stringify(s.prefs.shortcuts));
    check('The tray tooltip names the start/stop hotkey', (s.tooltip ?? '').endsWith('\nStart or stop the timer (⌥⌘P)'), JSON.stringify(s.tooltip));
    page = await relaunch(page);
    s = await shortcutState(page);
    check('The card does not come back; the saved keys are re-registered', !s.card && s.set.length === 3, s.set.join(' '));
    await page.context().close();
}
{
    let page = await firstRun();
    await page.click('.shortcut-offer .sheet-close');
    await page.waitForTimeout(200);
    let s = await shortcutState(page);
    check('× binds nothing and answers the card', !s.card && s.set.length === 0 && s.prefs.shortcutDefaults === 1 && s.prefs.shortcuts.toggleTimer === '', JSON.stringify(s.prefs));
    page = await relaunch(page);
    s = await shortcutState(page);
    check('…for good', !s.card && s.set.length === 0);
    await page.context().close();
}
{
    const page = await firstRun();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const s = await shortcutState(page);
    check('Escape is the card\'s ×', !s.card && s.set.length === 0 && s.prefs.shortcutDefaults === 1);
    await page.context().close();
}
{
    const page = await firstRun();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const s = await shortcutState(page);
    check('Return is the card\'s Turn on', !s.card && s.set.length === 3, s.set.join(' '));
    await page.context().close();
}
{
    const page = await firstRun();
    await page.click('.shortcut-offer .pref-shortcut:nth-of-type(1) .shortcut-record');
    await page.keyboard.press('Control+Alt+Meta+KeyS');
    await page.click('.shortcut-offer .pref-shortcut:nth-of-type(3) .shortcut-clear');
    await page.waitForTimeout(150);
    let s = await shortcutState(page);
    check('A row re-recorded or emptied on the card is only a draft', s.rows.join(' ') === '⌃⌥⌘S ⌥⌘N Record shortcut' && s.set.length === 0, s.rows.join(' '));
    await page.click('.shortcut-offer .btn-primary');
    await page.waitForTimeout(250);
    s = await shortcutState(page);
    check('Turn on binds the card as edited', !s.card && s.set.join(' ') === 'toggleTimer=Control+Alt+Super+KeyS newTimer=Alt+Super+KeyN' && s.prefs.shortcuts.togglePopover === '', s.set.join(' '));
    await page.context().close();
}
{
    const page = await firstRun(`sessionStorage.setItem('mockTaken', 'Alt+Super+KeyT');`);
    await page.click('.shortcut-offer .btn-primary');
    await page.waitForTimeout(250);
    let s = await shortcutState(page);
    check('A refused combination keeps the card up and says so on its row', s.card && s.taken.join() === 'false,false,true' && s.prefs.shortcuts.newTimer === 'Alt+Super+KeyN' && s.prefs.shortcuts.togglePopover === '', JSON.stringify(s.taken));
    await page.click('.shortcut-offer .pref-shortcut:nth-of-type(3) .shortcut-record');
    await page.keyboard.press('Alt+Meta+KeyZ');
    await page.waitForTimeout(100);
    s = await shortcutState(page);
    check('…re-recording the row clears the complaint', s.taken.join() === 'false,false,false' && s.rows[2] === '⌥⌘Z', s.rows.join(' '));
    await page.click('.shortcut-offer .btn-primary');
    await page.waitForTimeout(250);
    s = await shortcutState(page);
    check('…and Turn on then finishes', !s.card && s.prefs.shortcuts.togglePopover === 'Alt+Super+KeyZ', JSON.stringify(s.prefs.shortcuts));
    await page.context().close();
}
// 7. installs that already have bindings, and platforms with no offer
{
    const seed = (shortcuts) => `localStorage.setItem('zebu.prefs', ${JSON.stringify(JSON.stringify({ shortcuts }))});`;
    let page = await firstRun(seed({ toggleTimer: 'Control+Alt+KeyS', newTimer: '', togglePopover: '', toggleInsights: '', showPresets: '' }));
    let s = await shortcutState(page);
    check('A row already bound shows that binding on the card', s.card && s.rows.join(' ') === '⌃⌥S ⌥⌘N ⌥⌘T', s.rows.join(' '));
    await page.click('.shortcut-offer .btn-primary');
    await page.waitForTimeout(250);
    s = await shortcutState(page);
    check('…and Turn on leaves it as it was', s.prefs.shortcuts.toggleTimer === 'Control+Alt+KeyS' && s.prefs.shortcuts.newTimer === 'Alt+Super+KeyN', JSON.stringify(s.prefs.shortcuts));
    await page.context().close();
    page = await firstRun(seed({ toggleTimer: 'Alt+KeyA', newTimer: 'Alt+KeyB', togglePopover: 'Alt+KeyC', toggleInsights: '', showPresets: '' }));
    s = await shortcutState(page);
    check('Every offered row already bound: no card', !s.card && s.prefs.shortcutDefaults === 1);
    await page.context().close();
    page = await firstRun(`window.__mockOpts = { notMac: true };`);
    s = await shortcutState(page);
    check('Not a Mac: no card, nothing bound', !s.card && s.set.length === 0 && s.prefs.shortcutDefaults === 1, JSON.stringify(s.prefs));
    await page.context().close();
}
{
    // the card waits behind the entry sheet, and is still there after it
    const page = await firstRun();
    await page.keyboard.press('Meta+KeyN');
    await page.waitForTimeout(200);
    let s = await page.evaluate(() => ({ card: !!document.querySelector('.shortcut-offer'), sheet: !!document.querySelector('.sheet .picker') }));
    check('⌘N over the card opens the entry sheet instead', !s.card && s.sheet, JSON.stringify(s));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    s = await page.evaluate(() => ({ card: !!document.querySelector('.shortcut-offer'), sheet: !!document.querySelector('.sheet .picker') }));
    check('…and closing the sheet brings the card back, unanswered', s.card && !s.sheet, JSON.stringify(s));
    await page.context().close();
}
// 8. a picker nobody follows up (settings › Focus rule): Tab picks and moves to the next control
{
    const rules = [{ app: 'Figma', key: '', project_id: 'p1', workspace: 'https://studio.zebu.work' }];
    const page = await fresh(ANSWERED + `localStorage.setItem('zebu.focusRules', ${JSON.stringify(JSON.stringify(rules))});`);
    await page.click('.footer-right button');
    await page.click('#settings-tab-focus');
    await page.click('.focus-rule .picker-button');
    await page.keyboard.type('mob');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(250);
    const s = await page.evaluate(() => ({
        label: document.querySelector('.focus-rule .picker-button')?.textContent.trim().replace(/\s+/g, ' '),
        focus: document.activeElement?.className,
        stored: JSON.parse(localStorage.getItem('zebu.focusRules'))[0].project_id,
    }));
    check('Focus rule picker: Tab picks and focus moves to the next control', s.stored === 'p4' && String(s.focus).includes('focus-rule-remove'), JSON.stringify(s));
    await page.context().close();
}
// 9. the start/stop hotkey (Rust's tray-toggle-timer event) from another app
{
    // Tauri's event plumbing, enough for the app to hear an event fired from here
    const events = 'window.__mockOpts = OPTS; window.__handlers = {};';
    const plumbing = `
        (() => {
            const t = window.__TAURI_INTERNALS__;
            const cbs = [];
            t.transformCallback = (cb) => cbs.push(cb) - 1;
            const inner = t.invoke;
            t.invoke = async (cmd, args) => {
                if (cmd === 'plugin:event|listen') { (window.__handlers[args.event] ||= []).push(cbs[args.handler]); return args.handler; }
                return inner(cmd, args);
            };
            window.__fire = (event, payload) => (window.__handlers[event] || []).forEach((h) => h({ event, id: 0, payload }));
        })();
    `;
    const run = async (opts) => {
        const context = await browser.newContext({ viewport: { width: 475, height: 640 } });
        const page = await context.newPage();
        await page.addInitScript(ANSWERED + events.replace('OPTS', JSON.stringify(opts)) + mock + plumbing);
        await page.goto(base);
        await page.waitForSelector('.footer');
        await page.waitForTimeout(400);
        await page.evaluate(() => window.__fire('tray-toggle-timer'));
        await page.waitForTimeout(400);
        const out = await page.evaluate(() => ({
            started: window.__started ?? null,
            opened: window.__invoked.filter(([c]) => c === 'open_popover').length,
            sheet: !!document.querySelector('.sheet .picker'),
            error: document.querySelector('.error')?.textContent ?? '',
        }));
        await context.close();
        return out;
    };
    let o = await run({});
    check('Hotkey with a stopped timer resumes it, opening nothing', o.started?.entry_id === 'e1' && o.opened === 0 && !o.sheet, JSON.stringify(o));
    o = await run({ locked: true });
    check('Hotkey on an invoiced entry opens the popover on a new timer', o.opened === 1 && o.sheet && !o.started, JSON.stringify(o));
    o = await run({ weekLocked: true });
    check('Hotkey in a locked week shows the popover instead of doing nothing', o.opened === 1 && !o.sheet && !o.started, JSON.stringify(o));
    o = await run({ failStart: true });
    check('Hotkey whose start fails shows the popover with the error', o.opened === 1 && o.error.includes('locked'), JSON.stringify(o));
}
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} passed (${engine})`);
process.exit(results.every(Boolean) ? 0 : 1);
