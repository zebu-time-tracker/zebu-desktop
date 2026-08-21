<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, auth, formatMinutes, parseDuration, toDateString, type Summary, type Timesheet } from './api';

type View = 'connect' | 'main';

const view = ref<View>(auth.token && auth.server ? 'main' : 'connect');

// ---- connect flow ----------------------------------------------------------

const serverInput = ref(auth.server || 'https://');
const connectState = ref<'idle' | 'waiting' | 'error'>('idle');
const connectError = ref('');
const verificationUrl = ref('');
let pollTimer: ReturnType<typeof setInterval> | null = null;

const connect = async () => {
    connectError.value = '';
    const server = serverInput.value.replace(/\/+$/, '');
    try {
        const started = await api.deviceStart(server);
        verificationUrl.value = started.verification_url;
        connectState.value = 'waiting';
        await openUrl(started.verification_url);

        pollTimer = setInterval(async () => {
            const result = await api.devicePoll(server, started.device_code);
            if (result.data.status === 'approved') {
                clearInterval(pollTimer!);
                auth.server = server;
                auth.token = result.data.token;
                connectState.value = 'idle';
                view.value = 'main';
                refresh();
            } else if (['denied', 'expired'].includes(result.data.status)) {
                clearInterval(pollTimer!);
                connectState.value = 'error';
                connectError.value = result.data.status === 'denied' ? 'Access was denied in the browser.' : 'The request expired — try again.';
            }
        }, (started.interval || 3) * 1000);
    } catch (e: any) {
        connectState.value = 'error';
        connectError.value = e.message ?? 'Could not reach the server.';
    }
};

const disconnect = () => {
    auth.token = '';
    view.value = 'connect';
    connectState.value = 'idle';
    settingsOpen.value = false;
    invoke('set_tray_title', { title: '' });
};

// ---- timesheet -------------------------------------------------------------

const selectedDate = ref(toDateString(new Date()));
const sheet = ref<Timesheet | null>(null);
const summary = ref<Summary | null>(null);
const loading = ref(false);
const errorMessage = ref('');

const todayStr = () => toDateString(new Date());
const isToday = computed(() => selectedDate.value === todayStr());

const refresh = async () => {
    if (view.value !== 'main') return;
    loading.value = true;
    try {
        sheet.value = await api.timesheet(selectedDate.value);
        errorMessage.value = '';
    } catch (e: any) {
        if (e.message === 'unauthenticated') {
            view.value = 'connect';
            return;
        }
        errorMessage.value = e.message;
    } finally {
        loading.value = false;
    }
};

const loadSummary = async () => {
    try {
        summary.value = await api.summary();
    } catch {
        /* popover just stays empty */
    }
};

const weekDays = computed(() => {
    if (!sheet.value) return [];
    const start = new Date(sheet.value.week_start + 'T00:00:00');
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const date = toDateString(d);
        return {
            date,
            letter: ['M', 'T', 'W', 'T', 'F', 'S', 'S'][i],
            minutes: (sheet.value?.entries ?? []).filter((e) => e.date === date).reduce((s, e) => s + e.minutes, 0),
        };
    });
});

const dayEntries = computed(() => (sheet.value?.entries ?? []).filter((e) => e.date === selectedDate.value));
const running = computed(() => sheet.value?.running ?? null);

const headerLabel = computed(() => {
    const d = new Date(selectedDate.value + 'T00:00:00');
    const label = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    return isToday.value ? `Today, ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : label;
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
const elapsed = (entry: { minutes: number; timer_started_at: string | null }) => {
    if (!entry.timer_started_at) return entry.minutes;
    return entry.minutes + Math.max(0, (now.value - new Date(entry.timer_started_at).getTime()) / 60000);
};

let tick: ReturnType<typeof setInterval> | null = null;
let refreshLoop: ReturnType<typeof setInterval> | null = null;

const updateTray = () => {
    invoke('set_tray_title', { title: running.value ? formatMinutes(elapsed(running.value)) : '' }).catch(() => {});
};

onMounted(() => {
    tick = setInterval(() => {
        now.value = Date.now();
        updateTray();
    }, 15000);
    refreshLoop = setInterval(refresh, 60000);
    now.value = Date.now();
    if (view.value === 'main') refresh();
    window.addEventListener('focus', () => view.value === 'main' && refresh());
});
onUnmounted(() => {
    if (tick) clearInterval(tick);
    if (refreshLoop) clearInterval(refreshLoop);
    if (pollTimer) clearInterval(pollTimer);
});

// ---- actions ---------------------------------------------------------------

const act = async (fn: () => Promise<unknown>) => {
    try {
        await fn();
        await refresh();
        updateTray();
    } catch (e: any) {
        errorMessage.value = e.message === 'unauthenticated' ? '' : e.message;
        if (e.message === 'unauthenticated') view.value = 'connect';
    }
};

const stopTimer = () => act(() => api.stopTimer());
const resumeEntry = (id: string, projectId: string) => act(() => api.startTimer({ project_id: projectId, entry_id: id }));
const deleteEntry = (id: string) => act(() => api.deleteEntry(id));

// ---- new entry form --------------------------------------------------------

const formOpen = ref(false);
const form = ref({ project_id: '', task_id: '' as string | '', notes: '', duration: '' });
const formProject = computed(() => sheet.value?.projects.find((p) => p.id === form.value.project_id));

const openForm = () => {
    form.value = { project_id: sheet.value?.projects[0]?.id ?? '', task_id: '', notes: '', duration: '' };
    formOpen.value = true;
};

const submitForm = () =>
    act(async () => {
        const minutes = form.value.duration ? parseDuration(form.value.duration) : null;
        const payload = {
            project_id: form.value.project_id,
            task_id: form.value.task_id || null,
            notes: form.value.notes || null,
        };
        if (minutes !== null && minutes > 0) {
            await api.addEntry({ ...payload, date: selectedDate.value, minutes });
        } else {
            await api.startTimer(payload);
        }
        formOpen.value = false;
    });

// ---- popovers --------------------------------------------------------------

const summaryOpen = ref(false);
const settingsOpen = ref(false);

const toggleSummary = () => {
    summaryOpen.value = !summaryOpen.value;
    settingsOpen.value = false;
    if (summaryOpen.value) loadSummary();
};
</script>

<template>
    <!-- ======== connect ======== -->
    <div v-if="view === 'connect'" class="connect">
        <div class="connect-logo">Zebu</div>

        <template v-if="connectState !== 'waiting'">
            <p class="muted">Connect to your Zebu server. You'll approve this device in your browser.</p>
            <input v-model="serverInput" placeholder="https://zebu.example.com" @keyup.enter="connect" />
            <button class="btn-primary" @click="connect">Connect</button>
            <p v-if="connectError" class="error">{{ connectError }}</p>
        </template>

        <template v-else>
            <div class="spinner"></div>
            <p class="muted">Waiting for approval in your browser…</p>
            <button class="link" @click="openUrl(verificationUrl)">Re-open the approval page</button>
            <button
                class="link"
                @click="
                    connectState = 'idle';
                    pollTimer && clearInterval(pollTimer);
                "
            >
                Cancel
            </button>
        </template>
    </div>

    <!-- ======== main ======== -->
    <div v-else class="main">
        <header class="header">
            <span class="header-title">{{ headerLabel }}</span>
            <div class="header-actions">
                <button v-if="!isToday" title="Jump to Today" @click="goDate(todayStr())">⤴︎ Today</button>
                <button title="Time summary" :class="{ active: summaryOpen }" @click="toggleSummary">ⓘ</button>
            </div>
        </header>

        <!-- summary popover -->
        <div v-if="summaryOpen" class="summary">
            <template v-if="summary">
                <div class="summary-grid">
                    <div><span>Hours today</span><strong>{{ formatMinutes(summary.today) }}</strong></div>
                    <div><span>Hours yesterday</span><strong>{{ formatMinutes(summary.yesterday) }}</strong></div>
                    <div><span>Hours this week</span><strong>{{ formatMinutes(summary.this_week) }}</strong></div>
                    <div><span>Hours last week</span><strong>{{ formatMinutes(summary.last_week) }}</strong></div>
                    <div><span>Hours this month</span><strong>{{ formatMinutes(summary.this_month) }}</strong></div>
                    <div><span>Billable this month</span><strong>{{ summary.billable_pct_month }}%</strong></div>
                </div>
            </template>
            <p v-else class="muted" style="text-align: center">Loading…</p>
        </div>

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

        <!-- entries -->
        <main class="entries">
            <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
            <p v-if="sheet?.week_locked" class="muted locked-note">This week is approved and locked.</p>

            <div v-if="!dayEntries.length && !loading" class="empty">
                <p class="muted">No time tracked{{ isToday ? ' today' : '' }}.</p>
                <button class="btn-outline" @click="openForm">Add New Entry</button>
            </div>

            <div v-for="entry in dayEntries" :key="entry.id" class="entry" :class="{ running: entry.timer_started_at }">
                <div class="entry-text">
                    <span class="entry-project">{{ entry.project }}</span>
                    <span class="entry-sub">{{ [entry.task, entry.notes].filter(Boolean).join(' — ') || '&nbsp;' }}</span>
                </div>
                <span class="entry-time">{{ formatMinutes(elapsed(entry)) }}</span>
                <button v-if="entry.timer_started_at" class="entry-btn stop" title="Stop" @click="stopTimer">■</button>
                <button
                    v-else-if="isToday && !entry.locked && !sheet?.week_locked"
                    class="entry-btn play"
                    title="Resume"
                    @click="resumeEntry(entry.id, entry.project_id)"
                >
                    ▶
                </button>
                <button v-if="!entry.locked && !entry.timer_started_at && !sheet?.week_locked" class="entry-btn" title="Delete" @click="deleteEntry(entry.id)">
                    ✕
                </button>
                <span v-if="entry.locked" class="entry-lock" title="Invoiced">🔒</span>
            </div>
        </main>

        <!-- new entry sheet -->
        <div v-if="formOpen" class="sheet-overlay" @click.self="formOpen = false">
            <div class="sheet">
                <p class="sheet-title">New Time Entry</p>
                <select v-model="form.project_id">
                    <option value="" disabled>Add Project</option>
                    <option v-for="p in sheet?.projects ?? []" :key="p.id" :value="p.id">{{ p.client ? `${p.client} — ` : '' }}{{ p.name }}</option>
                </select>
                <select v-model="form.task_id">
                    <option value="">Add Task</option>
                    <option v-for="t in formProject?.tasks ?? []" :key="t.id" :value="t.id">{{ t.name }}</option>
                </select>
                <div class="sheet-row">
                    <input v-model="form.notes" placeholder="Notes (optional)" />
                    <input v-model="form.duration" class="duration" placeholder="0:00" />
                </div>
                <div class="sheet-actions">
                    <button class="btn-outline" @click="formOpen = false">Cancel</button>
                    <button class="btn-primary" :disabled="!form.project_id" @click="submitForm">
                        {{ form.duration ? 'Log' : 'Start' }}
                    </button>
                </div>
            </div>
        </div>

        <!-- footer -->
        <footer class="footer">
            <button v-if="!sheet?.week_locked" title="New time entry" @click="openForm">＋</button>
            <div class="footer-right">
                <button title="Settings" :class="{ active: settingsOpen }" @click="settingsOpen = !settingsOpen; summaryOpen = false">⚙</button>
            </div>
        </footer>

        <div v-if="settingsOpen" class="settings">
            <p class="muted">{{ auth.server }}</p>
            <button class="link" @click="openUrl(auth.server)">Open Zebu in the browser</button>
            <button class="link" @click="disconnect">Disconnect this device</button>
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
    padding: 10px 12px;
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

/* ---- summary popover ---- */
.summary {
    position: absolute;
    top: 40px;
    right: 8px;
    z-index: 30;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    width: 280px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.summary-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
}
.summary-grid div {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.summary-grid span {
    color: var(--muted);
    font-size: 11px;
}
.summary-grid strong {
    font-size: 18px;
    font-variant-numeric: tabular-nums;
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
    padding: 8px 0;
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
.entry-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.entry-project {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    background: var(--danger);
    border-color: var(--danger);
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
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
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
.link {
    color: var(--accent);
    text-align: left;
    padding: 0;
}
.muted {
    color: var(--muted);
}
</style>
