<script setup lang="ts">
// The entry sheet's project field: SearchSelect with the project's own
// rendering. The list groups the matches by client, with the client as a small
// heading above its projects, so each row is just "CODE: Project title" and a
// long client name can never crowd the project out of the narrow popover.
import { ref } from 'vue';
import type { ProjectOption } from './api';
import SearchSelect from './SearchSelect.vue';

defineProps<{
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
const emit = defineEmits<{ 'update:modelValue': [string]; picked: []; create: []; closed: [] }>();

const select = ref<{ open: () => void; focus: () => void } | null>(null);
defineExpose({ open: () => select.value?.open(), focus: () => select.value?.focus() });

const text = (p: ProjectOption) => `${p.code ?? ''} ${p.name} ${p.client ?? ''}`;
const label = (p: ProjectOption) => `${p.code ? `${p.code}: ` : ''}${p.name}${p.client ? ` (${p.client})` : ''}`;
const client = (p: ProjectOption) => p.client ?? '';
</script>

<template>
    <SearchSelect
        ref="select"
        :model-value="modelValue"
        :options="projects"
        :text="text"
        :label="label"
        :group-of="client"
        :no-group="noClient"
        :placeholder="placeholder"
        :search-placeholder="searchPlaceholder"
        :empty="empty"
        :create-label="createLabel"
        @update:model-value="emit('update:modelValue', $event)"
        @picked="emit('picked')"
        @create="emit('create')"
        @closed="emit('closed')"
    >
        <template #selected="{ option }">
            <span v-if="option.code" class="picker-code">{{ option.code }}:</span>
            <span class="picker-title">{{ option.name }}</span>
            <span v-if="option.client" class="picker-client">({{ option.client }})</span>
        </template>
        <template #row="{ option }">
            <span v-if="option.code" class="picker-code">{{ option.code }}:</span>
            <span class="picker-title">{{ option.name }}</span>
        </template>
    </SearchSelect>
</template>
