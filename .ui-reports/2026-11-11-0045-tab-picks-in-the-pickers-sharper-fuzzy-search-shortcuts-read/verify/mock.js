// Plain-browser stand-in for the workspace API, so the popover renders without a server.
(() => {
    try {
        localStorage.setItem('zebu.token', 'demo');
        localStorage.setItem('zebu.workspace', 'https://studio.zebu.work');
        localStorage.setItem('zebu.presets', JSON.stringify([
            { id: 'a', name: 'Morning standup', project_id: 'p9', task_id: 't-admin', workspace: 'https://studio.zebu.work' },
            { id: 'b', name: 'Design review', project_id: 'p3', task_id: 't-design', workspace: 'https://studio.zebu.work' },
            { id: 'c', name: 'Acme app sprint', project_id: 'p4', task_id: 't-development', workspace: 'https://studio.zebu.work' },
            { id: 'd', name: 'Waffle menu', project_id: 'p2', task_id: 't-design', workspace: 'https://studio.zebu.work' },
        ]));
    } catch {}
    // The app as it runs on a Mac: ⌘ keycaps, and the hotkeys a Mac starts with.
    try {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
        Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
    } catch {}
    // Just enough of Tauri for the shell calls that have an answer to matter here;
    // everything else rejects, as it does in a plain browser.
    window.__invoked = [];
    window.__TAURI_INTERNALS__ = {
        transformCallback: () => 0,
        invoke: async (cmd, args) => {
            window.__invoked.push([cmd, args]);
            if (cmd === 'set_shortcut' || cmd === 'set_tray_state' || cmd === 'open_popover') return null;
            throw new Error('not running inside Tauri');
        },
    };
    const tasks = (names) => names.map((n, i) => ({ id: `t-${n.toLowerCase().replace(/[^a-z]+/g, '-')}`, name: n }));
    const std = tasks(['Design', 'Development', 'Project management', 'Meetings', 'Research']);
    const projects = [
        { id: 'p1', name: 'Website redesign', code: 'WEB', client: 'Acme Holdings', tasks: std },
        { id: 'p2', name: 'Placemat & Menu Design', code: 'PMD', client: "Bob's Waffles", tasks: tasks(['Design', 'Illustration', 'Print production']) },
        { id: 'p3', name: 'Design retainer', code: null, client: 'Globex', tasks: std },
        { id: 'p4', name: 'Mobile app', code: 'APP', client: 'Acme Holdings', tasks: std },
        { id: 'p5', name: 'Brand guidelines', code: 'BRD', client: 'Globex', tasks: tasks(['Design', 'Copywriting']) },
        { id: 'p6', name: 'Annual report 2026', code: 'AR26', client: 'Initech', tasks: tasks(['Design', 'Copywriting', 'Data visualisation']) },
        { id: 'p7', name: 'Developer documentation', code: 'DOCS', client: 'Initech', tasks: tasks(['Writing', 'Review']) },
        { id: 'p8', name: 'Wine list redesign', code: 'WLR', client: "Bob's Waffles", tasks: tasks(['Design', 'Print production']) },
        { id: 'p9', name: 'Internal', code: null, client: null, tasks: tasks(['Admin', 'Bookkeeping', 'Business development']) },
        { id: 'p10', name: 'Dashboard rebuild', code: 'DSH', client: 'Umbrella Health', tasks: std },
        { id: 'p11', name: 'Patient portal', code: 'PP', client: 'Umbrella Health', tasks: std },
        { id: 'p12', name: 'Résumé site', code: null, client: 'Dana Søndergaard', tasks: [] },
    ];
    const entry = (id, p, task, minutes, notes, extra = {}) => ({
        id, date: '2026-11-11', minutes, notes, project: projects.find((x) => x.id === p).name, project_id: p,
        task, task_id: task ? `t-${task.toLowerCase()}` : null, is_billable: true, locked: false, timer_started_at: null,
        updated_at: '2026-11-11T09:30:00Z', ...extra,
    });
    const opts = window.__mockOpts || {};
    const entries = [
        entry('e1', 'p1', 'Design', 95, 'Homepage hero explorations', { locked: !!opts.locked }),
        entry('e2', 'p4', 'Meetings', 30, 'Sprint planning'),
    ];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const real = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        const at = url.indexOf('/api/');
        if (at < 0 || !url.startsWith('https://studio.zebu.work')) return real(input, init);
        const path = url.slice(at + 4).split('?')[0];
        const method = (init.method || 'GET').toUpperCase();
        if (path === '/me') return json({ name: 'Demo Person', email: 'demo@zebu.test', broadcast: null });
        if (path === '/timesheet')
            return json({
                week_start: '2026-11-09', entries, running: null, active: entries[0], active_as_of: entries[0].updated_at,
                server_time: new Date().toISOString(), projects, week_locked: !!opts.weekLocked,
                project_stats: Object.fromEntries(projects.map((p) => [p.id, { total_minutes: 1240, uninvoiced_minutes: 480, budget_pct: null }])),
            });
        if (path === '/timer/pulse') return json({ token: 'v1', running: false, maintenance: null });
        if (path === '/timer/idle') return json({ idle: null });
        if (path === '/summary')
            return json({ today: 125, yesterday: 410, this_week: 965, last_week: 2210, this_month: 4100, last_month: 9020, billable_pct_month: 82,
                month_by_day: [], year_by_month: [], uninvoiced_minutes: 3000, uninvoiced_amounts: {}, uninvoiced_total: 0, base_currency: 'USD' });
        if (method === 'POST' && path === '/timer/start') {
            const body = JSON.parse(init.body || '{}');
            if (opts.failStart) return json({ message: 'This entry has been invoiced and is locked.' }, 422);
            const p = projects.find((x) => x.id === body.project_id) || projects[0];
            const t = p.tasks.find((x) => x.id === body.task_id);
            window.__started = body;
            return json({ entry: { ...entry('e9', p.id, null, 0, body.notes ?? null), task: t ? t.name : null, task_id: t ? t.id : null, timer_started_at: new Date().toISOString() } });
        }
        return json({ ok: true });
    };
})();
