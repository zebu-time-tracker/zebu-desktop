<script setup lang="ts">
// A piece of a picker row with the characters the search matched marked, so
// the row shows why it is listed (board #569). Plain text when nothing is
// typed. The cutting is src/fuzzy.ts's; this only renders the runs.
import { computed } from 'vue';
import { segments } from './fuzzy';

const props = defineProps<{ text: string; query: string }>();
const runs = computed(() => segments(props.query, props.text));
</script>

<template>
    <template v-for="(run, i) in runs" :key="i"><mark v-if="run.hit" class="hit">{{ run.text }}</mark><template v-else>{{ run.text }}</template></template>
</template>
