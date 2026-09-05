// Auto-update: the Tauri updater plugin fetches latest.json from the GitHub
// release (endpoint + public key in tauri.conf.json), verifies the signature,
// and swaps the binary; the process plugin relaunches into the new build.
// Everything here is best-effort — an update check must never break the app.

import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { ref } from 'vue';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'upToDate' | 'downloading' | 'installing' | 'error';

export const updateStatus = ref<UpdateStatus>('idle');
/** Version on offer while `available`/`downloading`/`installing`. */
export const updateVersion = ref('');
/** 0–100 while downloading, when the server sends a Content-Length. */
export const updateProgress = ref<number | null>(null);
/** True while the launch-time prompt should be showing. */
export const updatePromptOpen = ref(false);

let pending: Update | null = null;

/** Looks for a newer release. `manual` surfaces "up to date"/errors; the launch check stays quiet unless something is available. */
export async function checkForUpdates(manual = false): Promise<void> {
    if (updateStatus.value === 'checking' || updateStatus.value === 'downloading' || updateStatus.value === 'installing') return;
    updateStatus.value = 'checking';
    try {
        const update = await check({ timeout: 15_000 });
        if (update) {
            pending = update;
            updateVersion.value = update.version;
            updateStatus.value = 'available';
            updatePromptOpen.value = true;
        } else {
            pending = null;
            updateStatus.value = manual ? 'upToDate' : 'idle';
        }
    } catch {
        // offline, endpoint not yet published, or not running inside Tauri
        pending = null;
        updateStatus.value = manual ? 'error' : 'idle';
    }
}

/** Downloads, installs and relaunches. On failure the current build keeps running. */
export async function installUpdate(): Promise<void> {
    const update = pending;
    if (!update) return;
    updatePromptOpen.value = false;
    updateStatus.value = 'downloading';
    updateProgress.value = null;
    let total = 0;
    let received = 0;
    try {
        await update.downloadAndInstall((event) => {
            if (event.event === 'Started') {
                total = event.data.contentLength ?? 0;
            } else if (event.event === 'Progress') {
                received += event.data.chunkLength;
                if (total > 0) updateProgress.value = Math.min(100, Math.round((received / total) * 100));
            } else if (event.event === 'Finished') {
                updateStatus.value = 'installing';
            }
        });
        await relaunch();
    } catch {
        updateStatus.value = 'error';
    }
}

/** "Later": keep the update around so settings can still install it, but stop prompting. */
export function dismissUpdate(): void {
    updatePromptOpen.value = false;
}
