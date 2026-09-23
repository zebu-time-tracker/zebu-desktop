<script setup lang="ts">
// The Focus tab of the Insights window (board card #401): where today went,
// from the spans Rust recorded locally, and entries it could become.
//
// Everything shown here is read from this Mac (`focus_spans`); the only thing
// fetched is the user's own timesheet, for the projects and recent notes the
// suggestions are matched against. A suggestion never creates anything: it
// opens the popover's new-entry sheet, filled in, via `open_focus_suggestion`.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, formatMinutes, toDateString, type Entry, type ProjectOption } from './api';
import { candidatesFrom, dayBounds, groupSpans, suggestFor, timeline, timelineRange, type FocusGroup, type FocusSpan, type Suggestion } from './focus';
import { intlLocale } from './i18n';

const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();

const spans = ref<FocusSpan[]>([]);
const titlesAllowed = ref(true);
const loaded = ref(false);
const projects = ref<ProjectOption[]>([]);
const entries = ref<Entry[]>([]);
const tracked = ref<Entry | null>(null);

const load = async () => {
    const [from, to] = dayBounds(Date.now());
    spans.value = await invoke<FocusSpan[]>('focus_spans', { from, to }).catch(() => []);
    titlesAllowed.value = await invoke<boolean>('focus_titles_allowed').catch(() => true);
    try {
        const sheet = await api.timesheet(toDateString(new Date()));
        projects.value = sheet.projects;
        entries.value = sheet.entries;
        tracked.value = sheet.running ?? sheet.active ?? null;
    } catch {
        /* suggestions just stay quiet without the project list */
    }
    loaded.value = true;
    emit('changed');
};

const day = computed(() => dayBounds(Date.now()));
const apps = computed(() => groupSpans(spans.value, day.value[0], day.value[1]));
const totalMs = computed(() => apps.value.reduce((s, a) => s + a.ms, 0));

/** The busiest apps get a colour of their own on the strip; the rest share one. */
const PALETTE = ['var(--accent)', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6'];
const colourOf = computed(() => {
    const map = new Map<string, string>();
    apps.value.slice(0, PALETTE.length).forEach((a, i) => map.set(a.app, PALETTE[i]));
    return (app: string) => map.get(app) ?? 'var(--muted)';
});

const range = computed(() => timelineRange(spans.value.filter((s) => s.end > day.value[0] && s.start < day.value[1])));
const strip = computed(() => (range.value ? timeline(spans.value, range.value[0], range.value[1]) : []));
const hourLabel = (ms: number) => new Date(ms).toLocaleTimeString(intlLocale.value, { hour: 'numeric' });
const hint = ref('');

/** How many groups an app lists before the rest fold into "Other". */
const SHOWN = 4;
const rowsOf = (groups: FocusGroup[]) => {
    const shown = groups.slice(0, SHOWN);
    const rest = groups.slice(SHOWN).reduce((s, g) => s + g.ms, 0);
    return { shown, rest };
};

const candidates = computed(() => candidatesFrom(projects.value, entries.value, tracked.value));
const suggestion = (g: FocusGroup): Suggestion | null => (g.key ? suggestFor(g, candidates.value) : null);

const clock = (ms: number) => formatMinutes(ms / 60_000);

const log = (s: Suggestion) =>
    invoke('open_focus_suggestion', { draft: { project_id: s.project_id, task_id: s.task_id, minutes: s.minutes, notes: s.notes } }).catch(() => {});
const allowTitles = () => {
    invoke('focus_request_titles').catch(() => {});
    setTimeout(load, 4000);
};

let refresh: ReturnType<typeof setInterval> | null = null;
let unlisten: (() => void) | null = null;
onMounted(() => {
    load();
    listen('insights-show', load).then((off) => (unlisten = off));
    refresh = setInterval(load, 30_000);
});
onUnmounted(() => {
    unlisten?.();
    if (refresh) clearInterval(refresh);
});
</script>

<template>
    <div class="focus">
        <p v-if="!titlesAllowed" class="focus-note">
            {{ t('focus.titlesBlocked') }}
            <button class="link" @click="allowTitles">{{ t('focus.allowTitles') }}</button>
        </p>

        <template v-if="apps.length">
            <div class="focus-total">
                <span>{{ t('focus.today') }}</span>
                <strong>{{ clock(totalMs) }}</strong>
            </div>
            <div v-if="range" class="focus-strip" @mouseleave="hint = ''">
                <i
                    v-for="(seg, i) in strip"
                    :key="i"
                    :style="{ left: `${seg.left * 100}%`, width: `max(${seg.width * 100}%, 2px)`, background: colourOf(seg.app) }"
                    @mouseenter="hint = seg.app"
                ></i>
            </div>
            <div v-if="range" class="focus-axis muted">
                <span>{{ hourLabel(range[0]) }}</span>
                <span class="focus-hint">{{ hint }}</span>
                <span>{{ hourLabel(range[1]) }}</span>
            </div>

            <div v-for="a in apps" :key="a.app" class="focus-app">
                <div class="focus-app-row">
                    <span class="focus-dot" :style="{ background: colourOf(a.app) }"></span>
                    <span class="focus-name">{{ a.app }}</span>
                    <strong>{{ clock(a.ms) }}</strong>
                </div>
                <template v-for="g in rowsOf(a.groups).shown" :key="g.key">
                    <div v-if="g.key" class="focus-group-row">
                        <span class="focus-name" :title="g.titles.map((x) => x.title).join('\n')">{{ g.key }}</span>
                        <span class="muted">{{ clock(g.ms) }}</span>
                    </div>
                    <button v-if="suggestion(g)" class="focus-suggest" @click="log(suggestion(g)!)">
                        {{ t('focus.suggest', { time: formatMinutes(suggestion(g)!.minutes), target: suggestion(g)!.label }) }}
                    </button>
                </template>
                <div v-if="rowsOf(a.groups).rest" class="focus-group-row muted">
                    <span class="focus-name">{{ t('focus.other') }}</span>
                    <span>{{ clock(rowsOf(a.groups).rest) }}</span>
                </div>
            </div>
        </template>
        <p v-else-if="loaded" class="muted focus-empty">{{ t('focus.empty') }}</p>
        <p v-else class="muted focus-empty">{{ t('common.loading') }}</p>
    </div>
</template>

<style scoped>
.focus {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0; /* long titles ellipsise instead of widening the panel */
}
.focus-note {
    font-size: 11px;
    line-height: 1.4;
    color: var(--muted);
    background: var(--accent-soft);
    border-radius: 8px;
    padding: 7px 10px;
}
.focus-note .link {
    font-size: 11px;
    margin-left: 2px;
}
.focus-total {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.focus-total span {
    color: var(--muted);
    font-size: 11px;
}
.focus-total strong {
    font-size: 19px;
    font-variant-numeric: tabular-nums;
}
.focus-strip {
    position: relative;
    height: 14px;
    border-radius: 4px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    overflow: hidden;
}
.focus-strip i {
    position: absolute;
    top: 0;
    bottom: 0;
}
.focus-axis {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    margin-top: -6px;
}
.focus-hint {
    color: var(--text);
}
.focus-app {
    display: flex;
    flex-direction: column;
    gap: 3px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
}
.focus-app-row,
.focus-group-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
}
.focus-app-row strong,
.focus-group-row > span:last-child {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
}
.focus-group-row {
    padding-left: 16px;
}
.focus-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.focus-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
}
.focus-suggest {
    align-self: flex-start;
    margin: 1px 0 3px 16px;
    font-size: 11px;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 6px;
    padding: 2px 8px;
    text-align: left;
}
.focus-suggest:hover {
    filter: brightness(1.15);
}
.focus-empty {
    text-align: center;
    padding: 30px 0;
    font-size: 12px;
}
.link {
    color: var(--accent);
    padding: 0;
}
.muted {
    color: var(--muted);
}
</style>
