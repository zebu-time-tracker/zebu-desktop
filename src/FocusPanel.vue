<script setup lang="ts">
// The Focus tab of the Insights window (board cards #401, #512): where today
// went, from the spans Rust recorded locally, by app or by the project it most
// likely belongs to, and the entries it could become.
//
// Everything shown here is read from this Mac (`focus_spans`), and the rules a
// row's project picker makes stay in this Mac's localStorage. The only thing
// fetched is the user's own timesheet — projects, recent notes and today's
// entries, for the matching and for what is already logged — and the only
// thing ever sent is an entry the user taps Log for. ✎ instead opens the
// popover's new-entry sheet filled in, via `open_focus_suggestion`. Every rule
// is in src/focus.ts and src/focusRules.ts.

import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, auth, formatMinutes, toDateString, type Entry, type ProjectOption } from './api';
import {
    assignTitles,
    byProject,
    candidatesFrom,
    dayBounds,
    groupSpans,
    logState,
    notesFor,
    projectOfRow,
    timeline,
    timelineRange,
    trackedToday,
    type FocusGroup,
    type FocusSpan,
    type ProjectGroup,
} from './focus';
import { loadRules, putRules, ruleIndex, rulesFor, storeRules, type FocusRule } from './focusRules';
import { intlLocale } from './i18n';
import ProjectPicker from './ProjectPicker.vue';

const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();

// The popover owns the preference; this window only reads it for the empty
// state's line, and asks the popover to open its Focus settings to change it.
const minSeconds = (() => {
    try {
        const n = Number(JSON.parse(localStorage.getItem('zebu.prefs') ?? '{}').focusMinSeconds);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 30;
    } catch {
        return 30;
    }
})();
const editThreshold = () => invoke('open_focus_settings').catch(() => {});

/** By app or by project; remembered on this Mac. */
const VIEW_KEY = 'zebu.focusView';
const view = ref<'app' | 'project'>(
    (() => {
        try {
            return localStorage.getItem(VIEW_KEY) === 'app' ? 'app' : 'project';
        } catch {
            return 'project';
        }
    })(),
);
const pickView = (v: 'app' | 'project') => {
    view.value = v;
    assigning.value = null;
    try {
        localStorage.setItem(VIEW_KEY, v);
    } catch {
        /* a convenience only */
    }
    nextTick(() => emit('changed'));
};

const spans = ref<FocusSpan[]>([]);
const titlesAllowed = ref(true);
const loaded = ref(false);
const projects = ref<ProjectOption[]>([]);
const entries = ref<Entry[]>([]);
const tracked = ref<Entry | null>(null);
const weekLocked = ref(false);
const rules = ref<FocusRule[]>(loadRules());
const now = ref(Date.now());

const load = async () => {
    const [from, to] = dayBounds(Date.now());
    spans.value = await invoke<FocusSpan[]>('focus_spans', { from, to }).catch(() => []);
    titlesAllowed.value = await invoke<boolean>('focus_titles_allowed').catch(() => true);
    rules.value = loadRules();
    try {
        const sheet = await api.timesheet(toDateString(new Date()));
        projects.value = sheet.projects;
        entries.value = sheet.entries;
        tracked.value = sheet.running ?? sheet.active ?? null;
        weekLocked.value = sheet.week_locked;
    } catch {
        /* matching just stays quiet without the project list */
    }
    now.value = Date.now();
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

/** How many rows an app or project lists before the rest fold into "Other". */
const SHOWN = 4;
const rowsOf = <T extends { ms: number }>(rows: T[]) => ({ shown: rows.slice(0, SHOWN), rest: rows.slice(SHOWN).reduce((s, g) => s + g.ms, 0) });

// ---- matching -------------------------------------------------------------

const workspaceRules = computed(() => rulesFor(rules.value, auth.workspace));
const candidates = computed(() => candidatesFrom(projects.value, entries.value, tracked.value));
const assigned = computed(() =>
    assignTitles(spans.value, day.value[0], day.value[1], candidates.value, ruleIndex(workspaceRules.value, projects.value.map((p) => p.id))),
);
const groups = computed(() => byProject(assigned.value));
const trackedMin = computed(() => trackedToday(entries.value, toDateString(new Date(now.value)), now.value));
const stateOf = (g: ProjectGroup) => logState(g.ms, g.project_id ? (trackedMin.value.get(g.project_id) ?? 0) : 0);

const projectById = computed(() => new Map(projects.value.map((p) => [p.id, p])));
const projectName = (id: string | null) => (id ? (projectById.value.get(id)?.name ?? '') : '');
const taskName = (g: ProjectGroup) => (g.project_id && g.task_id ? (projectById.value.get(g.project_id)?.tasks.find((x) => x.id === g.task_id)?.name ?? '') : '');
const clientName = (id: string | null) => (id ? (projectById.value.get(id)?.client ?? '') : '');

/** The project a By app row's tag names: the app-wide rule for an app, else where most of the row's time went. */
const appTag = (app: string) => workspaceRules.value.find((r) => r.app === app && !r.key)?.project_id ?? null;
const groupTag = (g: FocusGroup) => projectOfRow(assigned.value, g.app, g.key);

const clock = (ms: number) => formatMinutes(ms / 60_000);

// ---- assigning ------------------------------------------------------------

/** The row whose project picker is open, and the places a choice there makes rules for. */
const assigning = ref<{ row: string; places: { app: string; key: string }[]; current: string } | null>(null);
const picker = ref<InstanceType<typeof ProjectPicker>[] | null>(null);

const startAssign = (row: string, places: { app: string; key: string }[], current: string | null) => {
    if (assigning.value?.row === row) {
        assigning.value = null;
        return;
    }
    assigning.value = { row, places, current: current ?? '' };
    nextTick(() => {
        picker.value?.[0]?.open();
        emit('changed');
    });
};
const assign = (projectId: string) => {
    const a = assigning.value;
    if (!a || !projectId) return;
    rules.value = putRules(loadRules(), a.places, projectId, auth.workspace);
    storeRules(rules.value);
    assigning.value = null;
};
const stopAssign = () => {
    assigning.value = null;
    nextTick(() => emit('changed'));
};
const pickerProps = computed(() => ({
    projects: projects.value,
    placeholder: t('form.addProject'),
    searchPlaceholder: t('form.searchProject'),
    empty: t('form.noProjects'),
    noClient: t('form.noClient'),
    createLabel: '',
}));
const placesOf = (g: ProjectGroup) => g.places.map((p) => ({ app: p.app, key: p.key }));

// ---- logging --------------------------------------------------------------

const logging = ref<string | null>(null);
const error = ref('');

/** One tap: today, the minutes not yet logged, notes from the titles. Never without the tap. */
const logNow = async (g: ProjectGroup) => {
    const st = stateOf(g);
    if (!g.project_id || st.state !== 'log' || logging.value) return;
    logging.value = g.project_id;
    error.value = '';
    try {
        const { entry } = await api.addEntry({ project_id: g.project_id, task_id: g.task_id, date: toDateString(new Date()), minutes: st.minutes, notes: notesFor(g) });
        // counted at once, so the group reads as logged before the refetch lands
        entries.value = [...entries.value, entry];
        emitTo('main', 'focus-logged').catch(() => {});
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        logging.value = null;
    }
};
/** ✎: the same entry, opened in the popover's sheet to edit before saving. */
const editFirst = (g: ProjectGroup) => {
    if (!g.project_id) return;
    invoke('open_focus_suggestion', { draft: { project_id: g.project_id, task_id: g.task_id, minutes: stateOf(g).minutes, notes: notesFor(g) } }).catch(() => {});
};

const allowTitles = () => {
    invoke('focus_request_titles').catch(() => {});
    setTimeout(load, 4000);
};

// Settings edits the same rules from the other window.
const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === 'zebu.focusRules') rules.value = loadRules();
};

let refresh: ReturnType<typeof setInterval> | null = null;
let unlisten: (() => void) | null = null;
onMounted(() => {
    load();
    listen('insights-show', load).then((off) => (unlisten = off));
    refresh = setInterval(load, 30_000);
    window.addEventListener('storage', onStorage);
});
onUnmounted(() => {
    unlisten?.();
    if (refresh) clearInterval(refresh);
    window.removeEventListener('storage', onStorage);
});
</script>

<template>
    <div class="focus">
        <p v-if="!titlesAllowed" class="focus-note">
            {{ t('focus.titlesBlocked') }}
            <button class="link" @click="allowTitles">{{ t('focus.allowTitles') }}</button>
        </p>

        <template v-if="apps.length">
            <div class="focus-head">
                <div class="focus-total">
                    <span>{{ t('focus.today') }}</span>
                    <strong>{{ clock(totalMs) }}</strong>
                </div>
                <div class="focus-views" role="tablist">
                    <button role="tab" :class="{ selected: view === 'app' }" :aria-selected="view === 'app'" @click="pickView('app')">{{ t('focus.byApp') }}</button>
                    <button role="tab" :class="{ selected: view === 'project' }" :aria-selected="view === 'project'" @click="pickView('project')">
                        {{ t('focus.byProject') }}
                    </button>
                </div>
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
            <p v-if="error" class="focus-error">{{ error }}</p>

            <!-- by app: where the time went, each row tagged with its project -->
            <template v-if="view === 'app'">
                <div v-for="a in apps" :key="a.app" class="focus-block">
                    <div class="focus-row focus-head-row">
                        <span class="focus-dot" :style="{ background: colourOf(a.app) }"></span>
                        <span class="focus-name">{{ a.app }}</span>
                        <button class="focus-tag" :class="{ empty: !appTag(a.app) }" :title="t('focus.assign')" @click="startAssign(`app:${a.app}`, [{ app: a.app, key: '' }], appTag(a.app))">
                            <span v-if="appTag(a.app)">{{ projectName(appTag(a.app)) }}</span>
                            <svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
                        </button>
                        <strong class="focus-time">{{ clock(a.ms) }}</strong>
                    </div>
                    <div v-if="assigning?.row === `app:${a.app}`" class="focus-picker">
                        <ProjectPicker ref="picker" v-bind="pickerProps" :model-value="assigning.current" @update:model-value="assign" @closed="stopAssign" />
                    </div>
                    <template v-for="g in rowsOf(a.groups).shown" :key="g.key">
                        <template v-if="g.key">
                            <div class="focus-row focus-sub">
                                <span class="focus-name" :title="g.titles.map((x) => x.title).join('\n')">{{ g.key }}</span>
                                <button
                                    class="focus-tag"
                                    :class="{ empty: !groupTag(g) }"
                                    :title="t('focus.assign')"
                                    @click="startAssign(`group:${a.app}\n${g.key}`, [{ app: a.app, key: g.key }], groupTag(g))"
                                >
                                    <span v-if="groupTag(g)">{{ projectName(groupTag(g)) }}</span>
                                    <svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
                                </button>
                                <span class="focus-time muted">{{ clock(g.ms) }}</span>
                            </div>
                            <div v-if="assigning?.row === `group:${a.app}\n${g.key}`" class="focus-picker">
                                <ProjectPicker ref="picker" v-bind="pickerProps" :model-value="assigning.current" @update:model-value="assign" @closed="stopAssign" />
                            </div>
                        </template>
                    </template>
                    <div v-if="rowsOf(a.groups).rest" class="focus-row focus-sub muted">
                        <span class="focus-name">{{ t('focus.other') }}</span>
                        <span class="focus-time">{{ clock(rowsOf(a.groups).rest) }}</span>
                    </div>
                </div>
            </template>

            <!-- by project: what each project gets, with one tap to log what is left -->
            <template v-else>
                <div v-for="g in groups" :key="g.project_id ?? ''" class="focus-block" :class="{ unassigned: !g.project_id, logged: stateOf(g).state === 'logged' }">
                    <div class="focus-row focus-head-row">
                        <span class="focus-name">
                            <template v-if="g.project_id">
                                <strong>{{ projectName(g.project_id) }}</strong>
                                <span v-if="taskName(g)" class="muted"> · {{ taskName(g) }}</span>
                                <span v-if="clientName(g.project_id)" class="focus-client muted">{{ clientName(g.project_id) }}</span>
                            </template>
                            <strong v-else class="muted">{{ t('focus.unassigned') }}</strong>
                        </span>
                        <strong class="focus-time">{{ clock(g.ms) }}</strong>
                        <template v-if="!g.project_id">
                            <button class="focus-action" @click="startAssign('unassigned', placesOf(g), null)">{{ t('focus.assign') }}</button>
                        </template>
                        <template v-else-if="weekLocked"></template>
                        <template v-else-if="stateOf(g).state === 'log'">
                            <button class="focus-log" :disabled="logging === g.project_id" :title="notesFor(g)" @click="logNow(g)">
                                {{ t('focus.log', { time: formatMinutes(stateOf(g).minutes) }) }}
                            </button>
                            <button class="focus-edit" :title="t('focus.edit')" :aria-label="t('focus.edit')" @click="editFirst(g)">
                                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12H4v-2z" /></svg>
                            </button>
                        </template>
                        <span v-else-if="stateOf(g).state === 'logged'" class="focus-done">✓ {{ t('focus.logged') }}</span>
                    </div>
                    <div v-if="assigning?.row === 'unassigned' && !g.project_id" class="focus-picker">
                        <ProjectPicker ref="picker" v-bind="pickerProps" :model-value="assigning.current" @update:model-value="assign" @closed="stopAssign" />
                    </div>
                    <template v-for="p in rowsOf(g.places).shown" :key="`${p.app}\n${p.key}`">
                        <div class="focus-row focus-sub">
                            <span class="focus-dot small" :style="{ background: colourOf(p.app) }"></span>
                            <span class="focus-name" :title="p.titles.map((x) => x.title).join('\n')">
                                {{ p.key || p.app }}<span v-if="p.key" class="focus-app-name">{{ p.app }}</span>
                            </span>
                            <button
                                class="focus-tag empty"
                                :title="t('focus.assign')"
                                @click="startAssign(`place:${p.app}\n${p.key}`, [{ app: p.app, key: p.key }], g.project_id)"
                            >
                                <svg viewBox="0 0 16 16" aria-hidden="true"><path v-if="g.project_id" d="M3 5.5h9l-2.5-2.5M13 10.5H4l2.5 2.5" /><path v-else d="M8 3.5v9M3.5 8h9" /></svg>
                            </button>
                            <span class="focus-time muted">{{ clock(p.ms) }}</span>
                        </div>
                        <div v-if="assigning?.row === `place:${p.app}\n${p.key}`" class="focus-picker">
                            <ProjectPicker ref="picker" v-bind="pickerProps" :model-value="assigning.current" @update:model-value="assign" @closed="stopAssign" />
                        </div>
                    </template>
                    <div v-if="rowsOf(g.places).rest" class="focus-row focus-sub muted">
                        <span class="focus-name">{{ t('focus.other') }}</span>
                        <span class="focus-time">{{ clock(rowsOf(g.places).rest) }}</span>
                    </div>
                </div>
            </template>
        </template>
        <div v-else-if="loaded" class="focus-empty">
            <p class="muted">{{ t('focus.empty') }}</p>
            <p class="muted focus-empty-hint">
                {{ t('focus.emptyHint', { seconds: minSeconds }) }}
                <button class="link" @click="editThreshold">{{ t('focus.emptyEdit') }}</button>
            </p>
        </div>
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
.focus-error {
    font-size: 11px;
    color: var(--danger);
}
.focus-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 10px;
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
.focus-views {
    display: flex;
    padding: 2px;
    border-radius: 7px;
    background: var(--bg-input);
    border: 1px solid var(--border);
}
.focus-views button {
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 5px;
    color: var(--muted);
}
.focus-views button.selected {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
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
.focus-block {
    display: flex;
    flex-direction: column;
    gap: 3px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
}
.focus-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
    font-size: 12px;
}
.focus-sub {
    padding-left: 16px;
}
.focus-time {
    flex: none;
    font-variant-numeric: tabular-nums;
}
.focus-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.focus-client,
.focus-app-name {
    margin-left: 6px;
    font-size: 11px;
    color: var(--muted);
}
.focus-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
}
.focus-dot.small {
    width: 6px;
    height: 6px;
    margin-left: -12px;
    margin-right: -2px;
}
.focus-tag {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 45%;
    display: inline-flex;
    align-items: center;
    font-size: 10.5px;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 7px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.focus-tag span {
    overflow: hidden;
    text-overflow: ellipsis;
}
.focus-tag:hover {
    color: var(--accent);
    border-color: var(--accent);
}
.focus-tag.empty {
    border-color: transparent;
    padding: 1px 3px;
    opacity: 0;
}
.focus-row:hover .focus-tag.empty,
.focus-tag.empty:focus-visible {
    opacity: 1;
}
.focus-tag svg,
.focus-edit svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.focus-log {
    flex: none;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border-radius: 6px;
    padding: 2px 9px;
    font-variant-numeric: tabular-nums;
}
.focus-log:hover {
    filter: brightness(1.1);
}
.focus-log:disabled {
    opacity: 0.6;
    cursor: default;
}
.focus-edit {
    flex: none;
    display: inline-grid;
    place-content: center;
    width: 22px;
    height: 20px;
    margin-left: -4px;
    color: var(--muted);
    border-radius: 6px;
}
.focus-edit:hover {
    color: var(--text);
    background: var(--accent-soft);
}
.focus-action {
    flex: none;
    font-size: 11px;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 6px;
    padding: 2px 9px;
}
.focus-action:hover {
    filter: brightness(1.15);
}
.focus-done {
    flex: none;
    font-size: 11px;
    color: var(--accent);
}
.focus-picker {
    padding-left: 16px;
}
/* in the flow rather than floating: the window is only as tall as what it
   measures (fit_insights), so a list hanging below the last row would be cut */
.focus-picker :deep(.picker-list) {
    position: static;
    margin-top: 4px;
    box-shadow: none;
}
.focus-picker :deep(.picker-button),
.focus-picker :deep(input) {
    font-size: 12px;
    padding-top: 4px;
    padding-bottom: 4px;
}
.focus-empty {
    text-align: center;
    padding: 30px 0;
    font-size: 12px;
}
.focus-empty p {
    margin: 0;
}
.focus-empty-hint {
    margin-top: 6px !important;
    font-size: 11px;
}
.link {
    color: var(--accent);
    padding: 0;
}
.muted {
    color: var(--muted);
}
</style>
