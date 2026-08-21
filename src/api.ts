// Thin client for the Freilancer server API, token stored in localStorage.

export interface Entry {
    id: string;
    date: string;
    minutes: number;
    notes: string | null;
    project: string | null;
    project_id: string;
    task: string | null;
    task_id: string | null;
    is_billable: boolean;
    locked: boolean;
    timer_started_at: string | null;
}

export interface ProjectOption {
    id: string;
    name: string;
    client: string | null;
    tasks: { id: string; name: string }[];
}

export interface Timesheet {
    week_start: string;
    entries: Entry[];
    running: Entry | null;
    projects: ProjectOption[];
    week_locked: boolean;
}

export interface Summary {
    today: number;
    yesterday: number;
    this_week: number;
    last_week: number;
    this_month: number;
    last_month: number;
    billable_pct_month: number;
}

const store = {
    get server(): string {
        return localStorage.getItem('freilancer.server') ?? '';
    },
    set server(v: string) {
        localStorage.setItem('freilancer.server', v);
    },
    get token(): string {
        return localStorage.getItem('freilancer.token') ?? '';
    },
    set token(v: string) {
        localStorage.setItem('freilancer.token', v);
    },
};

export const auth = store;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${store.server}/api${path}`, {
        method,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${store.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401) {
        store.token = '';
        throw new Error('unauthenticated');
    }
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message ?? `Request failed (${response.status})`);
    }

    return response.json();
}

export const api = {
    deviceStart: (server: string) =>
        fetch(`${server}/api/device/start`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_name: 'Freilancer Desktop' }),
        }).then((r) => {
            if (!r.ok) throw new Error(`Could not reach the server (${r.status})`);
            return r.json() as Promise<{ device_code: string; verification_url: string; interval: number }>;
        }),

    devicePoll: (server: string, deviceCode: string) =>
        fetch(`${server}/api/device/poll`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: deviceCode }),
        }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) })),

    me: () => request<{ name: string; email: string }>('GET', '/me'),
    timesheet: (date: string) => request<Timesheet>('GET', `/timesheet?date=${date}`),
    summary: () => request<Summary>('GET', '/summary'),
    startTimer: (payload: { project_id: string; task_id?: string | null; notes?: string | null; entry_id?: string }) =>
        request<{ entry: Entry }>('POST', '/timer/start', payload),
    stopTimer: () => request<{ ok: boolean }>('POST', '/timer/stop'),
    addEntry: (payload: { project_id: string; task_id?: string | null; date: string; minutes: number; notes?: string | null }) =>
        request<{ entry: Entry }>('POST', '/time', payload),
    deleteEntry: (id: string) => request<{ ok: boolean }>('DELETE', `/time/${id}`),
};

export function formatMinutes(minutes: number): string {
    const m = Math.max(0, Math.round(minutes));
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** "1:30", "1.5", "90m" -> minutes */
export function parseDuration(input: string): number | null {
    const s = input.trim().toLowerCase();
    if (!s) return null;
    let m = s.match(/^(\d+):(\d{1,2})$/);
    if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
    m = s.match(/^(\d+)m$/);
    if (m) return parseInt(m[1]);
    m = s.match(/^(\d+(?:[.,]\d+)?)$/);
    if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    return null;
}

export function toDateString(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
