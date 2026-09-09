<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ProjectPicker from './ProjectPicker.vue';
import { api, auth, CENTRAL_URL, DEFAULT_DOMAIN, DEV_WORKSPACE, elapsedMinutes, formatDurationHuman, formatMinutes, parseDuration, resolveWorkspaceInput, session, toDateString, type Entry, type ProjectStats, type Summary, type Timesheet } from './api';
import { intlLocale, LOCALE_NAMES, setLocalePreference, SUPPORTED_LOCALES } from './i18n';
import { idleMinutes, resolveIdleChoice } from './idle';
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
}
const prefs = ref<Prefs>({ appearance: 'system', dock: false, hideOnBlur: true, idleEnabled: true, idleMinutes: 10, language: 'system' });
try {
    Object.assign(prefs.value, JSON.parse(localStorage.getItem('zebu.prefs') ?? '{}'));
} catch {
    /* fresh defaults */
}
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
    closeInsights();
    me.value = null;
    sheet.value = null;
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

const refresh = async () => {
    if (view.value !== 'main') return;
    loading.value = true;
    try {
        // the insights panel keeps itself in step, in its own window
        sheet.value = await api.timesheet(selectedDate.value);
        errorMessage.value = '';
    } catch (e: any) {
        if (e.message === 'unauthenticated') return; // session.onExpired already moved to the connect screen
        errorMessage.value = e.message;
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
const running = computed(() => sheet.value?.running ?? null);

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

const elapsed = (entry: { minutes: number; timer_started_at: string | null }) => elapsedMinutes(entry, now.value);

let tick: ReturnType<typeof setInterval> | null = null;
let refreshLoop: ReturnType<typeof setInterval> | null = null;
let refreshUnlisten: UnlistenFn | null = null;

// the pill falls back to today's most recent entry, so a timer stopped
// elsewhere leaves the day's total on screen rather than "zzzz"
const todaysLatest = computed(() => {
    const todays = (sheet.value?.entries ?? []).filter((e) => e.date === todayStr());
    return todays.length ? todays[todays.length - 1] : null;
});
const trayEntry = computed(() => running.value ?? todaysLatest.value);

// The pill itself is painted by Rust, which ticks the elapsed time on its own
// thread (webview timers stall while the popover is hidden, so the old
// setInterval here left the menubar frozen until the icon was clicked). This
// only hands over what is on the clock, whenever that changes; the tooltip is
// rendered here so it follows the app's locale, with `{time}` left for Rust.
const updateTray = () => {
    invoke('set_tray_state', { entry: describeTray(trayEntry.value, t) }).catch(() => {});
};

onMounted(() => {
    tick = setInterval(() => (now.value = Date.now()), 15000);
    // Rust nudges every 20 s (`refresh-due`) so a timer started or stopped from
    // another client shows up without a click; outside Tauri (plain-browser
    // dev) fall back to a webview interval.
    listen('refresh-due', () => refresh())
        .then((off) => (refreshUnlisten = off))
        .catch(() => (refreshLoop = setInterval(refresh, 20000)));
    now.value = Date.now();
    if (view.value === 'main') refresh();
    window.addEventListener('focus', () => view.value === 'main' && refresh());
    listen<{ started_at_ms: number; seconds: number }>('idle-return', (e) => onIdleReturn(e.payload)).then((off) => (idleUnlisten = off));
    // the answer comes back from the prompt's own window, via Rust
    listen<{ remove: boolean; stop: boolean }>('idle-choice', (e) => applyIdleChoice(e.payload)).then((off) => (idleChoiceUnlisten = off));
    // the menubar pill is a play/pause button: Rust reads the running flag it
    // was last handed and sends whichever press this was (see below)
    listen('tray-toggle-timer', () => onTrayPause()).then((off) => (trayPauseUnlisten = off));
    listen('tray-open-new-timer', () => onTrayPlay()).then((off) => (trayPlayUnlisten = off));
    syncIdleThreshold();
    // quiet launch-time update check; the prompt only appears when there is one
    setTimeout(() => checkForUpdates(false), 4000);
});
onUnmounted(() => {
    if (tick) clearInterval(tick);
    if (refreshLoop) clearInterval(refreshLoop);
    refreshUnlisten?.();
    if (pollTimer) clearInterval(pollTimer);
    idleUnlisten?.();
    idleChoiceUnlisten?.();
    trayPauseUnlisten?.();
    trayPlayUnlisten?.();
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
// whatever is (or was last seen) running is the freshest candidate;
// this also flips the menubar pill as soon as the first timesheet loads
watch([running, todaysLatest], ([r, latest]) => {
    // remember whatever is running; failing that, today's most recent entry —
    // so Resume continues today's work instead of an older day's
    if (r) rememberTimer(r);
    else if (latest) rememberTimer(latest);
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
    // the popover only opened for this question: tuck it away again
    getCurrentWindow().hide().catch(() => {});
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
const autosizeNotes = () => {
    const el = notesEl.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
};
const form = ref({ project_id: '', task_id: '' as string | '', notes: '', duration: '', date: '' });
const formProject = computed(() => sheet.value?.projects.find((p) => p.id === form.value.project_id));
let openedDuration = ''; // the prefill — only a changed duration rebases a live timer

const openForm = () => {
    editingEntry.value = null;
    openedDuration = '';
    form.value = { project_id: sheet.value?.projects[0]?.id ?? '', task_id: '', notes: '', duration: '', date: selectedDate.value };
    formOpen.value = true;
    nextTick(autosizeNotes);
};

const openEdit = (entry: Entry) => {
    if (entry.locked || sheet.value?.week_locked) return;
    editingEntry.value = entry;
    openedDuration = formatMinutes(elapsed(entry));
    form.value = {
        project_id: entry.project_id,
        task_id: entry.task_id ?? '',
        notes: entry.notes ?? '',
        duration: openedDuration,
        date: entry.date,
    };
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

/** Pause: exactly the stop the running entry's ■ button performs, opening nothing. */
const onTrayPause = () => {
    // Rust's flag can only be a beat behind this window's own view of things
    // (a timer stopped in the browser, say); doing nothing leaves the next
    // click — after the refresh that corrects the pill — to get it right.
    if (!running.value) return;
    stopTimer();
};

/** Play: nothing to pause, so land in the same new-entry sheet the ＋ button opens. */
const onTrayPlay = () => {
    // Rust has already shown the popover; on the connect screen, or a week the
    // server has locked, that is all there is to offer — there is nothing to
    // start a timer against.
    if (view.value !== 'main' || sheet.value?.week_locked) return;
    openForm();
};

// ---- popovers --------------------------------------------------------------

const settingsOpen = ref(false);

// Window height per state: compact connect screen, ~3.5 entry rows for the
// timesheet (the cut-off half row signals there's more below the fold).
// Insights is a window of its own now (src/Insights.vue) rather than an
// overlay scrolling inside these bounds, so nothing else resizes this one.
watch(
    view,
    (v) => {
        const height = v === 'connect' ? 240 : 330;
        try {
            getCurrentWindow()
                .setSize(new LogicalSize(380, height))
                .catch(() => {});
        } catch {
            // not inside Tauri (plain-browser vite dev) — nothing to resize
        }
    },
    { immediate: true },
);

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

// Escape dismisses the settings popover (click-away is the backdrop); the
// insights window handles its own Escape.
const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !settingsOpen.value) return;
    settingsOpen.value = false;
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
    <div v-else class="main">
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

        <!-- entries -->
        <main class="entries">
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
                    <span class="entry-project">{{ entry.project }}</span>
                        <span v-if="waitingLabel(entry)" class="entry-waiting" :class="{ live: entry.agent_waiting }">⏳ {{ waitingLabel(entry) }}</span>
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
                <ProjectPicker
                    v-model="form.project_id"
                    :projects="sheet?.projects ?? []"
                    :placeholder="t('form.addProject')"
                    :search-placeholder="t('form.searchProject')"
                    :empty="t('form.noProjects')"
                    :create-label="t('form.newProjectLink')"
                    @create="openUrl(`${auth.workspace}/projects/create`)"
                />
                <select v-model="form.task_id">
                    <option value="">{{ t('form.addTask') }}</option>
                    <option v-for="task in formProject?.tasks ?? []" :key="task.id" :value="task.id">{{ task.name }}</option>
                </select>
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
            <button v-if="!sheet?.week_locked" :title="t('footer.newEntry')" @click="openForm">＋</button>
            <div class="footer-right">
                <button :title="t('footer.settings')" :class="{ active: settingsOpen }" @click="settingsOpen = !settingsOpen">⚙</button>
            </div>
        </footer>

        <div v-if="settingsOpen" class="popover-backdrop" @click="settingsOpen = false"></div>
        <div v-if="settingsOpen" class="settings">
            <div v-if="me" class="settings-user">
                <strong>{{ me.name }}</strong>
                <span class="muted">{{ me.email }}</span>
            </div>
            <hr v-if="me" class="sep" />
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
.entry-project {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
.settings {
    position: absolute;
    bottom: 42px;
    right: 8px;
    z-index: 30;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    width: 250px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
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
