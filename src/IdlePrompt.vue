<script setup lang="ts">
// The idle prompt, in its own always-on-top window.
//
// It used to be a callout absolutely positioned inside the timer list, which
// the window frame clipped: a running entry near the bottom of a long list
// pushed the prompt out of sight and it had to be scrolled to. As its own OS
// window it is placed against the running entry's stop button but clamped to
// the monitor, so it is always fully visible.
//
// The window is a dumb presenter: Rust hands it the minutes away
// (`idle_prompt_data`, the server's count) and takes back the button pressed
// (`resolve_idle_prompt`), which reaches the main window as an `idle-choice`
// event. What each answer does — every one goes to the server — stays in
// App.vue and src/idle.ts.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatDurationHuman } from './api';
import { setLocalePreference } from './i18n';
import type { IdleChoice } from './idle';

const { t } = useI18n();

const minutes = ref(1);
/**
 * The absence as "12h 43m" rather than "763 minutes" — a raw minute count is
 * hard to read once an absence runs past an hour. Same formatter (and locale
 * unit labels) as the totals in the main window.
 */
const duration = computed(() => formatDurationHuman(minutes.value));
const heading = computed(() => t('idle.title', { duration: duration.value }));

/** Harvest's four answers. "Continue timing and remove" is the default (focused, so Enter picks it), as before. */
const choices = computed<{ choice: IdleChoice; label: string }[]>(() => [
    { choice: 'stop', label: t('idle.stop', { duration: duration.value }) },
    { choice: 'continue', label: t('idle.continue', { duration: duration.value }) },
    { choice: 'new_entry', label: t('idle.newEntry', { duration: duration.value }) },
    { choice: 'ignore', label: t('idle.ignore') },
]);

/** Theme and language are the main window's preferences; both windows share localStorage. */
const applyPrefs = () => {
    try {
        const prefs = JSON.parse(localStorage.getItem('zebu.prefs') ?? '{}');
        if (prefs.appearance && prefs.appearance !== 'system') document.documentElement.dataset.theme = prefs.appearance;
        else delete document.documentElement.dataset.theme;
        setLocalePreference(prefs.language ?? 'system');
    } catch {
        /* defaults are fine */
    }
};

/** Load the absence Rust is asking about, then let it size and reveal the window. */
const load = async () => {
    applyPrefs();
    const away = await invoke<number | null>('idle_prompt_data').catch(() => null);
    if (typeof away === 'number') minutes.value = away;
    await nextTick();
    document.querySelector<HTMLButtonElement>('.idle-choice.primary')?.focus();
    // Measured, not guessed: translated labels wrap to two lines in some
    // locales. Measure <body> — it is the card, borders included — rather than
    // documentElement.scrollHeight, which can never report less than the
    // window it is already in and so could only ever grow the window.
    invoke('fit_idle_prompt', { height: Math.ceil(document.body.getBoundingClientRect().height) }).catch(() => {});
};

const answer = (choice: IdleChoice) => invoke('resolve_idle_prompt', { choice }).catch(() => {});

let unlisten: (() => void) | null = null;
onMounted(() => {
    load();
    // the window is reused for the next absence, so re-read on every show
    listen('idle-prompt-show', load).then((off) => (unlisten = off));
});
onUnmounted(() => unlisten?.());
</script>

<template>
    <div class="idle" role="dialog" :aria-label="heading">
        <p class="idle-heading">{{ heading }}</p>
        <div class="idle-choices">
            <button v-for="c in choices" :key="c.choice" :class="['idle-choice', { primary: c.choice === 'continue', quiet: c.choice === 'ignore' }]" @click="answer(c.choice)">
                {{ c.label }}
            </button>
        </div>
    </div>
</template>

<style>
/* Only this window: it is sized to its content, so nothing stretches to 100%.
   main.ts stamps data-window="idle" on <html>; the main window is untouched. */
html[data-window='idle'],
html[data-window='idle'] body,
html[data-window='idle'] #app {
    height: auto;
}
html[data-window='idle'] body {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
}
</style>

<style scoped>
.idle {
    display: flex;
    flex-direction: column;
    padding: 14px;
}
.idle-heading {
    margin: 0 0 12px;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--text);
    text-align: center;
}
.idle-choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.idle-choice {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-input);
    color: var(--text);
    font-weight: 500;
    line-height: 1.3;
}
.idle-choice.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
}
.idle-choice.quiet {
    border-color: transparent;
    background: transparent;
    color: var(--muted);
}
</style>
