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
// (`idle_prompt_data`) and takes back the two answers (`resolve_idle_prompt`),
// which reach the main window as an `idle-choice` event. All the logic for
// what those answers do stays in App.vue.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { setLocalePreference } from './i18n';

const { t } = useI18n();

const minutes = ref(1);
// "Remove Idle Time?" — yes by default: you stepped away, that time is not work.
const removeIdle = ref(true);
// "Continue Timing?" — yes by default, the timer keeps running (as before).
const keepTiming = ref(true);

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
    removeIdle.value = true;
    keepTiming.value = true;
    await nextTick();
    // measured, not guessed: translated headings wrap to two lines in some locales
    invoke('fit_idle_prompt', { height: document.documentElement.scrollHeight }).catch(() => {});
};

const ok = () => invoke('resolve_idle_prompt', { remove: removeIdle.value, stop: !keepTiming.value }).catch(() => {});

const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') ok();
};

let unlisten: (() => void) | null = null;
onMounted(() => {
    load();
    // the window is reused for the next absence, so re-read on every show
    listen('idle-prompt-show', load).then((off) => (unlisten = off));
    window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
    unlisten?.();
    window.removeEventListener('keydown', onKey);
});
</script>

<template>
    <div class="idle" role="dialog" :aria-label="t('idle.title', { n: minutes }, minutes)">
        <p class="idle-heading">{{ t('idle.title', { n: minutes }, minutes) }}</p>

        <p class="idle-question">{{ t('idle.timeQuestion') }}</p>
        <div class="seg" role="radiogroup" :aria-label="t('idle.timeQuestion')">
            <button :class="{ active: removeIdle }" role="radio" :aria-checked="removeIdle" @click="removeIdle = true">{{ t('common.yes') }}</button>
            <button :class="{ active: !removeIdle }" role="radio" :aria-checked="!removeIdle" @click="removeIdle = false">{{ t('common.no') }}</button>
        </div>

        <p class="idle-question">{{ t('idle.timerQuestion') }}</p>
        <div class="seg" role="radiogroup" :aria-label="t('idle.timerQuestion')">
            <button :class="{ active: keepTiming }" role="radio" :aria-checked="keepTiming" @click="keepTiming = true">{{ t('common.yes') }}</button>
            <button :class="{ active: !keepTiming }" role="radio" :aria-checked="!keepTiming" @click="keepTiming = false">{{ t('common.no') }}</button>
        </div>

        <button class="idle-ok" @click="ok">{{ t('idle.ok') }}</button>
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
}
.idle-question {
    margin: 0 0 5px;
    font-size: 11px;
    color: var(--muted);
}
.seg {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-input);
    margin-bottom: 12px;
}
.seg button {
    padding: 8px 10px;
    color: var(--muted);
    font-weight: 500;
}
.seg button + button {
    border-left: 1px solid var(--border);
}
.seg button.active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
}
.idle-ok {
    background: var(--accent);
    color: #fff;
    border-radius: 8px;
    padding: 8px 18px;
    font-weight: 600;
    width: 100%;
}
</style>
