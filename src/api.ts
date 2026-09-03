// Thin client for the Zebu server API, token stored in localStorage.

import { i18n } from './i18n';

const t = (key: string, named?: Record<string, unknown>) => i18n.global.t(key, named ?? {});

// The hosted Zebu server — a build-time concern, set via VITE_ZEBU_SERVER in
// a .env file (release builds point at the hosted service; dev at a local
// instance). Not user-configurable.
export const SERVER: string = ((import.meta.env.VITE_ZEBU_SERVER as string | undefined) ?? 'https://app.zebu.work').replace(/\/+$/, '');

/** Hosted-service domain a bare workspace name is completed with. */
export const DEFAULT_DOMAIN = 'app.zebu.work';

/**
 * Hosted Zebu serves each workspace from its own subdomain — and the device
 * flow lives there, not on the bare app domain — so the user names their
 * workspace on the connect screen. Normalise what they typed into an origin,
 * or '' when it can't be one (same rules as the mobile app and the browser
 * extension):
 *   "studio"                 → https://studio.app.zebu.work
 *   "studio.app.zebu.work"   → https://studio.app.zebu.work
 *   "http://127.0.0.1:8003/" → http://127.0.0.1:8003   (local dev)
 */
export function workspaceUrl(input: string, defaultDomain = DEFAULT_DOMAIN): string {
    let value = input.trim().replace(/\/+$/, '');
    if (value === '') return '';
    if (!/^https?:\/\//i.test(value)) {
        value = value.includes('.') ? `https://${value}` : `https://${value}.${defaultDomain}`;
    }
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}`;
    } catch {
        return '';
    }
}

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
    /** Agentic work: minutes spent waiting on an AI agent, and whether one is being waited on now. */
    waiting_minutes?: number;
    waiting_subtracted?: boolean;
    agent_waiting?: boolean;
}

export interface ProjectOption {
    id: string;
    name: string;
    client: string | null;
    tasks: { id: string; name: string }[];
}

export interface ProjectStats {
    total_minutes: number;
    uninvoiced_minutes: number;
    budget_pct: number | null;
}

export interface Timesheet {
    week_start: string;
    entries: Entry[];
    running: Entry | null;
    projects: ProjectOption[];
    week_locked: boolean;
    project_stats: Record<string, ProjectStats>;
}

export interface Summary {
    today: number;
    yesterday: number;
    this_week: number;
    last_week: number;
    this_month: number;
    last_month: number;
    billable_pct_month: number;
    month_by_day: number[];
    year_by_month: number[];
    uninvoiced_minutes: number;
    uninvoiced_amounts: Record<string, number>;
    uninvoiced_total: number;
    base_currency: string;
}

// One-time migration: older builds offered a "Custom Server…" option and
// persisted its URL under zebu.server. The app is hosted-only now — a token
// issued by another server is useless against the standard one, so drop both
// and let the user land on the connect screen.
try {
    const legacy = localStorage.getItem('zebu.server');
    if (legacy !== null) {
        if (legacy.replace(/\/+$/, '') !== SERVER) localStorage.removeItem('zebu.token');
        localStorage.removeItem('zebu.server');
    }
} catch {
    /* storage unavailable — nothing to migrate */
}

const store = {
    get token(): string {
        return localStorage.getItem('zebu.token') ?? '';
    },
    set token(v: string) {
        localStorage.setItem('zebu.token', v);
    },
    /** Normalised workspace origin, e.g. https://studio.app.zebu.work */
    get workspace(): string {
        return localStorage.getItem('zebu.workspace') ?? '';
    },
    set workspace(v: string) {
        localStorage.setItem('zebu.workspace', v);
    },
};

/** Every request goes to the connected workspace; the build-time server is only a fallback. */
export const base = (): string => store.workspace || SERVER;

export const auth = store;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base()}/api${path}`, {
        method,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${store.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {
        throw new Error(t('errors.unreachable'));
    });

    if (response.status === 401) {
        store.token = '';
        throw new Error('unauthenticated');
    }
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message ?? t('errors.requestFailed', { status: response.status }));
    }

    return response.json();
}

export const api = {
    deviceStart: () =>
        fetch(`${base()}/api/device/start`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_name: 'Zebu Desktop' }),
        })
            .catch(() => {
                throw new Error(t('errors.unreachable'));
            })
            .then((r) => {
                if (!r.ok) throw new Error(t('errors.unreachableStatus', { status: r.status }));
                return r.json() as Promise<{ device_code: string; verification_url: string; interval: number }>;
            }),

    devicePoll: (deviceCode: string) =>
        fetch(`${base()}/api/device/poll`, {
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
    idleTimer: (payload: { idle_started_at: string; action: 'discard_keep' | 'discard_stop' }) =>
        request<{ entry: Entry | null }>('POST', '/timer/idle', payload),
    updateEntry: (id: string, payload: { project_id?: string; task_id?: string | null; notes?: string | null; date?: string; minutes?: number }) =>
        request<{ entry: Entry }>('PUT', `/time/${id}`, payload),
    addEntry: (payload: { project_id: string; task_id?: string | null; date: string; minutes: number; notes?: string | null }) =>
        request<{ entry: Entry }>('POST', '/time', payload),
    deleteEntry: (id: string) => request<{ ok: boolean }>('DELETE', `/time/${id}`),
};

/** Big totals read better in work units: an 8h day, a 5-day week. Unit labels come from the locale catalog. */
export function formatDurationHuman(minutes: number): string {
    const m = Math.max(0, Math.round(minutes));
    if (m < 8 * 60) return formatMinutes(m);
    const day = t('units.day');
    const week = t('units.week');
    const hours = m / 60;
    if (hours < 40) {
        const d = Math.floor(hours / 8);
        const h = Math.round(hours - d * 8);
        return h > 0 ? `${d}${day} ${h}${t('units.hour')}` : `${d}${day}`;
    }
    const w = Math.floor(hours / 40);
    const d = Math.round((hours - w * 40) / 8);
    if (d >= 5) return `${w + 1}${week}`;
    return d > 0 ? `${w}${week} ${d}${day}` : `${w}${week}`;
}

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
