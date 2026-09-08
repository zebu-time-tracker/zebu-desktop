import { getCurrentWindow } from '@tauri-apps/api/window';
import { createApp } from 'vue';
import App from './App.vue';
import IdlePrompt from './IdlePrompt.vue';
import { i18n } from './i18n';
import './style.css';

// One bundle, two windows: the idle prompt is its own always-on-top window
// (created in src-tauri/src/lib.rs) so it can hang outside the timer list's
// frame instead of being clipped by it. The label says which one we are; the
// hash is the fallback for `npm run dev` in a plain browser, where there is no
// Tauri to ask.
let label = '';
try {
    label = getCurrentWindow().label;
} catch {
    /* not running inside Tauri */
}
const isIdlePrompt = label === 'idle' || location.hash === '#idle';
if (isIdlePrompt) document.documentElement.dataset.window = 'idle';

createApp(isIdlePrompt ? IdlePrompt : App)
    .use(i18n)
    .mount('#app');
