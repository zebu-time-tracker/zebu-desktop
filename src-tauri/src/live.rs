//! Live timer updates over Reverb (board #278).
//!
//! The workspace pushes "your timer changed" the moment an entry is written,
//! so a start in the browser or the Chrome extension reaches the menubar in
//! about a hundred milliseconds instead of on the next pulse. The wire is the
//! Pusher protocol (version 7) that Reverb speaks: connect, learn the socket
//! id, authorise the person's private channel with the bearer token,
//! subscribe, answer pings, and read `timer.changed` events, which carry the
//! pulse — a token, whether a clock runs, the server's clock.
//!
//! Rust owns the socket for the same reason it owns the tray ticker: the
//! webview's timers stall while the popover is hidden, which is most of the
//! time for a menubar app. The webview hands over what it learned from
//! `GET /api/me` (`set_live_source`) and gets two events back — `live-state`
//! when the subscription comes up or goes down, `live-changed` for every
//! pushed change — and keeps deciding what to fetch (src/pulse.ts). Without a
//! `broadcast` block nothing here runs and the pulse stays as it is.
//!
//! The pure half (URL, frames, link bookkeeping, backoff) is tested; [`run`]
//! is the loop that keeps one connection up for as long as the source stands,
//! reconnecting with backoff.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio_tungstenite::tungstenite::Message;

/// The `broadcast` block of GET /api/me: where Reverb listens and which
/// channel is this person's.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Broadcast {
    pub key: String,
    /// None: the workspace host the app already talks to.
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_scheme")]
    pub scheme: String,
    pub channel: String,
}

fn default_port() -> u16 {
    443
}

fn default_scheme() -> String {
    "https".to_string()
}

/// Everything the socket needs, handed over by the webview once it has
/// talked to the workspace: which one, as whom, and the broadcast block.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct LiveSource {
    /// The workspace origin, e.g. `https://studio.zebu.work`.
    pub workspace: String,
    pub token: String,
    pub broadcast: Broadcast,
}

/// While the socket is up every change is pushed, so the pulse is only a
/// backstop against a quietly dead socket — a closed lid, a proxy timeout —
/// and slows to this whether or not a clock runs.
pub const PULSE_LIVE_S: u64 = 30;

/// Whether a subscription is up right now; the tray ticker reads it to pick
/// the pulse cadence.
pub static LIVE: AtomicBool = AtomicBool::new(false);

/// Bumped for every new source so a task that was replaced cannot report on
/// behalf of the one that replaced it.
static GENERATION: AtomicU64 = AtomicU64::new(0);

static TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

/// What `live-state` carries: whether pushes are arriving, and — on the way
/// back up — whether anything could have been missed while they were not.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LiveState {
    pub live: bool,
    pub gap: bool,
}

/// What `live-changed` carries: the pulse, pushed. `token` None means
/// changed, refetch; `at` is the server's clock.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LiveChange {
    pub token: Option<String>,
    pub running: Option<bool>,
    pub at: Option<String>,
}

/// Where to open the socket: the workspace's own host unless the server named
/// another (a dev box exposing Reverb on its own port, say).
pub fn socket_url(broadcast: &Broadcast, origin: &str, version: &str) -> String {
    let host = match broadcast.host.as_deref().filter(|h| !h.is_empty()) {
        Some(host) => host.to_string(),
        None => origin.split("://").nth(1).unwrap_or(origin).split(['/', ':']).next().unwrap_or("").to_string(),
    };
    let proto = if broadcast.scheme == "http" { "ws" } else { "wss" };
    format!("{proto}://{host}:{}/app/{}?protocol=7&client=zebu-desktop&version={version}", broadcast.port, broadcast.key)
}

/// One frame off the wire, reduced to what the loop acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// Reverb's hello, with the id the channel auth needs.
    Established { socket_id: String },
    Subscribed,
    Ping,
    /// A protocol error: reconnect rather than guess.
    Error,
    TimerChanged(LiveChange),
    Other,
}

#[derive(Deserialize)]
struct RawFrame {
    event: String,
    #[serde(default)]
    data: serde_json::Value,
}

/// Pusher wraps event payloads as JSON *strings*; undo that.
fn payload(data: serde_json::Value) -> serde_json::Value {
    match data {
        serde_json::Value::String(text) => serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
        other => other,
    }
}

pub fn parse_frame(raw: &str) -> Option<Frame> {
    let frame: RawFrame = serde_json::from_str(raw).ok()?;
    let data = payload(frame.data);
    let text = |key: &str| data.get(key).and_then(|v| v.as_str()).map(str::to_string);
    Some(match frame.event.as_str() {
        "pusher:connection_established" => Frame::Established { socket_id: text("socket_id").filter(|id| !id.is_empty())? },
        "pusher_internal:subscription_succeeded" => Frame::Subscribed,
        "pusher:ping" => Frame::Ping,
        "pusher:error" => Frame::Error,
        "timer.changed" => Frame::TimerChanged(LiveChange {
            token: text("token"),
            running: data.get("running").and_then(|v| v.as_bool()),
            at: text("at"),
        }),
        _ => Frame::Other,
    })
}

/// Reconnect delays: 1 s, 2 s, 4 s … capped at 30 s, so a box that is down is
/// not hammered and one that is back is noticed soon.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1 << attempt.min(5)).min(Duration::from_secs(30))
}

pub fn subscribe_frame(channel: &str, auth: &str) -> String {
    serde_json::json!({ "event": "pusher:subscribe", "data": { "channel": format!("private-{channel}"), "auth": auth } })
        .to_string()
}

pub const PONG: &str = r#"{"event":"pusher:pong","data":{}}"#;

/// Whether pushes are arriving, and whether a drop has gone unrepaired.
///
/// The first subscription of a source is not a gap: the webview fetched when
/// it connected, and nothing was promised before the socket was up. Every
/// later one is, because a change may have been pushed into the dark, so the
/// webview is told to fetch once. Split out so it can be tested without a
/// socket.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Link {
    up: bool,
    dropped: bool,
}

impl Link {
    /// Subscribed. The state to announce; `gap` says whether to refetch.
    pub fn came_up(&mut self) -> LiveState {
        let gap = std::mem::take(&mut self.dropped);
        self.up = true;
        LiveState { live: true, gap }
    }

    /// The socket closed or never opened. Some(state) when the webview should
    /// hear about it — only the first drop after being up, so a box that is
    /// down does not announce every retry.
    pub fn went_down(&mut self) -> Option<LiveState> {
        if !self.up {
            return None;
        }
        self.up = false;
        self.dropped = true;
        Some(LiveState { live: false, gap: false })
    }
}

/// Swap the source the socket follows: None stops it. Called by the webview
/// after GET /api/me answered, and again on disconnect.
pub fn set_source(app: tauri::AppHandle, source: Option<LiveSource>) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    LIVE.store(false, Ordering::SeqCst);
    let previous = TASK.lock().ok().and_then(|mut task| task.take());
    if let Some(previous) = previous {
        previous.abort();
    }
    let Some(source) = source else { return };
    let handle = tauri::async_runtime::spawn(async move {
        run(app, source, generation).await;
    });
    if let Ok(mut task) = TASK.lock() {
        *task = Some(handle);
    }
}

/// Keep one socket up until the source is replaced.
async fn run(app: tauri::AppHandle, source: LiveSource, generation: u64) {
    let version = app.package_info().version.to_string();
    let url = socket_url(&source.broadcast, &source.workspace, &version);
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build();
    let Ok(http) = http else { return };
    let mut link = Link::default();
    let mut attempt = 0u32;
    loop {
        session(&app, &http, &source, &url, generation, &mut link, &mut attempt).await;
        if let Some(state) = link.went_down() {
            announce(&app, generation, &state);
        }
        tokio::time::sleep(backoff(attempt)).await;
        attempt = attempt.saturating_add(1);
    }
}

/// Only the task for the current source may speak; a replaced one falls
/// silent even if abort has not reached it yet.
fn current(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

fn announce(app: &tauri::AppHandle, generation: u64, state: &LiveState) {
    if !current(generation) {
        return;
    }
    LIVE.store(state.live, Ordering::SeqCst);
    let _ = app.emit_to("main", "live-state", state);
}

/// `POST /api/broadcasting/auth`: the signature that lets this socket join
/// the person's private channel.
async fn broadcasting_auth(http: &reqwest::Client, source: &LiveSource, socket_id: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Auth {
        auth: String,
    }
    let body = serde_json::json!({ "socket_id": socket_id, "channel_name": format!("private-{}", source.broadcast.channel) });
    let answer = http
        .post(format!("{}/api/broadcasting/auth", source.workspace.trim_end_matches('/')))
        .bearer_auth(&source.token)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Auth>()
        .await
        .ok()?;
    Some(answer.auth)
}

/// One connection, from open to close.
async fn session(
    app: &tauri::AppHandle,
    http: &reqwest::Client,
    source: &LiveSource,
    url: &str,
    generation: u64,
    link: &mut Link,
    attempt: &mut u32,
) {
    let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else { return };
    while let Some(Ok(message)) = ws.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        match parse_frame(text.as_str()) {
            Some(Frame::Established { socket_id }) => match broadcasting_auth(http, source, &socket_id).await {
                Some(auth) => {
                    if ws.send(Message::Text(subscribe_frame(&source.broadcast.channel, &auth).into())).await.is_err() {
                        break;
                    }
                }
                // Refused: a revoked token (the next fetch says so) or a
                // channel that is not ours. Reconnecting with backoff is the
                // right shape either way.
                None => break,
            },
            Some(Frame::Subscribed) => {
                *attempt = 0;
                let state = link.came_up();
                announce(app, generation, &state);
            }
            Some(Frame::Ping) => {
                if ws.send(Message::Text(PONG.into())).await.is_err() {
                    break;
                }
            }
            Some(Frame::Error) => break,
            Some(Frame::TimerChanged(change)) if current(generation) => {
                let _ = app.emit_to("main", "live-changed", &change);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broadcast() -> Broadcast {
        Broadcast { key: "abc".into(), host: None, port: 443, scheme: "https".into(), channel: "timers.studio.7".into() }
    }

    #[test]
    fn the_broadcast_block_reads_with_its_defaults() {
        let full: Broadcast =
            serde_json::from_str(r#"{"key":"abc","host":"127.0.0.1","port":8080,"scheme":"http","channel":"timers.x.1"}"#).unwrap();
        assert_eq!(full.host.as_deref(), Some("127.0.0.1"));
        assert_eq!((full.port, full.scheme.as_str()), (8080, "http"));
        let bare: Broadcast = serde_json::from_str(r#"{"key":"abc","host":null,"channel":"timers.x.1"}"#).unwrap();
        assert_eq!(bare, Broadcast { key: "abc".into(), host: None, port: 443, scheme: "https".into(), channel: "timers.x.1".into() });
        assert!(serde_json::from_str::<Broadcast>(r#"{"key":"abc"}"#).is_err(), "no channel, nothing to subscribe to");
    }

    #[test]
    fn the_socket_opens_on_the_workspace_host_unless_the_server_named_another() {
        assert_eq!(
            socket_url(&broadcast(), "https://studio.zebu.work", "0.1.5"),
            "wss://studio.zebu.work:443/app/abc?protocol=7&client=zebu-desktop&version=0.1.5"
        );
        let dev = Broadcast { host: Some("127.0.0.1".into()), port: 8080, scheme: "http".into(), ..broadcast() };
        assert_eq!(socket_url(&dev, "http://localhost:8003", "0.1.5"), "ws://127.0.0.1:8080/app/abc?protocol=7&client=zebu-desktop&version=0.1.5");
        let empty_host = Broadcast { host: Some(String::new()), ..broadcast() };
        assert!(socket_url(&empty_host, "http://localhost:8003/", "0.1.5").starts_with("wss://localhost:443/"));
    }

    #[test]
    fn frames_are_parsed_and_their_string_payloads_unwrapped() {
        assert_eq!(parse_frame("nope"), None);
        assert_eq!(parse_frame(r#"{"data":{}}"#), None);
        let hello = r#"{"event":"pusher:connection_established","data":"{\"socket_id\":\"12.34\",\"activity_timeout\":30}"}"#;
        assert_eq!(parse_frame(hello), Some(Frame::Established { socket_id: "12.34".into() }));
        assert_eq!(parse_frame(r#"{"event":"pusher:connection_established","data":"{}"}"#), None, "a hello without an id is unusable");
        assert_eq!(parse_frame(r#"{"event":"pusher:ping","data":{}}"#), Some(Frame::Ping));
        assert_eq!(parse_frame(r#"{"event":"pusher_internal:subscription_succeeded","channel":"private-x","data":"{}"}"#), Some(Frame::Subscribed));
        assert_eq!(parse_frame(r#"{"event":"pusher:error","data":{"code":4009}}"#), Some(Frame::Error));
        assert_eq!(parse_frame(r#"{"event":"pusher:pong","data":{}}"#), Some(Frame::Other));
    }

    #[test]
    fn the_timer_event_is_the_pulse_pushed() {
        let event = r#"{"event":"timer.changed","channel":"private-timers.studio.7","data":"{\"token\":\"tok-2\",\"running\":true,\"at\":\"2026-09-19T06:30:06+00:00\"}"}"#;
        assert_eq!(
            parse_frame(event),
            Some(Frame::TimerChanged(LiveChange {
                token: Some("tok-2".into()),
                running: Some(true),
                at: Some("2026-09-19T06:30:06+00:00".into())
            }))
        );
        let unknown = r#"{"event":"timer.changed","data":"{\"token\":null,\"running\":null,\"at\":\"x\"}"}"#;
        assert_eq!(parse_frame(unknown), Some(Frame::TimerChanged(LiveChange { token: None, running: None, at: Some("x".into()) })));
    }

    #[test]
    fn the_first_subscription_is_not_a_gap_but_every_reconnect_is() {
        let mut link = Link::default();
        assert_eq!(link.went_down(), None, "never up: nothing to announce");
        assert_eq!(link.came_up(), LiveState { live: true, gap: false });
        assert_eq!(link.went_down(), Some(LiveState { live: false, gap: false }));
        assert_eq!(link.went_down(), None, "a box that stays down is announced once");
        assert_eq!(link.came_up(), LiveState { live: true, gap: true }, "something may have been pushed into the dark");
        assert_eq!(link.came_up(), LiveState { live: true, gap: false }, "the gap is repaid once");
    }

    #[test]
    fn reconnects_back_off_and_cap() {
        let seconds: Vec<u64> = [0, 1, 2, 3, 4, 5, 9].iter().map(|&n| backoff(n).as_secs()).collect();
        assert_eq!(seconds, vec![1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn the_subscribe_frame_names_the_private_channel() {
        let frame: serde_json::Value = serde_json::from_str(&subscribe_frame("timers.studio.7", "abc:sig")).unwrap();
        assert_eq!(frame, serde_json::json!({ "event": "pusher:subscribe", "data": { "channel": "private-timers.studio.7", "auth": "abc:sig" } }));
    }
}
