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
const fresh = async (extra = '') => {
    const context = await browser.newContext({ viewport: { width: 475, height: 640 } });
    const page = await context.newPage();
    await page.addInitScript(extra + mock);
    await page.goto(base);
    await page.waitForSelector('.new-timer');
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
// 6. default hotkeys: handed out once, named in the tray tooltip, a cleared one stays cleared
{
    const page = await fresh();
    await page.waitForTimeout(300);
    let info = await page.evaluate(() => ({
        set: window.__invoked.filter(([c]) => c === 'set_shortcut').map(([, a]) => `${a.action}=${a.accelerator}`),
        prefs: JSON.parse(localStorage.getItem('zebu.prefs')),
        tooltip: window.__invoked.filter(([c]) => c === 'set_tray_state').map(([, a]) => a.entry?.tooltip).pop(),
    }));
    check('First launch registers the three defaults', info.set.join(' ') === 'toggleTimer=Control+Alt+Super+KeyS newTimer=Control+Alt+Super+KeyN togglePopover=Control+Alt+Super+KeyZ', info.set.join(' '));
    check('…and stores them, with the marker', info.prefs.shortcutDefaults === 1 && info.prefs.shortcuts.toggleTimer === 'Control+Alt+Super+KeyS' && info.prefs.shortcuts.toggleInsights === '', JSON.stringify(info.prefs.shortcuts));
    check('The tray tooltip names the start/stop hotkey', (info.tooltip ?? '').endsWith('\nStart or stop the timer (⌃⌥⌘S)'), JSON.stringify(info.tooltip));
    // clear "new timer" in the settings, then relaunch (same storage)
    await page.click('.footer-right button');
    await page.click('#settings-tab-shortcuts');
    await page.click('.pref-shortcut:nth-of-type(2) .shortcut-clear');
    await page.waitForTimeout(200);
    await page.evaluate(() => (window.__keep = localStorage.getItem('zebu.prefs')));
    const kept = await page.evaluate(() => window.__keep);
    await page.context().close();
    const again = await fresh(`localStorage.setItem('zebu.prefs', ${JSON.stringify(kept)}); window.__seeded = true;`);
    await again.waitForTimeout(300);
    info = await again.evaluate(() => ({
        set: window.__invoked.filter(([c]) => c === 'set_shortcut').map(([, a]) => `${a.action}=${a.accelerator}`),
        prefs: JSON.parse(localStorage.getItem('zebu.prefs')),
    }));
    check('A default the person cleared stays cleared on the next launch', info.prefs.shortcuts.newTimer === '' && !info.set.some((x) => x.startsWith('newTimer')), info.set.join(' '));
    await again.context().close();
}
// 7. an install that already has its own start/stop hotkey keeps it
{
    const prefs = { shortcuts: { toggleTimer: 'Alt+Super+KeyT', newTimer: '', togglePopover: '', toggleInsights: 'Control+Alt+Super+KeyN', showPresets: '' } };
    const page = await fresh(`localStorage.setItem('zebu.prefs', ${JSON.stringify(JSON.stringify(prefs))});`);
    await page.waitForTimeout(300);
    const p = await page.evaluate(() => JSON.parse(localStorage.getItem('zebu.prefs')).shortcuts);
    check('Existing bindings are kept; only untouched rows get a default', p.toggleTimer === 'Alt+Super+KeyT' && p.toggleInsights === 'Control+Alt+Super+KeyN' && p.newTimer === '' && p.togglePopover === 'Control+Alt+Super+KeyZ', JSON.stringify(p));
    await page.context().close();
}
// 8. a picker nobody follows up (settings › Focus rule): Tab picks and moves to the next control
{
    const rules = [{ app: 'Figma', key: '', project_id: 'p1', workspace: 'https://studio.zebu.work' }];
    const page = await fresh(`localStorage.setItem('zebu.focusRules', ${JSON.stringify(JSON.stringify(rules))});`);
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
        await page.addInitScript(events.replace('OPTS', JSON.stringify(opts)) + mock + plumbing);
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
