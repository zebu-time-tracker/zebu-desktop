<script setup lang="ts">
// Fuzzy project picker for the entry sheet: type to filter, arrows + Enter to
// choose. Each row reads "CODE: Project title (Client)"; only the title
// truncates, so the code and client always stay visible.
import { computed, nextTick, ref, watch } from 'vue';
import type { ProjectOption } from './api';
import { fuzzyFilter } from './fuzzy';

const props = defineProps<{
    modelValue: string;
    projects: ProjectOption[];
    placeholder: string;
    searchPlaceholder: string;
    empty: string;
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

watch(filtered, () => (active.value = 0));

const show = () => {
    open.value = true;
    query.value = '';
    nextTick(() => input.value?.focus());
};
const choose = (p: ProjectOption) => {
    emit('update:modelValue', p.id);
    open.value = false;
};
const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        active.value = Math.min(active.value + 1, filtered.value.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active.value = Math.max(active.value - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const p = filtered.value[active.value];
        if (p) choose(p);
    } else if (e.key === 'Escape') {
        open.value = false;
    }
    nextTick(() => list.value?.querySelector<HTMLElement>('.picker-row.active')?.scrollIntoView({ block: 'nearest' }));
};
</script>

<template>
    <div class="picker" @focusout="(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) open = false; }">
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
            <button
                v-for="(p, i) in filtered"
                :key="p.id"
                type="button"
                class="picker-row"
                :class="{ active: i === active, current: p.id === modelValue }"
                role="option"
                :aria-selected="p.id === modelValue"
                :title="label(p)"
                @mousedown.prevent="choose(p)"
                @mouseenter="active = i"
            >
                <span v-if="p.code" class="picker-code">{{ p.code }}:</span>
                <span class="picker-title">{{ p.name }}</span>
                <span v-if="p.client" class="picker-client">({{ p.client }})</span>
            </button>
            <p v-if="!filtered.length" class="picker-empty">{{ empty }}</p>
            <button type="button" class="picker-row picker-create" @mousedown.prevent="emit('create')">{{ createLabel }}</button>
        </div>
    </div>
</template>
