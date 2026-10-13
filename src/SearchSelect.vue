<script setup lang="ts" generic="T extends { id: string }">
// The entry sheet's search picker: type to filter, arrows + Return to choose,
// Escape to back out. One component for the project field and the task field
// (board #501), so the two cannot drift apart; every rule worth testing is in
// src/picker.ts.
//
// `groupOf` puts the matches under small headings (the project picker groups
// by client), so each row stays short and a long heading can never crowd the
// row out of the narrow popover. Headings are inert: only rows take part in
// keyboard navigation, which walks them in the order they are rendered.
import { computed, nextTick, ref, watch } from 'vue';
import { fuzzyFilter } from './fuzzy';
import { focusLeftPicker, groupBy, homeIndex, listKey, pointerMoved, settleActive, step } from './picker';

const props = defineProps<{
    modelValue: string;
    options: T[];
    /** What the search matches against. */
    text: (option: T) => string;
    /** The whole row in words, for its tooltip. */
    label: (option: T) => string;
    /** Heading to file a row under; rows are not grouped without it. */
    groupOf?: (option: T) => string;
    /** Heading for the rows whose `groupOf` is ''. */
    noGroup?: string;
    placeholder: string;
    searchPlaceholder: string;
    empty: string;
    /** A first row that clears the choice, as a plain select's empty option did. Shown while nothing is typed. */
    noneLabel?: string;
    /** Footer link; the timer stays a timer, so new projects are created in the web app. */
    createLabel?: string;
    disabled?: boolean;
}>();
const emit = defineEmits<{
    'update:modelValue': [string];
    /** A row was chosen, by Return or by click: the sheet moves focus on. */
    picked: [];
    create: [];
    /** The list closed, picked or not: a picker shown only for one choice (the Focus tab's) goes away. */
    closed: [];
}>();
defineSlots<{
    selected?(p: { option: T }): unknown;
    row?(p: { option: T }): unknown;
}>();

const open = ref(false);
const query = ref('');
const active = ref(-1);
const input = ref<HTMLInputElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLElement | null>(null);

const selected = computed(() => props.options.find((o) => o.id === props.modelValue) ?? null);
const showNone = computed(() => props.noneLabel !== undefined && !query.value.trim());
const filtered = computed(() => fuzzyFilter(props.options, query.value, props.text));
const groups = computed(() => groupBy(filtered.value, props.groupOf ?? (() => ''), showNone.value ? 1 : 0));
/** The rows as they are rendered, top to bottom, by id ('' is the none row): what `active` indexes into. */
const ids = computed(() => [...(showNone.value ? [''] : []), ...groups.value.flatMap((g) => g.items.map((o) => o.id))]);

// The list can change under the person (a refetch hands over fresh projects)
// without them doing anything; only a new query moves the highlight then.
watch([query, ids], ([q, now], [prevQ, prev]) => {
    active.value = settleActive({ ids: now, prevIds: prev, index: active.value, queryChanged: q !== prevQ, query: q, selected: props.modelValue });
});

const show = () => {
    if (props.disabled) return;
    open.value = true;
    query.value = '';
    active.value = homeIndex(ids.value, props.modelValue);
    lastPointer = null;
    nextTick(() => {
        input.value?.focus();
        scrollToActive();
    });
};
const close = () => {
    open.value = false;
    emit('closed');
    nextTick(() => button.value?.focus());
};
// The new-entry sheet opens straight into the project search, so the first
// keystroke is already a project name (board card #146), and picking a project
// opens the task search the same way (board #501). Exposed rather than made a
// prop: opening the list is an action taken once, not a state to keep in sync.
defineExpose({ open: show, focus: () => button.value?.focus() });

const pick = (id: string) => {
    emit('update:modelValue', id);
    close();
    emit('picked');
};

const scrollToActive = () => list.value?.querySelector<HTMLElement>('.picker-row.active')?.scrollIntoView({ block: 'nearest' });

const onKey = (e: KeyboardEvent) => {
    const action = listKey(e);
    if (!action) return;
    e.preventDefault();
    if (action === 'next' || action === 'prev') {
        active.value = step(active.value, action === 'next' ? 1 : -1, ids.value.length);
        nextTick(scrollToActive);
    } else if (action === 'pick') {
        const id = ids.value[active.value];
        if (id !== undefined) pick(id);
    } else {
        close();
    }
};

let lastPointer: { x: number; y: number } | null = null;
const onPointer = (e: MouseEvent, index: number) => {
    const at = { x: e.screenX, y: e.screenY };
    if (!pointerMoved(lastPointer, at)) return;
    lastPointer = at;
    active.value = index;
};

// Asked a frame later, and of the document rather than the event: see
// focusLeftPicker for why the event itself cannot answer this.
const onFocusOut = (e: FocusEvent) => {
    const root = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
        if (open.value && focusLeftPicker(root, document.activeElement)) {
            open.value = false;
            emit('closed');
        }
    });
};
</script>

<template>
    <div class="picker" @focusout="onFocusOut">
        <button v-if="!open" ref="button" type="button" class="picker-button" :class="{ placeholder: !selected }" :disabled="disabled" @click="show">
            <template v-if="selected">
                <slot name="selected" :option="selected">
                    <span class="picker-title">{{ label(selected) }}</span>
                </slot>
            </template>
            <template v-else>{{ placeholder }}</template>
        </button>
        <input v-else ref="input" v-model="query" type="text" :placeholder="searchPlaceholder" autocomplete="off" spellcheck="false" @keydown="onKey" />

        <!-- rows take no Tab stop: Tab leaves the field for the next one, as it would a select -->
        <div v-if="open" ref="list" class="picker-list" role="listbox">
            <button
                v-if="showNone"
                type="button"
                tabindex="-1"
                class="picker-row picker-none"
                :class="{ active: active === 0, current: !modelValue }"
                role="option"
                :aria-selected="!modelValue"
                @mousedown.prevent="pick('')"
                @mousemove="onPointer($event, 0)"
            >
                {{ noneLabel }}
            </button>
            <div v-for="g in groups" :key="g.key" class="picker-group" role="group" :aria-label="groupOf ? g.key || noGroup : undefined">
                <p v-if="groupOf" class="picker-group-name" aria-hidden="true">{{ g.key || noGroup }}</p>
                <button
                    v-for="(o, i) in g.items"
                    :key="o.id"
                    type="button"
                    tabindex="-1"
                    class="picker-row"
                    :class="{ active: g.offset + i === active, current: o.id === modelValue }"
                    role="option"
                    :aria-selected="o.id === modelValue"
                    :title="label(o)"
                    @mousedown.prevent="pick(o.id)"
                    @mousemove="onPointer($event, g.offset + i)"
                >
                    <slot name="row" :option="o">
                        <span class="picker-title">{{ label(o) }}</span>
                    </slot>
                </button>
            </div>
            <p v-if="!filtered.length" class="picker-empty">{{ empty }}</p>
            <button v-if="createLabel" type="button" tabindex="-1" class="picker-row picker-create" @mousedown.prevent="emit('create')">{{ createLabel }}</button>
        </div>
    </div>
</template>
