<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ProjectPicker from './ProjectPicker.vue';
import { readActive, runningOf, supersedes, type ActiveAnswer } from './active';
import { api, auth, CENTRAL_URL, DEFAULT_DOMAIN, DEV_WORKSPACE, elapsedMinutes, formatDurationHuman, formatMinutes, parseDuration, resolveWorkspaceInput, session, toDateString, Unavailable, type Entry, type ProjectStats, type Summary, type Timesheet } from './api';
import { intlLocale, LOCALE_NAMES, setLocalePreference, SUPPORTED_LOCALES } from './i18n';
import { DEFAULT_EXCLUDED, parseExcludeList } from './focus';
import { idleMinutes, resolveIdleChoice } from './idle';
import { draftTouched, planReopen, takeDraft, type EntryDraft, type SheetKind, type StashedDraft } from './popover';
import { initialPulseState, onPulse, onUnavailable, PULSE, refetched } from './pulse';
import {
    defaultPresetName,
    filterPresets,
    hasPreset,
    presetRows,
    presetsFor,
    PRESETS_KEY,
    readPresets,
    removePreset,
    renamePreset,
    savePreset,
    type Preset,
    type PresetRow,
} from './presets';
import { accelerator, assignShortcut, formatAccelerator, noShortcuts, readShortcuts, SHORTCUT_ACTIONS, type ShortcutAction, type Shortcuts } from './shortcuts';
import { clockSkewMs, noteServerTime, serverNow } from './clock';
import { trayEntry as describeTray } from './tray';
import { checkForUpdates, dismissUpdate, installUpdate, updateProgress, updatePromptOpen, updateStatus, updateVersion } from './updater';

const { t } = useI18n();

type View = 'connect' | 'main';

const view = ref<View>(auth.token && auth.workspace ? 'main' : 'connect');

// ---- preferences -----------------------------------------------------------

interface Prefs {
    appearance: 'system' | 'dark' | 'light';
    dock: boolean;
    hideOnBlur: boolean;
    idleEnabled: boolean;
    idleMinutes: number;
    language: string; // 'system' or a locale code from SUPPORTED_LOCALES
    shortcuts: Shortcuts; // system-wide hotkeys, one accelerator per action ('' = unbound)
    /** Focus tracking (board #401): off until the user turns it on. Rust samples nothing while false. */
    focusEnabled: boolean;
    /** Apps never recorded, one per line — the password managers by default. */
    focusExclude: string;
}
const prefs = ref<Prefs>({
    appearance: 'system',
    dock: false,
    hideOnBlur: true,
    idleEnabled: true,
    idleMinutes: 10,
    language: 'system',
    shortcuts: noShortcuts(),
    focusEnabled: false,
    focusExclude: DEFAULT_EXCLUDED.join('\n'),
});
try {
    Object.assign(prefs.value, JSON.parse(localStorage.getItem('zebu.prefs') ?? '{}'));
} catch {
    /* fresh defaults */
}
// the assign above is shallow, so an older build's prefs (or a hand-edited
// file) could leave a row without an accelerator to render
prefs.value.shortcuts = readShortcuts(prefs.value.shortcuts);
watch(
    prefs,
    (p) => {
        try {
            localStorage.setItem('zebu.prefs', JSON.stringify(p));
        } catch {
            /* private mode */
        }
        if (p.appearance === 'system') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = p.appearance;
        setLocalePreference(p.language);
        invoke('set_dock_visible', { visible: p.dock }).catch(() => {});
        invoke('set_hide_on_blur', { hide: p.hideOnBlur }).catch(() => {});
        invoke('set_focus_tracking', { enabled: !!p.focusEnabled, exclude: parseExcludeList(p.focusExclude ?? '') }).catch(() => {});
    },
    { deep: true, immediate: true },
);

// ---- connect flow ----------------------------------------------------------

const connectState = ref<'idle' | 'waiting' | 'error'>('idle');
const connectError = ref('');
// Which workspace to talk to — remembered from the last connection so a
// re-login is one click; dev builds may prefill a local instance from .env.
const workspaceInput = ref(auth.workspace || DEV_WORKSPACE);
const connecting = ref(false);
const verificationUrl = ref('');
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDeadline: ReturnType<typeof setTimeout> | null = null;

const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (pollDeadline) clearTimeout(pollDeadline);
    pollTimer = pollDeadline = null;
};

const failConnect = (message: string) => {
    stopPolling();
    connectState.value = 'error';
    connectError.value = message;
};

const workspaceProblem = (reason: 'empty' | 'invalid' | 'central' | 'insecure') =>
    reason === 'central' ? t('connect.notAWorkspace') : reason === 'insecure' ? t('connect.insecureWorkspace') : t('connect.invalidWorkspace');

const connect = async () => {
    if (connecting.value) return;
    const resolved = resolveWorkspaceInput(workspaceInput.value);
    if (!resolved.ok) {
        failConnect(workspaceProblem(resolved.reason));
        return;
    }
    // a different workspace means a different token: drop the old one now so
    // a failed device flow can't leave a stale pairing behind
    if (auth.workspace !== resolved.origin) {
        auth.token = '';
        forgetLastTimer();
    }
    auth.workspace = resolved.origin;
    // show just the name when it lives under the default domain, otherwise the full host
    const host = resolved.origin.replace(/^https?:\/\//, '');
    workspaceInput.value = host.endsWith(`.${DEFAULT_DOMAIN}`) ? host.slice(0, -(DEFAULT_DOMAIN.length + 1)) : host;
    connecting.value = true;
    connectError.value = '';
    try {
        const started = await api.deviceStart();
        verificationUrl.value = started.verification_url;
        connectState.value = 'waiting';
        await openUrl(started.verification_url);

        let polling = false;
        pollTimer = setInterval(async () => {
            if (polling) return; // never overlap polls on a slow connection
            polling = true;
            try {
                const result = await api.devicePoll(started.device_code);
                if (result.status === 'approved') {
                    stopPolling();
                    auth.token = result.token;
                    connectState.value = 'idle';
                    view.value = 'main';
                    refresh();
                } else if (result.status === 'denied' || result.status === 'expired') {
                    failConnect(result.status === 'denied' ? t('connect.denied') : t('connect.expired'));
                }
            } catch {
                // transient network hiccup — the next tick tries again
            } finally {
                polling = false;
            }
        }, Math.max(2, started.interval || 3) * 1000);
        // the server forgets the code after expires_in; stop asking then
        pollDeadline = setTimeout(() => failConnect(t('connect.expired')), Math.max(30, started.expires_in || 600) * 1000);
    } catch (e: any) {
        failConnect(e.message ?? t('errors.unreachable'));
    } finally {
        connecting.value = false;
    }
};

const cancelConnect = () => {
    stopPolling();
    connectState.value = 'idle';
};

/** Back to the connect screen; `message` explains why when the app didn't choose to. */
const disconnect = (message = '') => {
    stopPolling();
    auth.token = '';
    view.value = 'connect';
    connectState.value = message ? 'error' : 'idle';
    connectError.value = message;
    settingsOpen.value = false;
    formOpen.value = false;
    // the presets themselves are kept: they are filed by workspace and come
    // back when this one is reconnected
    closePresets();
    stashedDraft.value = null; // a draft only means something on the workspace it was typed for
    closeInsights();
    me.value = null;
    sheet.value = null;
    // a reply still in flight for the old workspace must not repopulate the pill
    resetActive();
    forgetLastTimer();
    invoke('set_tray_state', { entry: null }).catch(() => {});
};

// the workspace answered 401: the device was revoked in the browser (or the
// token is otherwise dead) — explain, rather than silently showing the login
session.onExpired = () => {
    if (view.value === 'main') disconnect(t('connect.sessionExpired'));
};

// ---- timesheet -------------------------------------------------------------

const selectedDate = ref(toDateString(new Date()));
const sheet = ref<Timesheet | null>(null);
const loading = ref(false);
const errorMessage = ref('');

const todayStr = () => toDateString(new Date());
const isToday = computed(() => selectedDate.value === todayStr());

// Which entry the menubar is about, as the server last told us (src/active.ts).
// Held apart from the sheet because it is the thing two replies are ordered on:
// fetches are numbered as they start, and a reply that lost the race is thrown
// away whole rather than being allowed to put a stale week — and a stale pill —
// back on screen.
const activeAnswer = ref<ActiveAnswer<Entry> | null>(null);
let fetchSeq = 0;
/** Replies from a fetch below this belong to a session that is over. */
let fetchFloor = 0;
const resetActive = () => {
    activeAnswer.value = null;
    fetchFloor = ++fetchSeq;
};

const refresh = async () => {
    if (view.value !== 'main') return;
    const seq = ++fetchSeq;
    loading.value = true;
    try {
        // the insights panel keeps itself in step, in its own window
        const reply = await api.timesheet(selectedDate.value);
        // a disconnect since this went out: the reply is for a workspace nobody
        // is looking at any more, and must not repopulate the pill
        if (seq < fetchFloor) return;
        // The server's clock at this reply, before anything counts against it.
        noteServerTime(reply.server_time);
        const answer = readActive<Entry>(reply, seq, todayStr());
        // a reply that was overtaken changes nothing: the one on screen is newer
        if (!supersedes(answer, activeAnswer.value)) return;
        activeAnswer.value = answer;
        sheet.value = reply;
        errorMessage.value = '';
        // A fetch is a fetch, whoever asked for it: opening the popover or
        // starting a timer pushes the five-minute backstop out too.
        pulseState = refetched(pulseState, Date.now());
    } catch (e: any) {
        if (e.message === 'unauthenticated') return; // session.onExpired already moved to the connect screen
        // A planned outage is not a failure to report as one: "Service
        // Unavailable" tells nobody anything.
        errorMessage.value = e instanceof Unavailable ? t('errors.maintenance') : e.message;
    } finally {
        loading.value = false;
    }
};

const weekDays = computed(() => {
    if (!sheet.value) return [];
    const start = new Date(sheet.value.week_start + 'T00:00:00');
    const narrowWeekday = new Intl.DateTimeFormat(intlLocale.value, { weekday: 'narrow' });
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const date = toDateString(d);
        return {
            date,
            letter: narrowWeekday.format(d),
            // elapsed(), not minutes: a running timer counts up in the strip too
            minutes: (sheet.value?.entries ?? []).filter((e) => e.date === date).reduce((s, e) => s + elapsed(e), 0),
        };
    });
});

const dayEntries = computed(() => (sheet.value?.entries ?? []).filter((e) => e.date === selectedDate.value));

// The entry the menubar is about, and — the same row, by the server's rule —
// whatever is running. Everything downstream reads these two, so the pill, the
// ticking, the idle threshold and the banners cannot disagree with each other.
const activeEntry = computed(() => activeAnswer.value?.entry ?? null);
const running = computed(() => runningOf(activeEntry.value));

const headerLabel = computed(() => {
    const d = new Date(selectedDate.value + 'T00:00:00');
    if (isToday.value) return t('header.todayWithDate', { date: d.toLocaleDateString(intlLocale.value, { day: 'numeric', month: 'short' }) });
    return d.toLocaleDateString(intlLocale.value, { weekday: 'long', day: 'numeric', month: 'short' });
});

const goDate = (date: string) => {
    selectedDate.value = date;
    refresh();
};

const shiftWeek = (weeks: number) => {
    const d = new Date(selectedDate.value + 'T00:00:00');
    d.setDate(d.getDate() + weeks * 7);
    goDate(toDateString(d));
};

// ---- ticking timer + tray title -------------------------------------------

const now = ref(Date.now());
// agentic work: what the hook measured for this entry, if anything
const waitingLabel = (entry: { waiting_minutes?: number; agent_waiting?: boolean }): string => {
    if (entry.agent_waiting && !(entry.waiting_minutes ?? 0)) return t('timer.waitingNow');
    if ((entry.waiting_minutes ?? 0) > 0) return t('timer.waiting', { time: formatMinutes(entry.waiting_minutes ?? 0) }) + (entry.agent_waiting ? ' …' : '');
    return '';
};

// `now` ticks off this machine's clock; what a running timer is measured
// against is the server's. Reading `now` is what makes this recompute each
// second; `serverNow()` is what makes the answer right.
const elapsed = (entry: { minutes: number; timer_started_at: string | null }) => {
    void now.value;
    return elapsedMinutes(entry, serverNow());
};

let tick: ReturnType<typeof setInterval> | null = null;
let refreshLoop: ReturnType<typeof setInterval> | null = null;
let refreshUnlisten: UnlistenFn | null = null;
let pulseUnlisten: UnlistenFn | null = null;
let pulseLoop: ReturnType<typeof setTimeout> | null = null;

// What the pulse knows between beats (src/pulse.ts owns every rule; this only
// carries the answer). Not a ref: nothing renders from it.
let pulseState = initialPulseState();

/**
 * One beat: ask whether the active timer changed, and refetch only if it did.
 * The old behaviour — refetch everything, every twenty seconds — is now what
 * happens when the answer moves, or once every five minutes regardless.
 */
const onPulseBeat = async () => {
    if (view.value !== 'main') return;

    const beat = await api.pulse();
    const down = beat instanceof Unavailable;
    // Down for the announced window is its own answer: wait as long as the
    // server asked, and do not refetch — the full payload would be refused
    // too, and asking for it is the hammering Retry-After exists to stop
    // (board #216).
    const decision = down
        ? onUnavailable(beat.retryAfter === null ? null : beat.retryAfter * 1_000, pulseState, Date.now())
        : onPulse(beat, pulseState, Date.now());

    pulseState = decision.state;
    if (down) errorMessage.value = t('errors.maintenance');
    if (decision.refetch) await refresh();

    return decision.nextIn;
};

// The pill is the server's `active` entry: the running timer, or — so a timer
// stopped elsewhere leaves the work on screen rather than "zzzz" — the entry
// touched most recently. Not a guess made here: see src/active.ts.
const trayEntry = computed(() => activeEntry.value);

// The pill itself is painted by Rust, which ticks the elapsed time on its own
// thread (webview timers stall while the popover is hidden, so the old
// setInterval here left the menubar frozen until the icon was clicked). This
// only hands over what is on the clock, whenever that changes; the tooltip is
// rendered here so it follows the app's locale, with `{time}` left for Rust.
const updateTray = () => {
    invoke('set_tray_state', { entry: describeTray(trayEntry.value, t, clockSkewMs()) }).catch(() => {});
};

onMounted(() => {
    tick = setInterval(() => (now.value = Date.now()), 15000);
    // Rust nudges every 20 s (`refresh-due`) so a timer started or stopped from
    // another client shows up without a click; outside Tauri (plain-browser
    // dev) fall back to a webview interval.
    listen('refresh-due', () => refresh())
        .then((off) => (refreshUnlisten = off))
        .catch(() => (refreshLoop = setInterval(refresh, PULSE.fallback)));
    // Rust decides the pulse cadence from the clock it is already painting —
    // two seconds while something runs, thirty while nothing does — because its
    // thread keeps time while the popover is hidden and the webview's does not.
    // Outside Tauri (plain-browser dev) the beat schedules itself instead.
    listen('pulse-due', () => onPulseBeat())
        .then((off) => (pulseUnlisten = off))
        .catch(() => {
            const beat = async () => {
                const next = (await onPulseBeat()) ?? PULSE.idle;
                pulseLoop = setTimeout(beat, next);
            };
            pulseLoop = setTimeout(beat, PULSE.idle);
        });
    now.value = Date.now();
    if (view.value === 'main') refresh();
    window.addEventListener('focus', () => view.value === 'main' && refresh());
    listen<{ started_at_ms: number; seconds: number }>('idle-return', (e) => onIdleReturn(e.payload)).then((off) => (idleUnlisten = off));
    // the answer comes back from the prompt's own window, via Rust
    listen<{ remove: boolean; stop: boolean }>('idle-choice', (e) => applyIdleChoice(e.payload)).then((off) => (idleChoiceUnlisten = off));
    // the menubar pill is a play/pause button: Rust reads the running flag it
    // was last handed and sends whichever press this was (see below)
    listen('tray-toggle-timer', () => onTrayToggle()).then((off) => (trayPauseUnlisten = off));
    listen('tray-open-new-timer', () => onTrayPlay()).then((off) => (trayPlayUnlisten = off));
    // the presets hotkey, once Rust has the popover on screen (src-tauri: show_presets)
    listen('open-presets', () => openPresets()).then((off) => (presetsUnlisten = off));
    syncIdleThreshold();
    // quiet launch-time update check; the prompt only appears when there is one
    setTimeout(() => checkForUpdates(false), 4000);
});
onUnmounted(() => {
    if (tick) clearInterval(tick);
    if (refreshLoop) clearInterval(refreshLoop);
    refreshUnlisten?.();
    if (pulseLoop) clearTimeout(pulseLoop);
    pulseUnlisten?.();
    if (pollTimer) clearInterval(pollTimer);
    idleUnlisten?.();
    idleChoiceUnlisten?.();
    trayPauseUnlisten?.();
    trayPlayUnlisten?.();
    presetsUnlisten?.();
});

// ---- running-timer awareness ----------------------------------------------

// a timer running on a day other than the one being viewed
const runningElsewhere = computed(() => (running.value && running.value.date !== selectedDate.value ? running.value : null));

// the last actively managed timer, remembered across launches for one-click resume
interface LastTimer {
    entry_id: string;
    project_id: string;
    task_id: string | null;
    notes: string | null;
    project: string | null;
    task: string | null;
    date: string;
    workspace?: string; // the timer only means something on the workspace it came from
}
const lastTimer = ref<LastTimer | null>(null);
const forgetLastTimer = () => {
    lastTimer.value = null;
    try {
        localStorage.removeItem('zebu.lastTimer');
    } catch {
        /* fine */
    }
};
try {
    lastTimer.value = JSON.parse(localStorage.getItem('zebu.lastTimer') ?? 'null');
} catch {
    /* none remembered */
}
// A timer remembered on another workspace (e.g. a dev server's demo data) would
// offer to resume a project that does not exist here: drop it.
if (lastTimer.value && lastTimer.value.workspace !== auth.workspace) forgetLastTimer();
const rememberTimer = (e: Entry) => {
    lastTimer.value = {
        entry_id: e.id,
        project_id: e.project_id,
        task_id: e.task_id,
        notes: e.notes,
        project: e.project,
        task: e.task,
        date: e.date,
        workspace: auth.workspace,
    };
    try {
        localStorage.setItem('zebu.lastTimer', JSON.stringify(lastTimer.value));
    } catch {
        /* fine */
    }
};
// The entry the pill shows is also the one Resume offers — the same answer, so
// the two cannot point at different work. This also flips the menubar pill as
// soon as the first timesheet loads. (Resume still refuses to back-date onto an
// older day: see resumeLast.)
watch(activeEntry, (entry) => {
    if (entry) rememberTimer(entry);
    updateTray();
});

// a language switch re-renders the tray tooltip right away
watch(intlLocale, () => updateTray());

const confirmNewDay = ref(false);

/**
 * Starting or resuming a timer jumps to the entry's day (today, for a fresh
 * timer) so the running row is on screen; act() then refreshes that day.
 */
const showEntry = async (result: Promise<{ entry: Entry }>) => {
    const { entry } = await result;
    if (entry.date !== selectedDate.value) selectedDate.value = entry.date;
};

const resumeLast = () => {
    const last = lastTimer.value;
    if (!last || running.value) return;
    if (last.date !== todayStr()) {
        confirmNewDay.value = true; // don't silently back-date onto an old entry
        return;
    }
    act(() => showEntry(api.startTimer({ project_id: last.project_id, entry_id: last.entry_id })));
};

const startFreshToday = () => {
    const last = lastTimer.value;
    confirmNewDay.value = false;
    if (!last) return;
    act(() => showEntry(api.startTimer({ project_id: last.project_id, task_id: last.task_id, notes: last.notes })));
};

// Minutes the running timer has accrued beyond the stored `minutes` the
// server summed — added to every total the timer belongs in, on each tick.
const runningExtra = computed(() => (running.value ? Math.max(0, elapsed(running.value) - running.value.minutes) : 0));

// The row shows the project's client and code above and before its name; the
// entry itself only carries the name, the rest comes from the sheet's projects.
const projectOf = (entry: Entry) => sheet.value?.projects.find((p) => p.id === entry.project_id) ?? null;

const statsFor = (entry: Entry): ProjectStats | null => {
    const stats = sheet.value?.project_stats?.[entry.project_id];
    if (!stats) return null;
    const r = running.value;
    if (!r || r.project_id !== entry.project_id || !runningExtra.value) return stats;
    return {
        ...stats,
        total_minutes: stats.total_minutes + runningExtra.value,
        uninvoiced_minutes: stats.uninvoiced_minutes + (r.is_billable ? runningExtra.value : 0),
    };
};
const budgetClass = (pct: number) => {
    if (pct > 100) return 'over';
    if (pct > 80) return 'high';
    if (pct > 50) return 'mid';
    return 'ok';
};

const shortDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(intlLocale.value, { month: 'short', day: 'numeric', year: 'numeric' });

// ---- idle detection (Harvest-style) ----------------------------------------
//
// The OS idle counter is watched from a native thread (src-tauri/src/lib.rs):
// webview timers are throttled or paused while the popover is hidden, and the
// counter does not tick through system sleep, so polling from here missed
// long absences. The frontend only tells Rust the threshold (0 = off), decides
// whether the return is worth asking about, and points Rust at the row the
// prompt should hang from. The prompt itself is a window of its own (it used
// to be a callout in this DOM, which the window frame clipped); its two
// answers come back as an `idle-choice` event, and what they mean stays here.

const idlePrompt = ref<{ startedAt: number; minutes: number } | null>(null);
let idleUnlisten: UnlistenFn | null = null;
let idleChoiceUnlisten: UnlistenFn | null = null;

const syncIdleThreshold = () => {
    const seconds = prefs.value.idleEnabled && running.value ? Math.max(1, prefs.value.idleMinutes) * 60 : 0;
    invoke('set_idle_threshold', { seconds }).catch(() => {});
};
watch([() => prefs.value.idleEnabled, () => prefs.value.idleMinutes, () => running.value?.id ?? null], syncIdleThreshold);

/**
 * The running entry's stop button, once it is on screen. Switching day starts
 * a fetch, so the row the prompt points at may still be on its way; give it a
 * moment rather than anchoring to nothing.
 */
const runningStopButton = async (timeoutMs = 1500): Promise<HTMLElement | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await nextTick();
        const button = document.querySelector<HTMLElement>('.entry.running .entry-btn.stop');
        if (button) return button;
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const onIdleReturn = async (payload: { started_at_ms: number; seconds: number }) => {
    if (!running.value || idlePrompt.value) return;
    const minutes = idleMinutes(payload.seconds);
    idlePrompt.value = { startedAt: payload.started_at_ms, minutes };
    if (view.value !== 'main') view.value = 'main';
    // The user has been away from the machine, so nothing laid over the
    // timesheet is still what they are doing — and an open sheet would cover
    // the ■ the prompt is about to be anchored to. Rust's `popover-visible`
    // covers the popover having been hidden; this covers it having been up.
    settleAfterAbsence(Number.POSITIVE_INFINITY);
    // the prompt hangs from the running entry, so show the day it lives on
    // (a timer left running overnight sits on yesterday) and bring it into view
    if (running.value.date !== selectedDate.value) goDate(running.value.date);
    const button = await runningStopButton();
    button?.scrollIntoView({ block: 'nearest' });
    // Hand Rust that button's rect in CSS pixels: it places the prompt window
    // against it, or under the menubar icon when there is nothing to point at.
    const rect = button?.getBoundingClientRect();
    const anchor = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
    invoke('show_idle_prompt', { minutes, anchor }).catch(() => {});
};

/** Map the prompt's two answers onto the API: removing is one call, keeping-and-stopping is a plain stop. */
const applyIdleChoice = async (choice: { remove: boolean; stop: boolean }) => {
    const { action, stopAfter } = resolveIdleChoice(choice);
    await resolveIdle(action);
    if (stopAfter) stopTimer();
};

const resolveIdle = async (action: 'keep' | 'discard_keep' | 'discard_stop') => {
    const prompt = idlePrompt.value;
    idlePrompt.value = null;
    // the popover only opened for this question: tuck it away again — through
    // Rust, so it is one hide like any other and the window says it went away
    invoke('hide_popover').catch(() => {});
    if (!prompt || action === 'keep') return;
    try {
        await api.idleTimer({ idle_started_at: new Date(prompt.startedAt).toISOString(), action });
        await refresh();
        updateTray();
    } catch {
        // the next refresh will show the true state either way
    }
};

// ---- actions ---------------------------------------------------------------

const act = async (fn: () => Promise<unknown>) => {
    try {
        await fn();
        await refresh();
        updateTray();
    } catch (e: any) {
        errorMessage.value = e.message === 'unauthenticated' ? '' : e.message;
    }
};

const stopTimer = () => act(() => api.stopTimer());
const resumeEntry = (id: string, projectId: string) => act(() => showEntry(api.startTimer({ project_id: projectId, entry_id: id })));

const deleteFromSheet = () => {
    const id = editingEntry.value?.id;
    formOpen.value = false;
    editingEntry.value = null;
    if (id) act(() => api.deleteEntry(id));
};

// ---- new entry form --------------------------------------------------------

const formOpen = ref(false);
const editingEntry = ref<Entry | null>(null);
const notesEl = ref<HTMLTextAreaElement | null>(null);
const projectPicker = ref<InstanceType<typeof ProjectPicker> | null>(null);
const autosizeNotes = () => {
    const el = notesEl.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
};
const form = ref<EntryDraft>({ project_id: '', task_id: '', notes: '', duration: '', date: '' });
const formProject = computed(() => sheet.value?.projects.find((p) => p.id === form.value.project_id));
let openedDuration = ''; // the prefill — only a changed duration rebases a live timer
// The whole sheet as it was prefilled, so "did the user type anything?" is a
// comparison rather than a guess (see popover.ts).
let openedForm: EntryDraft = { project_id: '', task_id: '', notes: '', duration: '', date: '' };
/** A new entry the user had started when the popover went away for good; the next ＋ hands it back. */
const stashedDraft = ref<StashedDraft | null>(null);
/** Whether the sheet on screen is that draft, so it can say where it came from. */
const draftRestored = ref(false);
watch(formOpen, (open) => {
    if (!open) draftRestored.value = false;
});

const openForm = () => {
    editingEntry.value = null;
    openedDuration = '';
    openedForm = { project_id: sheet.value?.projects[0]?.id ?? '', task_id: '', notes: '', duration: '', date: selectedDate.value };
    // work typed before the popover was put away comes back rather than being lost
    const draft = takeDraft(stashedDraft.value, Date.now());
    stashedDraft.value = null;
    draftRestored.value = !!draft;
    form.value = { ...(draft ?? openedForm) };
    formOpen.value = true;
    nextTick(() => {
        autosizeNotes();
        // Land in the project search, so a new timer is "＋, type, Enter" with
        // no click in between (board card #146). Not for a restored draft:
        // that sheet already holds a project the user picked, and covering it
        // with an empty search box would read as having lost it.
        if (!draftRestored.value) projectPicker.value?.open();
    });
};

const openEdit = (entry: Entry) => {
    if (entry.locked || sheet.value?.week_locked) return;
    editingEntry.value = entry;
    openedDuration = formatMinutes(elapsed(entry));
    openedForm = {
        project_id: entry.project_id,
        task_id: entry.task_id ?? '',
        notes: entry.notes ?? '',
        duration: openedDuration,
        date: entry.date,
    };
    draftRestored.value = false;
    form.value = { ...openedForm };
    formOpen.value = true;
    nextTick(autosizeNotes);
};

const submitForm = () =>
    act(async () => {
        const minutes = form.value.duration ? parseDuration(form.value.duration) : null;
        const payload = {
            project_id: form.value.project_id,
            task_id: form.value.task_id || null,
            notes: form.value.notes || null,
        };
        if (editingEntry.value) {
            // an untouched duration means "leave the clock alone"
            const durationChanged = form.value.duration !== openedDuration;
            await api.updateEntry(editingEntry.value.id, {
                ...payload,
                date: form.value.date,
                ...(durationChanged && minutes !== null ? { minutes } : {}),
            });
        } else if (minutes !== null && minutes > 0) {
            await showEntry(api.addEntry({ ...payload, date: form.value.date || selectedDate.value, minutes }));
        } else {
            await showEntry(api.startTimer(payload));
        }
        formOpen.value = false;
        editingEntry.value = null;
    });

// ---- the menubar pill as a play/pause button -------------------------------
//
// Clicking the tray icon presses play/pause on the timer instead of opening
// the popover (board card #34). Rust owns the click and the running flag it
// was last handed by updateTray(), but not the API — so it sends one of two
// events and this window does the work, with the same calls the list's own ■
// and ＋ buttons make. Secondary click still toggles the popover, so the week,
// insights and settings stay reachable without stopping the clock.

let trayPauseUnlisten: UnlistenFn | null = null;
let trayPlayUnlisten: UnlistenFn | null = null;
/** The presets hotkey's event; the list itself lives in the presets section below. */
let presetsUnlisten: UnlistenFn | null = null;

/**
 * The pill's play/pause button, opening nothing: the stop the running entry's
 * ■ performs, or — on a paused pill — the ▶ of the entry the pill shows.
 */
const onTrayToggle = () => {
    // Rust's view of the pill can only be a beat behind this window's own (a
    // timer stopped in the browser, say); doing nothing leaves the next click
    // — after the refresh that corrects the pill — to get it right.
    if (running.value) {
        stopTimer();
        return;
    }
    // the pill's ▶ acts on the entry the pill is showing — the same `active`
    const paused = activeEntry.value;
    if (!paused || paused.locked || sheet.value?.week_locked || view.value !== 'main') return;
    resumeEntry(paused.id, paused.project_id);
};

/** The idle pill ("zzzz"): nothing to resume, so land in the same new-entry sheet the ＋ button opens. */
const onTrayPlay = () => {
    // Rust has already shown the popover; on the connect screen, or a week the
    // server has locked, that is all there is to offer — there is nothing to
    // start a timer against.
    if (view.value !== 'main' || sheet.value?.week_locked) return;
    openForm();
};

// ---- popovers --------------------------------------------------------------

const settingsOpen = ref(false);

// The settings popout is two tabs over one panel (board card #145): the
// preferences it has always held, and the five shortcut recorders that were
// added underneath them. Everything else in the popout — who is signed in, the
// links, the build line — is chrome for the whole thing and sits outside both.
const SETTINGS_TABS = ['preferences', 'shortcuts', 'focus'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
    preferences: 'settings.tabSettings',
    shortcuts: 'settings.tabShortcuts',
    focus: 'focus.tab',
};
/**
 * The tab on show. It is reset every time the popout opens rather than
 * remembered: the gear is labelled "Settings", so that is what it should
 * open on, and the window's height follows the tab — a remembered one would
 * have the popover open at a height decided by something the user did days
 * ago.
 */
const settingsTab = ref<SettingsTab>('preferences');

// Arrow keys move between tabs and take focus with them (WAI-ARIA's tabs
// pattern); a tab switches as it is selected, which is free here because both
// panels are already built. While a row is recording, every key belongs to the
// recorder instead — see `onKeydown`.
const onSettingsTabKeydown = (e: KeyboardEvent) => {
    if (recording.value) return;
    const at = SETTINGS_TABS.indexOf(settingsTab.value);
    const last = SETTINGS_TABS.length - 1;
    let next: number;
    if (e.key === 'ArrowRight') next = at === last ? 0 : at + 1;
    else if (e.key === 'ArrowLeft') next = at === 0 ? last : at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    settingsTab.value = SETTINGS_TABS[next];
    (((e.currentTarget as HTMLElement).children[next] as HTMLElement | undefined) ?? null)?.focus();
};

// Window height per state. The connect screen is a compact fixed card. The
// timesheet sizes itself to the day (fitPopover): the entries list gets room
// for 3.5 to 5.5 rows and only scrolls past that — the half row peeking out at
// the bottom is the cue that there is more. Insights is a window of its own
// (src/Insights.vue), so nothing else resizes this one.
const mainEl = ref<HTMLElement | null>(null);
const entriesEl = ref<HTMLElement | null>(null);
// A row as last measured, for days with no rows of their own to measure. The
// initial guess is a row with its project-stats line; it is replaced by the
// real thing the first time a day with entries is shown.
let rowHeight = 70;
let lastFit = '';

/** Height of an element including its vertical margins (the banners have some). */
const outerHeight = (el: Element) => {
    const style = getComputedStyle(el);
    return el.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
};

/**
 * The height the window would need for the settings popout to be read without
 * scrolling, or 0 when it is closed (board card #145). The popout is anchored
 * 42px above the window's foot and keeps 8px above itself, and its border is
 * outside the scrollHeight — hence the 52.
 *
 * This is a measurement, not a constant, so splitting the popout into tabs
 * lowered it by itself: what is asked for is the tab on show, not the two
 * stacked. `settingsTab` is watched alongside `settingsOpen` so switching tabs
 * re-measures.
 *
 * Only the settings popout asks for this. The presets list is a list: it is
 * meant to scroll past a few rows, and resizing the window on every keystroke
 * in its search box would be worse than the scrollbar.
 */
const POPOUT_MARGIN = 52;
const settingsFloor = (): number => {
    const popout = mainEl.value?.querySelector<HTMLElement>('.settings');
    return popout ? popout.scrollHeight + POPOUT_MARGIN : 0;
};

/**
 * Measure what is on screen and let Rust size the window: the chrome around
 * the list (header, week strip, banners, footer — whatever is there right now),
 * the average entry row, how many rows the day has, what else sits in the
 * list, and the floor an open popout sets. Rust owns the 3.5–5.5 row clamp and
 * the screen fit (`fit_popover`).
 */
const fitPopover = async () => {
    await nextTick();
    const main = mainEl.value;
    const list = entriesEl.value;
    if (view.value !== 'main' || !main || !list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.entry'));
    if (rows.length) rowHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) / rows.length;
    // in-flow siblings of the list; the popovers and sheets are absolute overlays
    const chrome = Array.from(main.children)
        .filter((el) => el !== list && getComputedStyle(el).position !== 'absolute')
        .reduce((sum, el) => sum + outerHeight(el), 0);
    // non-row content inside the list: an error or locked-week note above the
    // rows, the padding below them (the empty-day placeholder fills whatever
    // height the list gets, so it does not count)
    const extra =
        Array.from(list.children)
            .filter((el) => !el.classList.contains('entry') && !el.classList.contains('empty'))
            .reduce((sum, el) => sum + outerHeight(el), 0) + parseFloat(getComputedStyle(list).paddingBottom);
    const floor = settingsFloor();
    const key = [chrome, rowHeight, rows.length, extra, floor].map((n) => Math.round(n * 10)).join('|');
    if (key === lastFit) return; // nothing that affects the height has changed
    lastFit = key;
    invoke('fit_popover', { chrome, row: rowHeight, entries: rows.length, extra, floor }).catch(() => {});
};

watch(
    view,
    (v) => {
        if (v === 'main') {
            fitPopover();
            return;
        }
        try {
            getCurrentWindow()
                .setSize(new LogicalSize(380, 240))
                .catch(() => {});
        } catch {
            // not inside Tauri (plain-browser vite dev) — nothing to resize
        }
    },
    { immediate: true },
);
// Every refresh replaces `sheet`, so this covers entries coming and going, a
// timer starting or stopping, the running-elsewhere and resume banners, a
// locked week and the stats lines; the rest changes the chrome or row text.
// `settingsOpen` is in there because that popout sets a floor under the
// window's height while it is up, and gives it back on the way out;
// `settingsTab` because its two tabs are not the same height.
watch([sheet, lastTimer, errorMessage, loading, intlLocale, settingsOpen, settingsTab], fitPopover, { flush: 'post' });

// who's signed in + which build — shown in the settings popout
const me = ref<{ name: string; email: string } | null>(null);
const appVersion = ref('');

watch(
    view,
    (v) => {
        if (v === 'main' && !me.value) {
            api.me()
                .then((u) => (me.value = u))
                .catch(() => {});
        }
    },
    { immediate: true },
);
getVersion()
    .then((v) => (appVersion.value = v))
    .catch(() => {});

// ---- insights --------------------------------------------------------------
//
// The stats, the uninvoiced breakdown and the charts have their own window
// (src/Insights.vue, opened by Rust) — this popover is 380x330 and had to
// scroll them inside an overlay. Only the header button's pressed state lives
// here; Rust says when the panel goes away by itself (focus left the app, the
// menubar icon was clicked), so the button never lies about it.

const insightsOpen = ref(false);
let insightsUnlisten: UnlistenFn | null = null;

const toggleInsights = async () => {
    settingsOpen.value = false;
    closePresets();
    insightsOpen.value = await invoke<boolean>('toggle_insights').catch(() => false);
};

const closeInsights = () => {
    insightsOpen.value = false;
    invoke('close_insights').catch(() => {});
};

onMounted(() => {
    listen<boolean>('insights-visible', (e) => (insightsOpen.value = e.payload)).then((off) => (insightsUnlisten = off));
});
onUnmounted(() => insightsUnlisten?.());

// ---- focus tracking --------------------------------------------------------
//
// Board card #401. Rust records which app and window were in front into a
// local file (src-tauri/src/focus.rs); the Focus tab in Insights shows the day
// and suggests entries. This window owns only the opt-in, the exclude list,
// the delete button — and the new-entry sheet a suggestion opens, prefilled
// but not saved.

/** Whether the OS lets us read window titles (macOS: Accessibility); app names need nothing. */
const focusTitlesAllowed = ref(true);
const focusSupported = ref(true);
/** "Delete focus history" asks once more before it deletes. */
const focusDelete = ref<'idle' | 'confirm' | 'done'>('idle');

const checkFocusPermission = async () => {
    focusSupported.value = await invoke<boolean>('focus_supported').catch(() => true);
    focusTitlesAllowed.value = await invoke<boolean>('focus_titles_allowed').catch(() => true);
};
const requestFocusTitles = () => {
    invoke('focus_request_titles').catch(() => {});
    // the answer arrives in System Settings, not here; look again when the user is back
    setTimeout(checkFocusPermission, 4000);
};
const deleteFocusHistory = () => {
    if (focusDelete.value !== 'confirm') {
        focusDelete.value = 'confirm';
        return;
    }
    invoke('focus_clear').catch(() => {});
    focusDelete.value = 'done';
};
watch(settingsTab, (tab) => {
    focusDelete.value = 'idle';
    if (tab === 'focus') checkFocusPermission();
});

let focusLogUnlisten: UnlistenFn | null = null;
/** A suggestion from the Focus tab: the sheet opens filled in, and nothing is saved until Log. */
const openFocusSuggestion = (d: { project_id: string; task_id: string | null; minutes: number; notes: string }) => {
    if (view.value !== 'main' || sheet.value?.week_locked) return;
    settingsOpen.value = false;
    closePresets();
    const draft: EntryDraft = { project_id: d.project_id, task_id: d.task_id ?? '', notes: d.notes, duration: formatMinutes(d.minutes), date: toDateString(new Date()) };
    editingEntry.value = null;
    openedDuration = '';
    openedForm = { ...draft };
    draftRestored.value = false;
    form.value = { ...draft };
    formOpen.value = true;
    nextTick(autosizeNotes);
};
onMounted(() => {
    listen<{ project_id: string; task_id: string | null; minutes: number; notes: string }>('focus-log', (e) => openFocusSuggestion(e.payload)).then((off) => (focusLogUnlisten = off));
});
onUnmounted(() => focusLogUnlisten?.());

// ---- presets ---------------------------------------------------------------
//
// A preset is a saved starting point for a timer — a project and a task, the
// client coming along with the project the way the picker already groups it.
// The ☆ beside ＋ opens the list, the entry sheet saves what it is showing
// into it, and a row starts that timer in one press.
//
// They live in localStorage next to the preferences (src/presets.ts says why,
// and holds every rule worth testing); this file only wires the list up to the
// popover. A preset belongs to the workspace it was saved on, so the list is
// `presetsFor(auth.workspace)` and never offers a project this workspace has
// never heard of.

const presets = ref<Preset[]>([]);
try {
    presets.value = readPresets(JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]'));
} catch {
    /* none saved, or storage we can't read */
}
watch(
    presets,
    (list) => {
        try {
            localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
        } catch {
            /* private mode */
        }
    },
    { deep: true },
);

const presetsOpen = ref(false);
const presetQuery = ref('');
const presetSearchEl = ref<HTMLInputElement | null>(null);
/** The row being renamed, and the name being typed into it. */
const renamingPreset = ref<string | null>(null);
const renameDraft = ref('');
/** The row whose ✕ has been pressed once; a second press deletes it. */
const confirmingDelete = ref<string | null>(null);

/** This workspace's presets, resolved against the project list the sheet is showing. */
const presetList = computed(() => presetRows(presetsFor(presets.value, auth.workspace), sheet.value?.projects ?? []));
const visiblePresets = computed(() => filterPresets(presetList.value, presetQuery.value));

const openPresets = () => {
    // a locked week has nothing to start, the same reason ＋ is not offered
    if (view.value !== 'main' || sheet.value?.week_locked) return;
    // both popouts hang off the footer and share one backdrop, so only one is
    // ever up: a click on ☆ with the settings open never gets past the
    // backdrop, but the hotkey does
    settingsOpen.value = false;
    presetQuery.value = '';
    renamingPreset.value = null;
    confirmingDelete.value = null;
    presetsOpen.value = true;
    nextTick(() => presetSearchEl.value?.focus());
};

const closePresets = () => {
    presetsOpen.value = false;
    renamingPreset.value = null;
    confirmingDelete.value = null;
};

const togglePresets = () => (presetsOpen.value ? closePresets() : openPresets());

/** One press: the list goes away and the timer is running. */
const startFromPreset = (row: PresetRow) => {
    if (row.missing) return;
    closePresets();
    act(() => showEntry(api.startTimer({ project_id: row.preset.project_id, task_id: row.preset.task_id || null })));
};

const beginRename = (row: PresetRow) => {
    confirmingDelete.value = null;
    renamingPreset.value = row.preset.id;
    renameDraft.value = row.preset.name;
    nextTick(() => document.querySelector<HTMLInputElement>('.preset-rename')?.select());
};

/** Enter, the ✓, or the field losing focus — all the same thing. An empty name is refused by renamePreset. */
const commitRename = () => {
    const id = renamingPreset.value;
    renamingPreset.value = null;
    if (id) presets.value = renamePreset(presets.value, id, renameDraft.value);
};

/** Two presses, because there is no undo: the first arms the row, the second removes it. */
const deletePreset = (row: PresetRow) => {
    if (confirmingDelete.value !== row.preset.id) {
        confirmingDelete.value = row.preset.id;
        return;
    }
    confirmingDelete.value = null;
    presets.value = removePreset(presets.value, row.preset.id);
};

/** The starting point the new-entry sheet describes right now, or null until it has a project. */
const formPreset = computed(() =>
    form.value.project_id
        ? {
              name: defaultPresetName(formProject.value, form.value.task_id),
              project_id: form.value.project_id,
              task_id: form.value.task_id,
              workspace: auth.workspace,
          }
        : null,
);
/** Already in the list — so the control says so rather than offering a duplicate. */
const formPresetSaved = computed(() => !!formPreset.value && hasPreset(presets.value, formPreset.value));

const savePresetFromForm = () => {
    const draft = formPreset.value;
    if (draft) presets.value = savePreset(presets.value, draft);
};

// ---- keyboard shortcuts ----------------------------------------------------
//
// System-wide hotkeys for start/stop, a new timer, the popover, insights and
// the presets list. Rust owns the registration (it is the side that can act
// while another app has focus, and several of the actions are its own
// windows); this side owns the bindings — recording them, storing them with
// the other preferences, and handing each one over through `set_shortcut`,
// which is also what replays them at launch. See src/shortcuts.ts for the
// accelerator strings on the wire.
//
// The two that open something in this window (a new timer, the presets list)
// arrive as events Rust emits after it has shown the popover, so a hotkey and
// the ＋ / ☆ buttons end in the same call.

/** The row being recorded right now, if any. */
const recording = ref<ShortcutAction | null>(null);
/** Rows whose combination the system refused, so the row can say so. */
const shortcutTaken = ref<Partial<Record<ShortcutAction, boolean>>>({});

const shortcutLabels: Record<ShortcutAction, string> = {
    toggleTimer: 'settings.shortcutToggleTimer',
    newTimer: 'settings.shortcutNewTimer',
    togglePopover: 'settings.shortcutTogglePopover',
    toggleInsights: 'settings.shortcutToggleInsights',
    showPresets: 'settings.shortcutShowPresets',
};

/** Hand one binding (or '' to unbind) to Rust. False when it was refused. */
const applyShortcut = async (action: ShortcutAction, accel: string): Promise<boolean> => {
    let ok = false;
    try {
        await invoke('set_shortcut', { action, accelerator: accel || null });
        ok = true;
    } catch {
        /* the system refused the combination — or there is no Tauri to ask (plain-browser dev) */
    }
    shortcutTaken.value = { ...shortcutTaken.value, [action]: !ok };
    return ok;
};

/**
 * Bind what was just recorded. A combination can only mean one thing, so the
 * row that held it gives it up first — both because that is the rule and
 * because the system would otherwise refuse the new binding as taken.
 */
const setShortcut = async (action: ShortcutAction, accel: string) => {
    const next = assignShortcut(prefs.value.shortcuts, action, accel);
    const displaced = SHORTCUT_ACTIONS.filter((a) => a !== action && prefs.value.shortcuts[a] && !next[a]);
    for (const a of displaced) await applyShortcut(a, '');
    if (await applyShortcut(action, accel)) {
        prefs.value.shortcuts = next;
        return;
    }
    // refused: leave every row exactly as it was, including the displaced one
    for (const a of displaced) await applyShortcut(a, prefs.value.shortcuts[a]);
};

const clearShortcut = async (action: ShortcutAction) => {
    await applyShortcut(action, '');
    prefs.value.shortcuts = { ...prefs.value.shortcuts, [action]: '' };
    shortcutTaken.value = { ...shortcutTaken.value, [action]: false };
};

const startRecording = (action: ShortcutAction) => {
    recording.value = action;
    shortcutTaken.value = { ...shortcutTaken.value, [action]: false };
};

// Closing the popover (Escape, the backdrop, the insights button) abandons a
// recording rather than leaving it swallowing every keypress — and so does
// leaving the tab the recorder is on. Opening the popout always lands on
// Settings (see `settingsTab`).
watch(settingsOpen, (open) => {
    recording.value = null;
    if (open) settingsTab.value = 'preferences';
});
watch(settingsTab, () => (recording.value = null));

onMounted(() => {
    // The system forgets our registrations when the app quits, so every launch
    // hands the saved bindings back; one the machine has since given to
    // another app comes back refused and says so in its row.
    for (const action of SHORTCUT_ACTIONS) {
        if (prefs.value.shortcuts[action]) applyShortcut(action, prefs.value.shortcuts[action]);
    }
});

// ---- coming back to the popover -------------------------------------------
//
// The window is hidden, not closed, so this component is never torn down: an
// unfinished sheet, the settings popout and a half-recorded shortcut are all
// still on screen the next time the menubar icon is clicked — which is board
// card #141. Rust says when the window goes away and when it comes back
// (there is no window event for visibility, and a blur is not a hide when
// "hide when changing focus" is off), and the interval between the two is the
// only thing that can tell a glance at another app from a real absence.
// src/popover.ts holds the rule.

let hiddenAt = 0;
let popoverUnlisten: UnlistenFn | null = null;

const sheetKind = (): SheetKind => (!formOpen.value ? 'none' : editingEntry.value ? 'edit' : 'new');

/** Back to the plain timesheet, keeping a started entry if there is one to keep. */
const clearOverlays = (stash: boolean) => {
    if (stash) stashedDraft.value = { draft: { ...form.value }, at: Date.now() };
    formOpen.value = false;
    editingEntry.value = null;
    settingsOpen.value = false;
    confirmNewDay.value = false;
    recording.value = null;
    closePresets();
};

/** Decide what an absence of `awayMs` does to what is on screen. `Infinity` = the user was away from the machine. */
const settleAfterAbsence = (awayMs: number) => {
    const plan = planReopen({ awayMs, sheet: sheetKind(), dirty: draftTouched(form.value, openedForm) });
    if (plan.clear) clearOverlays(plan.stash);
};

const onPopoverVisible = (visible: boolean) => {
    if (!visible) {
        hiddenAt = Date.now();
        return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    settleAfterAbsence(away);
};

onMounted(() => {
    listen<boolean>('popover-visible', (e) => onPopoverVisible(e.payload)).then((off) => (popoverUnlisten = off));
});
onUnmounted(() => popoverUnlisten?.());

// Escape dismisses the settings and presets popovers (click-away is the
// backdrop); the insights window handles its own Escape. While a row is
// recording, every keypress belongs to the recorder instead — Escape included,
// which cancels it rather than closing the settings underneath. A preset being
// renamed swallows its own Escape too, so the field is abandoned without the
// list going with it.
const onKeydown = (e: KeyboardEvent) => {
    const action = recording.value;
    if (action) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
            recording.value = null;
            return;
        }
        const accel = accelerator(e);
        if (!accel) return; // a modifier still on its own, or a combination we can't bind: keep listening
        recording.value = null;
        setShortcut(action, accel);
        return;
    }
    if (e.key !== 'Escape') return;
    if (presetsOpen.value) closePresets();
    else if (settingsOpen.value) settingsOpen.value = false;
    else return;
    e.preventDefault();
};
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
    <!-- ======== connect ======== -->
    <div v-if="view === 'connect'" class="connect">
        <div class="connect-logo">Zebu</div>

        <template v-if="connectState !== 'waiting'">
            <label class="field">
                <span class="field-label">{{ t('connect.workspace') }}</span>
                <span class="field-row">
                    <input
                        v-model="workspaceInput"
                        type="text"
                        autocapitalize="none"
                        autocorrect="off"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="studio"
                        @keyup.enter="connect"
                    />
                    <!-- the fixed part of the address; hidden once someone pastes a full one -->
                    <span v-if="!workspaceInput.includes('.')" class="field-suffix">.{{ DEFAULT_DOMAIN }}</span>
                </span>
                <span class="hint">{{ t('connect.workspaceHint') }}</span>
            </label>
            <button class="btn-primary" :disabled="connecting || !workspaceInput.trim()" @click="connect">{{ t('connect.login') }}</button>
            <!-- fixed-height status line so an error doesn't reflow the buttons -->
            <p class="error status">{{ connectError }}</p>
        </template>

        <template v-else>
            <div class="spinner"></div>
            <p class="muted">{{ t('connect.waiting') }}</p>
            <button class="link" @click="openUrl(verificationUrl)">{{ t('connect.reopen') }}</button>
            <button class="link" @click="cancelConnect">{{ t('common.cancel') }}</button>
        </template>
    </div>

    <!-- ======== main ======== -->
    <div v-else ref="mainEl" class="main">
        <header class="header">
            <span class="header-title">{{ headerLabel }}</span>
            <div class="header-actions">
                <button v-if="!isToday" :title="t('header.jumpToToday')" @click="goDate(todayStr())">{{ t('header.today') }} ⤴︎</button>
                <!-- opens the insights panel in its own window (src-tauri: toggle_insights) -->
                <button :title="t('header.insights')" :class="{ active: insightsOpen }" @click="toggleInsights">
                    <svg class="icon-chart" viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
                        <rect x="1" y="7" width="3" height="6" rx="1" />
                        <rect x="5.5" y="4" width="3" height="9" rx="1" />
                        <rect x="10" y="1" width="3" height="12" rx="1" />
                    </svg>
                </button>
            </div>
        </header>

        <!-- week strip -->
        <div class="week">
            <button class="week-nav" @click="shiftWeek(-1)">‹</button>
            <button
                v-for="day in weekDays"
                :key="day.date"
                class="day"
                :class="{ selected: day.date === selectedDate }"
                @click="goDate(day.date)"
            >
                <span class="day-letter">{{ day.letter }}</span>
                <span class="day-total">{{ formatMinutes(day.minutes) }}</span>
            </button>
            <button class="week-nav" @click="shiftWeek(1)">›</button>
        </div>

        <!-- one-click resume of the last managed timer when nothing runs -->
        <button v-if="!running && lastTimer" class="running-elsewhere resume-last" @click="resumeLast">
            <span class="resume-play">▶</span>
            <span class="running-elsewhere-text">
                {{ t('timer.resume') }} — {{ lastTimer.project }}<template v-if="lastTimer.task"> · {{ lastTimer.task }}</template>
            </span>
        </button>

        <!-- a timer running on a different day than the one shown: pinned
             above the list so it neither scrolls nor pushes content around -->
        <button v-if="runningElsewhere" class="running-elsewhere" @click="goDate(runningElsewhere.date)">
            <span class="re-head">
                <span class="dot-live"></span>
                <span class="running-elsewhere-text">{{ t('timer.runningSince', { date: shortDate(runningElsewhere.date) }) }}</span>
                <span class="running-elsewhere-jump">⤴︎</span>
            </span>
            <span class="re-divider"></span>
            <span class="re-entry">
                <span class="re-text">
                    <span class="re-project">{{ runningElsewhere.project }}</span>
                    <span class="re-sub">{{ [runningElsewhere.task, runningElsewhere.notes].filter(Boolean).join(' — ') || '&nbsp;' }}</span>
                </span>
                <span class="running-elsewhere-time">{{ formatMinutes(elapsed(runningElsewhere)) }}</span>
            </span>
        </button>

        <!-- entries: the window is sized around this list, see fitPopover -->
        <main ref="entriesEl" class="entries">
            <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
            <p v-if="sheet?.week_locked" class="muted locked-note">{{ t('entry.weekLocked') }}</p>

            <div v-if="!dayEntries.length && !loading" class="empty" :class="{ raised: runningElsewhere || (!running && lastTimer) }">
                <button class="btn-outline" @click="openForm">{{ isToday ? t('timer.startTimer') : t('timer.addEntry') }}</button>
            </div>

            <div v-for="entry in dayEntries" :key="entry.id" class="entry" :class="{ running: entry.timer_started_at }">
                <div
                    class="entry-text"
                    :class="{ editable: !entry.locked && !sheet?.week_locked }"
                    :title="!entry.locked && !sheet?.week_locked ? t('entry.edit') : undefined"
                    @click="openEdit(entry)"
                >
                    <!-- client / [code] project / task — notes / totals -->
                    <span v-if="projectOf(entry)?.client" class="entry-client">{{ projectOf(entry)!.client }}</span>
                    <span class="entry-project">
                        <span v-if="projectOf(entry)?.code" class="entry-code">{{ projectOf(entry)!.code }}</span>
                        {{ entry.project }}
                        <span v-if="waitingLabel(entry)" class="entry-waiting" :class="{ live: entry.agent_waiting }">⏳ {{ waitingLabel(entry) }}</span>
                    </span>
                    <span class="entry-sub">{{ [entry.task, entry.notes].filter(Boolean).join(' — ') || '&nbsp;' }}</span>
                    <span v-if="statsFor(entry)" class="entry-stats">
                        <!-- prose, not a column: plain "4h 5m", never padded (figure
                             spaces read as stray gaps inside a sentence) -->
                        <span class="entry-stats-dim">
                            {{ t('entry.total') }}: {{ formatDurationHuman(statsFor(entry)!.total_minutes) }} · {{ t('entry.uninvoiced') }}:
                            {{ formatDurationHuman(statsFor(entry)!.uninvoiced_minutes) }}
                        </span>
                        <!-- only projects with a budget get a budget line -->
                        <template v-if="statsFor(entry)!.budget_pct !== null">
                            <span class="entry-stats-dim"> · </span>
                            <span class="budget-pill" :class="budgetClass(statsFor(entry)!.budget_pct!)">{{ t('entry.budget') }}: {{ statsFor(entry)!.budget_pct }}%</span>
                        </template>
                    </span>
                </div>
                <span class="entry-time">{{ formatMinutes(elapsed(entry)) }}</span>
                <!-- the idle prompt hangs from this button, in its own window (src-tauri: show_idle_prompt) -->
                <button v-if="entry.timer_started_at" class="entry-btn stop" :title="t('timer.stop')" @click="stopTimer">■</button>
                <button
                    v-else-if="!entry.locked && !sheet?.week_locked"
                    class="entry-btn play"
                    :title="t('timer.startHint')"
                    @click="resumeEntry(entry.id, entry.project_id)"
                >
                    ▶
                </button>
                <span v-if="entry.locked" class="entry-lock" :title="t('entry.invoiced')">🔒</span>
            </div>
        </main>

        <!-- resuming an entry from an earlier day starts a fresh one today -->
        <div v-if="confirmNewDay" class="sheet-overlay" @click.self="confirmNewDay = false">
            <div class="sheet">
                <p class="sheet-title">{{ t('newDay.title') }}</p>
                <p class="muted">{{ t('newDay.body', { date: lastTimer ? shortDate(lastTimer.date) : '' }) }}</p>
                <div class="sheet-actions">
                    <button class="btn-outline" @click="confirmNewDay = false">{{ t('common.cancel') }}</button>
                    <button class="btn-primary" @click="startFreshToday">{{ t('newDay.confirm') }}</button>
                </div>
            </div>
        </div>

        <!-- a newer release is available -->
        <div v-if="updatePromptOpen" class="sheet-overlay" @click.self="dismissUpdate">
            <div class="sheet">
                <p class="sheet-title">{{ t('update.available', { version: updateVersion }) }}</p>
                <p class="muted">{{ t('update.body') }}</p>
                <div class="sheet-actions">
                    <button class="btn-outline" @click="dismissUpdate">{{ t('update.later') }}</button>
                    <button class="btn-primary" @click="installUpdate">{{ t('update.install') }}</button>
                </div>
            </div>
        </div>

        <!-- new entry sheet -->
        <div v-if="formOpen" class="sheet-overlay" @click.self="formOpen = false">
            <div class="sheet">
                <p class="sheet-title">{{ editingEntry ? t('form.editTitle') : t('form.newTitle') }}</p>
                <!-- the popover was put away mid-entry: this is what was typed then, not a fresh sheet -->
                <p v-if="draftRestored" class="muted">{{ t('form.draftRestored') }}</p>
                <ProjectPicker
                    ref="projectPicker"
                    v-model="form.project_id"
                    :projects="sheet?.projects ?? []"
                    :placeholder="t('form.addProject')"
                    :search-placeholder="t('form.searchProject')"
                    :empty="t('form.noProjects')"
                    :no-client="t('form.noClient')"
                    :create-label="t('form.newProjectLink')"
                    @create="openUrl(`${auth.workspace}/projects/create`)"
                />
                <select v-model="form.task_id">
                    <option value="">{{ t('form.addTask') }}</option>
                    <option v-for="task in formProject?.tasks ?? []" :key="task.id" :value="task.id">{{ task.name }}</option>
                </select>
                <!-- keep this project and task for next time; the ☆ in the footer is where it lands -->
                <button v-if="!editingEntry" class="link preset-save" :disabled="!form.project_id || formPresetSaved" @click="savePresetFromForm">
                    {{ formPresetSaved ? `★ ${t('presets.saved')}` : `☆ ${t('presets.save')}` }}
                </button>
                <div class="sheet-row">
                    <input v-model="form.date" type="date" class="sheet-date" />
                    <span v-if="editingEntry?.timer_started_at" class="sheet-dot" :title="t('form.timerRunning')"></span>
                    <input v-model="form.duration" class="duration" :class="{ live: editingEntry?.timer_started_at }" placeholder="0:00" />
                </div>
                <textarea
                    ref="notesEl"
                    v-model="form.notes"
                    rows="2"
                    class="sheet-notes"
                    :placeholder="t('form.notes')"
                    @input="autosizeNotes"
                ></textarea>
                <div class="sheet-actions">
                    <button v-if="editingEntry && !editingEntry.timer_started_at" class="link danger sheet-delete" @click="deleteFromSheet">
                        {{ t('form.delete') }}
                    </button>
                    <button class="btn-outline" @click="formOpen = false">{{ t('common.cancel') }}</button>
                    <button class="btn-primary" :disabled="!form.project_id" @click="submitForm">
                        {{ editingEntry ? t('form.save') : form.duration ? t('form.log') : t('form.start') }}
                    </button>
                </div>
            </div>
        </div>

        <!-- footer -->
        <footer class="footer">
            <div class="footer-left">
                <button v-if="!sheet?.week_locked" :title="t('footer.newEntry')" @click="openForm">＋</button>
                <!-- saved starting points; also reachable by hotkey (src-tauri: show_presets) -->
                <button v-if="!sheet?.week_locked" :title="t('footer.presets')" :class="{ active: presetsOpen }" @click="togglePresets">☆</button>
            </div>
            <div class="footer-right">
                <button :title="t('footer.settings')" :class="{ active: settingsOpen }" @click="settingsOpen = !settingsOpen">⚙</button>
            </div>
        </footer>

        <!-- presets: search, start, rename, delete — anchored to the ☆ it opened from -->
        <div v-if="presetsOpen" class="popover-backdrop" @click="closePresets"></div>
        <div v-if="presetsOpen" class="presets">
            <div class="pref-group presets-title">{{ t('presets.title') }}</div>
            <input
                ref="presetSearchEl"
                v-model="presetQuery"
                type="text"
                class="preset-search"
                :placeholder="t('presets.search')"
                autocomplete="off"
                spellcheck="false"
            />
            <div class="preset-rows">
                <div v-for="row in visiblePresets" :key="row.preset.id" class="preset-row" :class="{ missing: row.missing }">
                    <template v-if="renamingPreset === row.preset.id">
                        <input
                            v-model="renameDraft"
                            class="preset-rename"
                            :aria-label="t('presets.rename')"
                            spellcheck="false"
                            @keydown.enter.prevent="commitRename"
                            @keydown.esc.stop.prevent="renamingPreset = null"
                            @blur="commitRename"
                        />
                        <button class="preset-icon" :title="t('presets.done')" @mousedown.prevent="commitRename">✓</button>
                    </template>
                    <template v-else>
                        <button
                            class="preset-start"
                            :disabled="row.missing"
                            :title="row.missing ? t('presets.missing') : t('presets.start', { name: row.preset.name })"
                            @click="startFromPreset(row)"
                        >
                            <span class="preset-name">{{ row.preset.name }}</span>
                            <span class="preset-sub">{{ row.missing ? t('presets.missing') : row.subtitle }}</span>
                        </button>
                        <button v-if="confirmingDelete === row.preset.id" class="preset-confirm" @click="deletePreset(row)">
                            {{ t('presets.confirmDelete') }}
                        </button>
                        <template v-else>
                            <button class="preset-icon" :title="t('presets.rename')" @click="beginRename(row)">
                                <!-- drawn rather than a glyph: ✎ picks up an emoji face in the webview -->
                                <svg class="icon-pencil" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                                    <path d="M9.55 1.35a1.35 1.35 0 0 1 1.9 1.9l-.62.62-1.9-1.9.62-.62ZM8.22 2.68l1.9 1.9-5.26 5.26-2.4.5.5-2.4 5.26-5.26Z" />
                                </svg>
                            </button>
                            <button class="preset-icon danger" :title="t('presets.delete')" @click="deletePreset(row)">✕</button>
                        </template>
                    </template>
                </div>
                <p v-if="!presetList.length" class="preset-empty">{{ t('presets.none') }}</p>
                <p v-else-if="!visiblePresets.length" class="preset-empty">{{ t('presets.noMatch') }}</p>
            </div>
        </div>

        <div v-if="settingsOpen" class="popover-backdrop" @click="settingsOpen = false"></div>
        <div v-if="settingsOpen" class="settings">
            <div v-if="me" class="settings-user">
                <strong>{{ me.name }}</strong>
                <span class="muted">{{ me.email }}</span>
            </div>
            <hr v-if="me" class="sep" />
            <!-- Two tabs over one panel (board card #145). Only the preferences
                 are split; who is signed in, the links and the build line below
                 belong to neither tab and stay put. -->
            <div class="pref-tabs" role="tablist" :aria-label="t('footer.settings')" @keydown="onSettingsTabKeydown">
                <button
                    v-for="tab in SETTINGS_TABS"
                    :id="`settings-tab-${tab}`"
                    :key="tab"
                    class="pref-tab"
                    :class="{ selected: settingsTab === tab }"
                    type="button"
                    role="tab"
                    :aria-selected="settingsTab === tab"
                    :aria-controls="`settings-panel-${tab}`"
                    :tabindex="settingsTab === tab ? 0 : -1"
                    @click="settingsTab = tab"
                >
                    {{ t(SETTINGS_TAB_LABELS[tab]) }}
                </button>
            </div>

            <div v-if="settingsTab === 'preferences'" id="settings-panel-preferences" class="pref-panel" role="tabpanel" aria-labelledby="settings-tab-preferences">
                <label class="pref-row">
                    <span>{{ t('settings.appearance') }}</span>
                    <select v-model="prefs.appearance" class="pref-select">
                        <option value="system">{{ t('common.system') }}</option>
                        <option value="dark">{{ t('settings.dark') }}</option>
                        <option value="light">{{ t('settings.light') }}</option>
                    </select>
                </label>
                <label class="pref-row">
                    <span>{{ t('settings.language') }}</span>
                    <select v-model="prefs.language" class="pref-select">
                        <option value="system">{{ t('common.system') }}</option>
                        <option v-for="l in SUPPORTED_LOCALES" :key="l" :value="l">{{ LOCALE_NAMES[l] ?? l }}</option>
                    </select>
                </label>
                <label class="pref-row">
                    <span>{{ t('settings.dock') }}</span>
                    <input v-model="prefs.dock" type="checkbox" />
                </label>
                <label class="pref-row">
                    <span>{{ t('settings.hideOnBlur') }}</span>
                    <input v-model="prefs.hideOnBlur" type="checkbox" />
                </label>
                <label class="pref-row">
                    <span class="pref-idle-label"><input v-model="prefs.idleEnabled" type="checkbox" /> {{ t('settings.idleAfter') }}</span>
                    <span class="pref-idle">
                        <input v-model.number="prefs.idleMinutes" type="number" min="1" max="120" class="pref-num" :disabled="!prefs.idleEnabled" />
                        {{ t('settings.min') }}
                    </span>
                </label>
            </div>

            <!-- focus tracking (board #401): opt-in, local only; Rust samples, the Insights window shows it -->
            <div v-else-if="settingsTab === 'focus'" id="settings-panel-focus" class="pref-panel" role="tabpanel" aria-labelledby="settings-tab-focus">
                <label class="pref-row">
                    <span>{{ t('focus.enable') }}</span>
                    <input v-model="prefs.focusEnabled" type="checkbox" :disabled="!focusSupported" />
                </label>
                <p class="pref-note muted">{{ focusSupported ? t('focus.privacy') : t('focus.unsupported') }}</p>
                <p v-if="prefs.focusEnabled && focusSupported && !focusTitlesAllowed" class="pref-note focus-permission">
                    {{ t('focus.titlesBlocked') }}
                    <button class="link" @click="requestFocusTitles">{{ t('focus.allowTitles') }}</button>
                </p>
                <label class="pref-stack">
                    <span>{{ t('focus.exclude') }}</span>
                    <textarea v-model="prefs.focusExclude" rows="3" class="pref-exclude" spellcheck="false"></textarea>
                </label>
                <button class="link danger" @click="deleteFocusHistory">
                    {{ focusDelete === 'confirm' ? t('focus.deleteConfirm') : focusDelete === 'done' ? t('focus.deleted') : t('focus.delete') }}
                </button>
            </div>

            <!-- system-wide hotkeys; Rust registers them (src-tauri: set_shortcut) -->
            <div v-else id="settings-panel-shortcuts" class="pref-panel pref-shortcuts" role="tabpanel" aria-labelledby="settings-tab-shortcuts">
                <div v-for="action in SHORTCUT_ACTIONS" :key="action" class="pref-shortcut">
                    <div class="pref-row">
                        <span class="pref-shortcut-label">{{ t(shortcutLabels[action]) }}</span>
                        <span class="shortcut-field">
                            <button
                                class="shortcut-record"
                                :class="{ recording: recording === action, set: !!prefs.shortcuts[action] }"
                                :title="t('settings.recordShortcut')"
                                @click="recording === action ? (recording = null) : startRecording(action)"
                            >
                                {{ recording === action ? t('settings.recording') : prefs.shortcuts[action] ? formatAccelerator(prefs.shortcuts[action]) : t('settings.recordShortcut') }}
                            </button>
                            <!-- always rendered so clearing a binding can't shift the row -->
                            <button class="shortcut-clear" :class="{ empty: !prefs.shortcuts[action] }" :title="t('settings.clearShortcut')" @click="clearShortcut(action)">✕</button>
                        </span>
                    </div>
                    <div v-if="shortcutTaken[action]" class="shortcut-taken">{{ t('settings.shortcutTaken') }}</div>
                </div>
            </div>

            <hr class="sep" />
            <button class="link" @click="openUrl(auth.workspace || CENTRAL_URL)">{{ t('settings.openInBrowser') }}</button>
            <button class="link" @click="disconnect()">{{ t('settings.disconnect') }}</button>
            <button class="link" @click="invoke('quit')">{{ t('settings.quit') }}</button>
            <hr class="sep" />
            <div class="build-row">
                <span class="build-line">Zebu Desktop{{ appVersion ? ` v${appVersion}` : '' }}</span>
                <button v-if="updateStatus === 'available'" class="link update-link" @click="installUpdate">{{ t('update.installVersion', { version: updateVersion }) }}</button>
                <span v-else-if="updateStatus === 'checking'" class="muted update-status">{{ t('update.checking') }}</span>
                <span v-else-if="updateStatus === 'downloading'" class="muted update-status">{{ t('update.downloading') }}{{ updateProgress !== null ? ` ${updateProgress}%` : '' }}</span>
                <span v-else-if="updateStatus === 'installing'" class="muted update-status">{{ t('update.installing') }}</span>
                <span v-else-if="updateStatus === 'upToDate'" class="muted update-status">{{ t('update.upToDate') }}</span>
                <span v-else-if="updateStatus === 'error'" class="muted update-status">{{ t('update.failed') }}</span>
                <button v-else class="link update-link" @click="checkForUpdates(true)">{{ t('update.check') }}</button>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* ---- connect ---- */
.connect {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 28px;
    text-align: center;
}
.connect .status {
    min-height: 2.6em;
    margin: 0;
}
.connect-logo {
    font-size: 20px;
    font-weight: 700;
}
.spinner {
    width: 22px;
    height: 22px;
    border: 2.5px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
}
@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

/* ---- layout ---- */
.main {
    height: 100vh;
    display: flex;
    flex-direction: column;
    position: relative;
}
.header {
    background: linear-gradient(180deg, var(--header-from), var(--header-to));
    color: #fff;
    height: 42px; /* fixed — the Today button coming and going must not shift it */
    padding: 0 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: none;
}
.header-title {
    font-weight: 600;
}
.header-actions {
    display: flex;
    gap: 6px;
}
.header-actions button {
    color: rgba(255, 255, 255, 0.9);
    padding: 2px 7px;
    border-radius: 6px;
    font-size: 12px;
}
.header-actions button:hover,
.header-actions button.active {
    background: rgba(255, 255, 255, 0.2);
}

/* ---- week strip ---- */
.week {
    display: flex;
    align-items: stretch;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
    flex: none;
}
.week-nav {
    padding: 0 8px;
    color: var(--muted);
    font-size: 15px;
}
.day {
    flex: 1;
    padding: 8px 0 9px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    border-bottom: 2px solid transparent;
}
.day:hover {
    background: var(--accent-soft);
}
.day-letter {
    color: var(--muted);
    font-size: 11px;
    width: 22px;
    height: 22px;
    line-height: 22px;
    border-radius: 50%;
}
.day-total {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
}
.day.selected {
    border-bottom-color: var(--accent);
}
.day.selected .day-letter {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
}
.day.selected .day-total {
    color: var(--accent);
    font-weight: 600;
}

/* ---- entries ---- */
.entries {
    flex: 1;
    overflow-y: auto;
    padding: 0 0 8px;
}
.empty.raised {
    padding-bottom: 28px;
}
.empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
}
.entry {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
}
.entry.running {
    background: var(--accent-soft);
}
/* running-timer-on-another-day banner (pinned between week strip and list):
   header line + divider + an entry-style row, all one green jump target */
.running-elsewhere {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    flex: none;
    text-align: left;
    padding: 8px 12px 9px;
    margin: 10px 10px 0;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--accent-soft);
    color: inherit;
    font-size: 12px;
    cursor: pointer;
}
.re-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
}
.re-divider {
    border-top: 1px solid rgba(22, 163, 74, 0.4);
    margin: 7px -12px;
}
.re-entry {
    display: flex;
    align-items: center;
    gap: 8px;
}
.re-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.re-project {
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.re-sub {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.running-elsewhere .dot-live {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
    animation: pulse-dot 1.6s ease-in-out infinite;
}
@keyframes pulse-dot {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0.35;
    }
}
.running-elsewhere-time {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
    white-space: nowrap;
    font-family: ui-monospace, Menlo, monospace;
    animation: pulse-dot 1.6s ease-in-out infinite;
}
.running-elsewhere-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.running-elsewhere-jump {
    color: var(--accent);
    font-weight: 600;
    white-space: nowrap;
}
.running-elsewhere:hover {
    background: rgba(22, 163, 74, 0.3);
}
.resume-last {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg-raised);
    border-color: var(--border);
}
.resume-last .resume-play {
    color: var(--accent);
    font-size: 11px;
}
.resume-last:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
}
.running-elsewhere:hover .running-elsewhere-jump {
    opacity: 0.75;
}
.entry-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px; /* breathing room between the project line and the task/notes line */
}
.entry-client {
    color: var(--muted);
    font-size: 10px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.entry-project {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.entry-code {
    color: var(--muted);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    margin-right: 2px;
}
.entry-text.editable {
    cursor: pointer;
}
.entry-text.editable:hover .entry-project {
    text-decoration: underline;
}
.entry-stats {
    color: var(--muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums; /* a ticking total must not jiggle the rest of the line */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 4px;
}
.budget-pill {
    display: inline-block;
}
.entry-stats-dim {
    opacity: 0.55;
    transition: opacity 0.15s ease;
}
.entry:hover .entry-stats-dim {
    opacity: 1;
}
.budget-pill.ok {
    color: var(--accent);
}
.budget-pill.mid {
    color: #eab308;
}
.budget-pill.high {
    color: #f97316;
}
.budget-pill.over {
    color: var(--danger);
}
.entry-sub {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.entry-time {
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    font-weight: 600;
}
.entry.running .entry-time {
    color: var(--accent);
    animation: pulse-dot 1.6s ease-in-out infinite;
}
.entry-btn {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    flex: none;
}
.entry-btn.play:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}
.entry-btn.stop {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}
.entry-lock {
    font-size: 11px;
}
.locked-note {
    text-align: center;
    padding: 6px;
}
.error {
    color: var(--danger);
    text-align: center;
    padding: 6px 12px;
    font-size: 12px;
}

/* ---- new entry sheet ---- */
.sheet-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
}
.sheet {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.45);
}
.sheet-title {
    text-align: center;
    font-weight: 600;
}
.sheet-row {
    display: flex;
    gap: 8px;
}
.duration {
    width: 74px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    flex: none;
}
.sheet-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
}
.sheet-date {
    flex: 1;
    font-size: 12px;
}
.sheet-notes {
    resize: none;
    min-height: 54px;
    max-height: 120px;
    overflow-y: auto;
    line-height: 1.4;
}
.sheet-delete {
    margin-right: auto; /* delete left, cancel/save right */
}
.duration.live {
    color: var(--accent);
    font-weight: 600;
}
.sheet-dot {
    align-self: center;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
    animation: pulse-dot 1.6s ease-in-out infinite;
}
.link.danger {
    color: var(--danger);
}

/* click-away closes the settings popout */
.popover-backdrop {
    position: absolute;
    inset: 0;
    z-index: 25;
}
.settings-user {
    display: flex;
    flex-direction: column;
    padding: 2px 2px 0;
}
.settings-user .muted {
    font-size: 11px;
}
.sep {
    border: none;
    border-top: 1px solid var(--border);
    margin: 2px 0;
}
/* ---- settings tabs ---- */
/* The week strip's selected-day treatment, borrowed rather than reinvented:
   muted labels, an accent underline on the one showing, accent-soft on hover.
   Two equal halves of the popout's width — 173px each, which fits all ten
   locales on one line at 12px, the longest being "Scorciatoie da tastiera" and
   "キーボードショートカット". Nothing is truncated: a label longer than any of
   the ten wraps onto a second line (both tabs stretch together), because a tab
   that cannot be read is worse than a tab that is two lines tall. */
.pref-tabs {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border);
    margin: -2px -4px 0;
}
.pref-tab {
    flex: 1 1 0;
    min-width: 0;
    padding: 5px 6px 6px;
    font-size: 12px;
    line-height: 1.3;
    text-align: center;
    color: var(--muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
}
.pref-tab:hover {
    background: var(--accent-soft);
    color: var(--text);
}
.pref-tab.selected {
    color: var(--accent);
    font-weight: 600;
    border-bottom-color: var(--accent);
}
.pref-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 6px;
}
/* the popout's own 8px gap separates the sections; inside a panel the rows are
   their own rhythm */
.pref-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.pref-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    padding: 1px 2px;
}
.pref-row .pref-select {
    width: auto;
    padding: 3px 26px 3px 8px;
    font-size: 12px;
}
.pref-idle-label {
    display: flex;
    align-items: center;
    gap: 6px;
}
.pref-idle {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
}
.pref-num {
    width: 46px;
    padding: 3px 6px;
    text-align: center;
    font-size: 12px;
}

/* ---- focus tracking (settings) ---- */
.pref-note {
    font-size: 11px;
    line-height: 1.4;
    padding: 0 2px;
}
.focus-permission .link {
    font-size: 11px;
    margin-left: 2px;
}
.pref-stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    padding: 1px 2px;
}
.pref-exclude {
    font-size: 11px;
    line-height: 1.4;
    padding: 4px 8px;
    resize: none;
}

/* ---- keyboard shortcuts (settings) ---- */
/* Tighter than the other panel: these are five rows of one kind, and the 8px
   the preferences use between unlike rows only makes the list longer. The tab
   above is the heading the section used to carry inside it. */
.pref-shortcuts {
    gap: 3px;
}
/* the presets popout's title */
.pref-group {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0 2px;
}
.pref-shortcut .pref-row {
    align-items: center;
}
/* The popout now spans the window, which is enough for every locale's label on
   one line (board card #145). Wrapping is left in as the safety valve — a
   longer translation than any of the ten should still break rather than push
   the recorder off the edge — but nothing shipped reaches it. */
.pref-shortcut-label {
    min-width: 0;
    line-height: 1.3;
    overflow-wrap: anywhere;
}
/* A field of its own width, so a row does not resize as it goes from its
   placeholder to a combination — and the clear control sits inside it, which
   is also the only way both fit across 250px. */
.shortcut-field {
    position: relative;
    flex: none;
}
.shortcut-record {
    display: block;
    width: 116px;
    padding: 3px 8px;
    font-size: 11px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
}
.shortcut-record:hover {
    border-color: var(--accent);
    color: var(--text);
}
/* a bound combination is the row's value, not its placeholder */
.shortcut-record.set {
    color: var(--text);
    font-size: 13px;
    letter-spacing: 0.08em;
}
.shortcut-record.recording,
.shortcut-record.recording:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
}
.shortcut-clear {
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted);
    font-size: 10px;
    line-height: 1;
    padding: 3px;
}
.shortcut-clear:hover {
    color: var(--danger);
}
.shortcut-clear.empty {
    visibility: hidden;
    pointer-events: none;
}
.shortcut-taken {
    font-size: 10px;
    line-height: 1.3;
    color: var(--danger);
    padding: 1px 2px 0;
}
.icon-chart {
    fill: currentColor;
    display: block;
}
.build-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}
.build-line,
.update-status,
.update-link {
    color: var(--muted);
    font-size: 10px;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.update-link {
    color: var(--accent);
    flex: none;
}

/* ---- presets popout ---- */
/* Anchored to the ☆ it opens from, and absolute like the settings popout so
   neither the list nor a long project name can push the footer around. It
   spans the popover's width (minus the same 8px the settings popout keeps)
   because a row carries a client, a project and a task on one line. */
.presets {
    position: absolute;
    bottom: 42px;
    left: 8px;
    right: 8px;
    z-index: 30;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    /* the window is only as tall as the day's list (see fit_popover), so the
       rows scroll rather than the popout running off the top edge */
    max-height: calc(100vh - 50px);
}
.presets-title {
    padding: 0 2px;
}
.preset-search {
    font-size: 12px;
    padding: 5px 9px;
    flex: none;
}
/* only the rows scroll: the search field stays put while filtering */
.preset-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
}
.preset-row {
    display: flex;
    align-items: center;
    gap: 1px;
    border-radius: 8px;
}
.preset-row:hover {
    background: var(--accent-soft);
}
.preset-start {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    text-align: left;
    padding: 6px 8px;
    border-radius: 8px;
}
.preset-start:disabled {
    cursor: default;
}
.preset-name,
.preset-sub {
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.preset-name {
    font-size: 12px;
    font-weight: 600;
}
.preset-sub {
    color: var(--muted);
    font-size: 10px;
}
/* the project has gone from this workspace: the row says so and starts nothing */
.preset-row.missing .preset-name {
    color: var(--muted);
}
.preset-row.missing .preset-sub {
    color: var(--danger);
}
/* dim until the row is under the pointer, so a list of presets reads as names
   rather than as a column of controls */
.preset-icon {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1;
    opacity: 0.5;
}
.icon-pencil {
    fill: currentColor;
    display: block;
}
.preset-row:hover .preset-icon {
    opacity: 1;
}
.preset-icon:hover {
    background: var(--bg-input);
    color: var(--text);
}
.preset-icon.danger:hover {
    color: var(--danger);
    background: none;
}
/* there is no undo, so ✕ arms the row and this is the second press */
.preset-confirm {
    flex: none;
    margin-right: 2px;
    padding: 3px 7px;
    border: 1px solid var(--danger);
    border-radius: 6px;
    color: var(--danger);
    font-size: 10px;
    white-space: nowrap;
}
.preset-confirm:hover {
    background: var(--danger);
    color: #fff;
}
.preset-rename {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    padding: 5px 8px;
}
.preset-empty {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
    text-align: center;
    padding: 14px 10px;
}
/* the entry sheet's "save this as a preset" control */
.preset-save {
    align-self: flex-start;
    font-size: 11px;
    margin-top: -2px;
}
.preset-save:disabled {
    color: var(--muted);
    cursor: default;
}

/* ---- footer ---- */
.footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
    flex: none;
}
.footer-left {
    display: flex;
    align-items: center;
    gap: 2px;
}
.footer button {
    color: var(--muted);
    font-size: 15px;
    padding: 3px 8px;
    border-radius: 6px;
}
.footer button:hover,
.footer button.active {
    background: var(--accent-soft);
    color: var(--text);
}
/* Spans the popover's width rather than the 250px column it used to be (board
   card #145). At 250 the shortcut labels wrapped onto two lines in every
   locale, which is what made the popout tall enough to need scrolling in the
   first place; the width the window already has costs nothing and buys back
   about five lines. It cannot be wider than this — a webview cannot paint
   outside its window, and widening the window would widen the timesheet with
   it. */
.settings {
    position: absolute;
    bottom: 42px;
    left: 8px;
    right: 8px;
    z-index: 30;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    /* The window is only as tall as the day's list (see fit_popover), and the
       popout is anchored to the footer — so on a genuinely short day it still
       scrolls rather than running off the top edge. */
    max-height: calc(100vh - 50px);
    overflow-y: auto;
    overscroll-behavior: contain;
}

/* ---- shared buttons ---- */
.btn-primary {
    background: var(--accent);
    color: #fff;
    border-radius: 8px;
    padding: 8px 18px;
    font-weight: 600;
    width: 100%;
}
.btn-primary:disabled {
    opacity: 0.5;
}
.sheet-actions .btn-primary,
.sheet-actions .btn-outline {
    width: auto;
}
.btn-outline {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 18px;
    color: var(--text);
}
.btn-outline:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
}
.link {
    color: var(--accent);
    text-align: left;
    padding: 0;
}
.muted {
    color: var(--muted);
}
</style>
