<script setup lang="ts">
// Insights, in its own window.
//
// This was an overlay absolutely positioned inside the 380x330 popover, where
// six stat tiles, the uninvoiced breakdown and two charts had to scroll inside
// a couple of hundred pixels. As its own borderless window (created in
// src-tauri/src/lib.rs, placed beside the popover) it is sized to what its
// content measures, so all of it is on screen at once.
//
// The panel is self-sufficient: it fetches the summary itself, and the day's
// timesheet for the running timer, so its tiles and charts count up with the
// clock exactly as they did inside App.vue.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, elapsedMinutes, formatDurationHuman, formatMinutes, toDateString, type Entry, type Summary } from './api';
import FocusPanel from './FocusPanel.vue';
import { intlLocale, setLocalePreference } from './i18n';

const { t } = useI18n();

const summary = ref<Summary | null>(null);
const running = ref<Entry | null>(null);
const now = ref(Date.now());
/** Focus tracking is on (a preference of the main window); only then is there a Focus tab. */
const focusEnabled = ref(false);
const tab = ref<'summary' | 'focus'>('summary');

/** Theme and language are the main window's preferences; both windows share localStorage. */
const applyPrefs = () => {
    try {
        const prefs = JSON.parse(localStorage.getItem('zebu.prefs') ?? '{}');
        if (prefs.appearance && prefs.appearance !== 'system') document.documentElement.dataset.theme = prefs.appearance;
        else delete document.documentElement.dataset.theme;
        setLocalePreference(prefs.language ?? 'system');
        focusEnabled.value = !!prefs.focusEnabled;
        if (!focusEnabled.value) tab.value = 'summary';
    } catch {
        /* defaults are fine */
    }
};

const loadSummary = async () => {
    try {
        summary.value = await api.summary();
    } catch {
        /* the panel just stays empty */
    }
};

// The timesheet carries whatever is running, whichever day it belongs to —
// the live minutes the tiles and charts add on top of the server's summary.
const loadRunning = async () => {
    try {
        running.value = (await api.timesheet(todayStr())).running;
    } catch {
        /* leave the last known timer in place */
    }
};

const todayStr = () => toDateString(new Date());
const mondayOf = (date: string) => {
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start on Monday, as on the server
    return toDateString(d);
};

// Minutes the running timer has accrued beyond the stored `minutes` the
// server summed — added to every total the timer belongs in, on each tick.
const runningExtra = computed(() => (running.value ? Math.max(0, elapsedMinutes(running.value, now.value) - running.value.minutes) : 0));

// the server's summary plus the running timer's live minutes, so the tiles
// and charts count up with the clock instead of waiting for a stop
const liveSummary = computed<Summary | null>(() => {
    const s = summary.value;
    const r = running.value;
    const extra = runningExtra.value;
    if (!s || !r || !extra) return s;
    const today = todayStr();
    const [ry, rm, rd] = r.date.split('-').map(Number);
    const [ty, tm] = today.split('-').map(Number);
    const live: Summary = { ...s, month_by_day: [...s.month_by_day], year_by_month: [...s.year_by_month] };
    if (r.date === today) live.today += extra;
    if (mondayOf(r.date) === mondayOf(today)) live.this_week += extra;
    if (ry === ty && rm === tm) {
        live.this_month += extra;
        if (r.is_billable) live.uninvoiced_minutes += extra;
        if (rd - 1 < live.month_by_day.length) live.month_by_day[rd - 1] += extra;
    }
    if (ry === ty && rm - 1 < live.year_by_month.length) live.year_by_month[rm - 1] += extra;
    return live;
});

const chartMax = computed(() => Math.max(...(liveSummary.value?.month_by_day ?? [0]), 60));
const yearMax = computed(() => Math.max(...(liveSummary.value?.year_by_month ?? [0]), 60));
const todayIndex = new Date().getDate() - 1;
const thisMonthIndex = new Date().getMonth();
const monthLabel = computed(() => new Date().toLocaleDateString(intlLocale.value, { month: 'long' }));
const yearLabel = new Date().getFullYear();

const chartHover = ref<{ kind: 'day' | 'month'; i: number; m: number } | null>(null);
const chartTip = computed(() => {
    const h = chartHover.value;
    if (!h) return '';
    if (h.kind === 'day') {
        const d = new Date(new Date().getFullYear(), new Date().getMonth(), h.i + 1);
        return `${d.toLocaleDateString(intlLocale.value, { weekday: 'short', month: 'short', day: 'numeric' })}: ${formatMinutes(h.m)}`;
    }
    const m = new Date(new Date().getFullYear(), h.i, 1);
    return `${m.toLocaleDateString(intlLocale.value, { month: 'long' })}: ${formatMinutes(h.m)}`;
});
const tipLeft = (i: number, count: number) => `min(max(${(((i + 0.5) / count) * 100).toFixed(1)}%, 16%), 84%)`;

/**
 * Fetch, then hand Rust the height this content needs — which is also what
 * reveals the window, so it never flashes at the wrong size. A refresh while
 * the panel is up only resizes it (see place_insights).
 */
const load = async () => {
    applyPrefs();
    await Promise.all([loadSummary(), loadRunning()]);
    now.value = Date.now();
    await nextTick();
    invoke('fit_insights', { height: document.documentElement.scrollHeight }).catch(() => {});
};

/** Re-measure after the content changed height (a tab switch, the focus list loading). */
const refit = async () => {
    await nextTick();
    invoke('fit_insights', { height: document.documentElement.scrollHeight }).catch(() => {});
};
const pickTab = (next: 'summary' | 'focus') => {
    tab.value = next;
    refit();
};

const close = () => invoke('close_insights').catch(() => {});

const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
};

let tick: ReturnType<typeof setInterval> | null = null;
let refreshLoop: ReturnType<typeof setInterval> | null = null;
let unlisten: (() => void) | null = null;

onMounted(() => {
    load();
    // the window is reused, so re-read whenever it is opened again
    listen('insights-show', load).then((off) => (unlisten = off));
    tick = setInterval(() => (now.value = Date.now()), 15000);
    refreshLoop = setInterval(load, 20000);
    window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
    unlisten?.();
    if (tick) clearInterval(tick);
    if (refreshLoop) clearInterval(refreshLoop);
    window.removeEventListener('keydown', onKey);
});
</script>

<template>
    <div class="insights" role="dialog" :aria-label="t('header.insights')">
        <header class="insights-head">
            <span class="insights-title">{{ t('header.insights') }}</span>
            <button class="insights-close" :title="t('common.close')" :aria-label="t('common.close')" @click="close">×</button>
        </header>

        <div v-if="focusEnabled" class="insights-tabs" role="tablist">
            <button class="insights-tab" :class="{ selected: tab === 'summary' }" role="tab" :aria-selected="tab === 'summary'" @click="pickTab('summary')">
                {{ t('focus.tabSummary') }}
            </button>
            <button class="insights-tab" :class="{ selected: tab === 'focus' }" role="tab" :aria-selected="tab === 'focus'" @click="pickTab('focus')">
                {{ t('focus.tab') }}
            </button>
        </div>

        <FocusPanel v-if="focusEnabled && tab === 'focus'" @changed="refit" />
        <template v-else-if="liveSummary">
            <div class="summary-grid">
                <div><span>{{ t('summary.hoursToday') }}</span><strong>{{ formatMinutes(liveSummary.today) }}</strong></div>
                <div><span>{{ t('summary.hoursYesterday') }}</span><strong>{{ formatMinutes(liveSummary.yesterday) }}</strong></div>
                <div><span>{{ t('summary.hoursThisWeek') }}</span><strong>{{ formatMinutes(liveSummary.this_week) }}</strong></div>
                <div><span>{{ t('summary.hoursLastWeek') }}</span><strong>{{ formatMinutes(liveSummary.last_week) }}</strong></div>
                <div><span>{{ t('summary.hoursThisMonth') }}</span><strong>{{ formatMinutes(liveSummary.this_month) }}</strong></div>
                <div><span>{{ t('summary.billableThisMonth') }}</span><strong>{{ liveSummary.billable_pct_month }}%</strong></div>
            </div>
            <hr class="sep" />
            <div class="summary-uninv">
                <p class="uninv-title">{{ t('summary.uninvoicedThisMonth') }}</p>
                <div class="uninv-row"><span>{{ t('summary.time') }}</span><strong>{{ formatDurationHuman(liveSummary.uninvoiced_minutes) }}</strong></div>
                <div v-for="(cents, cur) in liveSummary.uninvoiced_amounts" :key="cur" class="uninv-row">
                    <span>{{ cur }}</span>
                    <strong>{{ (cents / 100).toLocaleString(intlLocale, { maximumFractionDigits: 0 }) }}</strong>
                </div>
                <div v-if="liveSummary.uninvoiced_total" class="uninv-row uninv-total">
                    <span>{{ t('summary.approxTotal', { currency: liveSummary.base_currency }) }}</span>
                    <strong>{{ (liveSummary.uninvoiced_total / 100).toLocaleString(intlLocale, { maximumFractionDigits: 0 }) }}</strong>
                </div>
            </div>
            <div class="mini-chart" @mouseleave="chartHover = null">
                <span
                    v-for="(m, i) in liveSummary.month_by_day"
                    :key="i"
                    :class="{ today: i === todayIndex, hovered: chartHover?.kind === 'day' && chartHover.i === i }"
                    @mouseenter="chartHover = { kind: 'day', i, m }"
                >
                    <i :style="{ height: `${Math.max(4, (m / chartMax) * 100)}%` }"></i>
                </span>
                <div v-if="chartHover?.kind === 'day'" class="chart-tip" :style="{ left: tipLeft(chartHover.i, liveSummary.month_by_day.length) }">
                    {{ chartTip }}
                </div>
            </div>
            <p class="muted chart-caption">{{ t('summary.hoursPerDay', { month: monthLabel }) }}</p>
            <div class="mini-chart" @mouseleave="chartHover = null">
                <span
                    v-for="(m, i) in liveSummary.year_by_month"
                    :key="i"
                    :class="{ today: i === thisMonthIndex, hovered: chartHover?.kind === 'month' && chartHover.i === i }"
                    @mouseenter="chartHover = { kind: 'month', i, m }"
                >
                    <i :style="{ height: `${Math.max(4, (m / yearMax) * 100)}%` }"></i>
                </span>
                <div v-if="chartHover?.kind === 'month'" class="chart-tip" :style="{ left: tipLeft(chartHover.i, 12) }">
                    {{ chartTip }}
                </div>
            </div>
            <p class="muted chart-caption">{{ t('summary.hoursPerMonth', { year: yearLabel }) }}</p>
        </template>
        <p v-else class="muted insights-loading">{{ t('common.loading') }}</p>
    </div>
</template>

<style>
/* Only this window: it is sized to its content, so nothing stretches to 100%.
   main.ts stamps data-window="insights" on <html>; the main window is untouched. */
html[data-window='insights'],
html[data-window='insights'] body,
html[data-window='insights'] #app {
    height: auto;
}
html[data-window='insights'] body {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    /* The window is sized to this content, so there is normally nothing to
       scroll. On a display too short for the whole panel Rust caps the window
       at the work area (see insights_height) — the overflow has to be reachable
       then, rather than sliced off at the bottom edge. */
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
}
</style>

<style scoped>
.insights {
    display: flex;
    flex-direction: column;
    padding: 14px 18px 18px;
}
.insights-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
}
.insights-title {
    font-size: 14px;
    font-weight: 700;
}
.insights-close {
    color: var(--muted);
    font-size: 17px;
    line-height: 1;
    padding: 2px 7px;
    border-radius: 6px;
}
.insights-close:hover {
    background: var(--accent-soft);
    color: var(--text);
}
.insights-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    margin: -6px -4px 14px;
}
.insights-tab {
    flex: 1 1 0;
    padding: 5px 6px 6px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
}
.insights-tab:hover {
    background: var(--accent-soft);
    color: var(--text);
}
.insights-tab.selected {
    color: var(--accent);
    font-weight: 600;
    border-bottom-color: var(--accent);
}
.insights-loading {
    text-align: center;
    padding: 40px 0;
}

/* ---- stat tiles ---- */
.summary-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 18px;
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
    font-size: 19px;
    font-variant-numeric: tabular-nums;
}
.sep {
    border: none;
    border-top: 1px solid var(--border);
    margin: 14px 0 12px;
}

/* ---- uninvoiced this month ---- */
.uninv-title {
    color: var(--muted);
    font-size: 11px;
    margin: 0 0 8px;
}
.uninv-total {
    border-top: 1px solid var(--border);
    margin-top: 4px;
    padding-top: 4px;
}
.uninv-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    line-height: 1.7;
}
.uninv-row strong {
    font-variant-numeric: tabular-nums;
}
.uninv-row span {
    color: var(--muted);
}

/* ---- charts: taller here than they could be in the popover ---- */
.mini-chart {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 60px;
    margin-top: 22px; /* room for the hover tooltip above the tallest bar */
}
.mini-chart span {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end; /* full-height hover column; the bar sits at the bottom */
}
.mini-chart span i {
    display: block;
    width: 100%;
    background: var(--border);
    border-radius: 2px 2px 0 0;
}
.mini-chart span.today i {
    background: var(--accent);
}
.mini-chart span.hovered i {
    background: var(--text);
}
.mini-chart span.today.hovered i {
    background: var(--accent);
    filter: brightness(1.25);
}
.chart-tip {
    position: absolute;
    top: -26px;
    transform: translateX(-50%);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 10px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 5;
}
.chart-caption {
    font-size: 10px;
    margin: 6px 0 0;
    text-align: center;
}
.muted {
    color: var(--muted);
}
</style>
