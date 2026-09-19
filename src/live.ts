/* The workspace's live channel, as far as the webview is concerned.
 *
 * The socket itself lives in Rust (src-tauri/src/live.rs): the webview's
 * timers stall while the popover is hidden, so nothing time-critical may run
 * here. This side only reads the `broadcast` block off GET /api/me and hands
 * Rust what the socket needs. Every rule is a plain function so it can be
 * tested without Tauri.
 */

/** Where Reverb listens and which channel is this person's. */
export interface Broadcast {
    key: string;
    /** null: the workspace host the app already talks to. */
    host: string | null;
    port: number;
    scheme: 'http' | 'https';
    channel: string;
}

/** What Rust needs to keep the socket up: which workspace, as whom, and the block. */
export interface LiveSource {
    workspace: string;
    token: string;
    broadcast: Broadcast;
}

/**
 * The `broadcast` block, or null when the workspace does not push — an older
 * server without the field, `null` because Reverb is not configured, or a
 * block the client only half understands. Null means keep polling as before;
 * a broken block must never stop the app polling.
 */
export const readBroadcast = (value: unknown): Broadcast | null => {
    const block = value as Partial<Broadcast> | null | undefined;

    if (!block || typeof block.key !== 'string' || block.key === '' || typeof block.channel !== 'string' || block.channel === '') return null;

    const host = typeof block.host === 'string' && block.host !== '' ? block.host : null;
    const scheme = block.scheme === 'http' ? 'http' : 'https';
    const port = Number.isInteger(block.port) && (block.port as number) > 0 ? (block.port as number) : 443;

    return { key: block.key, host, port, scheme, channel: block.channel };
};

/**
 * What to hand Rust, or null when there is nothing to subscribe to: no
 * broadcast block, or nobody signed in.
 */
export const liveSource = (workspace: string, token: string, broadcast: Broadcast | null): LiveSource | null =>
    broadcast && workspace && token ? { workspace, token, broadcast } : null;
