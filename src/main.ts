import { getCurrentWindow } from '@tauri-apps/api/window';
import { createApp } from 'vue';
import App from './App.vue';
import IdlePrompt from './IdlePrompt.vue';
import Insights from './Insights.vue';
import { i18n } from './i18n';
import './style.css';

// One bundle, three windows: the idle prompt and the insights panel are their
// own windows (created in src-tauri/src/lib.rs) so neither is clipped by the
// timer list's tiny frame. The label says which one we are; the hash is the
// fallback for `npm run dev` in a plain browser, where there is no Tauri to
// ask.
let label = '';
try {
    label = getCurrentWindow().label;
} catch {
    /* not running inside Tauri */
}
const route = label === 'idle' || location.hash === '#idle' ? 'idle' : label === 'insights' || location.hash === '#insights' ? 'insights' : 'main';
if (route !== 'main') document.documentElement.dataset.window = route;

createApp(route === 'idle' ? IdlePrompt : route === 'insights' ? Insights : App)
    .use(i18n)
    .mount('#app');
