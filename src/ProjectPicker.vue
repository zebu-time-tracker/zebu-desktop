<script setup lang="ts">
// Fuzzy project picker for the entry sheet: type to filter, arrows + Enter to
// choose. The list groups the matches by client, with the client as a small
// heading above its projects, so each row is just "CODE: Project title" and a
// long client name can never crowd the project out of the narrow popover.
// Headings are inert: only the project rows take part in keyboard navigation,
// which walks the flattened list in the order the groups are rendered.
import { computed, nextTick, ref, watch } from 'vue';
import type { ProjectOption } from './api';
import { fuzzyFilter } from './fuzzy';
import { focusLeftPicker, groupByClient } from './picker';

const props = defineProps<{
    modelValue: string;
    projects: ProjectOption[];
    placeholder: string;
    searchPlaceholder: string;
    empty: string;
    /** Heading for the group of projects that have no client. */
    noClient: string;
    /** Footer link; the timer stays a timer, so new projects are created in the web app. */
    createLabel: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [string]; create: [] }>();

const open = ref(false);
const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

const selected = computed(() => props.projects.find((p) => p.id === props.modelValue) ?? null);
const label = (p: ProjectOption) => `${p.code ? `${p.code}: ` : ''}${p.name}${p.client ? ` (${p.client})` : ''}`;

const filtered = computed(() => fuzzyFilter(props.projects, query.value, (p) => `${p.code ?? ''} ${p.name} ${p.client ?? ''}`));
const groups = computed(() => groupByClient(filtered.value));
/** The rows as they are rendered, top to bottom: what `active` indexes into. */
const rows = computed(() => groups.value.flatMap((g) => g.projects));

watch(filtered, () => (active.value = 0));

const show = () => {
    open.value = true;
    query.value = '';
    nextTick(() => input.value?.focus());
};
// The new-entry sheet opens straight into the search, so the first keystroke
// is already a project name (board card #146). Exposed rather than made a
// prop: opening the list is an action taken once, not a state to keep in sync.
defineExpose({ open: show });
const choose = (p: ProjectOption) => {
    emit('update:modelValue', p.id);
    open.value = false;
};
const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        active.value = Math.min(active.value + 1, rows.value.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active.value = Math.max(active.value - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const p = rows.value[active.value];
        if (p) choose(p);
    } else if (e.key === 'Escape') {
        open.value = false;
    }
    nextTick(() => list.value?.querySelector<HTMLElement>('.picker-row.active')?.scrollIntoView({ block: 'nearest' }));
};

// Asked a frame later, and of the document rather than the event: see
// focusLeftPicker for why the event itself cannot answer this.
const onFocusOut = (e: FocusEvent) => {
    const root = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
        if (focusLeftPicker(root, document.activeElement)) open.value = false;
    });
};
</script>

<template>
    <div class="picker" @focusout="onFocusOut">
        <button v-if="!open" type="button" class="picker-button" :class="{ placeholder: !selected }" @click="show">
            <template v-if="selected">
                <span v-if="selected.code" class="picker-code">{{ selected.code }}:</span>
                <span class="picker-title">{{ selected.name }}</span>
                <span v-if="selected.client" class="picker-client">({{ selected.client }})</span>
            </template>
            <template v-else>{{ placeholder }}</template>
        </button>
        <input v-else ref="input" v-model="query" type="text" :placeholder="searchPlaceholder" autocomplete="off" spellcheck="false" @keydown="onKey" />

        <div v-if="open" ref="list" class="picker-list" role="listbox">
            <div v-for="g in groups" :key="g.client" class="picker-group" role="group" :aria-label="g.client || noClient">
                <p class="picker-group-name" aria-hidden="true">{{ g.client || noClient }}</p>
                <button
                    v-for="(p, i) in g.projects"
                    :key="p.id"
                    type="button"
                    class="picker-row"
                    :class="{ active: g.offset + i === active, current: p.id === modelValue }"
                    role="option"
                    :aria-selected="p.id === modelValue"
                    :title="label(p)"
                    @mousedown.prevent="choose(p)"
                    @mouseenter="active = g.offset + i"
                >
                    <span v-if="p.code" class="picker-code">{{ p.code }}:</span>
                    <span class="picker-title">{{ p.name }}</span>
                </button>
            </div>
            <p v-if="!rows.length" class="picker-empty">{{ empty }}</p>
            <button type="button" class="picker-row picker-create" @mousedown.prevent="emit('create')">{{ createLabel }}</button>
        </div>
    </div>
</template>
