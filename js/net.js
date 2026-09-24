/* LIMBO — serverless multiplayer via Trystero (WebRTC P2P, no server).
 *
 * One Trystero room per location ('limbo-nexus', 'limbo-realm-1' …).
 * The strategy modules are loaded with dynamic import inside boot() so a
 * blocked/unreachable CDN degrades gracefully to single-player — the game
 * never depends on this file succeeding.
 *
 * NAT TRAVERSAL — Trystero core ships STUN-only ICE servers, which cannot
 * punch through symmetric NAT (mobile carriers / CGNAT — i.e. phones). We
 * add TURN via the OpenRelay static-auth scheme (standard coturn TURN REST
 * API, the same one Nextcloud Talk / Jitsi use): credentials are derived
 * client-side with WebCrypto HMAC-SHA1, no signup needed. NOTE: Trystero
 * REPLACES its default iceServers with ours when rtcConfig is passed
 * (core: new RTCPeerConnection({iceServers: defaults, ...rtcConfig})), so
 * we include STUN entries ourselves. The old fixed openrelayproject /
 * openrelayproject password pair is stale — do not use it.
 *
 * SIGNALING — build 30 runs BOTH strategies (torrent trackers + nostr
 * relays) IN PARALLEL on the same room key and merges the peer sets. This
 * replaced the old 15s once-only fallback, which had three fatal races
 * (found by reading the 0.25.4 module sources after a real two-phone test
 * failed to connect at all):
 *   1. Staggered-join deadlock: A joins at t=0, falls back to nostr at
 *      t=15s; B joins torrent at t=60s. They never share a strategy again —
 *      the fallback was one-shot, so both sit alone forever.
 *   2. Mid-handshake kill: the 15s timer fired on peers.size===0 even when
 *      a handshake was in progress (onPeerJoin only fires after the data
 *      channel connects; ICE on mobile can take 10-30s). Leaving the room
 *      mid-handshake destroyed handshakes that would have succeeded.
 *   3. ICE-failure silence: discovery working but ICE failing only recorded
 *      lastJoinError for the debug HUD — nothing retried, nothing told the
 *      user; the client sat silent until the next passive re-announce
 *      (60s nostr / 120s torrent).
 * With parallel rooms there is no switching and no timer: whenever two
 * clients share ANY working strategy they discover each other, no matter
 * when they joined. A failed ICE path triggers a visible retry (leave +
 * rejoin both rooms for fresh RTCPeerConnections and immediate
 * re-announce, with backoff), never silence.
 *
 * DEDUP — the same human may connect twice (once per strategy). Every
 * payload carries our per-session clientId (`cid`); callbacks receive the
 * cid as the peer id, so game.js keys one wisp / one chat line / one queue
 * entry per human with zero changes. A short-window dedup filter drops the
 * second delivery of each logical broadcast (same cid+action+payload).
 * Targeted sends (file chunks) resolve the cid to a single connection and
 * go out once, on one room.
 *
 * HANDSHAKE WATCHDOG (build 31) — the real two-phone build-30 test got
 * stuck on "connecting…" forever: discovery worked (peer announced via
 * signaling) but the WebRTC data channel never opened, and Trystero fired
 * neither onPeerJoin nor onJoinError, so nothing ever retried. If the pill
 * sits in "connecting…" with zero fully-joined peers for longer than
 * WATCHDOG_MS, we treat it as a failure: flip to "couldn't connect ·
 * retrying…" and take the same leave+rejoin ICE-retry path (backoff
 * preserved). Never sit silent.
 *
 * ?debug=net (build 31) — when the URL carries ?debug=net, a small
 * toggleable monospace panel renders timestamped net events (module
 * load, rooms joined, peer announced per strategy, ICE state changes,
 * local candidate types incl. whether TURN produced relay candidates,
 * join errors, retry countdowns, watchdog triggers) so a phone test
 * produces a diagnosis instead of a shrug. Zero UI change otherwise.
 *
 * RELAY MODE (build 37) — Nostr data-transport fallback for when WebRTC
 * can't connect (symmetric NAT / CGNAT on mobile carriers, 5G included:
 * fast pipe, no direct path between phones). Instead of accounts, tokens,
 * or dashboard taps, the game relays its tiny traffic through the same
 * public Nostr relays it uses for signaling: ephemeral kind-20001 events
 * with one `t` tag per room (`<appId>:<roomKey>`), JSON envelope
 * {a: actionName, d: <the exact payload _bcast would send>, to?}.
 * Receivers feed it into the same _in() path, so dedup, cid merging, and
 * the game.js handler contract are untouched. Engages automatically
 * (watchdog / ICE join-error / 30s of no discovery with reachable
 * relays), stays on for the session; the pill shows `● N here · relay`.
 * Oversize payloads (wall JPEG backfills, jukebox file chunks) are
 * skipped in relay mode — they'd blow past relay event size caps.
 */

const APP_ID = 'limbo_by_holowatts';
const MAX_NAME = 16;
/* Build 38 — numbered Nexus servers. Fresh clients pick one in the start
   overlay (#1–#10, live headcounts from the lobby); the Trystero room key
   is 'limbo-nexus-N'. The old bare 'limbo-nexus' room is retired. */
const NEXUS_SERVERS = 10;
function nexusServerKey(n) {
  const k = Math.min(Math.max(1, (n | 0) || 1), NEXUS_SERVERS);
  return 'limbo-nexus-' + k;
}
function isNexusServerKey(k) {
  return /^limbo-nexus-\d+$/.test(String(k || ''));
}
/* Shared presence room: every client joins it at boot and heartbeats
   {name, realm} here. Presence ONLY — no wisps, no chat — so the friends
   list can show who's live and where without joining every realm room. */
const LOBBY_ROOM = 'limbo-lobby';
const PRESENCE_INTERVAL_MS = 15000; // heartbeat cadence
const PRESENCE_EXPIRE_MS = 45000;   // silent this long -> considered gone
const PRESENCE_SWEEP_MS = 10000;    // how often expired entries are reaped
/* Sound room (build 12): room key for the DJ/social space. */
const SOUND_ROOM_KEY = 'limbo-realm-5';
/* Build 48: the stamp reads the module's own ?v= cache-bust, so it always
   shows the build that's actually running — never a stale hardcoded number. */
const BUILD = (() => {
  try {
    const m = String(import.meta.url || '').match(/[?&]v=(\d+)/);
    return m ? m[1] : '?';
  } catch (e) { return '?'; }
})();

/* Alone in a realm room this long -> suggest the Nexus (once per visit). */
const QUIET_AFTER_MS = 20000;
/* Duplicate-delivery filter window: the same logical broadcast arrives once
   per strategy room; the second copy inside this window is dropped. */
const DEDUP_WINDOW_MS = 8000;
/* ICE-failure retry: leave + rejoin both rooms (fresh peer connections +
   immediate re-announce) with this backoff ladder, while we have no peers. */
const ICE_RETRY_BASE_MS = 10000;
const ICE_RETRY_MAX_MS = 60000;
/* Handshake watchdog (build 31): "connecting…" (peer announced /
   handshaking) with zero fully-joined peers for longer than this is
   treated as a failed handshake and forced down the ICE-retry path. */
const WATCHDOG_MS = 20000;

const STRATEGIES = [
  // Pinned to 0.25.4: unpinned esm.sh URLs resolve "latest", which could
  // silently change the module's export shape and break the import.
  { name: 'torrent', url: 'https://esm.sh/@trystero-p2p/torrent@0.25.4' },
  { name: 'nostr', url: 'https://esm.sh/@trystero-p2p/nostr@0.25.4' },
];

/* Nostr relay pinning — the 0.25.4 nostr strategy picks 5 relays
   deterministically from its 28 defaults, seeded by appId. For our appId
   that set included two flaky relays (nostr.sathoarder.com, schnorr.me —
   both timed out in testing), so we pin the 3 reliable ones. Verified in
   the module source: getRelays(config, defaults, 5) returns
   config.relayConfig.urls when set. */
const NOSTR_RELAYS = [
  'wss://yabu.me/v2',
  'wss://relay02.lnfi.network',
  'wss://relay.sigit.io',
];

/* action name -> LimboNet callback property. Broadcast actions go out on
   every strategy room; targeted actions resolve the cid to one connection. */
const ACTION_CBS = {
  wisp: 'onWispCb',
  chat: 'onChatCb',
  jamClock: 'onJamClockCb',
  jamNote: 'onJamNoteCb',
  jamPad: 'onJamPadCb',
  wallStroke: 'onWallStrokeCb',
  wallSyncReq: 'onWallSyncReqCb',
  wallSync: 'onWallSyncCb',
  wallHello: 'onWallHelloCb',
  wallUndo: 'onWallUndoCb',
  wallFresh: 'onWallFreshCb', // build 84: a wall was archived + cleared
  jukeAdd: 'onJukeAddCb',
  jukeRemove: 'onJukeRemoveCb',
  jukePlay: 'onJukePlayCb',
  jukeSkipVote: 'onJukeSkipVoteCb',
  jukeStateReq: 'onJukeStateReqCb',
  jukeState: 'onJukeStateCb',
  jukeFileReq: 'onJukeFileReqCb',
  jukeFileChunk: 'onJukeFileChunkCb',
  jukeFileHave: 'onJukeFileHaveCb',
  jukeLike: 'onJukeLikeCb', // build 33: P2P likes for the jukebox track
  jukeHello: 'onJukeHelloCb', // build 43: server-channel presence for holder election
  jukeClaim: 'onJukeClaimCb', // build 43: "I hold this server's line"
  jukeSync: 'onJukeSyncCb', // build 43: canonical queue snapshot from the holder
  jukeClear: 'onJukeClearCb', // build 43: anyone may clear the server's line
  theatreAdd: 'onTheatreAddCb', // build 75: queue a video in the theatre
  theatrePlay: 'onTheatrePlayCb', // build 75: play video from position (synced)
  theatrePause: 'onTheatrePauseCb', // build 75: pause video at position
  theatreStateReq: 'onTheatreStateReqCb', // build 75: late joiner asks what's playing
  mediaPing: 'onMediaPingCb', // build 82: RTT probe for media-host election
  mediaPong: 'onMediaPongCb', // build 82: RTT reply
  mediaScore: 'onMediaScoreCb', // build 82: "my avg RTT is X" for host election
  mediaHostSync: 'onMediaHostSyncCb', // build 82: host's authoritative media state
  stageSync: 'onStageSyncCb', // build 66: shared sound-room stage layout
  stageReq: 'onStageReqCb', // build 66: late joiner asks for the stage
  fohSync: 'onFohSyncCb', // build 66: shared front-of-house light rig
  fohReq: 'onFohReqCb', // build 66: late joiner asks for the lights
  modelShare: 'onModelShareCb', // build 69: model-room shared shelf — one model
  modelDel: 'onModelDelCb', // build 69: a maker deleted their model
  modelReq: 'onModelReqCb', // build 69: late joiner asks for the shelf
  modelChunk: 'onModelChunkCb', // build 69: chunked large model payloads
  voiceChunk: 'onVoiceChunkCb', // build 40: live room voice over the relay
  voiceTalk: 'onVoiceTalkCb',
};
const BROADCAST_ACTIONS = Object.keys(ACTION_CBS).filter(
  (n) => n !== 'jukeFileReq' && n !== 'jukeFileChunk'
);
const TARGETED_ACTIONS = ['jukeFileReq', 'jukeFileChunk'];

/* Build 41: the jukebox is server-wide. These actions ride a dedicated
   server channel (the selected Nexus server's tag) instead of the current
   world room — one shared queue per server, same list on every phone,
   whether you're in the sound room, the journey, or the nexus itself.
   jukeFileReq/Chunk stay world-room targeted (direct transfers only). */
const JUKE_SERVER_ACTIONS = new Set([
  'jukeAdd', 'jukeRemove', 'jukePlay', 'jukeSkipVote',
  'jukeStateReq', 'jukeState', 'jukeLike',
  /* Build 43: the queue is server-held. One peer per server is the
     authoritative holder — elected, not assumed. Hellos track who's on
     the server channel, claims announce the holder, syncs carry the
     canonical line, and anyone can ask for a clear. */
  'jukeHello', 'jukeClaim', 'jukeSync', 'jukeClear',
  /* Build 75: the theatre rides the same server channel — one shared
     screen per server, audible from any room (including the jam). */
  'theatreAdd', 'theatrePlay', 'theatrePause', 'theatreStateReq',
  /* Build 82: media-host election rides here too — the best-connected peer
     becomes the authoritative host for theatre + jukebox state. */
  'mediaPing', 'mediaPong', 'mediaScore', 'mediaHostSync',
]);

/* OpenRelay static-auth (no signup): time-limited HMAC-SHA1 credentials. */
const TURN_HOST = 'staticauth.openrelay.metered.ca';
const TURN_SECRET = 'openrelayprojectsecret';
const TURN_TTL_S = 24 * 3600; // credentials valid 24h

async function makeTurnCreds() {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_S;
  const username = `${expiry}:limbo`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TURN_SECRET),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(username)
  );
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { username, password: btoa(bin), expiry };
}

function buildIceServers(creds) {
  return [
    // STUN first (cheap, direct); Trystero's defaults are replaced, so ours
    // must be complete.
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    // TURN relay for symmetric NATs — UDP then TCP flavors.
    {
      urls: [`turn:${TURN_HOST}:80`, `turn:${TURN_HOST}:443`],
      username: creds.username,
      credential: creds.password,
    },
    {
      urls: `turns:${TURN_HOST}:443`,
      username: creds.username,
      credential: creds.password,
    },
  ];
}

/* ---- relay mode (build 37): Nostr data-transport fallback ---- */
const RELAY_EVENT_KIND = 20001; // ephemeral range: relays forward, never store
const RELAY_MAX_BYTES = 48 * 1024;
const RELAY_SKIP_ACTIONS = new Set(['jukeFileReq', 'jukeFileChunk']);
const RELAY_WISP_MIN_MS = 150; // be polite: ~6-7 pos updates/sec per client in relay mode
const NOSTR_TOOLS_URL = 'https://esm.sh/nostr-tools@2.10.4';

/* Minimal Nostr client: one WebSocket per pinned relay, one REQ per tag,
 * raw EVENT publish. Separate from Trystero's sockets — no shared state.
 * Privacy model is identical to a Trystero room: anyone holding the room
 * key can read the traffic. Relay mode adds no new exposure. */
class RelayLink {
  constructor(net) {
    this.net = net;
    this.urls = NOSTR_RELAYS;
    this.tools = null;
    this.seckey = null;
    this.sockets = new Map(); // url -> WebSocket
    this.subs = new Map(); // tag -> Set<onEvent>
    this.ready = false;
    this.tx = 0;
    this.rx = 0;
    /* Build 44: outbox. Relay sockets connect at different times (and can
       drop), so a page can have zero open sockets while relayMode is on.
       Publishes in that window used to vanish silently; now they wait here
       and flush on the next socket open. */
    this.outbox = []; // [{ tag, obj }] — re-signed at flush time
  }

  tagFor(roomKey) {
    return `${APP_ID}:${roomKey}`;
  }

  /* Load nostr-tools (graceful: false when the CDN is unreachable) and
     open relay sockets. Idempotent. */
  async ensure() {
    if (this.ready) return true;
    // build 80: overlapping enterRelayMode() calls (a goTo() mid-flight)
    // must share one import — two concurrent ensures would mint two
    // keypairs and double every socket.
    if (this._ensuring) return this._ensuring;
    this._ensuring = this._ensureInner();
    try {
      return await this._ensuring;
    } finally {
      this._ensuring = null;
    }
  }

  async _ensureInner() {
    let tools = null;
    try {
      tools = await import(NOSTR_TOOLS_URL);
    } catch (e) {
      tools = null;
    }
    if (
      !tools ||
      typeof tools.finalizeEvent !== 'function' ||
      typeof tools.generateSecretKey !== 'function' ||
      typeof tools.getPublicKey !== 'function'
    ) {
      this.net._netLog('relay: nostr-tools unavailable — relay mode disabled');
      return false;
    }
    try {
      this.seckey = tools.generateSecretKey();
      tools.getPublicKey(this.seckey); // sanity: throws on bad keygen
    } catch (e) {
      this.net._netLog('relay: keygen failed — relay mode disabled');
      return false;
    }
    this.tools = tools;
    this.ready = true;
    for (const url of this.urls) this._connect(url);
    return true;
  }

  _host(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return String(url);
    }
  }

  _connect(url) {
    if (!this.ready || this.sockets.has(url)) return;
    let ws = null;
    try {
      ws = new window.WebSocket(url);
    } catch (e) {
      return;
    }
    ws.addEventListener('open', () => {
      this.sockets.set(url, ws);
      this.net._netLog(`relay: socket open (${this._host(url)})`);
      for (const tag of this.subs.keys()) this._sendReq(ws, tag);
      this._flushOutbox(); // build 44: deliver anything queued with no socket
    });
    ws.addEventListener('message', (ev) => {
      try {
        this._onMessage(String(ev.data));
      } catch (e) {
        /* never break on relay data */
      }
    });
    const drop = () => {
      if (this.sockets.get(url) === ws) this.sockets.delete(url);
    };
    ws.addEventListener('close', () => {
      drop();
      this.net._netLog(`relay: socket closed (${this._host(url)})`);
      if (this.ready) setTimeout(() => this._connect(url), 5000);
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch (e) {}
    });
  }

  _subId(tag) {
    return `limbo37-${tag}`;
  }

  _sendReq(ws, tag) {
    try {
      if (ws.readyState === 1)
        ws.send(
          JSON.stringify([
            'REQ',
            this._subId(tag),
            {
              kinds: [RELAY_EVENT_KIND],
              '#t': [tag],
              // Fresh-state only: never replay stored history on (re)subscribe.
              // Live traffic re-announces continuously (wisp ~7Hz, presence
              // 15s), so nothing is lost — but stale peers can't resurrect.
              since: Math.floor(Date.now() / 1000),
              limit: 50,
            },
          ])
        );
    } catch (e) {}
  }

  subscribe(tag, onEvent) {
    let set = this.subs.get(tag);
    if (!set) {
      set = new Set();
      this.subs.set(tag, set);
    }
    set.add(onEvent);
    for (const ws of this.sockets.values()) this._sendReq(ws, tag);
  }

  unsubscribe(tag, onEvent) {
    const set = this.subs.get(tag);
    if (!set) return;
    if (onEvent) set.delete(onEvent);
    else set.clear();
    if (set.size > 0) return;
    this.subs.delete(tag);
    const close = JSON.stringify(['CLOSE', this._subId(tag)]);
    for (const ws of this.sockets.values()) {
      try {
        if (ws.readyState === 1) ws.send(close);
      } catch (e) {}
    }
  }

  _onMessage(data) {
    if (!data || data.charCodeAt(0) !== 91) return; // '['
    let arr = null;
    try {
      arr = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!Array.isArray(arr) || arr[0] !== 'EVENT') return;
    const ev = arr[2];
    if (!ev || ev.kind !== RELAY_EVENT_KIND || !Array.isArray(ev.tags)) return;
    let tag = null;
    for (const t of ev.tags) {
      if (Array.isArray(t) && t[0] === 't' && typeof t[1] === 'string') {
        tag = t[1];
        break;
      }
    }
    if (!tag) return;
    const set = this.subs.get(tag);
    if (!set || set.size === 0) return;
    let obj = null;
    try {
      obj = JSON.parse(ev.content);
    } catch (e) {
      return;
    }
    this.rx++;
    for (const fn of set) {
      try {
        fn(obj);
      } catch (e) {}
    }
  }

  /* Sign + publish an envelope to every open socket. Returns true when at
     least one socket accepted it. Oversize payloads are skipped loudly. */
  publish(tag, obj) {
    if (!this.ready || !this.tools || !this.seckey) return false;
    let content = null;
    try {
      content = JSON.stringify(obj);
    } catch (e) {
      return false;
    }
    if (content.length > RELAY_MAX_BYTES) {
      this.net._netLog(
        `relay: skipped oversize payload (${content.length}b > ${RELAY_MAX_BYTES}b)`
      );
      return false;
    }
    let ev = null;
    try {
      ev = this.tools.finalizeEvent(
        {
          kind: RELAY_EVENT_KIND,
          tags: [['t', tag]],
          content,
          created_at: Math.floor(Date.now() / 1000),
        },
        this.seckey
      );
    } catch (e) {
      return false;
    }
    let msg = null;
    try {
      msg = JSON.stringify(['EVENT', ev]);
    } catch (e) {
      return false;
    }
    let sent = 0;
    for (const ws of this.sockets.values()) {
      try {
        if (ws.readyState === 1) {
          ws.send(msg);
          sent++;
        }
      } catch (e) {}
    }
    if (sent > 0) this.tx++;
    /* Build 44: no open socket — queue instead of dropping silently.
       The next socket open flushes the outbox (fresh signature each time).
       Cap keeps a long outage from growing memory. */
    if (sent === 0 && this.outbox.length < 30) this.outbox.push({ tag, obj });
    return sent > 0;
  }

  /* Build 44: deliver anything queued while there was no socket. */
  _flushOutbox() {
    if (!this.outbox.length) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const { tag, obj } of pending) this.publish(tag, obj);
  }

  socketStates() {
    return this.urls.map((u) => {
      const ws = this.sockets.get(u);
      return { host: this._host(u), open: !!ws && ws.readyState === 1 };
    });
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class LimboNet {
  constructor() {
    this.build = BUILD; // deploy stamp, shown in the debug HUD
    this.enabled = false;
    this.mods = []; // strategy modules, indexed like STRATEGIES (null when failed)
    this.selfIds = []; // per-strategy trystero selfId (null when not loaded)
    this.selfId = null; // first loaded strategy's selfId (compat)
    this.clientId = null; // per-session UUID; canonical peer identity across strategies
    this.rtcConfig = null;
    this.turnCreds = null;
    /* Parallel rooms: [{si, name, mod, room, selfId, A}] where A maps
       action name -> trystero action object. */
    this.rooms = [];
    this.roomKey = null;
    this.joinedAt = 0; // discovery window start (drives the "finding others" UI)
    /* peers: canonicalId -> {conns: Map(connKey -> {si, peerId})}.
       canonicalId is the sender's cid; before the first payload arrives a
       connection sits under a provisional '~prov:' key. */
    this.peers = new Map();
    this._seen = new Map(); // dedupKey -> expiryMs
    this.name = 'drifter';
    this.cosmetics = null; // () => ({s: skinId, h: hatId, t: trailStyle, c: trailHex6}) — set by game.js
    this.onWispCb = null; // (peerId, {p:[x,y,z], n:name, s:skin, h:hat, cid})
    this.onChatCb = null; // ({n:name, t:text}, peerId)
    this.onPeerLeaveCb = null; // (peerId)
    this.onQuietCb = null; // () — fired once per room visit when alone too long
    // --- lobby presence (build 11) ---
    this.lobbyRooms = []; // [{si, room, presenceAction}]
    this.sendPresence = null;
    this.lobbyPeers = new Map(); // cid -> {name, room, lastSeen}
    this.onPresenceCb = null; // () — lobby roster changed (heartbeat/expire)
    this.presenceName = 'drifter';
    this.presenceRoom = 'nexus';
    this._presenceTimer = null;
    this._sweepTimer = null;
    // --- jam room (build 13) ---
    this.onJamClockCb = null; // (data, peerId)
    this.onJamNoteCb = null; // (data, peerId)
    this.onJamPadCb = null; // (data, peerId)
    // --- community wall (build 18) ---
    this.onWallStrokeCb = null; // (data, peerId)
    this.onWallSyncReqCb = null; // (data, peerId)
    this.onWallSyncCb = null; // (data, peerId)
    this.onWallHelloCb = null; // (data, peerId)
    this.onWallUndoCb = null; // (data, peerId)
    this.onWallFreshCb = null; // (data, peerId) — build 84
    this.onJukeAddCb = null; // (data, peerId)
    this.onJukeRemoveCb = null; // (data, peerId)
    this.onJukePlayCb = null; // (data, peerId)
    this.onJukeSkipVoteCb = null; // (data, peerId)
    this.onJukeFileReqCb = null; // (data, peerId)
    this.onJukeFileChunkCb = null; // (data, peerId)
    this.onJukeFileHaveCb = null; // (data, peerId)
    this.onJukeStateReqCb = null; // (data, peerId)
    this.onJukeStateCb = null; // (data, peerId)
    this.onJukeHelloCb = null; // (data, peerId) — build 43 holder election
    this.onJukeClaimCb = null; // (data, peerId)
    this.onJukeSyncCb = null; // (data, peerId)
    this.onJukeClearCb = null; // (data, peerId)
    this.onStageSyncCb = null; // (data, peerId)
    this.onStageReqCb = null; // (data, peerId)
    this.onFohSyncCb = null; // (data, peerId)
    this.onFohReqCb = null; // (data, peerId)
    this.onRelayUpCb = null; // () — build 43: relay engaged, safe to sync
    this.onVoiceChunkCb = null; // (data, peerId)
    this.onVoiceTalkCb = null; // (data, peerId)
    // send functions are installed by _joinAll(); null when no rooms
    this._nullSends();
    this.quietTimer = null;
    this.quietFired = false;
    this.lastJoinError = null; // {error, peerId, strategy, at} from trystero onJoinError
    // --- ICE-failure retry (build 30) ---
    this._iceRetryTimer = null;
    this._iceRetryN = 0;
    // --- handshake-stage diagnostics (debug HUD) ---
    this.hsPeers = new Map(); // 'strategy:shortId' -> {stage, firstSeen, lastSeenMs, sigIn, sigOut, initiator}
    this.nostrFrames = []; // ring buffer of recent nostr EVENT frames (compact strings)
    this.relayHosts = NOSTR_RELAYS.map((u) => {
      try {
        return new URL(u).host;
      } catch (e) {
        return u;
      }
    });
    // --- phone-visible status pill (build 30; touch devices only) ---
    this._pill = null;
    this._pillTimer = null;
    // --- handshake watchdog (build 31) ---
    this._connectingSince = 0; // Date.now() when pill first showed "connecting…"
    // --- ?debug=net on-screen log (build 31) ---
    this._netLogBuf = []; // ring buffer of timestamped lines (kept always; cheap)
    this._netLogOn =
      typeof location !== 'undefined' &&
      /[?&]debug=net(?:[&#]|$)/.test(location.search || '');
    this._netLogEl = null;
    this._netLogBody = null;
    this._pcSeen = new Map(); // connKey -> {ice, gathering, typesLogged}
    // --- relay mode (build 37): Nostr data-transport fallback ---
    this.relayLink = null; // RelayLink, created lazily on first engage
    this.relayMode = false;
    this._relayRoomTag = null;
    this._relaySince = 0;
    this._relayRetryT = null; // build 80: one delayed re-engage after a failed ensure()
    // --- server-wide jukebox channel (build 41) ---
    this._jukeServerKey = null; // e.g. 'limbo-nexus-3'
    this._jukeServerTag = null; // relay tag subscribed for jukebox traffic
    this._jukeServerHandler = (obj) => this._onRelayJukeServer(obj);
    this._lastRelayWisp = 0;
    // --- jukebox link diagnostics (build 73): tx/rx counters read off the
    // phones to see which leg is dead instead of guessing.
    this._jukeTx = 0;
    this._jukeRx = 0;
    this._theatreTx = 0; // build 79: theatre-only link counters
    this._theatreRx = 0;
    this._relaySkipLogged = new Set();
    this._relayRoomHandler = (obj) => this._onRelayRoom(obj);
    this._relayLobbyHandler = (obj) => this._onRelayLobby(obj);
    this._installWsTap();
  }

  _nullSends() {
    for (const n of BROADCAST_ACTIONS) this['send' + cap(n)] = null;
    for (const n of TARGETED_ACTIONS) this['send' + cap(n)] = null;
  }

  cleanName(n) {
    return String(n || 'drifter').trim().slice(0, MAX_NAME) || 'drifter';
  }

  /* One-time WebSocket wrapper that taps nostr signaling frames for the
     debug HUD. Trystero 0.25.4 exposes no event for "saw a peer announce"
     or per-relay socket state, so we observe the wire directly: the nostr
     module creates its sockets via `new WebSocket(url)`, and our subclass
     logs EVENT frames to/from our pinned relay hosts. Everything else
     passes through to the native WebSocket untouched. Installed before the
     strategy module is dynamically imported, so its sockets get wrapped. */
  _installWsTap() {
    try {
      if (typeof window === 'undefined' || !window.WebSocket) return;
      if (window.__limboNostrTap) return; // installed already
      const hosts = this.relayHosts;
      const note = (dir, url, data) => {
        try {
          this._noteNostrFrame(dir, url, data);
        } catch (e) {
          /* diagnostics must never break networking */
        }
      };
      const NativeWS = window.WebSocket;
      class TapWS extends NativeWS {
        constructor(url, protocols) {
          super(url, protocols);
          try {
            if (hosts.some((h) => String(url).indexOf(h) !== -1)) {
              this.addEventListener('message', (ev) =>
                note('in', String(url), String(ev.data))
              );
              const rawSend = this.send.bind(this);
              this.send = (data) => {
                note('out', String(url), String(data));
                return rawSend(data);
              };
            }
          } catch (e) {
            /* never break the socket */
          }
        }
      }
      window.WebSocket = TapWS;
      window.__limboNostrTap = true;
    } catch (e) {
      /* tap is optional */
    }
  }

  /* Parse one nostr frame (relay<->client). Incoming frames look like
     ["EVENT", subId, {kind, tags, content, pubkey}]; outgoing look like
     ["EVENT", {kind, tags, content}]. The "x" tag is an opaque topic hash,
     so we label frames by content shape instead: announce content is just
     {"peerId"}, signal content carries offer/answer payloads. */
  _noteNostrFrame(dir, url, data) {
    if (!data || data.charCodeAt(0) !== 91) return; // must start with '['
    if (data.indexOf('"EVENT"') === -1) return;
    let arr;
    try {
      arr = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!Array.isArray(arr) || arr[0] !== 'EVENT') return;
    const ev =
      arr[1] && typeof arr[1] === 'object' && typeof arr[1].kind === 'number'
        ? arr[1]
        : arr[2] && typeof arr[2] === 'object'
          ? arr[2]
          : null;
    if (!ev || typeof ev.kind !== 'number') return;
    if (ev.kind === RELAY_EVENT_KIND) return; // our own relay-mode data frames — not signaling
    let topicKind = '?';
    let peerId = null;
    if (typeof ev.content === 'string') {
      try {
        const c = JSON.parse(ev.content);
        if (c && c.peerId) {
          peerId = String(c.peerId).slice(0, 8);
          topicKind = c.offer || c.answer || c.offerId ? 'signal' : 'announce';
        }
      } catch (e) {}
    }
    const now = Date.now();
    this.nostrFrames.push(
      `${dir}/${topicKind}${peerId ? '/' + peerId : ''}`
    );
    if (this.nostrFrames.length > 14) this.nostrFrames.shift();
    if (peerId && (topicKind === 'announce' || topicKind === 'signal')) {
      const nsi = STRATEGIES.findIndex((s) => s.name === 'nostr');
      const selfShort =
        nsi >= 0 && this.selfIds[nsi] ? String(this.selfIds[nsi]).slice(0, 8) : null;
      const isSelf = selfShort && peerId === selfShort;
      const key = `nostr:${peerId}`;
      const rec = this.hsPeers.get(key) || {
        stage: 'seen',
        firstSeen: new Date(now).toLocaleTimeString(),
        lastSeenMs: now,
        sigIn: 0,
        sigOut: 0,
        initiator: null,
      };
      if (isSelf) {
        // Our own announce echoed back by the relay — proves the relay
        // round-trips; not another player.
        rec.stage = 'self';
      } else if (topicKind === 'announce' && rec.stage === 'seen') rec.stage = 'discovered';
      if (topicKind === 'signal') {
        if (dir === 'in') rec.sigIn++;
        else rec.sigOut++;
        if (rec.stage === 'seen' || rec.stage === 'discovered') rec.stage = 'signaling';
      }
      rec.lastSeenMs = now;
      this.hsPeers.set(key, rec);
      this._netLog(`nostr ${dir}/${topicKind}/${peerId}${isSelf ? ' (self echo)' : ''}`);
    }
  }

  /* Which pinned nostr relays actually have an open socket. Uses the
     module's own exported getRelaySockets() (0.25.4 exports it) — no
     guessing at internals. NOTE: despite the name it returns a plain
     {url: WebSocket} object, not a Map (verified live). Returns null when
     the nostr strategy isn't loaded. */
  _getRelayStatus() {
    try {
      const nsi = STRATEGIES.findIndex((s) => s.name === 'nostr');
      const mod = nsi >= 0 ? this.mods[nsi] : null;
      if (!mod || typeof mod.getRelaySockets !== 'function') return null;
      const m = mod.getRelaySockets();
      const entries =
        m && typeof m.forEach === 'function' ? [...m.entries()] : Object.entries(m || {});
      return entries.map(([url, ws]) => ({
        host: String(url).replace(/^wss:\/\//, ''),
        open: !!ws && ws.readyState === 1,
      }));
    } catch (e) {
      return null;
    }
  }

  _hsTouch(si, peerId, isInitiator) {
    const id = String(peerId).slice(0, 8);
    const key = `${STRATEGIES[si].name}:${id}`;
    const now = Date.now();
    const rec = this.hsPeers.get(key) || {
      stage: 'handshaking',
      firstSeen: new Date(now).toLocaleTimeString(),
      lastSeenMs: now,
      sigIn: 0,
      sigOut: 0,
      initiator: null,
    };
    rec.stage = 'handshaking';
    rec.lastSeenMs = now;
    if (typeof isInitiator === 'boolean') rec.initiator = isInitiator;
    this.hsPeers.set(key, rec);
    this._netLog(`handshake start via ${STRATEGIES[si].name} with ${id} (initiator=${isInitiator})`);
    this._updatePill();
    return rec;
  }

  /* Trystero fired onJoinError: SDP was exchanged but the peer connection
     failed (ICE/TURN/etc). Record it for the HUD and — instead of sitting
     silent — schedule a retry while we have no peers at all. */
  _onJoinError(si, details) {
    this.lastJoinError = {
      error: String((details && details.error) || details || 'unknown'),
      peerId: details && details.peerId ? String(details.peerId).slice(0, 8) : '?',
      strategy: STRATEGIES[si] ? STRATEGIES[si].name : '?',
      at: new Date().toLocaleTimeString(),
    };
    this._netLog(`joinError via ${this.lastJoinError.strategy}: ${this.lastJoinError.error}`);
    this._scheduleIceRetry();
    // build 37: SDP was exchanged but ICE failed — bring up the relay backstop.
    this.enterRelayMode('join-error');
    this._updatePill();
  }

  /* Leave + rejoin every strategy room: fresh RTCPeerConnections and an
     immediate re-announce on each strategy, with backoff. Only runs while
     we have zero peers; any successful join resets the ladder. */
  _scheduleIceRetry() {
    if (this.peerCount() > 0) return;
    if (this._iceRetryTimer) return;
    if (!this.roomKey || !this.enabled) return;
    const delay = Math.min(
      ICE_RETRY_BASE_MS * Math.pow(2, this._iceRetryN),
      ICE_RETRY_MAX_MS
    );
    this._iceRetryN++;
    this._iceRetryAt = Date.now() + delay;
    this._netLog(`ICE retry scheduled in ${delay}ms (attempt ${this._iceRetryN})`);
    this._iceRetryTimer = setTimeout(() => {
      this._iceRetryTimer = null;
      if (this.peerCount() > 0 || !this.roomKey) return;
      this._rejoinAll();
      this._updatePill();
    }, delay);
    this._updatePill();
  }

  _clearIceRetry() {
    if (this._iceRetryTimer) {
      clearTimeout(this._iceRetryTimer);
      this._iceRetryTimer = null;
    }
    this._iceRetryAt = 0;
  }

  /* Build 31 — handshake watchdog. Called on the 2s tick. If the pill is
     in "connecting…" (a peer was announced / handshaking, i.e. discovery
     worked) with zero fully-joined peers for longer than WATCHDOG_MS,
     the data channel is never going to open — Trystero fired neither
     onPeerJoin nor onJoinError, which is exactly the stuck state the
     build-30 two-phone test hit. Treat it as a failure: flip the pill to
     "couldn't connect · retrying…" and take the same leave+rejoin
     ICE-retry path (backoff preserved). Re-arms automatically, so it can
     never sit silent again. */
  _checkWatchdog() {
    if (!this.enabled || !this.roomKey) {
      this._connectingSince = 0;
      return;
    }
    if (this.peerCount() > 0) {
      this._connectingSince = 0;
      return;
    }
    const now = Date.now();
    let connecting = false;
    for (const [, r] of this.hsPeers) {
      if (
        now - (r.lastSeenMs || 0) < 30000 &&
        (r.stage === 'discovered' ||
          r.stage === 'signaling' ||
          r.stage === 'handshaking')
      ) {
        connecting = true;
        break;
      }
    }
    if (!connecting) {
      this._connectingSince = 0;
      return;
    }
    if (!this._connectingSince) {
      this._connectingSince = now;
      return;
    }
    if (now - this._connectingSince < WATCHDOG_MS) return;
    // Fire.
    this._connectingSince = 0;
    this._netLog(
      `WATCHDOG: "connecting…" ${Math.round(WATCHDOG_MS / 1000)}s+ with 0 joined peers — forcing retry`
    );
    this.lastJoinError = {
      error:
        'watchdog: peer announced but data channel never opened (stalled handshake)',
      peerId: '?',
      strategy: 'watchdog',
      at: new Date().toLocaleTimeString(),
    };
    this._scheduleIceRetry();
    // build 37: peer announced but the data channel never opened — relay backstop.
    this.enterRelayMode('watchdog');
    this._updatePill();
  }

  _rejoinAll() {
    this._netLog('rejoining all strategy rooms (fresh RTCPeerConnections + re-announce)');
    for (const e of this.rooms) {
      try {
        e.room.leave();
      } catch (err) {
        /* ignore */
      }
    }
    this.rooms = [];
    this.peers.clear(); // we had no real peers — that's why we're retrying
    this._nullSends();
    this._joinAll();
  }

  _makeClientId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return (
      'cid-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }

  /* Loads all strategy modules (tolerating individual failures) + TURN
     credentials. Resolves true when at least one strategy loaded. */
  /* Build 38: boot is idempotent — the start overlay boots early (so the
     server picker has live headcounts) and the drift tap re-boots with the
     real name. Same promise, name updated. */
  async boot(name) {
    if (name) this.name = this.cleanName(name);
    if (this._bootPromise) return this._bootPromise;
    // Build 88: boot must not hang forever — if the Trystero modules don't
    // load in 12s (flaky CDN, blocked network), fall back to solo instead
    // of leaving the server list spinning on "finding servers…".
    this._bootPromise = Promise.race([
      this._boot(),
      new Promise((resolve) => setTimeout(() => {
        if (!this.enabled) {
          this._netLog('boot: module load timed out — solo drift');
          try { this._ensurePill(); this._updatePill(); } catch (e) {}
        }
        resolve(this.enabled);
      }, 12000)),
    ]);
    return this._bootPromise;
  }

  async _boot() {
    this.clientId = this._makeClientId();
    try {
      this.turnCreds = await makeTurnCreds();
      this.rtcConfig = { iceServers: buildIceServers(this.turnCreds) };
    } catch (err) {
      this.enabled = false; // crypto unavailable: single-player
      this._netLog('boot: crypto unavailable — single-player');
      this._ensurePill();
      this._updatePill();
      return this.enabled;
    }
    const loaded = await Promise.all(
      STRATEGIES.map((s) =>
        import(s.url)
          .then((m) => m)
          .catch(() => null)
      )
    );
    this.mods = loaded;
    this.selfIds = loaded.map((m) => (m ? m.selfId : null));
    this.selfId = this.selfIds.find((id) => id) || null;
    this.enabled = loaded.some(Boolean);
    STRATEGIES.forEach((s, si) =>
      this._netLog(`strategy ${s.name}: module ${this.mods[si] ? 'loaded' : 'FAILED to load'}`)
    );
    this._netLog(`boot: enabled=${this.enabled} clientId=${String(this.clientId).slice(0, 8)}`);
    this._ensurePill();
    this._updatePill();
    return this.enabled;
  }

  /* Refresh TURN credentials when they're close to expiring (long sessions). */
  async _refreshTurnCreds() {
    const now = Math.floor(Date.now() / 1000);
    if (!this.turnCreds || now > this.turnCreds.expiry - 600) {
      this.turnCreds = await makeTurnCreds();
      this.rtcConfig = { iceServers: buildIceServers(this.turnCreds) };
    }
  }

  /* Leave the current room (if any) and join a new one — on every loaded
     strategy at once. */
  async join(roomKey) {
    if (!this.enabled) return;
    this.leave();
    this.roomKey = roomKey;
    this.joinedAt = Date.now(); // discovery window start (drives the "finding others" UI)
    this.quietFired = false;
    this.lastJoinError = null;
    this._iceRetryN = 0;
    this.hsPeers.clear(); // fresh diagnostics per room visit
    this.nostrFrames.length = 0;
    try {
      await this._refreshTurnCreds();
    } catch (e) {
      /* keep going with existing creds; worst case TURN rejects and we
         fall back to STUN-only behavior for this room */
    }
    this._joinAll();
    // build 38: relay-FIRST — engage the relay the moment we join instead
    // of burning ~30s on a direct connection the carrier will never allow.
    // Fire-and-forget: WebRTC keeps trying in parallel and direct peers
    // still merge in. The watchdog / join-error / no-discovery triggers
    // below stay as backstops (all no-op once relayMode is true).
    try {
      this.enterRelayMode('join-fast').catch(() => {});
    } catch (e) {}
    // build 37: relay mode is sticky across room hops — move the room
    // subscription to the new room's tag. (leave() already dropped the old
    // tag's peers via peers.clear().)
    if (this.relayMode && this.relayLink && this.relayLink.ready) {
      if (this._relayRoomTag)
        this.relayLink.unsubscribe(this._relayRoomTag, this._relayRoomHandler);
      this._relayRoomTag = this.relayLink.tagFor(roomKey);
      this.relayLink.subscribe(this._relayRoomTag, this._relayRoomHandler);
      // build 41: keep the server-wide jukebox channel across room hops
      this.setJukeServer(this._jukeServerKey);
    }
    this._armQuietTimer();
    this._updatePill();
  }

  /* Join the room on every loaded strategy module and wire all actions.
     Trystero 0.25.x API: makeAction returns an action OBJECT (not a
     [send, receive] tuple), and room event handlers are property
     assignments (not method calls). The old call style throws. */
  _joinAll() {
    this.rooms = [];
    for (let si = 0; si < STRATEGIES.length; si++) {
      const mod = this.mods[si];
      if (!mod) continue;
      const name = STRATEGIES[si].name;
      const isNostr = name === 'nostr';
      let room;
      try {
        room = mod.joinRoom(
          {
            appId: APP_ID,
            rtcConfig: this.rtcConfig,
            // Pin the 3 reliable nostr relays (verified config key in the
            // 0.25.4 module source: getRelays uses config.relayConfig.urls).
            ...(isNostr ? { relayConfig: { urls: NOSTR_RELAYS } } : {}),
            // Trystero calls this when SDP was exchanged but the peer
            // connection failed — carries the real reason (ICE/TURN/etc).
            onJoinError: (details) => this._onJoinError(si, details),
            // Fires per peer during the WebRTC handshake, BEFORE onPeerJoin
            // (which only fires after the data channel fully connects). The
            // core composes this with its internal handshake handler, so
            // observing here is safe. Lets the HUD tell "discovered but
            // handshake stalled" apart from "never discovered".
            onPeerHandshake: (peerId, _send, _receive, isInitiator) =>
              this._hsTouch(si, peerId, isInitiator),
          },
          this.roomKey
        );
      } catch (e) {
        this._netLog(`joinRoom threw on ${name}: ${(e && e.message) || e}`);
        continue;
      }
      this._netLog(`room joined on ${name} (key=${this.roomKey})`);
      const entry = { si, name, mod, room, selfId: this.selfIds[si], A: {} };
      this._wireRoom(entry);
      this.rooms.push(entry);
    }
    if (this.rooms.length > 0) {
      for (const n of BROADCAST_ACTIONS)
        // build 41: jukebox actions ride the server channel, not the world room
        this['send' + cap(n)] = JUKE_SERVER_ACTIONS.has(n)
          ? (data) => this._jukeBcast(n, data)
          : (data) => this._bcast(n, data);
      for (const n of TARGETED_ACTIONS)
        this['send' + cap(n)] = (data, target) => this._sendTo(n, data, target);
    } else {
      this._nullSends();
    }
  }

  /* Build 41: publish a jukebox action on the server channel. The relay is
     the transport (it engages ~600ms after join, always); before it does,
     fall back to the world-room broadcast so nothing is lost. */
  _jukeBcast(actionName, data) {
    if (!this.enabled) return;
    let out;
    try {
      out = Object.assign({ cid: this.clientId }, data);
    } catch (e) {
      out = { cid: this.clientId };
    }
    /* Build 43: stamp every jukebox payload with its server key. Receivers
       drop payloads from other servers, so a stray can never contaminate
       another server's line. */
    if (this._jukeServerKey) out.srv = this._jukeServerKey;
    /* Build 70: dual-leg delivery. The relay server channel is the primary
       leg, but a peer whose relay never engaged (blocked CDN, dead socket)
       is silently cut out of a relay-only broadcast while everything else
       keeps working over data channels — the "flying together but the track
       never arrived" hole. So the stamped payload ALSO rides the world-room
       data channels; the receive-side dedup collapses the double delivery
       and jukeSrvOk keeps servers from cross-talking. */
    if (this.relayMode && this.relayLink) {
      const tag = this._jukeServerTag || this._relayRoomTag;
      if (tag) this._relayPublishTo(tag, actionName, out, null);
    }
    for (const e of this.rooms) {
      try {
        if (e.A[actionName]) e.A[actionName].send(out);
      } catch (err) {
        /* best effort per room */
      }
    }
    this._jukeTx++; // build 73: link diagnostic
    if (actionName.indexOf('theatre') === 0) this._theatreTx++; // build 79
  }

  /* Build 41: point the server-wide jukebox channel at a Nexus server room.
     Safe to call any time; subscribes once the relay is up and keeps the
     subscription across room hops (leave() drops it). */
  setJukeServer(serverKey) {
    this._jukeServerKey = serverKey || null;
    if (this.relayLink && this._jukeServerTag) {
      try {
        this.relayLink.unsubscribe(this._jukeServerTag, this._jukeServerHandler);
      } catch (e) {}
      this._jukeServerTag = null;
    }
    if (!this._jukeServerKey || !this.relayMode || !this.relayLink) return;
    try {
      const tag = this.relayLink.tagFor(this._jukeServerKey);
      if (tag && tag !== this._relayRoomTag) {
        this.relayLink.subscribe(tag, this._jukeServerHandler);
        this._jukeServerTag = tag;
      }
    } catch (e) {}
  }

  /* Build 41: incoming jukebox traffic from the server channel. Same _in()
     path as the room handler; only jukebox actions are honored here. */
  _onRelayJukeServer(obj) {
    try {
      if (!obj || typeof obj !== 'object') return;
      const actionName = obj.a;
      if (typeof actionName !== 'string' || !JUKE_SERVER_ACTIONS.has(actionName)) return;
      const d = obj.d;
      if (!d || typeof d !== 'object') return;
      const cbProp = ACTION_CBS[actionName];
      if (!cbProp) return;
      const cid = typeof d.cid === 'string' && d.cid ? d.cid : null;
      if (!cid || cid === this.clientId) return;
      if (obj.to && obj.to !== this.clientId) return;
      let rec = this.peers.get(cid);
      if (!rec) {
        rec = { conns: new Map(), relay: true, lastSeen: 0 };
        this.peers.set(cid, rec);
      }
      rec.lastSeen = Date.now();
      this._in('relay', actionName, cbProp, d, cid);
      this._updatePill();
    } catch (e) {}
  }

  _wireRoom(entry) {
    const si = entry.si;
    const room = entry.room;
    for (const name of Object.keys(ACTION_CBS)) {
      const action = room.makeAction(name);
      entry.A[name] = action;
      const cbProp = ACTION_CBS[name];
      action.onMessage = (d, info) =>
        this._in(si, name, cbProp, d, info && info.peerId);
    }
    room.onPeerJoin = (id) => this._noteConn(si, id);
    room.onPeerLeave = (id) => this._dropConn(si, id);
  }

  /* A data channel connected on strategy si to trystero peerId. We don't
     know the human's cid until their first payload arrives, so park the
     connection under a provisional key; _in() promotes it on first sight. */
  _noteConn(si, peerId) {
    const connKey = `${si}:${peerId}`;
    const prov = `~prov:${connKey}`;
    let rec = this.peers.get(prov);
    if (!rec) {
      rec = { conns: new Map() };
      this.peers.set(prov, rec);
    }
    rec.conns.set(connKey, { si, peerId: String(peerId) });
    // Someone made it — signaling works. Reset the ICE retry ladder.
    this._iceRetryN = 0;
    this._clearIceRetry();
    this._netLog(`peer JOINED via ${STRATEGIES[si].name} — data channel open (${connKey})`);
    this._updatePill();
  }

  _dropConn(si, peerId) {
    const connKey = `${si}:${peerId}`;
    for (const [canon, rec] of this.peers) {
      if (rec.conns.delete(connKey)) {
        if (rec.conns.size === 0) {
          this.peers.delete(canon);
          // Only real humans (cid keys) reach game.js; provisional keys
          // never produced a visual.
          if (!canon.startsWith('~prov:') && this.onPeerLeaveCb) {
            try {
              this.onPeerLeaveCb(canon);
            } catch (e) {
              /* game callbacks must never break networking */
            }
          }
        }
        break;
      }
    }
    this._netLog(`peer left (${connKey})`);
    this._updatePill();
  }

  /* Promote a provisional connection to its cid on first payload, merging
     with the same human's connection from the other strategy (if any). */
  _promoteConn(si, peerId, cid) {
    const connKey = `${si}:${peerId}`;
    const prov = `~prov:${connKey}`;
    const c = { si, peerId: String(peerId) };
    let rec = this.peers.get(cid);
    if (!rec) {
      rec = { conns: new Map() };
      this.peers.set(cid, rec);
    }
    rec.conns.set(connKey, c);
    const old = this.peers.get(prov);
    if (old && old !== rec) {
      for (const [k, v] of old.conns) if (k !== connKey) rec.conns.set(k, v);
      this.peers.delete(prov);
    }
  }

  /* Incoming action payload on strategy si. Canonical peer id is the
     sender's cid (injected by _bcast/_sendTo on every payload we emit);
     the '~prov:' fallback only matters for mixed-version rooms. */
  _in(si, actionName, cbProp, d, peerId) {
    let cid = null;
    try {
      cid =
        d && typeof d.cid === 'string' && d.cid.length < 64 && d.cid
          ? d.cid
          : null;
    } catch (e) {}
    if (!cid) cid = `~prov:${si}:${peerId}`;
    else this._promoteConn(si, peerId, cid);
    // Duplicate-delivery filter: the same logical broadcast arrives once
    // per strategy room; drop the second copy.
    const now = Date.now();
    const key = `${cid}|${actionName}|${this._fp(d)}`;
    const exp = this._seen.get(key);
    if (exp && exp > now) return;
    this._seen.set(key, now + DEDUP_WINDOW_MS);
    if (this._seen.size > 600) {
      for (const [k, x] of this._seen) {
        if (x <= now) this._seen.delete(k);
        if (this._seen.size <= 400) break;
      }
    }
    // build 73: count live jukebox arrivals (post-dedup) for the link diagnostic
    if (JUKE_SERVER_ACTIONS.has(actionName)) this._jukeRx++;
    if (actionName.indexOf('theatre') === 0) this._theatreRx++; // build 79
    const cb = this[cbProp];
    if (cb) {
      try {
        cb(cid, d); // (peerId, data) — matches the game.js handler contract
      } catch (e) {
        /* game callbacks must never break networking */
      }
    }
  }

  /* Payload fingerprint for the dedup filter. Long strings (wall JPEGs,
     file chunks) are truncated — same logical message still collides,
     different ones still differ. */
  _fp(d) {
    try {
      return JSON.stringify(d, (k, v) =>
        typeof v === 'string' && v.length > 256
          ? v.slice(0, 64) + '…' + v.length
          : v
      );
    } catch (e) {
      return '?';
    }
  }

  /* Broadcast an action on every strategy room. The cid lets receivers
     merge our two connections into one human. */
  _bcast(actionName, data) {
    if (!this.enabled || this.rooms.length === 0) return;
    let out;
    try {
      out = Object.assign({ cid: this.clientId }, data);
    } catch (e) {
      out = { cid: this.clientId };
    }
    for (const e of this.rooms) {
      try {
        e.A[actionName].send(out);
      } catch (err) {
        /* best effort per room */
      }
    }
    // build 37: relay-mode fallback — the same payload rides Nostr when
    // WebRTC is down. Dedup on receipt collapses double deliveries.
    if (this.relayMode) this._relayPublish(actionName, out, null);
  }

  /* Resolve a canonical cid to one concrete (room, peerId) and send once. */
  _pickConn(canon) {
    const rec = this.peers.get(canon);
    if (!rec) return null;
    for (const [, c] of rec.conns) {
      const entry = this.rooms[c.si];
      if (entry) return { entry, peerId: c.peerId };
    }
    return null;
  }

  _sendTo(actionName, data, target) {
    if (!this.enabled) return;
    if (target == null) {
      // build 81: a null-target jukeFileReq is discovery ("who has this file?") —
      // broadcast it so a holder can answer and get pinned for the rest of the
      // transfer. Chunks stay targeted-only (a null chunk target is a bug, not
      // discovery, so those still drop).
      if (actionName === 'jukeFileReq') return this._bcast(actionName, data);
      return;
    }
    const c = this._pickConn(String(target));
    let out;
    try {
      out = Object.assign({ cid: this.clientId }, data);
    } catch (e) {
      out = { cid: this.clientId };
    }
    if (c) {
      try {
        c.entry.A[actionName].send(out, c.peerId);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    // build 37: no data-channel path to this peer — try the relay instead.
    if (this.relayMode) this._relayPublish(actionName, out, String(target));
  }

  /* Suggest the Nexus when a player sits alone in a realm room. */
  _armQuietTimer() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (
        !this.quietFired &&
        this.peerCount() === 0 &&
        this.roomKey &&
        !isNexusServerKey(this.roomKey) &&
        this.onQuietCb
      ) {
        this.quietFired = true;
        this.onQuietCb();
      }
    }, QUIET_AFTER_MS);
  }

  leave() {
    this._clearIceRetry();
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    for (const e of this.rooms) {
      try {
        e.room.leave();
      } catch (err) {
        /* ignore */
      }
    }
    this.rooms = [];
    this.peers.clear();
    this._nullSends();
    // build 37: drop the room's relay subscription (the lobby sub survives hops).
    if (this.relayLink && this._relayRoomTag) {
      try {
        this.relayLink.unsubscribe(this._relayRoomTag, this._relayRoomHandler);
      } catch (e) {}
      this._relayRoomTag = null;
    }
    // build 41: the jukebox server channel is re-pointed by setJukeServer,
    // never dropped by a room hop — but a full leave() resets it.
    if (this.relayLink && this._jukeServerTag) {
      try {
        this.relayLink.unsubscribe(this._jukeServerTag, this._jukeServerHandler);
      } catch (e) {}
      this._jukeServerTag = null;
    }
    this._updatePill();
  }

  /* ---------------- lobby presence (build 11) ----------------
     Rooms joined once at boot, one per strategy. Heartbeats carry
     {n, r, t, cid}. leave()/join() never touch them — they survive realm
     hops. */

  /* Update what our heartbeat says, and re-broadcast immediately.
     No-op until the lobby is joined. game.js calls this on boot,
     realm change, and drifter-name change. */
  setPresence(name, roomKey) {
    this.presenceName = this.cleanName(name);
    this.presenceRoom = String(roomKey || 'nexus').slice(0, 16);
    this._presenceTick();
  }

  _presencePayload() {
    return { n: this.presenceName, r: this.presenceRoom, t: Date.now() };
  }

  _presenceTick() {
    if (!this.enabled || !this.sendPresence) return;
    try {
      this.sendPresence(this._presencePayload());
    } catch (e) {
      /* ignore */
    }
    // build 37: the lobby roster rides the relay too when fallback is on.
    this._presenceTickRelay();
  }

  _notePresence(data) {
    try {
      if (!data) return;
      const cid = typeof data.cid === 'string' && data.cid ? data.cid : null;
      if (!cid || cid === this.clientId) return; // never list ourselves
      const name = this.cleanName(data.n);
      const room = String(data.r || 'nexus').slice(0, 16);
      const dj = typeof data.dj === 'string' && data.dj ? String(data.dj).slice(0, 16) : null;
      this.lobbyPeers.set(cid, { name, room, dj, lastSeen: Date.now() });
      if (this.onPresenceCb) this.onPresenceCb();
    } catch (e) {
      /* ignore */
    }
  }

  /* Drop entries silent longer than PRESENCE_EXPIRE_MS. `now` is
     injectable so tests can time-travel instead of waiting 45s. */
  _sweepLobby(now) {
    const t = typeof now === 'number' ? now : Date.now();
    let dropped = 0;
    for (const [id, p] of this.lobbyPeers) {
      if (t - p.lastSeen > PRESENCE_EXPIRE_MS) {
        this.lobbyPeers.delete(id);
        dropped++;
      }
    }
    if (dropped > 0 && this.onPresenceCb) this.onPresenceCb();
  }

  joinLobby() {
    if (!this.enabled || this.lobbyRooms.length) return;
    for (let si = 0; si < STRATEGIES.length; si++) {
      const mod = this.mods[si];
      if (!mod) continue;
      const isNostr = STRATEGIES[si].name === 'nostr';
      try {
        const room = mod.joinRoom(
          {
            appId: APP_ID,
            rtcConfig: this.rtcConfig,
            ...(isNostr ? { relayConfig: { urls: NOSTR_RELAYS } } : {}),
          },
          LOBBY_ROOM
        );
        const presenceAction = room.makeAction('presence');
        presenceAction.onMessage = (d) => this._notePresence(d);
        // A newcomer joining mid-session gets our heartbeat right away.
        room.onPeerJoin = () => this._presenceTick();
        this.lobbyRooms.push({ si, room, presenceAction });
      } catch (e) {
        /* ignore */
      }
    }
    if (!this.lobbyRooms.length) return;
    this.sendPresence = (data) => {
      let out;
      try {
        out = Object.assign({ cid: this.clientId }, data);
      } catch (e) {
        out = { cid: this.clientId };
      }
      for (const l of this.lobbyRooms) {
        try {
          l.presenceAction.send(out);
        } catch (e) {
          /* ignore */
        }
      }
    };
    this._presenceTick(); // announce ourselves on entry
    this._presenceTimer = setInterval(
      () => this._presenceTick(),
      PRESENCE_INTERVAL_MS
    );
    this._sweepTimer = setInterval(() => this._sweepLobby(), PRESENCE_SWEEP_MS);
  }

  _leaveLobby() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    for (const l of this.lobbyRooms) {
      try {
        l.room.leave();
      } catch (e) {
        /* ignore */
      }
    }
    this.lobbyRooms = [];
    this.sendPresence = null;
    this.lobbyPeers.clear();
  }

  /* ---------------- relay mode (build 37) ----------------
     Nostr data-transport fallback — see the header comment. These are the
     LimboNet-side hooks; the wire client is the RelayLink class above. */

  /* Engage the Nostr data-transport fallback. Idempotent; safe to call
     from any failure path. Sticky for the session once on. */
  async enterRelayMode(reason) {
    if (this.relayMode || !this.enabled) return;
    this.relayMode = true;
    this._relaySince = Date.now();
    this._netLog(
      `RELAY MODE engaged (${reason}) — traffic now rides Nostr relays`
    );
    this._updatePill();
    if (!this.relayLink) this.relayLink = new RelayLink(this);
    let ok = false;
    try {
      ok = await this.relayLink.ensure();
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      this.relayMode = false;
      this._netLog('relay: transport unavailable — staying on WebRTC retries');
      // build 80: a goTo() during ensure() returns early from ITS
      // enterRelayMode() (relayMode was already true), so after this failure
      // nothing will ever re-engage the relay — the room-tag subscription
      // is skipped and the client is silently relay-less. One delayed retry
      // closes the hole; the watchdog / join-error / no-discovery triggers
      // stay as backstops.
      if (this.enabled && this.roomKey && !this._relayRetryT) {
        this._relayRetryT = setTimeout(() => {
          this._relayRetryT = null;
          if (!this.relayMode && this.enabled && this.roomKey) {
            this._netLog('relay: retrying transport after failed ensure()');
            try {
              this.enterRelayMode('retry-after-fail').catch(() => {});
            } catch (e) {}
          }
        }, 5000);
      }
      this._updatePill();
      return;
    }
    if (this.roomKey) {
      this._relayRoomTag = this.relayLink.tagFor(this.roomKey);
      this.relayLink.subscribe(this._relayRoomTag, this._relayRoomHandler);
    }
    // build 41: the server-wide jukebox channel follows the selected server
    this.setJukeServer(this._jukeServerKey);
    this.relayLink.subscribe(
      this.relayLink.tagFor(LOBBY_ROOM),
      this._relayLobbyHandler
    );
    this._presenceTickRelay();
    /* Build 43: the relay is live — safe moment for the jukebox to ask the
       server's holder for the line (the old blind boot timer fired before
       the drift tap, so late joiners never caught up). */
    if (this.onRelayUpCb) {
      try { this.onRelayUpCb(); } catch (e) {}
    }
  }

  /* Publish one action payload over the relay. Same envelope the data
     channel would carry ({cid, ...}), wrapped as {a, d, to?}. */
  _relayPublish(actionName, data, targetCid) {
    if (!this._relayRoomTag) return;
    this._relayPublishTo(this._relayRoomTag, actionName, data, targetCid);
  }

  /* Build 41: publish to an explicit relay tag (the server-wide jukebox
     channel). The plain _relayPublish keeps the old room-tag behavior. */
  /* Build 44: returns true when the envelope left on at least one socket
     (or was queued in the outbox for the next socket open). */
  _relayPublishTo(tag, actionName, data, targetCid) {
    try {
      if (!this.relayMode || !this.relayLink || !tag) return false;
      if (RELAY_SKIP_ACTIONS.has(actionName)) {
        if (!this._relaySkipLogged.has(actionName)) {
          this._relaySkipLogged.add(actionName);
          this._netLog(
            `relay: ${actionName} needs a direct connection — skipped in relay mode`
          );
        }
        return false;
      }
      if (actionName === 'wisp') {
        const now = Date.now();
        if (now - this._lastRelayWisp < RELAY_WISP_MIN_MS) return false;
        this._lastRelayWisp = now;
      }
      const env = { a: actionName, d: data };
      if (targetCid) env.to = targetCid;
      return this.relayLink.publish(tag, env);
    } catch (e) {
      /* relay must never break the game loop */
      return false;
    }
  }

  /* Incoming room traffic from the relay. Feeds the same _in() path as
     the data channel — dedup + cid merging handle hybrid peers. */
  _onRelayRoom(obj) {
    try {
      if (!obj || typeof obj !== 'object') return;
      const actionName = obj.a;
      const d = obj.d;
      if (typeof actionName !== 'string' || !d || typeof d !== 'object') return;
      const cbProp = ACTION_CBS[actionName];
      if (!cbProp) return;
      const cid = typeof d.cid === 'string' && d.cid ? d.cid : null;
      if (!cid || cid === this.clientId) return; // malformed / our own echo
      if (obj.to && obj.to !== this.clientId) return; // addressed elsewhere
      let rec = this.peers.get(cid);
      if (!rec) {
        rec = { conns: new Map(), relay: true, lastSeen: 0 };
        this.peers.set(cid, rec);
      }
      rec.lastSeen = Date.now();
      this._in('relay', actionName, cbProp, d, cid);
      this._updatePill();
    } catch (e) {
      /* never break on peer data */
    }
  }

  /* Incoming lobby presence from the relay — same roster as _notePresence. */
  _onRelayLobby(obj) {
    try {
      if (!obj || obj.a !== 'presence' || !obj.d || typeof obj.d !== 'object')
        return;
      const d = obj.d;
      if (!d.cid || d.cid === this.clientId) return;
      this._notePresence(d);
    } catch (e) {}
  }

  /* Heartbeat our presence over the relay (lobby tag). Called on engage
     and piggybacked on the regular 15s _presenceTick. */
  _presenceTickRelay() {
    try {
      if (!this.relayMode || !this.relayLink) return;
      this.relayLink.publish(this.relayLink.tagFor(LOBBY_ROOM), {
        a: 'presence',
        d: Object.assign({ cid: this.clientId }, this._presencePayload()),
      });
    } catch (e) {}
  }

  /* True when at least one pinned relay has an open Trystero socket —
     meaning the relay path is provably reachable from this client. */
  _relayReachable() {
    try {
      const st = this._getRelayStatus();
      return !!(st && st.some((r) => r.open));
    } catch (e) {
      return false;
    }
  }

  /* No-discovery trigger: 30s+ in a room with zero peers but reachable
     relays — the WebRTC path is getting us nothing. The watchdog and
     join-error paths engage relay mode directly (discovery proven). */
  _checkRelayTriggers() {
    if (this.relayMode || !this.enabled || !this.roomKey) return;
    if (this.peerCount() > 0) return;
    if (Date.now() - this.joinedAt > 30000 && this._relayReachable()) {
      this._netLog('relay trigger: 30s, no peers, relays reachable');
      this.enterRelayMode('no-discovery');
    }
  }

  /* Relay peers have no onPeerLeave — expire them like presence entries. */
  _sweepRelayPeers(now) {
    const t = typeof now === 'number' ? now : Date.now();
    let dropped = 0;
    for (const [cid, rec] of this.peers) {
      if (cid.startsWith('~prov:')) continue;
      if (!rec.relay) continue;
      if (t - (rec.lastSeen || 0) > PRESENCE_EXPIRE_MS) {
        this.peers.delete(cid);
        dropped++;
        this._netLog(`relay: peer ${String(cid).slice(0, 8)} expired`);
        if (this.onPeerLeaveCb) {
          try {
            this.onPeerLeaveCb(cid);
          } catch (e) {}
        }
      }
    }
    if (dropped > 0) this._updatePill();
  }

  /* Broadcast our wisp position + heading + name + equipped look (~12Hz
     from the game loop). game.js sets this.cosmetics so peers can render
     our skin, hat, and trail; short string ids keep the payload tiny.
     `fwd` (optional THREE-like {x,y,z}) is our forward vector — the
     journey room's flock math uses it to pick the V leader (build 36). */
  broadcast(pos, fwd) {
    if (!this.enabled || !this.sendWisp) return;
    let s = 'drifter', h = 'none', t = 'ribbon', c = 'bfe2ff';
    try {
      const csm = (typeof this.cosmetics === 'function') ? this.cosmetics() : null;
      if (csm) {
        if (csm.s) s = String(csm.s).slice(0, 16);
        if (csm.h) h = String(csm.h).slice(0, 16);
        if (csm.t) t = String(csm.t).slice(0, 16);
        if (csm.c) c = String(csm.c).slice(0, 6);
      }
    } catch (e) { /* ignore */ }
    try {
      const wisp = {
        p: [r1(pos.x), r1(pos.y), r1(pos.z)],
        n: this.name,
        s,
        h,
        t,
        c,
      };
      if (fwd && typeof fwd.x === 'number') wisp.f = [r1(fwd.x), r1(fwd.y), r1(fwd.z)];
      this.sendWisp(wisp);
    } catch (e) {
      /* ignore */
    }
  }

  say(text) {
    if (!this.enabled || !this.sendChat) return;
    try {
      this.sendChat({ n: this.name, t: String(text).slice(0, 140) });
    } catch (e) {
      /* ignore */
    }
  }

  /* Unique humans currently connected (both of a human's strategy
     connections collapse to their cid). */
  peerCount() {
    let n = 0;
    for (const k of this.peers.keys()) if (!k.startsWith('~prov:')) n++;
    return n;
  }

  /* Build 73: one-line jukebox link diagnostic for the phones.
     tx = jukebox broadcasts sent, rx = jukebox messages arrived,
     relay = relay transport engaged, peers = data-channel peers seen. */
  jukeDiag() {
    let relay = false;
    try { relay = !!(this.relayMode && this.relayLink && this.relayLink.ready); }
    catch (e) {}
    return { tx: this._jukeTx | 0, rx: this._jukeRx | 0, relay, peers: this.peerCount() };
  }

  /* Raw RTCPeerConnections across all strategy rooms, keyed
     'strategy:peerId'. Empty when signaling has found nobody — which is
     itself diagnostic. */
  getPeerConnections() {
    const out = {};
    try {
      for (const e of this.rooms) {
        let pcs = {};
        try {
          pcs = e.room.getPeers() || {};
        } catch (err) {}
        for (const [id, pc] of Object.entries(pcs)) out[`${e.name}:${id}`] = pc;
      }
    } catch (e) {}
    return out;
  }

  /* ---------------- phone-visible status pill (build 30) ----------------
     The debug HUD needs a keyboard (press D) — useless on phones. This
     small always-visible pill shows live net state for touch devices:
       ○ offline              strategy modules failed to load (single-player)
       ○ net ready            loaded, no room joined yet
       ○ finding others…      in a room, no peers, no handshake activity
       ○ connecting…          peer announced / handshaking, no data channel yet
       ○ couldn't connect · retrying…   ICE failed (onJoinError), retry scheduled
       ○ relay: finding others… relay fallback on, no peers yet (build 37)
       ● N here               N humans connected
       ● N here · relay       N humans connected via relay fallback (build 37)
     Updates on join/leave/error/handshake plus a 2s poll for stage changes.
     pointer-events:none so it never eats game touches. */

  _ensurePill() {
    if (typeof document === 'undefined') return;
    try {
      // The 2s tick drives the watchdog + pc-state polling on EVERY
      // platform (build 31); the visible pill itself stays touch-only.
      if (!this._pillTimer)
        this._pillTimer = setInterval(() => this._tick(), 2000);
      const touch =
        (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
        'ontouchstart' in window;
      if (!touch || this._pill) {
        this._updatePill();
        return;
      }
      const el = document.createElement('div');
      el.id = 'net-pill';
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
      this._pill = el;
      this._updatePill();
    } catch (e) {
      /* pill is optional */
    }
  }

  /* Periodic tick: watchdog first (the actual fix), then diagnostics,
     then the pill label. Diagnostics must never break networking. */
  _tick() {
    try {
      this._checkWatchdog();
    } catch (e) {
      /* never break networking */
    }
    try {
      this._pollPcStates();
    } catch (e) {
      /* diagnostics only */
    }
    // build 37: relay-mode triggers + relay peer expiry (diagnostics-safe)
    try {
      this._checkRelayTriggers();
    } catch (e) {
      /* diagnostics only */
    }
    try {
      this._sweepRelayPeers();
    } catch (e) {
      /* diagnostics only */
    }
    this._updatePill();
  }

  _netState() {
    if (!this.enabled) return { cls: 'off', text: '○ offline' };
    if (!this.roomKey) return { cls: 'mid', text: '○ net ready' };
    const n = this.peerCount();
    if (n > 0)
      return this.relayMode
        ? { cls: 'relay', text: `● ${n} here · relay` }
        : { cls: 'on', text: `● ${n} here` };
    if (this.relayMode)
      return { cls: 'relay', text: '○ relay: finding others…' };
    if (this.lastJoinError) return { cls: 'warn', text: "○ couldn't connect · retrying…" };
    const now = Date.now();
    for (const [, r] of this.hsPeers) {
      if (
        now - (r.lastSeenMs || 0) < 30000 &&
        (r.stage === 'discovered' || r.stage === 'signaling' || r.stage === 'handshaking')
      ) {
        return { cls: 'mid', text: '○ connecting…' };
      }
    }
    return { cls: 'mid', text: '○ finding others…' };
  }

  _updatePill() {
    if (!this._pill) return;
    try {
      const s = this._netState();
      if (this._pill.textContent !== s.text) this._pill.textContent = s.text;
      if (this._pill.dataset.cls !== s.cls) this._pill.dataset.cls = s.cls;
    } catch (e) {
      /* never break networking for a label */
    }
  }

  /* ---------------- ?debug=net on-screen log (build 31) ----------------
     When the URL carries ?debug=net, timestamped net events render in a
     small toggleable monospace panel (tap the header to collapse) so a
     phone test produces a diagnosis instead of a shrug. Without the param
     there is zero UI change — the ring buffer is still kept (cheap) for
     the keyboard debug HUD. */

  _netLog(msg) {
    try {
      const t = new Date();
      const line =
        `${t.toLocaleTimeString('en-GB')}.${String(t.getMilliseconds()).padStart(3, '0')} ${msg}`;
      // Ensure the panel BEFORE pushing, so the buffer replay inside
      // _ensureNetLogPanel can't duplicate the line we're about to add.
      if (this._netLogOn) this._ensureNetLogPanel();
      this._netLogBuf.push(line);
      if (this._netLogBuf.length > 200) this._netLogBuf.shift();
      if (!this._netLogOn) return;
      const body = this._netLogBody;
      if (body) {
        const div = document.createElement('div');
        div.textContent = line;
        body.appendChild(div);
        while (body.children.length > 200) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
      }
    } catch (e) {
      /* diagnostics must never break networking */
    }
  }

  _ensureNetLogPanel() {
    if (this._netLogEl || typeof document === 'undefined') return;
    try {
      const wrap = document.createElement('div');
      wrap.id = 'net-log';
      const head = document.createElement('div');
      head.id = 'net-log-head';
      const body = document.createElement('div');
      body.id = 'net-log-body';
      const setLabel = (open) => {
        head.textContent = open ? 'NET LOG · tap to collapse' : 'NET LOG · tap to expand';
      };
      setLabel(true);
      head.addEventListener('click', () => {
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : '';
        setLabel(!isOpen);
      });
      wrap.appendChild(head);
      wrap.appendChild(body);
      document.body.appendChild(wrap);
      this._netLogEl = wrap;
      this._netLogBody = body;
      for (const line of this._netLogBuf) {
        const div = document.createElement('div');
        div.textContent = line;
        body.appendChild(div);
      }
      body.scrollTop = body.scrollHeight;
    } catch (e) {
      /* panel is optional */
    }
  }

  /* Poll raw RTCPeerConnections for ICE state transitions + local
     candidate types. Only runs with ?debug=net (the pill doesn't show
     this). The candidate-type line is the money: 'relay' present means
     TURN allocation worked; host+srflx only means TURN is dead and two
     symmetric-NAT phones can never connect. */
  _pollPcStates() {
    if (!this._netLogOn) return;
    let pcs = {};
    try {
      pcs = this.getPeerConnections();
    } catch (e) {
      return;
    }
    for (const [key, pc] of Object.entries(pcs)) {
      let prev = this._pcSeen.get(key);
      if (!prev) {
        prev = { ice: null, gathering: null, typesLogged: false };
        this._pcSeen.set(key, prev);
      }
      let ice = null;
      let gathering = null;
      try {
        ice = pc.iceConnectionState || '?';
        gathering = pc.iceGatheringState || '?';
      } catch (e) {
        /* ignore */
      }
      if (prev.ice === null) {
        this._netLog(`pc ${key}: new (ice=${ice}, gathering=${gathering})`);
      } else if (ice !== prev.ice) {
        this._netLog(`pc ${key}: ice ${prev.ice} → ${ice}`);
      }
      if (prev.gathering !== 'complete' && gathering === 'complete' && !prev.typesLogged) {
        prev.typesLogged = true;
        this._logCandidateTypes(key, pc);
      }
      prev.ice = ice;
      prev.gathering = gathering;
    }
    for (const k of [...this._pcSeen.keys()]) {
      if (!Object.prototype.hasOwnProperty.call(pcs, k)) {
        this._pcSeen.delete(k);
        this._netLog(`pc ${k}: gone`);
      }
    }
  }

  async _logCandidateTypes(key, pc) {
    try {
      const stats = await pc.getStats();
      const types = new Set();
      stats.forEach((s) => {
        if (s.type === 'local-candidate' && s.candidateType) types.add(s.candidateType);
      });
      const arr = [...types].sort();
      const verdict = arr.includes('relay')
        ? '← TURN alive (relay candidate)'
        : '← NO relay candidate (TURN dead?)';
      this._netLog(`pc ${key}: local candidates [${arr.join(', ') || 'none'}] ${verdict}`);
    } catch (e) {
      this._netLog(`pc ${key}: getStats failed`);
    }
  }

  /* Snapshot for the debug HUD (press D). Works with zero peers — that's
     the whole point. localTypes tells us whether TURN allocation worked:
     'relay' present = TURN is alive; host+srflx only = TURN is dead. */
  async getDebugSnapshot() {
    const pcs = this.getPeerConnections();
    const peers = [];
    for (const [id, pc] of Object.entries(pcs)) {
      const info = {
        id: String(id).slice(0, 24),
        ice: '?',
        gathering: '?',
        conn: '?',
        localTypes: [],
        selectedType: 'none',
      };
      try {
        info.ice = pc.iceConnectionState || '?';
        info.gathering = pc.iceGatheringState || '?';
        info.conn = pc.connectionState || '?';
        const stats = await pc.getStats();
        const localById = new Map();
        const types = new Set();
        let selectedLocalId = null;
        stats.forEach((s) => {
          if (s.type === 'local-candidate') {
            localById.set(s.id, s.candidateType || '?');
            if (s.candidateType) types.add(s.candidateType);
          } else if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
            selectedLocalId = s.localCandidateId;
          }
        });
        info.localTypes = [...types].sort();
        if (selectedLocalId && localById.has(selectedLocalId)) {
          info.selectedType = localById.get(selectedLocalId);
        }
      } catch (e) {
        info.ice = 'stats-err';
      }
      peers.push(info);
    }
    const strats = STRATEGIES.map((s, si) => {
      const entry = this.rooms.find((e) => e.si === si);
      let conns = 0;
      for (const [, rec] of this.peers)
        for (const [, c] of rec.conns) if (c.si === si) conns++;
      return {
        name: s.name,
        loaded: !!this.mods[si],
        joined: !!entry,
        conns,
      };
    });
    return {
      build: this.build,
      enabled: this.enabled,
      strategies: strats,
      roomKey: this.roomKey || '(none)',
      peerCount: this.peerCount(),
      peers,
      lastJoinError: this.lastJoinError,
      iceRetry: this._iceRetryTimer
        ? { inMs: Math.max(0, (this._iceRetryAt || 0) - Date.now()), attempt: this._iceRetryN }
        : null,
      turnUser: this.turnCreds ? this.turnCreds.username : '(none)',
      clientId: this.clientId ? String(this.clientId).slice(0, 8) : '(none)',
      // Handshake-stage diagnostics: relay socket state, per-peer
      // discovery/handshake stage, recent nostr wire frames.
      relays: this._getRelayStatus(),
      hsPeers: [...this.hsPeers.entries()].map(([id, r]) => ({
        id,
        stage: r.stage,
        sigIn: r.sigIn,
        sigOut: r.sigOut,
        initiator: r.initiator,
        lastSeenMs: r.lastSeenMs,
      })),
      frames: this.nostrFrames.slice(),
      // build 37: relay-mode fallback state
      relay: this.relayMode
        ? {
            since: this._relaySince,
            roomTag: this._relayRoomTag,
            tx: this.relayLink ? this.relayLink.tx : 0,
            rx: this.relayLink ? this.relayLink.rx : 0,
            sockets: this.relayLink ? this.relayLink.socketStates() : [],
          }
        : null,
    };
  }
}

function r1(v) {
  return Math.round(v * 10) / 10;
}

/* Build 38: numbered Nexus servers, shared with game.js for the picker. */
export { NEXUS_SERVERS, nexusServerKey, isNexusServerKey };
