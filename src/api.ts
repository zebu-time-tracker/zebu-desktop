// Thin client for the per-workspace Zebu API, token stored in localStorage.
//
// Hosted Zebu serves every workspace from its own host ({sub}.zebu.work) and
// the API — device flow included — lives there, never on the central
// app.zebu.work site. So there is no fixed server: every request goes to the
// workspace the user connected on the connect screen.

import { formatDurationHuman as formatDuration } from './duration';
import { i18n } from './i18n';
import { CENTRAL_URL, DEFAULT_DOMAIN, migrateWorkspaceOrigin, resolveWorkspace, type WorkspaceResolution } from './workspace';

export { CENTRAL_URL, DEFAULT_DOMAIN };
export { formatMinutes, parseDuration } from './duration';

const t = (key: string, named?: Record<string, unknown>) => i18n.global.t(key, named ?? {});

/**
 * Optional prefill for the workspace field in dev builds, set via
 * VITE_ZEBU_WORKSPACE (or the older VITE_ZEBU_SERVER) in .env — typically a
 * local instance such as http://127.0.0.1:8003. Ignored in release builds:
 * users always name their own workspace.
 */
export const DEV_WORKSPACE: string = import.meta.env.DEV
    ? ((import.meta.env.VITE_ZEBU_WORKSPACE as string | undefined) ?? (import.meta.env.VITE_ZEBU_SERVER as string | undefined) ?? '').replace(/\/+$/, '')
    : '';

/**
 * Normalise what the user typed into a workspace origin ('' when it isn't
 * one). Plain http is accepted for loopback hosts in every build (local
 * dev) and for any host only in dev builds; release builds insist on TLS.
 */
export function workspaceUrl(input: string): string {
    const r = resolveWorkspaceInput(input);
    return r.ok ? r.origin : '';
}

export function resolveWorkspaceInput(input: string): WorkspaceResolution {
    return resolveWorkspace(input, { allowInsecure: import.meta.env.DEV });
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
    code: string | null;
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

// One-time migrations of what older builds persisted.
try {
    // Builds before the workspace field offered a "Custom Server…" option and
    // persisted its URL under zebu.server. A token issued by some other server
    // is useless against a hosted workspace, so drop both.
    if (localStorage.getItem('zebu.server') !== null) {
        localStorage.removeItem('zebu.server');
        localStorage.removeItem('zebu.token');
    }
    // Workspaces moved from {sub}.app.zebu.work to {sub}.zebu.work; the token
    // is per workspace, so only the stored origin needs rewriting.
    const ws = localStorage.getItem('zebu.workspace');
    if (ws) {
        const migrated = migrateWorkspaceOrigin(ws);
        if (migrated !== ws) localStorage.setItem('zebu.workspace', migrated);
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
    /** Normalised workspace origin, e.g. https://studio.zebu.work */
    get workspace(): string {
        return localStorage.getItem('zebu.workspace') ?? '';
    },
    set workspace(v: string) {
        localStorage.setItem('zebu.workspace', v);
    },
};

/** Origin every request goes to: the connected workspace. '' until one is connected. */
export const base = (): string => store.workspace;

export const auth = store;

/**
 * Called when the workspace rejects the token (401): it was revoked in the
 * browser, or the workspace is gone. The token is already cleared by then;
 * the app uses this to fall back to the connect screen with an explanation.
 */
export const session: { onExpired: (() => void) | null } = { onExpired: null };

/** Bearer-token requests time out rather than hanging on a stalled host. */
const REQUEST_TIMEOUT_MS = 20_000;
const timeoutSignal = (): AbortSignal | undefined =>
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;

const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!store.workspace || !store.token) throw new Error('unauthenticated');

    const response = await fetch(`${base()}/api${path}`, {
        method,
        headers: { ...jsonHeaders, Authorization: `Bearer ${store.token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(),
    }).catch(() => {
        throw new Error(t('errors.unreachable'));
    });

    if (response.status === 401) {
        store.token = '';
        session.onExpired?.();
        throw new Error('unauthenticated');
    }
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message ?? t('errors.requestFailed', { status: response.status }));
    }

    return response.json();
}

/**
 * The device flow's unauthenticated calls. An unknown subdomain answers 404
 * ("This workspace does not exist"), and the central site redirects to its
 * signup page — neither is a JSON API, so both become a clear message.
 */
async function deviceRequest<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${base()}/api/device/${path}`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
        signal: timeoutSignal(),
    }).catch(() => {
        throw new Error(t('errors.unreachable'));
    });

    const host = new URL(base()).host;
    if (response.status === 404) throw new Error(t('errors.workspaceNotFound', { host }));
    // gated workspace (trial without a card, lapsed billing, operator suspension)
    if (response.status === 402) throw new Error(t('errors.workspacePaused', { host }));
    if (response.redirected || !(response.headers.get('content-type') ?? '').includes('json')) throw new Error(t('errors.notAWorkspaceHost', { host }));
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message ?? t('errors.unreachableStatus', { status: response.status }));
    }
    return response.json();
}

export interface DeviceStart {
    device_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}

export type DevicePoll = { status: 'pending' } | { status: 'approved'; token: string } | { status: 'denied' | 'expired' };

export const api = {
    deviceStart: () => deviceRequest<DeviceStart>('start', { device_name: 'Zebu Desktop' }),

    /** Polls the code. denied/expired arrive with 403/410 but carry a status body, so only the body matters. */
    devicePoll: async (deviceCode: string): Promise<DevicePoll> => {
        const response = await fetch(`${base()}/api/device/poll`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ device_code: deviceCode }),
            signal: timeoutSignal(),
        });
        const data = (await response.json().catch(() => ({}))) as Partial<DevicePoll & { token: string }>;
        if (data.status === 'approved' && typeof data.token === 'string') return { status: 'approved', token: data.token };
        if (data.status === 'denied' || data.status === 'expired') return { status: data.status };
        return { status: 'pending' };
    },

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

/**
 * Tracked / uninvoiced totals as hours and minutes ("38h 12m") with the
 * locale's unit labels. See src/duration.ts for the formatting rules.
 */
export function formatDurationHuman(minutes: number): string {
    return formatDuration(minutes, { hour: t('units.hour'), minute: t('units.minute') });
}

export function toDateString(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
