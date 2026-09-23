/* ============================================================
   LIMBO — a portal universe (prototype)
   Fly a wisp through the Nexus into 4 art-realms, gather echoes.
   Drift with others: serverless P2P multiplayer (Trystero) + chat.

   Controls: WASD / arrows fly · mouse-drag look · SPACE/SHIFT or
   E/Q rise/sink · T chat · M mute · touch: left-half joystick,
   right-half drag
   ============================================================ */

import * as THREE from 'three';
import { AudioEngine } from './audio.js?v=81';
import { LimboNet, NEXUS_SERVERS, nexusServerKey, isNexusServerKey } from './net.js?v=81';
import { CouchNet } from './couch.js?v=81';
import { computeFlocks, meanHeading, FLOCK_R } from './flock.js?v=81';
import { quantizeUp, estimateBpm, OnsetDetector, playSynthNote, synthNoteOn, synthNoteOff, synthAllOff, playBassNote, playDrum, playDrumSample, renderDrumKits, DRUM_KITS, drumVariantName, drumVariantCount, playPadChord, JAM_CHORDS, JAM_DRUMS, makeImpulseResponse, jamMetroClick, synthVoiceCount, createSynthFx } from './jam.js?v=81';

/* Build 47: the build number rides the script's own ?v= cache-bust, so
   the stamp below can never drift from what's actually running. */
const LIMBO_BUILD = (() => {
  try {
    const m = String(import.meta.url || '').match(/[?&]v=(\d+)/);
    return m ? m[1] : '?';
  } catch (e) { return '?'; }
})();
try {
  const bs = document.getElementById('build-stamp');
  if (bs) bs.textContent = 'build ' + LIMBO_BUILD;
} catch (e) {}

/* Build 25: aborted fetches (our own timeout-aborts, the P2P tracker's
   retries, provider player internals) surface as unhandled AbortErrors —
   "signal is aborted without reason" in Chrome. They're expected noise, not
   bugs: every fetch we start is already caught at its own call site, so an
   unhandled AbortError is by definition someone else's. Swallow it so it
   never pollutes error telemetry; everything else still reports. */
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e && e.reason;
      const msg = r && typeof r.message === 'string' ? r.message : '';
      if ((r && r.name === 'AbortError') || /aborted without reason/i.test(msg)) {
        e.preventDefault();
      }
    } catch (_) {}
  });
}

/* ---------------- configuration ---------------- */

const REALM_DEFS = [
  { key: 'realm1', name: 'PRISM DEEP',  file: 'assets/realm1.jpg', fog: 0x1a0b2e, accent: 0xff4fd8, root: 130.81 },
  { key: 'realm2', name: 'MIRROR TIDE', file: 'assets/realm2.jpg', fog: 0x0a1030, accent: 0x7a5cff, root: 146.83 },
  { key: 'realm3', name: 'CHROME VEIL', file: 'assets/realm3.jpg', fog: 0x031018, accent: 0x37e6ff, root: 164.81 },
  { key: 'realm4', name: 'STILL POINT', file: 'assets/realm4.jpg', fog: 0x06231c, accent: 0x2dffb3, root: 196.0  },
];
const NEXUS_DEF = { key: 'nexus', name: 'THE NEXUS', root: 110.0 };

// Print shop: every realm's artwork is a real giclée print. One base URL so
// the store can move from the temp domain to shop.holowatts.com later
// without touching the rows below.
const SHOP_BASE = 'https://newvjk-az.myshopify.com';
const REALM_PRINT = {
  realm1: { title: 'Colorful Worlds' },
  realm2: { title: 'Rainbow Deathstar' },
  realm3: { title: 'BubbleFairy' },
  realm4: { title: 'Mind Body n Soul' },
};
function printUrl(realmKey) {
  const t = (REALM_PRINT[realmKey] && REALM_PRINT[realmKey].title) || '';
  return SHOP_BASE + '/search?q=' + encodeURIComponent(t);
}

const ECHOES_PER_REALM = 5;
const TOTAL_ECHOES = REALM_DEFS.length * ECHOES_PER_REALM;
/* The sound room (build 12): a 5th portal and a social space, NOT a
   progression realm — no echoes, no attunement, so none of the
   REALM_DEFS-based math (echo totals, unlock thresholds, prints) moves. */
const SOUND_DEF = { key: 'soundroom', name: 'SOUND ROOM', accent: 0xffc24d, root: 98.0 };
const SOUND_ROOM_KEY = SOUND_DEF.key; // world key used by goTo()
/* The endless journey (build 33; open field in 36): album-release room.
   Free flight like the Nexus across one big open field holding four
   environment zones; orbs that bunch up fall into a bird-flock V and
   slipstream faster. Its own P2P room, like the sound room. */
const JOURNEY_DEF = { key: 'journey', name: 'ENDLESS JOURNEY', accent: 0x7af2ff, root: 110.0 };
const JOURNEY_ROOM_KEY = JOURNEY_DEF.key;
/* The model room (build 66): a workshop realm with an in-browser mini
   3D modeler. Saved models feed the sound room's stage builder. Its own
   P2P room, like the sound room. */
const WORKSHOP_DEF = { key: 'workshop', name: 'MODEL ROOM', accent: 0x9fd8ff, root: 146.83 };
const WORKSHOP_ROOM_KEY = WORKSHOP_DEF.key;
/* The theatre (build 75): a cinema room for watching videos together.
   Paste a YouTube URL, everyone sees the same frame at the same time.
   Its own P2P room, like the sound room. */
const THEATRE_DEF = { key: 'theatre', name: 'THEATRE', accent: 0xff5566, root: 120.0 };
const THEATRE_ROOM_KEY = THEATRE_DEF.key;
const NEXUS_BOUND = 40;       // horizontal leash in the hub
const PORTAL_TRIGGER = 3.0;   // wisp-to-portal distance that teleports
const ECHO_TRIGGER = 2.6;     // wisp-to-echo distance that collects
const MAX_REMOTE = 15;        // cap on rendered remote wisps

/* ---------------- dom ---------------- */

const canvas      = document.getElementById('scene');
const fadeEl      = document.getElementById('fade');
const titleCardEl = document.getElementById('title-card');
const attunedEl   = document.getElementById('attuned');
const realmNameEl = document.getElementById('realm-name');
const echoCountEl = document.getElementById('echo-counter');
const hintEl      = document.getElementById('controls-hint');
const muteEl      = document.getElementById('mute-label');
const loadingEl   = document.getElementById('loading');
const overlayEl   = document.getElementById('start-overlay');
const driftBtn    = document.getElementById('drift-btn');
const joyBase     = document.getElementById('joy-base');
const joyKnob     = document.getElementById('joy-knob');
const nameInput   = document.getElementById('name-input');
const chatLog     = document.getElementById('chat-log');
const chatInput   = document.getElementById('chat-input');
const chatSend    = document.getElementById('chat-send');
const chatToggle  = document.getElementById('chat-toggle');
const peerCountEl = document.getElementById('peer-count');
const gearBtn       = document.getElementById('gear-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const soundToggle   = document.getElementById('sound-toggle');
const settingsName  = document.getElementById('settings-name');
const settingsDebug = document.getElementById('settings-debug');
const unlockToastEl = document.getElementById('unlock-toast');
const wispSkinsEl   = document.getElementById('wisp-skins');
const wispHatsEl    = document.getElementById('wisp-hats');
const wispTrailStylesEl = document.getElementById('wisp-trail-styles');
const wispTrailColorsEl = document.getElementById('wisp-trail-colors');
const printsListEl  = document.getElementById('prints-list');
const friendsListEl   = document.getElementById('friends-list');
const friendsLiveEl   = document.getElementById('friends-live');
const friendAddInput  = document.getElementById('friend-add-input');
const friendAddBtn    = document.getElementById('friend-add-btn');
// Couch co-op (build 34): offline LAN multiplayer ceremony UI.
const couchPanel      = document.getElementById('couch-panel');
const couchCloseBtn   = document.getElementById('couch-close');
const couchHome       = document.getElementById('couch-home');
const couchHostScreen = document.getElementById('couch-host');
const couchHostScanScreen = document.getElementById('couch-host-scan');
const couchJoinScreen = document.getElementById('couch-join');
const couchJoinShowScreen = document.getElementById('couch-join-show');
const couchHostBtn    = document.getElementById('couch-host-btn');
const couchJoinBtn    = document.getElementById('couch-join-btn');
const couchHostQr     = document.getElementById('couch-host-qr');
const couchHostStatus = document.getElementById('couch-host-status');
const couchHostScanBtn = document.getElementById('couch-host-scan-btn');
const couchHostVideo  = document.getElementById('couch-host-video');
const couchHostScanStatus = document.getElementById('couch-host-scan-status');
const couchHostScanBack = document.getElementById('couch-host-scan-back');
const couchRosterEl   = document.getElementById('couch-roster');
const couchHostStop   = document.getElementById('couch-host-stop');
const couchJoinVideo  = document.getElementById('couch-join-video');
const couchJoinStatus = document.getElementById('couch-join-status');
const couchJoinManualBtn = document.getElementById('couch-join-manual-btn');
const couchJoinManual = document.getElementById('couch-join-manual');
const couchJoinCode   = document.getElementById('couch-join-code');
const couchJoinCodeBtn = document.getElementById('couch-join-code-btn');
const couchJoinBack   = document.getElementById('couch-join-back');
const couchJoinQr     = document.getElementById('couch-join-qr');
const couchJoinShowStatus = document.getElementById('couch-join-show-status');
const couchJoinCancel = document.getElementById('couch-join-cancel');
const setCouchHostBtn = document.getElementById('set-couch-host');
const setCouchJoinBtn = document.getElementById('set-couch-join');
const couchSetRow     = document.getElementById('couch-set-row');
const couchSetStatus  = document.getElementById('couch-set-status');
const paintBtn        = document.getElementById('paint-btn');
const paintOverlay    = document.getElementById('paint-overlay');
const paintCanvas     = document.getElementById('paint-canvas');
const paintPaletteEl  = document.getElementById('paint-palette');
const paintSizesEl    = document.getElementById('paint-sizes');
const paintDoneBtn    = document.getElementById('paint-done');
const jukeBtn         = document.getElementById('juke-btn');
const jukePanel       = document.getElementById('juke-panel');
// Journey room: like the jukebox track + follow Holowatts (build 33);
// the zone banner names the land you're flying through (build 36).
const zoneNameEl      = document.getElementById('zone-name');
const jukeSocialPill  = document.getElementById('juke-social-pill');
const jukeLikeBtn     = document.getElementById('juke-like-btn');
const jukeLikeCount   = document.getElementById('juke-like-count');
const jukeFollowBtn   = document.getElementById('juke-follow-btn');
const jukeFollowMenu  = document.getElementById('juke-follow-menu');
const paintEraserBtn  = document.getElementById('paint-eraser');
const paintUndoBtn    = document.getElementById('paint-undo');
const paintBlendBtn   = document.getElementById('paint-blend');
const paintSaveBtn    = document.getElementById('paint-save');

/* ---------------- multiplayer state ---------------- */

/* Build 34: two transports, one `net`. Online P2P (Trystero) stays exactly
   as it was; couch co-op (offline LAN, CouchNet) is selected from the
   Nexus and never bridged with online. The dispatcher proxy forwards
   READS to the active transport (binding methods) and WRITES (callback
   wiring like net.onWispCb = ...) to BOTH, so every handler the game
   installs once works over either transport with zero call-site changes.
   A drifter is either online OR couch — enterCouchMode()/exitCouchMode()
   flip `couchActive` and tear down the other side. */
const onlineNet = new LimboNet();
const couchNet = new CouchNet();
let couchActive = false;
const net = new Proxy(onlineNet, {
  get(t, p) {
    const a = couchActive ? couchNet : onlineNet;
    const v = a[p];
    return typeof v === 'function' ? v.bind(a) : v;
  },
  set(t, p, v) {
    onlineNet[p] = v;
    couchNet[p] = v;
    return true;
  },
});
const peerLayer = new THREE.Group(); // remote wisps, re-parented per scene
const peerVisuals = new Map();       // peerId -> {group, bob, tag, target, name, phase}
let myName = 'drifter';
let started = false;                 // true once past the start overlay
let chatFocused = false;
let netTimer = 0;
try { myName = localStorage.getItem('limbo_name') || 'drifter'; } catch (e) { /* ignore */ }
if (nameInput && myName !== 'drifter') nameInput.value = myName;

function roomKeyFor(worldKey) {
  if (worldKey === 'nexus') return nexusServerKey(selectedServer);
  if (worldKey === SOUND_ROOM_KEY) return 'limbo-realm-5';
  if (worldKey === JOURNEY_ROOM_KEY) return 'limbo-realm-6';
  if (worldKey === WORKSHOP_ROOM_KEY) return 'limbo-realm-7';
  return 'limbo-realm-' + worldKey.replace('realm', '');
}

/* Build 38 — numbered Nexus servers. The start overlay lets the drifter
   pick #1–#10 with live headcounts; the pick survives realm hops. */
let selectedServer = 1;
/* Build 41: the jukebox is server-wide — one shared queue per Nexus
   server, same list on every phone. The server channel follows the pick:
   changing servers leaves the old party (queue resets) and asks the new
   server for its queue + now-playing. */
/* Build 43: the queue is server-held, not individual-held. One peer per
   Nexus server is the authoritative holder of the line — elected by lowest
   election key, with the parked relay peer (?park=1, the one that never
   sleeps) preferred. The holder answers state requests and broadcasts the
   canonical line; if it leaves, the next peer takes over seamlessly. */
const IS_PARK_HOLDER = (() => {
  try { return new URLSearchParams(location.search).get('park') === '1'; }
  catch (e) { return false; }
})();
/* Build 43: the line caps at 50 tracks — new adds past that are refused
   with a kind note rather than silently dropping someone's pick. */
const JUKE_MAX_QUEUE = 50;
let jukeServerN = 0;
/* Build 43: catch-up that actually catches up. The old blind 2.5s timer
   fired before the drift tap (relay not up yet), so the request died
   unheard and late joiners sat with an empty line. Now we ask only when
   the relay is live, and retry while we're still empty. */
let jukeSyncGen = 0; // bumps per server change; stale retry timers no-op
let jukeLastStateReqAt = 0;
function jukeMaybeSync() {
  try {
    if (!net || !net.relayMode) return; // relay first — earlier asks die unheard
    if (juke.now || juke.queue.length) return; // already holding the line
    const now = Date.now();
    if (now - jukeLastStateReqAt < 8000) return; // one ask per 8s, no storms
    jukeLastStateReqAt = now;
    if (net.sendJukeStateReq) {
      net.sendJukeStateReq({ reqId: 'srv-' + now.toString(36) });
    }
  } catch (e) {}
}
function jukeScheduleSync() {
  const gen = ++jukeSyncGen;
  for (const ms of [1500, 6000, 15000, 30000]) {
    setTimeout(() => { if (gen === jukeSyncGen) jukeMaybeSync(); }, ms);
  }
}
function syncJukeServer() {
  try {
    if (net && net.setJukeServer) net.setJukeServer(nexusServerKey(selectedServer));
  } catch (e) {}
  if (jukeServerN !== selectedServer) {
    jukeServerN = selectedServer;
    jukeLeaveServer(); // fresh party per server — no stale queue
    jukeResetElection(); // new server, new holder election
    jukeRestore(); // build 60: my last line on this server seeds the handoff
    jukeScheduleSync(); // ask the holder for the line; retries while empty
  }
}

/* ---------- build 43: server-held queue — holder election ----------
   The line belongs to the SERVER, not to whoever queued first. Every peer
   on the server channel says hello; the roster elects the holder by lowest
   election key (the parked peer first — it never sleeps — then lowest
   client id). The holder answers state requests and broadcasts the
   canonical line; everyone else drifts with it. If the holder leaves, its
   hellos expire and the next peer steps up — the line survives. */
const JUKE_HELLO_MS = 15000;
const JUKE_HELLO_TTL_MS = 40000;
const JUKE_CLAIM_MS = 10000;
const JUKE_SYNC_MS = 15000;
const jukeRoster = new Map(); // cid -> {name, park, key, lastSeen}
let jukeIAmHolder = false;
let jukeHolderCid = null;
let jukeHolderKey = null;
let jukeHolderName = '';
let jukeSyncRev = 0; // my outgoing snapshot revision (holder only)
let jukeSyncRevSeen = -1; // newest snapshot revision applied
let jukeHelloTimer = null;
let jukeClaimTimer = null;
let jukeSyncTimer = null;
let jukeLastClearAt = 0; // Date.now() of the last clear we applied — stale snapshots can't resurrect
/* Build 44: reliable adds. The relay mesh is best-effort broadcast — a page
   only hears the relays it's currently socketed to, so a one-shot jukeAdd
   can miss the holder (and the holder's repeating sync then wipes it from
   every phone but the adder's). The adder watches the holder's syncs: if its
   track isn't in the canonical line after a while, it re-sends until the
   holder confirms it. */
const jukePendingAck = new Map(); // id -> { track, sentAt, retries }
/* build 74: drop-reason counters — which gate in handleJukeAdd kills arrivals */
const jukeDrops = { srv: 0, valid: 0, playing: 0, dup: 0, full: 0 };
const JUKE_ACK_MS = 20000; // wait this long for the holder's sync to confirm
const JUKE_ACK_RETRIES = 8;
let jukeAckTimer = null;
const jukeRemovedIds = new Map(); // id -> Date.now() — stops a sync from resurrecting a pulled track
/* Build 53: holder handoff. Every peer remembers the last canonical line it
   accepted from the holder. When a new holder is elected, it asks the room
   for the line and inherits the freshest copy instead of broadcasting an
   empty one — an empty first sync used to wipe the queue off every phone
   while the song kept playing underneath. */
let jukeLastKnown = null; // {queue, now, at, rev} — last good canonical snapshot
let jukeHolderCatchingUp = false; // newly elected holder, still inheriting the line
let jukeHandoffTimer = null;
let jukeHandoffReqId = null;
let jukeHandoffAnswers = []; // {queue, now, at} collected during catch-up
const JUKE_HANDOFF_MS = 2500;
function jukeTrackPending(t) {
  try {
    if (!t || !t.id || jukeIAmHolder) return; // holder merges locally — already canonical
    jukePendingAck.set(t.id, { track: t, sentAt: Date.now(), retries: 0 });
  } catch (e) {}
}
/* One send path for user-queued tracks: broadcast + watch for the holder's ack. */
function jukeSendAdd(t) {
  try {
    if (net && net.enabled && net.sendJukeAdd) net.sendJukeAdd(t);
  } catch (e) { /* best effort — the ack timer retries */ }
  jukeTrackPending(t);
}
function jukeStartAckTimer() {
  if (jukeAckTimer) return;
  jukeAckTimer = setInterval(() => {
    try {
      if (!net || !net.enabled) return;
      const now = Date.now();
      // prune old remove tombstones
      for (const [id, at] of jukeRemovedIds) {
        if (now - at > 300000) jukeRemovedIds.delete(id);
      }
      if (!jukePendingAck.size) return;
      for (const [id, p] of jukePendingAck) {
        // user pulled it, or a clear took it — stop watching
        if (!juke.queue.some((t) => t.id === id) && !(juke.now && juke.now.id === id)) {
          jukePendingAck.delete(id);
          continue;
        }
        if (now - p.sentAt < JUKE_ACK_MS) continue;
        if (p.retries >= JUKE_ACK_RETRIES) {
          jukePendingAck.delete(id);
          jukeHint('the line didn\u2019t catch \u2018' + (p.track.title || 'that track') + '\u2019 \u2014 try queuing it again');
          continue;
        }
        p.retries++;
        p.sentAt = now;
        try { if (net.sendJukeAdd) net.sendJukeAdd(p.track); } catch (e) {}
      }
    } catch (e) {}
  }, 10000);
}

function jukeElectionKey(cid, park) {
  return (park ? '0:' : '1:') + String(cid || '');
}
function jukeMyElectionKey() {
  let cid = '';
  try { cid = (net && net.clientId) || ''; } catch (e) {}
  return jukeElectionKey(cid, IS_PARK_HOLDER);
}
/* Build 43: every jukebox payload carries its server key (stamped in
   net.js). Drop anything from another server — a pre-relay world-room
   broadcast can never contaminate a different server's line. Payloads
   from older builds lack srv and are accepted (mixed rollout). */
function jukeSrvOk(d) {
  try {
    if (!d || d.srv == null) return true;
    return String(d.srv) === nexusServerKey(selectedServer);
  } catch (e) { return true; }
}
function jukeSweepRoster() {
  const now = Date.now();
  for (const [cid, rec] of jukeRoster) {
    if (now - rec.lastSeen > JUKE_HELLO_TTL_MS) jukeRoster.delete(cid);
  }
}
function jukeRecomputeHolder() {
  jukeSweepRoster();
  const myKey = jukeMyElectionKey();
  let lowest = myKey;
  let lowestCid = null;
  try {
    for (const [cid, rec] of jukeRoster) {
      if (rec.key < lowest) { lowest = rec.key; lowestCid = cid; }
    }
  } catch (e) {}
  const prevCid = jukeHolderCid;
  if (lowestCid === null) {
    if (!jukeIAmHolder) jukeBecomeHolder();
    else {
      try { jukeHolderCid = (net && net.clientId) || null; } catch (e) {}
      jukeHolderKey = myKey;
      jukeHolderName = (typeof myName === 'string' && myName) || 'drifter';
    }
  } else {
    if (jukeIAmHolder) jukeStepDown();
    jukeHolderCid = lowestCid;
    jukeHolderKey = lowest;
    const rec = jukeRoster.get(lowestCid);
    jukeHolderName = (rec && rec.name) || 'a drifter';
  }
  if (String(prevCid || '') !== String(jukeHolderCid || '')) jukeSyncRevSeen = -1; // new holder, fresh revisions
  renderJukeHolder();
}
function jukeBecomeHolder() {
  jukeIAmHolder = true;
  try { jukePendingAck.clear(); } catch (e) {} // build 44: my line is canonical now
  try { jukeHolderCid = (net && net.clientId) || null; } catch (e) {}
  jukeHolderKey = jukeMyElectionKey();
  jukeHolderName = (typeof myName === 'string' && myName) || 'drifter';
  jukeSyncRev = 0;
  jukeBroadcastClaim();
  if (jukeClaimTimer) clearInterval(jukeClaimTimer);
  jukeClaimTimer = setInterval(() => { try { jukeBroadcastClaim(); } catch (e) {} }, JUKE_CLAIM_MS);
  /* Build 53: don't claim the line empty — ask the room for it first. The
     sync timer starts once the handoff finishes. */
  jukeHolderCatchingUp = true;
  jukeHandoffAnswers = [];
  jukeHandoffReqId = 'handoff-' + Date.now().toString(36);
  try { if (net && net.sendJukeStateReq) net.sendJukeStateReq({ reqId: jukeHandoffReqId }); } catch (e) {}
  if (jukeHandoffTimer) clearTimeout(jukeHandoffTimer);
  jukeHandoffTimer = setTimeout(() => { try { jukeFinishHandoff(); } catch (e) {} }, JUKE_HANDOFF_MS);
  if (jukeSyncTimer) clearInterval(jukeSyncTimer);
}
function jukeFinishHandoff() {
  if (jukeHandoffTimer) { clearTimeout(jukeHandoffTimer); jukeHandoffTimer = null; }
  if (!jukeIAmHolder) { jukeHolderCatchingUp = false; return; }
  jukeHolderCatchingUp = false;
  // freshest wins: answers, my remembered line, then my local state
  let best = null;
  const consider = (q, n, at) => {
    const has = (Array.isArray(q) && q.length) || (n && !n.stopped);
    if (!has) return;
    if (!best || (at || 0) > (best.at || 0)) best = { queue: q, now: n, at: at || 0 };
  };
  for (const a of jukeHandoffAnswers) consider(a.queue, a.now, a.at);
  if (jukeLastKnown) consider(jukeLastKnown.queue, jukeLastKnown.now, jukeLastKnown.at);
  consider(juke.queue, juke.now, Date.now());
  if (best) {
    juke.queue = (Array.isArray(best.queue) ? best.queue : []).filter(jukeValidAdd).slice(0, JUKE_MAX_QUEUE);
    jukeSortQueue();
    const bn = best.now;
    if (bn && jukeValidPlay(bn) && !bn.stopped && (!juke.now || juke.now.id !== bn.id)) {
      jukeAdoptPlay(bn); // offset math puts us in sync mid-track
    }
    renderJuke();
  }
  jukeBroadcastSync(); // the inherited line is canonical now
  jukeSyncTimer = setInterval(() => { try { jukeBroadcastSync(); } catch (e) {} }, JUKE_SYNC_MS);
}
function jukeStepDown() {
  jukeIAmHolder = false;
  jukeHolderCatchingUp = false; // build 53: a stepped-down catch-up never finishes
  if (jukeHandoffTimer) { clearTimeout(jukeHandoffTimer); jukeHandoffTimer = null; }
  if (jukeClaimTimer) { clearInterval(jukeClaimTimer); jukeClaimTimer = null; }
  if (jukeSyncTimer) { clearInterval(jukeSyncTimer); jukeSyncTimer = null; }
}
function jukeResetElection() {
  jukeStepDown();
  jukeRoster.clear();
  jukeLastKnown = null; // build 53: fresh server, fresh line
  jukeHolderCid = null;
  jukeHolderKey = null;
  jukeHolderName = '';
  jukeSyncRev = 0;
  jukeSyncRevSeen = -1;
  renderJukeHolder();
}
function jukeBroadcastClaim() {
  try {
    if (net && net.sendJukeClaim) {
      net.sendJukeClaim({ name: (typeof myName === 'string' && myName) || 'drifter', park: IS_PARK_HOLDER });
    }
  } catch (e) {}
}
/* The canonical line, from the holder. Periodic + on every mutation, so
   any drift between phones heals within seconds. */
/* Build 60: the line survives a leave-and-return. Persisted per-server to
   localStorage on every canonical change; on (re)join the persisted line
   seeds jukeLastKnown so the holder handoff inherits it. Fresher peer
   data always wins over the persisted snapshot. */
function jukePersistKey() {
  try { return 'limbo-juke-' + nexusServerKey(selectedServer); } catch (e) { return null; }
}
function jukePersist() {
  try {
    const key = jukePersistKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify({
      queue: (juke.queue || []).slice(0, JUKE_MAX_QUEUE),
      now: juke.now || null,
      at: Date.now(),
    }));
  } catch (e) {}
}
function jukeRestore() {
  try {
    const key = jukePersistKey();
    if (!key) return;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d) return;
    /* phone-file tracks can't survive a reload (bytes are in-memory only),
       so they're dropped on restore rather than resurrected as dead entries. */
    const q = (Array.isArray(d.queue) ? d.queue : [])
      .filter((t) => t && t.provider !== 'phone-file')
      .filter(jukeValidAdd).slice(0, JUKE_MAX_QUEUE);
    const n = (d.now && d.now.provider !== 'phone-file' && jukeValidPlay(d.now) && !d.now.stopped) ? d.now : null;
    if (!q.length && !n) return; // nothing worth remembering
    jukeLastKnown = { queue: q, now: n, at: d.at || Date.now(), rev: -1 };
  } catch (e) {}
}
function jukeBroadcastSync() {
  try {
    if (!net || !net.sendJukeSync) return;
    jukeSyncRev++;
    net.sendJukeSync({
      rev: jukeSyncRev,
      at: Date.now(), // snapshot build time — receivers drop anything older than their last clear
      park: IS_PARK_HOLDER,
      name: (typeof myName === 'string' && myName) || 'drifter',
      queue: juke.queue.slice(0, JUKE_MAX_QUEUE),
      now: juke.now,
    });
  } catch (e) {}
  jukePersist(); // build 60: holder's canonical line survives a leave-and-return
}
function jukeNotePeer(cid, d) {
  const id = String(cid || '');
  if (!id) return;
  const park = !!(d && d.park);
  jukeRoster.set(id, {
    name: (d && d.name) || 'a drifter',
    park,
    key: jukeElectionKey(id, park),
    lastSeen: Date.now(),
  });
  jukeRecomputeHolder();
}
/* Say hello on the server channel; starts once the relay is up. */
function jukeHelloTick() {
  try {
    if (net && net.relayMode && net.sendJukeHello) {
      net.sendJukeHello({ name: (typeof myName === 'string' && myName) || 'drifter', park: IS_PARK_HOLDER });
    }
  } catch (e) {}
  jukeRecomputeHolder();
}
function jukeStartHellos() {
  if (jukeHelloTimer) return;
  jukeHelloTick();
  jukeHelloTimer = setInterval(() => { try { jukeHelloTick(); } catch (e) {} }, JUKE_HELLO_MS);
  jukeStartAckTimer(); // build 44: retry loop for unconfirmed adds
}
let jukeHolderEl = null;
function renderJukeHolder() {
  try {
    if (!jukeHolderEl) jukeHolderEl = document.getElementById('juke-holder');
    if (!jukeHolderEl) return;
    jukeHolderEl.textContent =
      jukeIAmHolder ? '· holding the line'
      : jukeHolderName ? '· line held by ' + jukeHolderName
      : '';
  } catch (e) {}
}
function handleJukeHello(peerId, d) {
  if (!jukeSrvOk(d)) return;
  jukeNotePeer(peerId, d);
}
function handleJukeClaim(peerId, d) {
  if (!jukeSrvOk(d)) return;
  jukeNotePeer(peerId, d); // a claim is a hello with authority
}
/* Canonical snapshot from the holder. A sync doubles as a claim — the
   sender is alive and asserting the line. */
function handleJukeSync(peerId, d) {
  if (!jukeSrvOk(d) || !d || typeof d.rev !== 'number') return;
  const cid = String(peerId || '');
  if (!cid) return;
  const park = !!d.park;
  jukeRoster.set(cid, {
    name: d.name || 'a drifter', park,
    key: jukeElectionKey(cid, park), lastSeen: Date.now(),
  });
  jukeRecomputeHolder();
  if (!jukeHolderCid || cid !== String(jukeHolderCid)) return; // not the elected holder — stale chatter
  if (d.rev <= jukeSyncRevSeen) return; // stale snapshot
  if (d.at && jukeLastClearAt && d.at < jukeLastClearAt - 5000) return; // built before our clear — can't resurrect
  jukeSyncRevSeen = d.rev;
  const incoming = Array.isArray(d.queue) ? d.queue.filter(jukeValidAdd) : [];
  const incomingIds = new Set(incoming.map((t) => t.id));
  /* Build 44: ack pending adds against the canonical line — the holder's
     sync including my track is the delivery confirmation. */
  if (jukePendingAck.size) {
    for (const id of [...jukePendingAck.keys()]) {
      if (incomingIds.has(id)) jukePendingAck.delete(id);
    }
  }
  /* Keep my own just-added tracks the snapshot hasn't seen yet — my add
     broadcast is still in flight and will merge into the canonical line
     on the next round (dedupe by id keeps it single). */
  const mine = juke.queue.filter((t) => t.addedBy === myName && !incomingIds.has(t.id));
  const mineIds = new Set(mine.map((t) => t.id));
  /* Build 44: don't let a holder snapshot that hasn't seen a fresh add yet
     wipe it from the room. Tracks added in the last minute that the snapshot
     is missing stay as unconfirmed — the adder's retry gets them to the
     holder, and the next snapshot confirms them. Pulled tracks and anything
     older than the last clear are never resurrected. */
  const nowTs = Date.now();
  const unconfirmed = juke.queue.filter((t) =>
    t && !incomingIds.has(t.id) && !mineIds.has(t.id) &&
    typeof t.addedAt === 'number' && (nowTs - t.addedAt) < 60000 &&
    !(jukeLastClearAt && t.addedAt < jukeLastClearAt - 5000) &&
    !jukeRemovedIds.has(t.id)
  );
  juke.queue = incoming.concat(mine).concat(unconfirmed).slice(0, JUKE_MAX_QUEUE);
  jukeSortQueue();
  const dn = d.now;
  /* Build 53: remember the canonical line — if this holder leaves, the next
     one inherits it instead of starting empty. Only a line with something
     in it overwrites the memory; an empty snapshot never erases a good one. */
  if (incoming.length || (dn && jukeValidPlay(dn) && !dn.stopped)) {
    jukeLastKnown = {
      queue: incoming.slice(0, JUKE_MAX_QUEUE),
      now: (dn && jukeValidPlay(dn) && !dn.stopped) ? dn : null,
      at: d.at || Date.now(), rev: d.rev,
    };
  }
  if (dn && jukeValidPlay(dn) && !dn.stopped) {
    if (!juke.now || juke.now.id !== dn.id) jukeAdoptPlay(dn); // holder's line rules
  }
  /* A null now in a snapshot never stops local playback — real stops and
     clears arrive as their own broadcasts (jukePlay stopped / jukeClear),
     so a snapshot racing a just-advanced track can't mute it. */
  renderJuke();
  jukePersist(); // build 60: converged line survives a leave-and-return
}
/* Build 43: anyone in the server can clear the line. The clear lands
   locally at once, and the holder rebroadcasts the empty canonical
   state so every phone converges on empty. */
function jukeClearQueue() {
  jukeStopPlayback();
  juke.now = null;
  juke.queue = [];
  jukeLastKnown = null; // build 53: an explicit clear really is empty
  jukeLastClearAt = Date.now();
  try { jukePendingAck.clear(); } catch (e) {} // build 44: the line is gone — stop retrying
  renderJuke();
  jukeHint('the line is clear — drift on');
  jukePersist(); // build 60: the cleared line stays cleared on return
  try {
    if (net && net.enabled && net.sendJukeClear) {
      net.sendJukeClear({ by: (typeof myName === 'string' && myName) || 'drifter' });
    }
  } catch (e) {}
  if (jukeIAmHolder) jukeBroadcastSync();
}
function handleJukeClear(peerId, d) {
  if (!jukeSrvOk(d)) return;
  jukeStopPlayback();
  juke.now = null;
  juke.queue = [];
  jukeLastKnown = null; // build 53: an explicit clear really is empty
  jukeLastClearAt = Date.now();
  try { jukePendingAck.clear(); } catch (e) {} // build 44: the line is gone — stop retrying
  renderJuke();
  jukeHint('the line was cleared by ' + ((d && d.by) || 'a drifter'));
  jukePersist(); // build 60: the cleared line stays cleared on return
  if (jukeIAmHolder) jukeBroadcastSync();
}
function pickServer(n) {
  n = Math.max(1, Math.min(NEXUS_SERVERS, +n || 1));
  selectedServer = n;
  serverListTouched = true;
  renderServerList();
  syncJukeServer();
}
function serverCount(n) {
  const key = nexusServerKey(n);
  let c = 0;
  for (const [, p] of net.lobbyPeers) if (p.room === key) c++;
  return c;
}
/* What our lobby heartbeat advertises: the full server room key in the
   Nexus, the plain world key everywhere else. */
function presenceKeyFor(worldKey) {
  return worldKey === 'nexus' ? nexusServerKey(selectedServer) : worldKey;
}

/* ---------------- tiny utils ---------------- */

// Deterministic RNG so echo layouts are stable between visits.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft radial glow texture, tinted per-use via material color.
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Floating text sprite (portal labels). Thin, tracked, elegant.
function makeLabel(text, size = 44) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = `300 ${size}px system-ui, -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  try { g.letterSpacing = '14px'; } catch (e) { /* older browsers */ }
  g.fillStyle = 'rgba(235,240,255,0.85)';
  g.shadowColor = 'rgba(150,190,255,0.8)';
  g.shadowBlur = 18;
  g.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(9, 2.25, 1);
  return sp;
}

/* ---------------- renderer / camera ---------------- */

// If WebGL is unavailable (old browser, headless test rig) the constructor
// throws — show a message instead of leaving a dead "loading…" screen.
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (err) {
  loadingEl.firstElementChild.textContent = 'limbo needs WebGL — try another browser';
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 600);
const clock = new THREE.Clock();
const glowTex = makeGlowTexture();
const audio = new AudioEngine();

/* ---------------- player: the wisp ---------------- */

const wisp = new THREE.Group();
const wispCore = new THREE.Mesh(
  new THREE.SphereGeometry(0.32, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0xeaf6ff })
);
const wispGlow = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: glowTex, color: 0x9fd8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
);
wispGlow.scale.set(3.2, 3.2, 1);
const wispLight = new THREE.PointLight(0xaad4ff, 50, 45, 1.8);
wisp.add(wispCore, wispGlow, wispLight);

const vel = new THREE.Vector3();   // wisp velocity (dreamy inertia)
let yaw = 0, pitch = -0.05;        // look direction

/* ---------------- trails ----------------
   Three earnable styles, all cheap CPU point buffers with additive
   blending (head bright -> tail black = invisible):
   - ribbon: the classic fading point trail (default)
   - comet: sparkles emitted along the path that drift and fade out
   - ghost: two wide soft ribbons weaving side to side (dreamy)
   makeTrail(n, sizeScale) -> { group, setStyle, setColor, update, clear }.
   The local wisp gets a full 60-segment trail; remote drifters get a
   shorter 24-segment one (hidden beyond 150m for perf). */

const TRAIL_STYLES = {
  ribbon: { name: 'Ribbon', req: null },
  comet:  { name: 'Comet',  req: 'collect 10 echoes' },
  ghost:  { name: 'Ghost',  req: 'attune 2 realms' },
};
const TRAIL_COLORS = {
  white: { name: 'Moonlight', hex: 0xbfe2ff, req: null },
  prism: { name: 'Prism',     hex: 0xff4fd8, req: 'attune PRISM DEEP' },
  tide:  { name: 'Tide',      hex: 0x7a5cff, req: 'attune MIRROR TIDE' },
  volt:  { name: 'Volt',      hex: 0x37e6ff, req: 'attune CHROME VEIL' },
  sage:  { name: 'Sage',      hex: 0x2dffb3, req: 'attune STILL POINT' },
  gold:  { name: 'Gold',      hex: 0xffe9a8, req: 'attune all 4 realms' },
};
const TRAIL_STYLE_ORDER = ['ribbon', 'comet', 'ghost'];
const TRAIL_COLOR_ORDER = ['white', 'prism', 'tide', 'volt', 'sage', 'gold'];
const REALM_TRAIL_COLOR = { realm1: 'prism', realm2: 'tide', realm3: 'volt', realm4: 'sage' };

function makeTrail(n, sizeScale) {
  const group = new THREE.Group();
  const color = new THREE.Color(0xbfe2ff);
  let style = 'ribbon';

  function fadeInto(arr) {
    for (let i = 0; i < n; i++) {
      const f = Math.pow(i / (n - 1), 1.6); // i=0 tail .. i=n-1 head
      arr[i * 3] = color.r * f;
      arr[i * 3 + 1] = color.g * f;
      arr[i * 3 + 2] = color.b * f;
    }
  }
  function ribbonPoints(size, opacity) {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    fadeInto(col);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size: size * sizeScale, vertexColors: true, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.frustumCulled = false;
    return { pts, pos, col, geo };
  }

  const R = ribbonPoints(0.45, 0.85);          // ribbon style
  const G1 = ribbonPoints(0.9, 0.35);          // ghost: left weave
  const G2 = ribbonPoints(0.9, 0.35);          // ghost: right weave

  // comet: n sparkles, each with velocity + remaining life
  const cPos = new Float32Array(n * 3), cCol = new Float32Array(n * 3);
  const cVel = new Float32Array(n * 3), cLife = new Float32Array(n);
  const COMET_LIFE = 0.9;
  let cCursor = 0, cEmitT = 0;
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
  cGeo.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
  const comet = new THREE.Points(cGeo, new THREE.PointsMaterial({
    size: 0.3 * sizeScale, vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  comet.frustumCulled = false;

  group.add(R.pts, G1.pts, G2.pts, comet);

  let pushT = 0, tG = 0;

  function pushRibbon(P, x, y, z) {
    P.pos.copyWithin(0, 3); // drop oldest
    const o = (n - 1) * 3;
    P.pos[o] = x; P.pos[o + 1] = y; P.pos[o + 2] = z;
    P.geo.attributes.position.needsUpdate = true;
  }

  function setStyle(s) {
    style = TRAIL_STYLES[s] ? s : 'ribbon';
    R.pts.visible = style === 'ribbon';
    comet.visible = style === 'comet';
    G1.pts.visible = G2.pts.visible = style === 'ghost';
  }
  function setColor(hex) {
    color.setHex(hex);
    for (const P of [R, G1, G2]) { fadeInto(P.col); P.geo.attributes.color.needsUpdate = true; }
    // comet particles re-tint live from `color` as they fade
  }
  function clear(pos) {
    for (const P of [R, G1, G2]) {
      for (let i = 0; i < n; i++) { P.pos[i * 3] = pos.x; P.pos[i * 3 + 1] = pos.y; P.pos[i * 3 + 2] = pos.z; }
      P.geo.attributes.position.needsUpdate = true;
    }
    cLife.fill(0); cCol.fill(0);
    cGeo.attributes.position.needsUpdate = true;
    cGeo.attributes.color.needsUpdate = true;
  }
  function update(pos, dt) {
    tG += dt;
    if (style === 'ribbon') {
      pushT += dt;
      if (pushT < 0.035) return;
      pushT = 0;
      pushRibbon(R, pos.x, pos.y, pos.z);
    } else if (style === 'comet') {
      cEmitT += dt;
      while (cEmitT > 0.05) {
        cEmitT -= 0.05;
        const i = cCursor; cCursor = (cCursor + 1) % n;
        cPos[i * 3] = pos.x; cPos[i * 3 + 1] = pos.y; cPos[i * 3 + 2] = pos.z;
        const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.4;
        cVel[i * 3] = Math.cos(a) * sp;
        cVel[i * 3 + 1] = (Math.random() - 0.2) * 1.2;
        cVel[i * 3 + 2] = Math.sin(a) * sp;
        cLife[i] = COMET_LIFE;
      }
      const drag = Math.max(0, 1 - dt * 1.5);
      for (let i = 0; i < n; i++) {
        if (cLife[i] <= 0) continue;
        cLife[i] -= dt;
        const f = Math.max(cLife[i], 0) / COMET_LIFE;
        cPos[i * 3] += cVel[i * 3] * dt;
        cPos[i * 3 + 1] += cVel[i * 3 + 1] * dt;
        cPos[i * 3 + 2] += cVel[i * 3 + 2] * dt;
        cVel[i * 3] *= drag; cVel[i * 3 + 1] *= drag; cVel[i * 3 + 2] *= drag;
        cCol[i * 3] = color.r * f; cCol[i * 3 + 1] = color.g * f; cCol[i * 3 + 2] = color.b * f;
      }
      cGeo.attributes.position.needsUpdate = true;
      cGeo.attributes.color.needsUpdate = true;
    } else { // ghost: two soft ribbons with a slow lateral weave
      pushT += dt;
      if (pushT < 0.05) return;
      pushT = 0;
      const wx = Math.cos(tG * 1.3) * 0.55, wz = Math.sin(tG * 1.3) * 0.55;
      pushRibbon(G1, pos.x + wx, pos.y, pos.z + wz);
      pushRibbon(G2, pos.x - wx, pos.y, pos.z - wz);
    }
  }

  setStyle('ribbon');

  /* Build 41: audio reactivity — the trail breathes with the room's low
     end (jam bus + direct-audio jukebox through roomBassSmooth). v ~ 0..1. */
  let pulse = 0;
  function setPulse(v) {
    pulse = Math.max(0, Math.min(1.5, Number(v) || 0));
    const s = (1 + pulse * 0.9) * sizeScale;
    try {
      R.pts.material.size = 0.45 * s;
      G1.pts.material.size = 0.9 * s;
      G2.pts.material.size = 0.9 * s;
      comet.material.size = 0.3 * s;
      const o = Math.min(1, 0.8 + pulse * 0.2);
      R.pts.material.opacity = o;
      G1.pts.material.opacity = o;
      G2.pts.material.opacity = o;
    } catch (e) {}
  }
  return { group, setStyle, setColor, setPulse, update, clear, getStyle: () => style };
}
const localTrail = makeTrail(60, 1);
function retintTrail(hex) { localTrail.setColor(hex); }
function clearTrail() { localTrail.clear(wisp.position); }
function pushTrail(dt) { localTrail.update(wisp.position, dt); }

/* ---------------- wisp customization: skins & hats ----------------
   Attuning a realm (all 5 echoes) unlocks cosmetics. Unlocks + equipped
   look persist in localStorage; the equipped look broadcasts to other
   drifters ~12Hz so remote wisps render with the right skin + hat. */

const SKINS = {
  drifter:    { name: 'Drifter',    core: 0xeaf6ff, glow: 0x9fd8ff, light: 0xaad4ff, trail: 0xbfe2ff, req: null },
  prism:      { name: 'Prism',      core: 0xffd9f2, glow: 0xff4fd8, light: 0xff4fd8, trail: 0xff8fdc, req: 'attune PRISM DEEP' },
  tide:       { name: 'Tide',       core: 0xded4ff, glow: 0x7a5cff, light: 0x7a5cff, trail: 0x9d86ff, req: 'attune MIRROR TIDE' },
  volt:       { name: 'Volt',       core: 0xd4f7ff, glow: 0x37e6ff, light: 0x37e6ff, trail: 0x6fe8ff, req: 'attune CHROME VEIL' },
  sage:       { name: 'Sage',       core: 0xd6ffea, glow: 0x2dffb3, light: 0x2dffb3, trail: 0x66ffbe, req: 'attune STILL POINT' },
  voidwalker: { name: 'Voidwalker', core: 0xfff9e8, glow: 0xffe9a8, light: 0xffdf8a, trail: 0xffe9a8, req: 'attune all 4 realms' },
};
const HATS = {
  none:  { name: 'Bare',      req: null },
  party: { name: 'Party Hat', req: 'attune 1 realm' },
  top:   { name: 'Top Hat',   req: 'attune 2 realms' },
  crown: { name: 'Crown',     req: 'attune all 4 realms' },
};
const REALM_SKIN = { realm1: 'prism', realm2: 'tide', realm3: 'volt', realm4: 'sage' };
const SKIN_ORDER = ['drifter', 'prism', 'tide', 'volt', 'sage', 'voidwalker'];
const HAT_ORDER = ['none', 'party', 'top', 'crown'];

// limbo_unlocks: { attuned:[realmKeys], skins:[ids], hats:[ids], trailStyles:[ids], trailColors:[ids] }
// limbo_wisp:   { skin, hat, trailStyle, trailColor } — equipped look
function loadUnlocks() {
  const d = { attuned: [], skins: ['drifter'], hats: [], trailStyles: ['ribbon'], trailColors: ['white'] };
  try {
    const raw = JSON.parse(localStorage.getItem('limbo_unlocks') || 'null');
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.attuned)) d.attuned = raw.attuned.filter((k) => REALM_DEFS.some((r) => r.key === k));
      if (Array.isArray(raw.skins)) d.skins = ['drifter', ...raw.skins.filter((s) => SKINS[s] && s !== 'drifter')];
      if (Array.isArray(raw.hats)) d.hats = raw.hats.filter((h) => HATS[h] && h !== 'none');
      if (Array.isArray(raw.trailStyles)) d.trailStyles = ['ribbon', ...raw.trailStyles.filter((t) => TRAIL_STYLES[t] && t !== 'ribbon')];
      if (Array.isArray(raw.trailColors)) d.trailColors = ['white', ...raw.trailColors.filter((t) => TRAIL_COLORS[t] && t !== 'white')];
    }
  } catch (e) { /* ignore — defaults */ }
  return d;
}
function saveUnlocks() {
  try { localStorage.setItem('limbo_unlocks', JSON.stringify(unlocks)); } catch (e) { /* ignore */ }
}
function loadWisp() {
  const d = { skin: 'drifter', hat: 'none', trailStyle: 'ribbon', trailColor: 'white' };
  try {
    const raw = JSON.parse(localStorage.getItem('limbo_wisp') || 'null');
    if (raw && SKINS[raw.skin]) d.skin = raw.skin;
    if (raw && HATS[raw.hat]) d.hat = raw.hat;
    if (raw && TRAIL_STYLES[raw.trailStyle]) d.trailStyle = raw.trailStyle;
    if (raw && TRAIL_COLORS[raw.trailColor]) d.trailColor = raw.trailColor;
  } catch (e) { /* ignore — defaults */ }
  return d;
}
function saveWisp() {
  try { localStorage.setItem('limbo_wisp', JSON.stringify(equipped)); } catch (e) { /* ignore */ }
}
let unlocks = loadUnlocks();
let equipped = loadWisp();

function applySkin(skinId) {
  const s = SKINS[skinId] || SKINS.drifter;
  wispCore.material.color.setHex(s.core);
  wispGlow.material.color.setHex(s.glow);
  wispLight.color.setHex(s.light);
  // Trail color is its own customization now (applyTrail) — skins no longer re-tint it.
}

// Dress the local trail in the equipped style + color.
function applyTrail() {
  localTrail.setStyle(equipped.trailStyle);
  const c = TRAIL_COLORS[equipped.trailColor] || TRAIL_COLORS.white;
  localTrail.setColor(c.hex);
}

function buildHat(hatId) {
  const g = new THREE.Group();
  if (hatId === 'party') {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.5, 20),
      new THREE.MeshBasicMaterial({ color: 0xff4fd8 })
    );
    cone.position.y = 0.25;
    const pompom = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
    );
    pompom.position.y = 0.53;
    g.add(cone, pompom);
  } else if (hatId === 'top') {
    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.05, 24),
      new THREE.MeshBasicMaterial({ color: 0x1a1d26 })
    );
    const crownM = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.42, 24),
      new THREE.MeshBasicMaterial({ color: 0x23262f })
    );
    crownM.position.y = 0.23;
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.205, 0.205, 0.08, 24),
      new THREE.MeshBasicMaterial({ color: 0x7a5cff })
    );
    band.position.y = 0.07;
    g.add(brim, crownM, band);
  } else if (hatId === 'crown') {
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.26, 0.18, 24),
      new THREE.MeshBasicMaterial({ color: 0xd9a441 })
    );
    band.position.y = 0.09;
    g.add(band);
    for (let i = 0; i < 6; i++) {
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.055, 0.22, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
      );
      const a = (i / 6) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.22, 0.28, Math.sin(a) * 0.22);
      g.add(spike);
    }
  }
  return g;
}

let wispHat = null;
function applyHat(hatId) {
  if (wispHat) { wisp.remove(wispHat); wispHat = null; }
  if (hatId && hatId !== 'none' && HATS[hatId]) {
    wispHat = buildHat(hatId);
    wispHat.position.y = 0.42; // sits atop the 0.32-radius core
    wisp.add(wispHat);
  }
}

function showUnlockToast(lines) {
  if (!unlockToastEl || !lines.length) return;
  unlockToastEl.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    unlockToastEl.appendChild(div);
  }
  unlockToastEl.classList.remove('show');
  void unlockToastEl.offsetWidth; // restart CSS animation
  unlockToastEl.classList.add('show');
}

// Called the moment a realm attunes (all 5 echoes). Grants are idempotent —
// re-attuning across sessions replays the shimmer but not the unlock toast.
function onRealmAttuned(realmKey, realmName) {
  const isNew = !unlocks.attuned.includes(realmKey);
  if (isNew) unlocks.attuned.push(realmKey);
  const fresh = [];
  const skinId = REALM_SKIN[realmKey];
  if (skinId && !unlocks.skins.includes(skinId)) {
    unlocks.skins.push(skinId);
    fresh.push(`${SKINS[skinId].name} skin unlocked`);
  }
  const n = unlocks.attuned.length;
  for (const [hatId, need] of [['party', 1], ['top', 2], ['crown', 4]]) {
    if (n >= need && !unlocks.hats.includes(hatId)) {
      unlocks.hats.push(hatId);
      fresh.push(`${HATS[hatId].name} unlocked`);
    }
  }
  if (n >= 4 && !unlocks.skins.includes('voidwalker')) {
    unlocks.skins.push('voidwalker');
    fresh.push('Voidwalker skin unlocked');
  }
  const tc = REALM_TRAIL_COLOR[realmKey];
  if (tc && !unlocks.trailColors.includes(tc)) {
    unlocks.trailColors.push(tc);
    fresh.push(`${TRAIL_COLORS[tc].name} trail unlocked`);
  }
  if (n >= 2 && !unlocks.trailStyles.includes('ghost')) {
    unlocks.trailStyles.push('ghost');
    fresh.push('Ghost trail unlocked');
  }
  if (n >= 4 && !unlocks.trailColors.includes('gold')) {
    unlocks.trailColors.push('gold');
    fresh.push('Gold trail unlocked');
  }
  saveUnlocks();
  if (fresh.length) {
    const printTitle = (REALM_PRINT[realmKey] && REALM_PRINT[realmKey].title) || '';
    const lines = [`${realmName} attuned`, ...fresh];
    if (printTitle) lines.push(`own "${printTitle}" — PRINTS in settings`);
    showUnlockToast(lines);
    addSystemLine(`${realmName} attuned — ${fresh.join(' · ').toLowerCase()}`);
  }
  renderWispSection();
  renderPrintsSection();
}

// Settings panel "WISP" section: skin swatches + hat buttons + trail styles
// + trail colors. Locked items show their requirement; tapping an owned
// item equips it immediately.
function renderWispSection() {
  if (!wispSkinsEl || !wispHatsEl || !wispTrailStylesEl || !wispTrailColorsEl) return;
  wispSkinsEl.innerHTML = '';
  for (const id of SKIN_ORDER) {
    const s = SKINS[id];
    const owned = unlocks.skins.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-swatch' + (equipped.skin === id ? ' equipped' : '') + (owned ? '' : ' locked');
    const hex = '#' + s.glow.toString(16).padStart(6, '0');
    b.style.setProperty('--sw', owned ? hex : '#3a4152');
    b.title = owned ? s.name : `${s.name} — ${s.req}`;
    b.setAttribute('aria-label', b.title);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = owned ? s.name : s.req;
    b.append(dot, lbl);
    if (owned) b.addEventListener('click', () => {
      equipped.skin = id; saveWisp(); applySkin(id); renderWispSection(); b.blur();
    });
    wispSkinsEl.appendChild(b);
  }
  wispHatsEl.innerHTML = '';
  for (const id of HAT_ORDER) {
    const h = HATS[id];
    const owned = id === 'none' || unlocks.hats.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-hat' + (equipped.hat === id ? ' equipped' : '') + (owned ? '' : ' locked');
    b.title = owned ? h.name : `${h.name} — ${h.req}`;
    b.setAttribute('aria-label', b.title);
    b.textContent = owned ? h.name : h.req;
    if (owned) b.addEventListener('click', () => {
      equipped.hat = id; saveWisp(); applyHat(id); renderWispSection(); b.blur();
    });
    wispHatsEl.appendChild(b);
  }
  wispTrailStylesEl.innerHTML = '';
  for (const id of TRAIL_STYLE_ORDER) {
    const ts = TRAIL_STYLES[id];
    const owned = unlocks.trailStyles.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-hat' + (equipped.trailStyle === id ? ' equipped' : '') + (owned ? '' : ' locked');
    b.title = owned ? ts.name : `${ts.name} — ${ts.req}`;
    b.setAttribute('aria-label', b.title);
    b.textContent = owned ? ts.name : ts.req;
    if (owned) b.addEventListener('click', () => {
      equipped.trailStyle = id; saveWisp(); applyTrail(); renderWispSection(); b.blur();
    });
    wispTrailStylesEl.appendChild(b);
  }
  wispTrailColorsEl.innerHTML = '';
  for (const id of TRAIL_COLOR_ORDER) {
    const tc = TRAIL_COLORS[id];
    const owned = unlocks.trailColors.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-swatch' + (equipped.trailColor === id ? ' equipped' : '') + (owned ? '' : ' locked');
    const hex = '#' + tc.hex.toString(16).padStart(6, '0');
    b.style.setProperty('--sw', owned ? hex : '#3a4152');
    b.title = owned ? tc.name : `${tc.name} — ${tc.req}`;
    b.setAttribute('aria-label', b.title);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = owned ? tc.name : tc.req;
    b.append(dot, lbl);
    if (owned) b.addEventListener('click', () => {
      equipped.trailColor = id; saveWisp(); applyTrail(); renderWispSection(); b.blur();
    });
    wispTrailColorsEl.appendChild(b);
  }
}

// Settings panel "PRINTS" section: each realm's artwork as a real giclée
// print. Attuned realms get a small ✓. Buttons open the shop in a new tab.
function renderPrintsSection() {
  if (!printsListEl) return;
  printsListEl.innerHTML = '';
  for (const r of REALM_DEFS) {
    const p = REALM_PRINT[r.key];
    if (!p) continue;
    const row = document.createElement('div');
    row.className = 'print-row';
    const dot = document.createElement('span');
    dot.className = 'print-dot';
    dot.style.background = '#' + r.accent.toString(16).padStart(6, '0');
    const label = document.createElement('span');
    label.className = 'print-title';
    const attuned = unlocks.attuned.includes(r.key);
    label.textContent = (attuned ? '✓ ' : '') + p.title;
    const btn = document.createElement('button');
    btn.className = 'print-btn';
    btn.textContent = 'own the print';
    btn.addEventListener('click', () => {
      window.open(printUrl(r.key), '_blank', 'noopener');
      btn.blur();
    });
    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(btn);
    printsListEl.appendChild(row);
  }
}

/* ---------------- friends + live presence (build 11) ----------------
   Friends are just names in localStorage ('limbo_friends'). "Live" means
   we recently heard their heartbeat in the lobby room. The join button
   portals to their realm through the same goTo() the Nexus portals use. */

let friends = [];
try {
  const rawFriends = JSON.parse(localStorage.getItem('limbo_friends') || '[]');
  if (Array.isArray(rawFriends)) {
    friends = rawFriends
      .filter((n) => typeof n === 'string')
      .map((n) => n.trim().slice(0, 16))
      .filter(Boolean);
  }
} catch (e) { friends = []; }
function saveFriends() {
  try { localStorage.setItem('limbo_friends', JSON.stringify(friends)); } catch (e) { /* ignore */ }
}
function addFriend(name) {
  const clean = String(name || '').trim().slice(0, 16);
  if (!clean) return false;
  const lc = clean.toLowerCase();
  if (lc === myName.toLowerCase()) return false; // adding yourself is a no-op
  if (friends.some((f) => f.toLowerCase() === lc)) return false; // no duplicates
  friends.push(clean);
  saveFriends();
  renderFriendsSection();
  return true;
}
function removeFriend(name) {
  const lc = String(name || '').toLowerCase();
  const before = friends.length;
  friends = friends.filter((f) => f.toLowerCase() !== lc);
  if (friends.length !== before) { saveFriends(); renderFriendsSection(); }
}

// Freshest heartbeat wins when two drifters share a name.
function livePresenceFor(name) {
  const lc = String(name || '').toLowerCase();
  let best = null;
  for (const [pid, p] of net.lobbyPeers) {
    if (String(p.name).toLowerCase() === lc && (!best || p.lastSeen > best.lastSeen)) {
      best = { peerId: pid, name: p.name, room: p.room, lastSeen: p.lastSeen };
    }
  }
  return best;
}
function realmDisplayName(key) {
  if (isNexusServerKey(key)) return 'Nexus #' + key.split('-').pop();
  if (key === 'nexus') return NEXUS_DEF.name;
  if (key === SOUND_ROOM_KEY) return SOUND_DEF.name;
  if (key === JOURNEY_ROOM_KEY) return JOURNEY_DEF.name;
  if (key === WORKSHOP_ROOM_KEY) return WORKSHOP_DEF.name;
  const d = REALM_DEFS.find((r) => r.key === key);
  return d ? d.name : String(key || '').toUpperCase();
}

function renderFriendsSection() {
  if (!friendsListEl) return;
  friendsListEl.innerHTML = '';
  const rows = friends.map((name) => ({ name, live: livePresenceFor(name) }));
  rows.sort((a, b) =>
    (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  let liveCount = 0;
  for (const { name, live } of rows) {
    if (live) liveCount++;
    const row = document.createElement('div');
    row.className = 'friend-row';
    const dot = document.createElement('span');
    dot.className = 'friend-dot' + (live ? ' live' : '');
    const nm = document.createElement('span');
    nm.className = 'friend-name';
    nm.textContent = name;
    row.appendChild(dot);
    row.appendChild(nm);
    if (live) {
      const where = document.createElement('span');
      where.className = 'friend-realm';
      where.textContent = realmDisplayName(live.room);
      const join = document.createElement('button');
      join.className = 'friend-join';
      join.textContent = 'join';
      join.setAttribute('aria-label', `join ${name} in ${realmDisplayName(live.room)}`);
      join.addEventListener('click', () => {
        setSettings(false);
        goTo(live.room);
        join.blur();
      });
      row.appendChild(where);
      row.appendChild(join);
    }
    const x = document.createElement('button');
    x.className = 'friend-remove';
    x.textContent = '×';
    x.setAttribute('aria-label', `remove ${name} from friends`);
    x.addEventListener('click', () => { removeFriend(name); x.blur(); });
    row.appendChild(x);
    friendsListEl.appendChild(row);
  }
  if (friendsLiveEl) friendsLiveEl.textContent = liveCount > 0 ? `— ${liveCount} drifting now` : '';
}

/* ---------------- server picker (build 38) ----------------
   Numbered Nexus servers with live headcounts from the lobby roster.
   Rendered in the start overlay once net boots; re-rendered in place on
   every presence tick (no DOM rebuild under the user's finger). The pick
   survives realm hops via selectedServer. */

const serverListEl = document.getElementById('server-list');
let serverListTouched = false; // the drifter picked manually — stop auto-select

function bestServer() {
  let best = 1, bestN = -1;
  for (let n = 1; n <= NEXUS_SERVERS; n++) {
    const c = serverCount(n);
    if (c > bestN) { bestN = c; best = n; }
  }
  return best;
}

function renderServerList() {
  if (!serverListEl || started) return; // overlay gone — nothing to render
  if (!net.enabled) {
    serverListEl.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'server-row off';
    d.textContent = 'offline — solo drift';
    serverListEl.appendChild(d);
    return;
  }
  if (!serverListTouched) { selectedServer = bestServer(); syncJukeServer(); }
  let rows = serverListEl.querySelectorAll('.server-row');
  if (rows.length !== NEXUS_SERVERS) {
    serverListEl.innerHTML = '';
    for (let n = 1; n <= NEXUS_SERVERS; n++) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'server-row';
      row.setAttribute('role', 'option');
      const num = document.createElement('span');
      num.className = 'server-num';
      num.textContent = '#' + n;
      const cnt = document.createElement('span');
      cnt.className = 'server-count';
      row.appendChild(num);
      row.appendChild(cnt);
      row.addEventListener('click', () => {
        pickServer(n);
        row.blur();
      });
      serverListEl.appendChild(row);
    }
    rows = serverListEl.querySelectorAll('.server-row');
  }
  rows.forEach((row, i) => {
    const n = i + 1;
    const c = serverCount(n);
    row.classList.toggle('sel', n === selectedServer);
    row.setAttribute('aria-selected', n === selectedServer ? 'true' : 'false');
    row.querySelector('.server-count').textContent = c === 0 ? 'empty' : c + ' here';
  });
}

/* ---------------- sound room: shared jam + jukebox (build 12; broadcast relay retired build 28) ----------------
   No DJ slot anymore: every jammer's notes broadcast live (jamNote) and the
   jukebox stays in sync by wall clock, so a "go live" relay earned nothing
   but confusion. A bus analyser feeds the room's bass-reactive lights. */

let roomBassSmooth = 0; // 0..1, eased — drives the room pulse
let roomAnalyser = null; // {comp, analyser, data} — FFT tap on the jam bus (build 28)

/* Room analyser (build 28): a tiny FFT hanging off the jam master bus.
   Feeds the bass-reactive lights and the auto-BPM detector. With
   create=false it never builds the audio chain — safe for the render dub. */
function roomAnalyserGet(create) {
  const ch = create ? jamEnsureChain() : ((audio.ctx && jam.chain) || null);
  if (!ch || !ch.comp || !audio.ctx) return null;
  if (roomAnalyser && roomAnalyser.comp === ch.comp) return roomAnalyser;
  try {
    const analyser = audio.ctx.createAnalyser();
    analyser.fftSize = 64; // 32 bins; bass lives in the first few
    ch.comp.connect(analyser);
    roomAnalyser = { comp: ch.comp, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
  } catch (e) { roomAnalyser = null; }
  return roomAnalyser;
}

/* Room chrome: show/hide each room's buttons when we drift between
   rooms. (Build 28: the DJ HUD line and go-live button are gone.)
   Build 41: the jukebox is server-wide — its button rides everywhere,
   and the queue survives room hops (it resets only on server change).
   Jam + paint stay sound-room only. */
function inMusicRoom() {
  return !!(active && (active.key === SOUND_ROOM_KEY || active.key === JOURNEY_ROOM_KEY));
}
function renderRoomChrome() {
  const inSound = !!(active && active.key === SOUND_ROOM_KEY);
  const inWorkshop = !!(active && active.key === WORKSHOP_ROOM_KEY);
  if (jamBtn) jamBtn.style.display = inSound ? '' : 'none';
  if (paintBtn) paintBtn.style.display = inSound ? '' : 'none';
  if (jukeBtn) jukeBtn.style.display = ''; // build 41: the server jukebox rides everywhere
  if (workshopBtn) workshopBtn.style.display = inWorkshop ? '' : 'none';
  if (!inSound && paint.open) setPaintOpen(false); // paint mode can't leave the room
  if (!inWorkshop) setWorkshopPanel(false); // the workbench can't leave the room
  renderJourneyChrome(); // build 41: journey-only buttons + minimap
  renderJamStageFoh(); // build 66: stage + FOH sections only live in the sound room
}

/* Build 41: the endless journey's own chrome — return-to-nexus, jam mute,
   minimap. Everything else in the HUD stays as it was. */
function renderJourneyChrome() {
  const inJourney = !!(active && active.key === JOURNEY_ROOM_KEY);
  const el = document.getElementById('journey-chrome');
  if (el) el.style.display = inJourney ? '' : 'none';
  if (inJourney) {
    journeyJamMuteSet(journeyJamMuted); // refresh the toggle label
    journeyMinimapInit();
  }
}
const journeyHomeBtn = document.getElementById('journey-home-btn');
if (journeyHomeBtn) journeyHomeBtn.addEventListener('click', () => {
  try { goTo('nexus'); } catch (e) {}
  journeyHomeBtn.blur();
});
const journeyJammuteBtn = document.getElementById('journey-jammute');
if (journeyJammuteBtn) journeyJammuteBtn.addEventListener('click', () => {
  journeyJamMuteSet(!journeyJamMuted);
  journeyJammuteBtn.blur();
});

/* Make sure the WebAudio engine is up and running. The drift tap calls
   audio.init(); this is the safety net for programmatic callers. */
function audioEnsureRunning() {
  try {
    if (!audio.ctx) audio.init(110);
    if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  } catch (e) {}
  if (audio.ctx && audio.master) jamEnsureDrumKits(); // bake the drum kits once
  return !!(audio.ctx && audio.master);
}

/* iOS Safari can re-suspend the AudioContext when the tab is backgrounded.
   Best-effort resume on return; if the OS still says no, the next audio
   need raises the "tap for sound" pill — the honest path back in. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') audioEnsureRunning();
});

/* ---------------- jam room (build 13) ----------------
   The sound room becomes a jam space. THE CORE TRICK: instrument audio
   is never streamed — the internet can't do real-time jam latency
   (~500ms round trips). Instead, tiny note/pad events ride Trystero's
   data channel and EVERY client synthesizes the sound locally with
   WebAudio, scheduled against a shared beat clock. Your own notes play
   instantly (zero latency for you); everyone else's land quantized on
   the grid. It feels tight because the timing happens on-device.

   Protocol (sound-room room only, fire-and-forget):
     jamClock {bpm, startWall, by}  — DJ -> room. startWall is a
       Date.now() epoch for beat 0; beat = (now - startWall) * bpm/60000.
       Re-broadcast on BPM change, DJ takeover, and every 15s while
       DJing (keeps late joiners on the grid).
     jamNote {n, midi, vel, beat, inst, drum, chord, w, c, r} — any jammer
       -> room. beat is the target beat on the shared clock (null =
       free-time, play now). inst is the sender's instrument
       (lead/bass/drums/pad, build 20) so every client renders the note
       with the SENDER's voice, never its own. drums uses drum (kick,
       snare, clap, chat, ohat, shaker); pad uses chord (0-3, i-VI-III-VII
       in A minor); lead/bass use midi. w/c/r carry the lead patch (wave,
       cutoff, resonance) so every client renders the same timbre.
     jamPad {n, pad, beat, lenBars} — pad trigger. The loop audio itself
       is NEVER sent: every client grabs its own local copy of the same
       DJ stream (see the ring buffer below), so triggers quantized to
       the bar stay musical within network jitter. Honest v1.

   The DJ is the clock master. No DJ -> clock stopped; the synth still
   plays free-time locally (heard by all, unsynced). */

const jamBtn = document.getElementById('jam-btn');
const jamPanel = document.getElementById('jam-panel');
const jamCloseBtn = document.getElementById('jam-close');
const jamBpmEl = document.getElementById('jam-bpm');
const jamClockDotEl = document.getElementById('jam-clock-dot');
const jamClockStatusEl = document.getElementById('jam-clock-status');
const jamTapEl = document.getElementById('jam-tap');
const jamBpmDownEl = document.getElementById('jam-bpm-down');
const jamBpmUpEl = document.getElementById('jam-bpm-up');
const jamKeysEl = document.getElementById('jam-keys');
const jamGrabEl = document.getElementById('jam-grab');
const jamGrabRoomEl = document.getElementById('jam-grab-room');
const jamRoomNoteEl = document.getElementById('jam-room-note');
const jamPadsEl = document.getElementById('jam-pads');
const jamHintEl = document.getElementById('jam-hint');
const jamJammersEl = document.getElementById('jam-jammers');
const jamInstTabsEl = document.getElementById('jam-inst-tabs');
const jamBeatDotsEl = document.getElementById('jam-beat-dots');
const jamMetroToggleEl = document.getElementById('jam-metro-toggle');
const jamMetroVolEl = document.getElementById('jam-metro-vol');
const jamBassKeysEl = document.getElementById('jam-bass-keys');
const jamDrumsEl = document.getElementById('jam-drums');
const jamChordsEl = document.getElementById('jam-chords');
const jamLeadChordsEl = document.getElementById('jam-lead-chords');
const jamSeqToggleEl = document.getElementById('jam-seq-toggle');
const jamSeqStateEl = document.getElementById('jam-seq-state');
const jamSeqBodyEl = document.getElementById('jam-seq-body');
const jamSeqGridEl = document.getElementById('jam-seq-grid');
const jamSeqSwingEl = document.getElementById('jam-seq-swing');
const jamSeqClearEl = document.getElementById('jam-seq-clear');
const jamMicBtnEl = document.getElementById('jam-mic-btn');
const jamMicMuteEl = document.getElementById('jam-mic-mute');
const jamMicLoopEl = document.getElementById('jam-mic-loop');
const jamTalkBtnEl = document.getElementById('jam-talk-btn');
const jamMicMeterEl = document.getElementById('jam-mic-meter');
const jamMicMeterFillEl = document.getElementById('jam-mic-meter-fill');
const jamMicNoteEl = document.getElementById('jam-mic-note');

/* Build 20 instruments. Every player picks one; the pick rides every
   jamNote (inst) so each client renders the SENDER's voice, and each
   player's wisp glow takes their instrument's color. */
const JAM_INSTRUMENTS = {
  lead: { label: 'LEAD', color: '#37e6ff', glow: 0x37e6ff },
  bass: { label: 'BASS', color: '#b388ff', glow: 0xb388ff },
  drums: { label: 'DRUMS', color: '#ffc24d', glow: 0xffc24d },
  pad: { label: 'PAD', color: '#ff7ad9', glow: 0xff7ad9 },
};
const JAM_INST_IDS = Object.keys(JAM_INSTRUMENTS);
const jamPeerInst = new Map(); // peerId -> instrument id (from their notes)

const jam = {
  open: false,
  bpm: 120,
  startWall: null, // Date.now() epoch of beat 0; null = clock stopped
  clockBy: null, // whose clock we're following
  clockMsgT: 0, // t of the last clock we accepted or broadcast (last-writer-wins)
  clockLastRemote: 0, // when we last heard someone else's clock
  manual: false, // manual tempo override (auto-detect paused)
  instrument: 'lead', // build 20: this player's instrument
  // build 39: the pocket synth is a real patch now — every field rides the
  // jamNote so the room hears YOUR voice, not a default.
  synth: {
    wave: 'sawtooth', // osc 1 wave
    wave2: 'sawtooth', // osc 2 wave
    osc2mix: 0.45, // osc 2 level 0..1
    cutoff: 1800, reso: 5,
    env: 0.35, // filter envelope amount 0..1
    attack: 0.008, decay: 0.4, sustain: 0.7, release: 0.3, // amp ADSR (seconds, s is 0..1)
    sub: 0, // 0..1 sub-osc level
    spread: 12, // cents of detune (osc 2)
    echo: 0.3, // 0..1 per-voice delay/reverb send
    glide: 0.02, // seconds of portamento (local performance only)
    lfoRate: 5, // Hz
    lfoPitch: 0, // cents of vibrato
    lfoFilter: 0, // 0..1 filter wobble
    // build 64: the synth's pedalboard — clipper drive, tempo delay, limiter
    drive: 0, // 0..1 clipper drive
    dlyMix: 0.25, // 0..1 delay wet
    dlyFb: 0.35, // 0..0.92 delay feedback
    dlyDiv: 0.75, // delay note value in beats (0.5=1/8, 0.75=dotted 1/8, 1=1/4)
  },
  scale: 'chromatic', // chromatic | minpent | majpent — the lead keys remap
  drumVariant: (() => { // build 63: per-pad sample pick (persists)
    const d = { kick: 0, snare: 0, clap: 0, chat: 0, ohat: 0, shaker: 0 };
    try {
      const raw = JSON.parse(localStorage.getItem('limbo-drumkit') || '{}');
      for (const k of Object.keys(d)) if (Number.isInteger(raw[k]) && raw[k] >= 0) d[k] = raw[k];
    } catch (e) {}
    return d;
  })(),
  glideFrom: 0, // last lead freq, for portamento (local only, never broadcast)
  pads: [null, null, null, null], // AudioBuffers, local to this client
  padRound: 0, // next pad to fill on grab (round-robin)
  rec: null, // ring-buffer recorder on the jam bus
  jammers: new Map(), // name -> {t, inst} (30s window)
  detector: null, // OnsetDetector for auto-BPM
  detStable: 0,
  detLast: null,
  listen: false, // build 46: tempo listens to the jukebox through the mic
  listenOwnsMic: false, // we opened the mic just for listening
  chain: null, // build 20: jam master bus (bus -> sends -> comp -> master)
  metro: { on: false, vol: 0.5, nextBeat: null, clicks: 0 }, // local-only metronome
  lastVoice: null, // {inst, ...} of the most recently rendered voice (test hook)
  beatUiIdx: -2, // last beat index the dot row rendered
};
const jamQueue = []; // pending {beat, play(audioTime)} — the lookahead scheduler's list
let jamVoicesSpawned = 0; // diagnostic counter for the test hook
let jamTaps = []; // tap-tempo timestamps

/* ---------------- the loop (build 66: simplified) ----------------
 * One big button at the top of the jam UI, four moves, no thinking:
 *   empty     -> tap  = start recording
 *   recording -> tap  = close the loop, start it looping
 *   playing   -> tap  = stop (rest)
 *   stopped   -> tap  = play again
 *   anytime   -> hold = clear it all
 * Recording starts the instant you tap and closes the instant you tap
 * again -- the loop is exactly what you played, captured off the
 * post-limiter bus (what the room hears). No bar alignment, no layers,
 * no double-taps. The pedal flow (builds 39/63) is retired. */
const dub = {
  state: 'empty', // empty|recording|playing|stopped
  buf: null, // AudioBuffer (stereo) -- the loop itself
  src: null, // looping BufferSource
  srcGain: null,
  t0: 0, // ctx.currentTime of the current playback cycle start
  dur: 0, // loop duration in seconds
  take: null, // {proc,tap,sink,L,R,idx,len} while capturing
  uiRaf: 0,
};
/* Longest take the loop will hold -- a take that runs past this closes
   itself instead of eating memory. */
const LOOP_MAX_SEC = 30;

/* Current beat on the shared clock, or null when the clock is stopped. */
function jamBeatNow() {
  if (jam.startWall == null) return null;
  return (Date.now() - jam.startWall) * jam.bpm / 60000;
}

/* AudioContext timestamp for a beat. Clamped to "now" — a beat in the
   past (late-arriving event) plays immediately rather than throwing. */
function jamAudioTimeForBeat(beat) {
  const ctx = audio.ctx;
  if (!ctx || jam.startWall == null) return null;
  const wallMs = jam.startWall + (beat * 60000) / jam.bpm;
  return ctx.currentTime + Math.max(0, (wallMs - Date.now()) / 1000);
}

function jamEnqueue(ev) {
  jamQueue.push(ev);
}

/* Lookahead scheduler: every 25ms, schedule any queued event whose time
   falls within the next 120ms. The standard WebAudio pattern — absorbs
   network jitter so remote notes land on the grid. */
function jamSchedulerTick() {
  jamMetroTick(); // personal metronome rides the same 25ms tick
  if (!jamQueue.length) return;
  const ctx = audio.ctx;
  if (!ctx || jamBeatNow() == null) {
    // Clock vanished mid-queue: flush immediately, never strand notes.
    while (jamQueue.length) {
      const ev = jamQueue.shift();
      try { ev.play(ctx ? ctx.currentTime + 0.01 : 0); } catch (e) {}
    }
    return;
  }
  jamQueue.sort((a, b) => a.beat - b.beat);
  const horizon = ctx.currentTime + 0.12;
  while (jamQueue.length) {
    const at = jamAudioTimeForBeat(jamQueue[0].beat);
    if (at == null || at > horizon) break;
    const ev = jamQueue.shift();
    try { ev.play(Math.max(at, ctx.currentTime + 0.005)); } catch (e) {}
  }
}
setInterval(jamSchedulerTick, 25);

/* ---------------- personal metronome (build 20) ----------------
   Accented click on beat 1, plain clicks otherwise, scheduled against
   the shared beat clock ~180ms ahead. Audible ONLY locally — never
   broadcast, never in anyone else's mix. Off by default. */
function jamMetroTick() {
  const m = jam.metro;
  const ctx = audio.ctx;
  if (!m.on || !ctx || !audio.master) return;
  const bn = jamBeatNow();
  if (bn == null) return;
  if (m.nextBeat == null || m.nextBeat < bn - 1) m.nextBeat = Math.ceil(bn - 1e-6);
  const horizon = bn + 0.18;
  let guard = 0;
  while (m.nextBeat <= horizon && guard++ < 16) {
    const at = jamAudioTimeForBeat(m.nextBeat);
    if (at != null) {
      jamMetroClick(ctx, audio.master, {
        time: at,
        accent: m.nextBeat % 4 === 0,
        vol: m.vol,
      });
      m.clicks++;
    }
    m.nextBeat++;
  }
}

function jamSetMetro(on, vol) {
  jam.metro.on = !!on;
  if (vol != null && Number.isFinite(Number(vol))) {
    jam.metro.vol = Math.max(0, Math.min(1, Number(vol)));
  }
  if (jam.metro.on) jam.metro.nextBeat = null; // re-sync to the grid
  if (jamMetroToggleEl) {
    jamMetroToggleEl.classList.toggle('sel', jam.metro.on);
    jamMetroToggleEl.textContent = jam.metro.on ? 'metro on' : 'metro';
  }
  if (jamMetroVolEl) jamMetroVolEl.value = Math.round(jam.metro.vol * 100);
}

/* Beat-dot row + pad pulse: the UI breathes with the clock. */
function jamBeatUiTick() {
  if (!jam.open) return;
  const bn = jamBeatNow();
  const idx = bn == null ? -1 : ((Math.floor(bn) % 4) + 4) % 4;
  if (idx === jam.beatUiIdx) return;
  jam.beatUiIdx = idx;
  if (jamBeatDotsEl) {
    const dots = jamBeatDotsEl.children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i === idx);
  }
  if (idx >= 0 && jamPanel) {
    jamPanel.classList.add('onbeat');
    setTimeout(() => { if (jamPanel) jamPanel.classList.remove('onbeat'); }, 140);
  }
}
setInterval(jamBeatUiTick, 100);

/* ---------------- jam master bus (build 20) ----------------
   The "as we grow" chain: every instrument feeds its own gain into one
   shared bus; the bus splits into a generated-impulse convolution reverb
   send and a tempo-synced feedback delay send; dry + wet meet at a
   DynamicsCompressor (safety limiter — six players can't clip the room)
   and flow into the game's master (so mute/fade still apply). One shared
   convolver, not per-voice: CPU stays sane. The sampler's ring buffer
   taps the bus post-compressor, so grabs capture what the room hears. */
function jamEnsureChain() {
  const ctx = audio.ctx;
  if (!ctx) return null;
  if (jam.chain) return jam.chain;
  try {
    const bus = ctx.createGain();
    bus.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 20;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.24;
    // generated-impulse room reverb (no audio files)
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulseResponse(ctx, 1.9, 2.4);
    const revSend = ctx.createGain(); revSend.gain.value = 0.32;
    const revRet = ctx.createGain(); revRet.gain.value = 0.5;
    // build 72: quarter-note (was dotted-eighth) — the echo lands on the
    // beat grid so the drum loop closes cleanly instead of drifting
    const delay = ctx.createDelay(2.0);
    delay.delayTime.value = (60 / jam.bpm) * 1.0;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const dlySend = ctx.createGain(); dlySend.gain.value = 0.2;
    const dlyRet = ctx.createGain(); dlyRet.gain.value = 0.45;
    bus.connect(comp); // dry
    bus.connect(revSend); revSend.connect(conv); conv.connect(revRet); revRet.connect(comp);
    bus.connect(dlySend); dlySend.connect(delay);
    delay.connect(fb); fb.connect(delay);
    delay.connect(dlyRet); dlyRet.connect(comp);
    comp.connect(audio.master);
    const gains = {};
    // build 40: lead/drums/loop faders live on the mixer strip — the chain
    // is built from the stored mix so a rejoin keeps your levels.
    // build 64: the synth's own pedalboard (clipper -> delay -> limiter)
    // sits between the lead fader and the bus.
    let synthFx = null;
    try {
      synthFx = createSynthFx(ctx);
      synthFx.updateTempo(jam.bpm);
      synthFx.setDrive(jam.synth.drive || 0);
      synthFx.setDelay(jam.synth.dlyMix, jam.synth.dlyFb, jam.synth.dlyDiv);
    } catch (e) { synthFx = null; }
    const levels = { lead: mixer.levels.lead, bass: 1.0, drums: mixer.levels.drums, pad: 0.8 };
    for (const id of JAM_INST_IDS) {
      const g = ctx.createGain();
      g.gain.value = levels[id];
      if (id === 'lead' && synthFx) {
        g.connect(synthFx.input);
        synthFx.output.connect(bus);
      } else {
        g.connect(bus);
      }
      gains[id] = g;
    }
    const loopG = ctx.createGain();
    loopG.gain.value = mixer.levels.loop;
    loopG.connect(bus);
    gains.loop = loopG;
    jam.chain = { bus, comp, conv, delay, revSend, dlySend, gains, synthFx };
    return jam.chain;
  } catch (e) {
    return null;
  }
}

/* Where an instrument's voice lands: its bus gain, or the game master
   when the chain isn't built yet (audio not initialized). */
function jamDestFor(inst) {
  const ch = jamEnsureChain();
  if (ch && ch.gains[inst]) return ch.gains[inst];
  return audio.master;
}

/* ---------------- mic in (build 27, voice routing build 40) ----------------
   The mic is live-only by default: mic -> gain -> dry monitor -> master,
   never the jam bus — so the overdub looper can't capture it. The
   "voice → loop" toggle (jamMicToggleLoop) explicitly re-adds the bus
   tap when Joshua wants his voice in the loop. "Talk" (voiceTalkToggle)
   streams 16kHz PCM frames to the room over the relay; incoming voices
   land on audio.master through the mixer's voice fader. echoCancellation
   + noiseSuppression are on; the headphone note in the panel says the
   rest. The mic NEVER touches the "sample the room" tab-capture path —
   that API only sees the tab's rendered output, so no software feedback
   loop exists. Denial is an honest toast, never a crash. */
const jamMic = {
  on: false,
  muted: false,
  stream: null,
  src: null,
  gain: null,      // mute lives here (post-mute taps: TX, loop, monitor)
  analyser: null,
  analyserData: null,
  local: null,     // dry monitor -> master (live-only)
  loopTap: null,   // opt-in tap -> jam bus (gets room space + looper)
  loopIn: false,
  meterRaf: 0,
};

/* Open the mic stream inside the caller's tap gesture (iPhone Safari
   requires getUserMedia in a user gesture). Returns true when live. */
async function jamMicEnsureStream() {
  if (jamMic.on && jamMic.stream) return true;
  const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? (c) => navigator.mediaDevices.getUserMedia(c) // bound: the method needs its receiver
    : null;
  if (!gum) {
    showUnlockToast(['this browser has no mic input']);
    return false;
  }
  try {
    if (!audioEnsureRunning()) { showUnlockToast(['audio isn\u2019t running']); return false; }
    const stream = await gum({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
    if (!track) {
      try { (stream.getTracks() || []).forEach((t) => { try { t.stop(); } catch (e) {} }); } catch (e) {}
      throw new Error('no mic track');
    }
    const ctx = audio.ctx;
    const srcNode = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 1.0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    // Build 40: voice is live-only by default — the monitor lands dry on
    // the master, NEVER the jam bus, so the overdub looper can't capture
    // it. The "voice → loop" toggle below re-adds the bus tap explicitly.
    const local = ctx.createGain();
    local.gain.value = 1.0;
    srcNode.connect(gain);
    gain.connect(analyser);
    analyser.connect(local);
    local.connect(audio.master);
    const loopTap = ctx.createGain();
    loopTap.gain.value = 0;
    analyser.connect(loopTap);
    const ch = jamEnsureChain();
    if (ch && ch.bus) loopTap.connect(ch.bus);
    jamMic.stream = stream;
    jamMic.src = srcNode;
    jamMic.gain = gain;
    jamMic.analyser = analyser;
    jamMic.analyserData = new Uint8Array(analyser.frequencyBinCount);
    jamMic.local = local;
    jamMic.loopTap = loopTap;
    jamMic.loopIn = false;
    jamMic.on = true;
    jamMic.muted = false;
    track.onended = () => jamMicOff(); // OS / browser revoked the mic
    renderJamMic();
    jamMicMeterLoop();
    return true;
  } catch (e) {
    jamMicDeny(e);
    return false;
  }
}

async function jamMicToggle() {
  if (jamMic.on) { jamMicOff(); return; }
  const ok = await jamMicEnsureStream();
  if (ok) addSystemLine('mic is live \u2014 headphones on');
}
/* Build 46: "listen" - the tempo listens for the jukebox's BPM through
   the mic. The mic hears whatever's playing (phone speaker, room PA -
   source-agnostic, works for SoundCloud/YouTube iframes whose bytes we
   can't tap). Detection-only: the local monitor is muted so the mic'd
   music can't feed back through the speaker. The 1s detect tick feeds
   this analyser to the onset detector and adopts stable estimates. */
const jamListenEl = document.getElementById('jam-listen');
function renderJamListen() {
  if (!jamListenEl) return;
  jamListenEl.classList.toggle('sel', jam.listen);
  jamListenEl.textContent = jam.listen ? 'listening' : 'listen';
}
async function jamListenToggle() {
  if (jam.listen) {
    jam.listen = false;
    const owned = jam.listenOwnsMic;
    jam.listenOwnsMic = false;
    renderJamListen();
    // We opened the mic just to listen - give it back. If the voice mic
    // was already live, just unmute its monitor.
    if (owned) jamMicOff();
    else if (jamMic.on && jamMic.local && audio.ctx) {
      try { jamMic.local.gain.setTargetAtTime(1.0, audio.ctx.currentTime, 0.03); } catch (e) {}
    }
    return;
  }
  // Called from the tap gesture, so iOS grants the mic.
  const already = jamMic.on;
  const ok = await jamMicEnsureStream();
  if (!ok || !jamMic.analyser) return;
  jam.listenOwnsMic = !already;
  // Detection only - mute the monitor so the room can't howl.
  if (jamMic.local && audio.ctx) {
    try { jamMic.local.gain.setTargetAtTime(0.0, audio.ctx.currentTime, 0.03); } catch (e) {}
  }
  jam.listen = true;
  jam.detStable = 0;
  jam.detLast = null;
  renderJamListen();
}


/* Opt-in: let the voice drift into the jam bus (room space + the overdub
   looper can capture it). Off by default — voice stays live-only. */
function jamMicToggleLoop() {
  if (!jamMic.on || !jamMic.loopTap || !audio.ctx) return;
  jamMic.loopIn = !jamMic.loopIn;
  try {
    jamMic.loopTap.gain.setTargetAtTime(jamMic.loopIn ? 1 : 0, audio.ctx.currentTime, 0.03);
  } catch (e) {}
  addSystemLine(jamMic.loopIn
    ? 'your voice drifts into the loop now'
    : 'your voice stays live-only');
  renderJamMic();
}

function jamMicDeny(e) {
  const n = (e && e.name) || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    showUnlockToast(['mic was blocked \u2014 allow it in the browser bar, then tap again']);
    addSystemLine('mic blocked \u2014 check the browser permission');
  } else if (n === 'NotFoundError' || (e && e.message === 'no mic track')) {
    showUnlockToast(['no mic found on this device']);
  } else if (n === 'AbortError') {
    // user dismissed the picker — quiet
  } else {
    showUnlockToast(['couldn\u2019t open the mic']);
  }
  renderJamMic();
}

function jamMicOff() {
  if (voice.tx.on) voiceTalkStop(); // talking stops when the mic dies
  if (jam.listen) { jam.listen = false; jam.listenOwnsMic = false; renderJamListen(); }
  if (!jamMic.on && !jamMic.stream) return;
  jamMic.on = false;
  jamMic.muted = false;
  jamMic.loopIn = false;
  if (jamMic.meterRaf) { try { cancelAnimationFrame(jamMic.meterRaf); } catch (e) {} jamMic.meterRaf = 0; }
  try { if (jamMic.gain) jamMic.gain.disconnect(); } catch (e) {}
  try { if (jamMic.analyser) jamMic.analyser.disconnect(); } catch (e) {}
  try { if (jamMic.local) jamMic.local.disconnect(); } catch (e) {}
  try { if (jamMic.loopTap) jamMic.loopTap.disconnect(); } catch (e) {}
  try { if (jamMic.src) jamMic.src.disconnect(); } catch (e) {}
  try {
    if (jamMic.stream) (jamMic.stream.getTracks() || []).forEach((t) => { try { t.stop(); } catch (e2) {} });
  } catch (e) {}
  jamMic.stream = jamMic.src = jamMic.gain = jamMic.analyser = jamMic.analyserData =
    jamMic.local = jamMic.loopTap = null;
  if (jamMicMeterFillEl) jamMicMeterFillEl.style.width = '0%';
  renderJamMic();
}

function jamMicToggleMute() {
  if (!jamMic.on || !jamMic.gain || !audio.ctx) return;
  jamMic.muted = !jamMic.muted;
  try {
    jamMic.gain.gain.setTargetAtTime(jamMic.muted ? 0 : 1.0, audio.ctx.currentTime, 0.03);
  } catch (e) {}
  renderJamMic();
}

/* Level meter: average the analyser bins into a 0..1 bar. */
function jamMicLevel() {
  if (!jamMic.on || !jamMic.analyser || !jamMic.analyserData) return 0;
  try {
    jamMic.analyser.getByteFrequencyData(jamMic.analyserData);
  } catch (e) { return 0; }
  let sum = 0;
  const d = jamMic.analyserData;
  for (let i = 0; i < d.length; i++) sum += d[i];
  return Math.min(1, (sum / d.length / 255) * 3);
}

function jamMicMeterLoop() {
  if (!jamMic.on) return;
  if (jamMicMeterFillEl) {
    jamMicMeterFillEl.style.width = Math.round(jamMicLevel() * 100) + '%';
  }
  jamMic.meterRaf = requestAnimationFrame(jamMicMeterLoop);
}

function renderJamMic() {
  if (jamMicBtnEl) {
    jamMicBtnEl.classList.toggle('on', jamMic.on);
    jamMicBtnEl.innerHTML = jamMic.on ? '&#127908; mic on' : '&#127908; mic';
  }
  if (jamMicMuteEl) {
    jamMicMuteEl.style.display = jamMic.on ? '' : 'none';
    jamMicMuteEl.textContent = jamMic.muted ? 'unmute' : 'mute';
  }
  if (jamMicLoopEl) {
    jamMicLoopEl.style.display = jamMic.on ? '' : 'none';
    jamMicLoopEl.classList.toggle('sel', jamMic.loopIn);
    jamMicLoopEl.setAttribute('aria-pressed', jamMic.loopIn ? 'true' : 'false');
  }
  if (jamTalkBtnEl) renderVoiceTalkBtn();
  if (jamMicMeterEl) jamMicMeterEl.style.display = jamMic.on ? '' : 'none';
  if (jamMicNoteEl) jamMicNoteEl.style.display = jamMic.on ? '' : 'none';
}

/* ---------------- room voice (build 40) ----------------
   Tap "talk" and your voice drifts out to the room — live, riding the
   same relay path everyone connects on (no separate media server, no
   data-channel chunking hacks). iPhone-safe: the mic only ever opens
   inside your tap (getUserMedia needs the gesture); echoCancellation +
   noiseSuppression are on.
   Transport: the mic is downsampled to 16kHz mono and framed into 120ms
   PCM chunks (~5KB base64), broadcast as voiceChunk events. Receivers
   jitter-buffer ~360ms and play frames back to back — about a half-second
   behind you, steady. Your own echo never comes back: the transport drops
   self-echo before it reaches us.
   Voice is LIVE-only: incoming voices land on audio.master, never the
   jam bus, so the overdub looper can't capture them. Opt-in, always —
   the mic starts OFF; mute rests your voice too; the talk button shows
   exactly when you're live. */
const VOICE_FRAME = 1920; // 16kHz * 0.12s per chunk
const VOICE_PRIME = 3;    // frames of jitter buffer before playout starts
const voice = {
  tx: { on: false, starting: false, node: null, zero: null, seq: 0, gen: 0 },
  rx: new Map(), // peerId -> {name,q:Map,next,started,prime,playAt,lastChunk,ended}
  inGain: null,
  _tick: 0,
  lastError: '',
};

/* Raw PCM capture: downsample to ~16kHz mono, emit 120ms Int16 frames. */
const VOICE_WORKLET_SRC = `class VoiceCap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = Math.max(1, Math.round(sampleRate / 16000));
    this.buf = new Int16Array(${VOICE_FRAME});
    this.n = 0; this.seq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i += this.step) {
        let s = ch[i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.buf[this.n++] = s < 0 ? s * 32768 : s * 32767;
        if (this.n >= this.buf.length) {
          const out = new Int16Array(this.buf);
          this.port.postMessage({ seq: this.seq++, pcm: out.buffer }, [out.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('limbo-voice-cap', VoiceCap);`;

/* Jam-panel hint line (mirrors jukeHint). */
function jamHint(msg) {
  if (jamHintEl) jamHintEl.textContent = msg;
}

function voiceEnsureInGain() {  if (voice.inGain || !audio.ctx) return voice.inGain;
  try {
    const g = audio.ctx.createGain();
    g.gain.value = mixer.levels.voice;
    g.connect(audio.master);
    voice.inGain = g;
  } catch (e) { /* no graph yet */ }
  return voice.inGain;
}

async function voiceTalkToggle() {
  if (voice.tx.on) { voiceTalkStop(); return; }
  if (voice.tx.starting) return; // a start is already in flight — don't race it
  voice.tx.starting = true;
  try {
    if (!audioEnsureRunning()) { showUnlockToast(['audio isn\u2019t running']); return; }
    // One tap opens the mic (same gesture = one permission prompt) and
    // starts the send. The mic stream is shared with the monitor path.
    const ok = await jamMicEnsureStream();
    if (!ok || !jamMic.on || !jamMic.gain) return;
    if (!net.sendVoiceChunk) {
      // Couch co-op has no voice transport yet — stay honest, don't fake it.
      jamHint('voice rides the online room — the couch stays quiet for now');
      return;
    }
    const ctx = audio.ctx;
    if (!ctx.audioWorklet) { showUnlockToast(['this browser can\u2019t send voice']); return; }
    // Unique processor name per start: a rapid double-tap must never race
    // two registrations of the same name.
    const gen = ++voice.tx.gen;
    const src = VOICE_WORKLET_SRC.replace('limbo-voice-cap', `limbo-voice-cap-${gen}`);
    const blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(blobUrl);
    } finally {
      try { URL.revokeObjectURL(blobUrl); } catch (e) {}
    }
    if (!voice.tx.starting) return; // stopped while starting — bail quietly
    const node = new AudioWorkletNode(ctx, `limbo-voice-cap-${gen}`);
    const zero = ctx.createGain();
    zero.gain.value = 0;
    jamMic.gain.connect(node); // post-mute: muting rests your voice too
    node.connect(zero);
    zero.connect(ctx.destination); // keep the node pulled; silence out
    voice.tx.node = node;
    voice.tx.zero = zero;
    voice.tx.seq = 0;
    node.port.onmessage = (e) => voiceTxSend(e.data);
    voice.tx.on = true;
    if (net.sendVoiceTalk) { try { net.sendVoiceTalk({ on: true, name: myName }); } catch (e) {} }
    renderVoiceTalkBtn();
    jamHint('your voice is drifting out \u2014 tap again to rest');
  } catch (e) {
    voice.lastError = (e && (e.name + ': ' + e.message)) || String(e);
    jamMicDeny(e);
  } finally {
    voice.tx.starting = false;
  }
}

function voiceTxSend(frame) {
  if (!voice.tx.on || !frame || typeof frame.seq !== 'number' || !frame.pcm) return;
  if (jamMic.muted) return; // muted rests your voice
  if (!net.sendVoiceChunk) return; // e.g. couch mode: no voice transport yet
  try {
    const u8 = new Uint8Array(frame.pcm);
    let bin = '';
    for (let i = 0; i < u8.length; i += 8192) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    net.sendVoiceChunk({ seq: frame.seq, data: btoa(bin) });
  } catch (e) { /* best effort per frame */ }
}

function voiceTalkStop() {
  voice.tx.starting = false; // an in-flight start bails when it sees this
  if (!voice.tx.on && !voice.tx.node) return;
  voice.tx.on = false;
  try { if (voice.tx.node) voice.tx.node.disconnect(); } catch (e) {}
  try { if (voice.tx.zero) voice.tx.zero.disconnect(); } catch (e) {}
  voice.tx.node = voice.tx.zero = null;
  if (net.sendVoiceTalk) { try { net.sendVoiceTalk({ on: false, name: myName }); } catch (e) {} }
  renderVoiceTalkBtn();
}

/* --- receive path --- */

function voiceRxEntry(id) {
  let r = voice.rx.get(id);
  if (!r) {
    r = { name: '', q: new Map(), next: 0, started: false, prime: 0, playAt: 0, lastChunk: 0, ended: false };
    voice.rx.set(id, r);
  }
  return r;
}

function handleVoiceTalk(peerId, d) {
  if (!d || typeof d.on !== 'boolean') return;
  const r = voiceRxEntry(peerId || 'unknown');
  if (d.on) {
    if (typeof d.name === 'string' && d.name) r.name = d.name.slice(0, 16);
    r.ended = false;
    r.lastChunk = Date.now(); // announced — reap if no audio follows
    voicePlayoutKick(); // the ticker also reaps stale talkers
  } else {
    r.ended = true; // drain what arrived, then clear
  }
  renderVoiceUI();
}

function handleVoiceChunk(peerId, d) {
  if (!d || typeof d.seq !== 'number' || typeof d.data !== 'string') return;
  if (d.data.length > 60000) return; // absurd — drop
  const r = voiceRxEntry(peerId || 'unknown');
  if (r.q.size > 40) return; // flooded — drop, don't balloon
  try {
    const bin = atob(d.data);
    if (!bin.length || bin.length % 2) return;
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(u8.buffer);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    if (!r.started) { r.next = d.seq; r.started = true; }
    r.q.set(d.seq, f32);
    r.lastChunk = Date.now();
    if (audio.ctx && audio.ctx.state === 'suspended') soundPillShow();
  } catch (e) { /* one bad frame never breaks the room */ }
  voicePlayoutKick();
}

/* One shared 120ms ticker plays every peer's next frame, chained
   gaplessly via playAt. Missing frames become silence — never a stall. */
function voicePlayoutKick() {
  if (voice._tick) return;
  voice._tick = setInterval(() => {
    const ctx = audio.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const g = voiceEnsureInGain();
    if (!g) return;
    const now = Date.now();
    for (const [id, r] of voice.rx) {
      const quietFor = now - r.lastChunk;
      // stale talker (announced but no audio ever arrived) or a finished
      // talker fully drained — clear them off the roster line.
      if ((!r.started && !r.ended && quietFor > 4000) ||
          (r.ended && r.q.size === 0 && quietFor > 1200) ||
          (!r.ended && r.started && r.q.size === 0 && quietFor > 4000)) {
        voice.rx.delete(id);
        renderVoiceUI();
        continue;
      }
      if (!r.started) continue;
      if (r.prime < VOICE_PRIME) {
        let have = 0;
        for (const s of r.q.keys()) if (s >= r.next) have++;
        if (have < VOICE_PRIME && now - r.lastChunk < 1500) { r.prime = have; continue; }
        r.prime = VOICE_PRIME;
        r.playAt = ctx.currentTime + 0.05;
      }
      let f = r.q.get(r.next);
      r.q.delete(r.next);
      r.next++;
      if (r.q.size > 12) { // falling behind — shed ancient backlog
        const ks = [...r.q.keys()].sort((a, b) => a - b);
        const cut = ks[ks.length - 12];
        for (const k of ks) if (k < cut) r.q.delete(k);
      }
      try {
        if (r.playAt < ctx.currentTime - 0.3 || r.playAt > ctx.currentTime + 1.5) {
          r.playAt = ctx.currentTime + 0.05; // resync after a stall
        }
        const buf = ctx.createBuffer(1, VOICE_FRAME, 16000);
        if (f) buf.getChannelData(0).set(f.subarray(0, VOICE_FRAME));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(g);
        src.start(r.playAt);
        r.playAt += VOICE_FRAME / 16000;
      } catch (e) {}
    }
    if (!voice.rx.size && voice._tick) { clearInterval(voice._tick); voice._tick = 0; }
  }, 120);
}

/* --- voice UI --- */

function renderVoiceTalkBtn() {
  if (!jamTalkBtnEl) return;
  jamTalkBtnEl.style.display = jamMic.on || voice.tx.on ? '' : 'none';
  jamTalkBtnEl.classList.toggle('live', voice.tx.on);
  jamTalkBtnEl.innerHTML = voice.tx.on ? '&#127908; talking \u2014 tap to rest' : '&#127908; talk';
}

function renderVoiceUI() {
  renderVoiceTalkBtn();
  renderJamJammers(); // talkers ride the room roster line
}

function voiceTalkers() {
  const out = [];
  for (const [, r] of voice.rx) {
    if (!r.ended || r.q.size) out.push(r.name || 'a drifter');
  }
  return out;
}

/* Keep the delay musical under tempo changes — quarter note, eased.
 * Build 72: was dotted-eighth; the off-grid echo made the drum loop feel
 * unsealed. Quarter-note lands on the grid so the loop closes cleanly. */
function jamSyncDelayToBpm() {
  const ch = jam.chain;
  if (!ch || !audio.ctx) return;
  try {
    ch.delay.delayTime.setTargetAtTime((60 / jam.bpm) * 1.0, audio.ctx.currentTime, 0.1);
    if (ch.synthFx) ch.synthFx.updateTempo(jam.bpm); // build 64: synth delay follows too
  } catch (e) { /* ignore */ }
}

/* Render one LEAD note through the shared-voice builder. Every note
   spawns fresh nodes — no voice stealing, so overlapping notes from
   several jammers just layer. Subtle per-note stereo spread. */
function jamRenderNote(midi, vel, audioTime, patch) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  jamVoicesSpawned++;
  const s = jam.synth;
  const P = patch || {};
  jam.lastVoice = { inst: 'lead', wave: P.w || s.wave };
  playSynthNote(ctx, jamDestFor('lead'), {
    midi,
    vel,
    time: audioTime,
    wave: P.w || s.wave,
    wave2: P.w2 || s.wave2,
    osc2mix: P.o2 != null ? P.o2 : s.osc2mix,
    cutoff: P.c || s.cutoff,
    resonance: P.r != null ? P.r : s.reso,
    env: P.e != null ? P.e : s.env,
    decay: P.d || s.decay,
    attack: P.a || s.attack,
    sustain: P.su != null ? P.su : s.sustain,
    release: P.rl != null ? P.rl : s.release,
    sub: P.s != null ? P.s : s.sub,
    spread: P.sp != null ? P.sp : s.spread,
    echo: P.x != null ? P.x : s.echo,
    lfoRate: P.lr || s.lfoRate,
    lfoPitch: P.lp != null ? P.lp : s.lfoPitch,
    lfoFilter: P.lf != null ? P.lf : s.lfoFilter,
    // glide is a local performance feel — remote notes render straight.
    sends: jamSynthSends(P.x != null ? P.x : s.echo),
  });
}
/* Build 63: local held notes — sustain while the finger is down, release
 * on lift. This is the real-synth feel; the room hears note on/off too. */
const jamHeldVoices = new Map(); // pointerId -> {voiceId, midi}
function jamNoteOnLocal(midi, vel = 0.9) {
  audioEnsureRunning(); // key taps are gestures — iOS resumes here
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return 0;
  const s = jam.synth;
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const glideFrom = s.glide > 0.005 ? jam.glideFrom : 0;
  jam.glideFrom = f;
  const id = synthNoteOn(ctx, jamDestFor('lead'), {
    midi, vel, time: ctx.currentTime + 0.01,
    osc1: { wave: s.wave, oct: 0, detune: -s.spread / 2, level: 0.85 },
    osc2: { wave: s.wave2, oct: 0, detune: s.spread / 2, level: s.osc2mix },
    sub: s.sub, cutoff: s.cutoff, reso: s.reso,
    fAmt: s.env, fA: 0.01, fD: 0.25, fS: 0.4, fR: 0.25,
    aA: s.attack, aD: s.decay, aS: s.sustain, aR: s.release,
    lfoRate: s.lfoRate, lfoPitch: s.lfoPitch, lfoFilter: s.lfoFilter,
    glide: s.glide, fromFreq: glideFrom,
    echo: s.echo, sends: jamSynthSends(s.echo),
  });
  if (!id) return 0;
  jamVoicesSpawned++;
  jam.lastVoice = { inst: 'lead', wave: s.wave };
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 0.25) : null;
  jamBroadcastNote({ midi, vel, beat, inst: 'lead', patch: jamLeadPatch(), on: 1 });
  jamMarkJammer(myName, 'lead');
  renderJamJammers();
  return id;
}
function jamNoteOffLocal(pointerId) {
  const rec = jamHeldVoices.get(pointerId);
  if (!rec) return;
  jamHeldVoices.delete(pointerId);
  const ctx = audio.ctx;
  if (ctx && rec.voiceId) synthNoteOff(ctx, rec.voiceId, 0);
  jamBroadcastNote({ midi: rec.midi, inst: 'lead', off: 1 });
}

/* Per-voice echo destinations: the game's own delay + reverb. Called with
   the note's echo amount; empty when the chain isn't built yet (the voice
   still gets the bus's global sends through jamDestFor). */
function jamSynthSends(echoAmt) {
  const ch = jam.chain;
  if (!ch || !ch.delay || !ch.conv) return [];
  const e = Math.max(0, Math.min(1, Number(echoAmt) || 0));
  if (e <= 0.01) return [];
  return [
    { node: ch.delay, gain: 0.55 },
    { node: ch.conv, gain: 0.45 },
  ];
}

function jamRenderBass(midi, vel, audioTime) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  jamVoicesSpawned++;
  jam.lastVoice = { inst: 'bass', midi };
  playBassNote(ctx, jamDestFor('bass'), { midi, vel, time: audioTime });
}

function jamDrumVariant(drum) {
  const vi = jam.drumVariant && jam.drumVariant[drum];
  return Math.max(0, Math.min(drumVariantCount(drum) - 1, vi | 0));
}
function jamRenderDrum(drum, vel, audioTime, variant) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  jamVoicesSpawned++;
  jam.lastVoice = { inst: 'drums', drum };
  const vi = variant != null ? variant : jamDrumVariant(drum);
  playDrumSample(ctx, jamDestFor('drums'), { drum, variant: vi, vel, time: audioTime });
}

function jamRenderChord(chord, vel, audioTime) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  jamVoicesSpawned++;
  jam.lastVoice = { inst: 'pad', chord };
  playPadChord(ctx, jamDestFor('pad'), { chord, vel, time: audioTime });
}

/* Route an inbound event to the SENDER's instrument voice — never the
   receiver's. d = {inst, midi, vel, drum, chord, patch}. */
/* Build 63: sustained remote lead voices, keyed by peer+midi. A lost
 * note-off can't drone forever — every held note auto-releases at 8s. */
const jamRemoteVoices = new Map(); // `${peerId}:${midi}` -> {id, timer}
function jamRemoteVoiceKey(peerId, midi) { return String(peerId || '?') + ':' + midi; }
function jamRemoteNoteOn(peerId, midi, vel, audioTime, patch) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  jamRemoteNoteOff(peerId, midi);
  const s = jam.synth;
  const id = synthNoteOn(ctx, jamDestFor('lead'), {
    midi, vel, time: audioTime,
    osc1: { wave: patch.w, oct: 0, detune: -patch.sp / 2, level: 0.85 },
    osc2: { wave: patch.w2, oct: 0, detune: patch.sp / 2, level: patch.o2 },
    sub: patch.s, cutoff: patch.c, reso: patch.r,
    fAmt: patch.e, fA: 0.01, fD: 0.25, fS: 0.4, fR: 0.25,
    aA: patch.a, aD: patch.d, aS: patch.su, aR: patch.rl,
    lfoRate: patch.lr, lfoPitch: patch.lp, lfoFilter: patch.lf,
    echo: patch.x, sends: jamSynthSends(patch.x),
  });
  if (!id) return;
  jamVoicesSpawned++;
  jam.lastVoice = { inst: 'lead', wave: patch.w };
  const key = jamRemoteVoiceKey(peerId, midi);
  const timer = setTimeout(() => jamRemoteNoteOff(peerId, midi), 8000);
  jamRemoteVoices.set(key, { id, timer });
}
function jamRemoteNoteOff(peerId, midi) {
  const key = jamRemoteVoiceKey(peerId, midi);
  const rec = jamRemoteVoices.get(key);
  if (!rec) return;
  jamRemoteVoices.delete(key);
  clearTimeout(rec.timer);
  const ctx = audio.ctx;
  if (ctx) synthNoteOff(ctx, rec.id, 0);
}
function jamRenderRemote(d, audioTime, peerId) {
  const inst = JAM_INSTRUMENTS[d.inst] ? d.inst : 'lead';
  const vel = d.vel;
  if (inst === 'drums') {
    if (JAM_DRUMS.includes(d.drum)) jamRenderDrum(d.drum, vel, audioTime, Number.isInteger(d.dv) ? d.dv : 0);
  } else if (inst === 'pad') {
    const c = Number(d.chord);
    if (Number.isInteger(c) && c >= 0 && c < JAM_CHORDS.length) jamRenderChord(c, vel, audioTime);
  } else if (inst === 'bass') {
    jamRenderNoteBassSafe(d.midi, vel, audioTime);
  } else {
    // build 39: notes carry a patch object; pre-39 clients sent flat w/c/r.
    // build 63: `on` marks a held note — sustain it until the note-off lands.
    const patch = d.patch || ((d.w || d.c || d.r != null) ? { w: d.w, c: d.c, r: d.r } : null);
    if (d.on && peerId) jamRemoteNoteOn(peerId, d.midi, vel, audioTime, jamPatchFromBroadcast(patch || {}, d));
    else jamRenderNote(d.midi, vel, audioTime, patch);
  }
}

function jamRenderNoteBassSafe(midi, vel, audioTime) {
  const m = Math.max(0, Math.min(127, Math.round(Number(midi) || 48)));
  jamRenderBass(m, vel, audioTime);
}

/* YOUR note: plays locally immediately (zero latency for you) and
   broadcasts quantized to the next 16th so the room hears it on-grid.
   `kind` selects the instrument; every broadcast carries inst so peers
   render your voice, not theirs. */
function jamBroadcastNote(payload) {
  if (active && active.key === SOUND_ROOM_KEY) jamEnsureClock();
  if (net.enabled && net.sendJamNote && active && active.key === SOUND_ROOM_KEY) {
    try {
      net.sendJamNote({ n: myName, inst: jam.instrument, ...payload });
    } catch (e) { /* ignore */ }
  }
}

/* The player's current patch, packed for the wire — the room hears YOUR
   voice. (glide/fromFreq stay local; old clients ignore new fields.) */
function jamLeadPatch() {
  const s = jam.synth;
  return {
    w: s.wave, w2: s.wave2, o2: s.osc2mix,
    c: Math.round(s.cutoff), r: s.reso,
    e: s.env, d: s.decay, a: s.attack, su: s.sustain, rl: s.release,
    s: s.sub, sp: s.spread, x: s.echo,
    lr: s.lfoRate, lp: s.lfoPitch, lf: s.lfoFilter,
  };
}
/* Build 63: the full patch a remote note carries (flat, broadcast-safe). */
function jamPatchFromBroadcast(p, d) {
  const pick = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  return {
    w: ['sawtooth', 'square', 'triangle', 'mix'].includes(p.w || d.w) ? (p.w || d.w) : 'sawtooth',
    w2: ['sawtooth', 'square', 'triangle'].includes(p.w2) ? p.w2 : 'sawtooth',
    o2: pick(p.o2, 0.45),
    c: pick(p.c != null ? p.c : d.c, 1800),
    r: pick(p.r != null ? p.r : d.r, 5),
    e: pick(p.e, 0.35), d: pick(p.d, 0.4), a: pick(p.a, 0.008),
    su: pick(p.su, 0.7), rl: pick(p.rl, 0.3),
    s: pick(p.s, 0), sp: pick(p.sp, 12), x: pick(p.x, 0.3),
    lr: pick(p.lr, 5), lp: pick(p.lp, 0), lf: pick(p.lf, 0),
  };
}
function jamBroadcastLeadNote(midi, vel, patch) {
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 0.25) : null;
  jamBroadcastNote({ midi, vel, beat, inst: 'lead', patch });
  jamMarkJammer(myName, 'lead');
  renderJamJammers();
}
function jamPlayLocal(midi, vel = 0.9) {
  audioEnsureRunning(); // pad taps are gestures — iOS resumes the context here
  const ctx = audio.ctx;
  // Portamento: glide from the last lead note's pitch (local feel only —
  // the room hears each note straight, no slide).
  const s = jam.synth;
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const glideFrom = s.glide > 0.005 ? jam.glideFrom : 0;
  jam.glideFrom = f;
  const patch = jamLeadPatch();
  jamRenderNote(midi, vel, ctx ? ctx.currentTime + 0.01 : 0,
    { ...patch, glide: s.glide, fromFreq: glideFrom });
  jamBroadcastLeadNote(midi, vel, patch);
}

/* One-touch chords on the lead (build 39): every note of the triad rides
   the player's patch, so chords sound like YOUR voice, not a preset.
   A breath of stagger — strummed, not stepped — and the room hears all
   three notes on the same beat. */
function jamPlayChordLocal(midis, vel = 0.85) {
  if (!Array.isArray(midis) || !midis.length) return;
  audioEnsureRunning();
  const ctx = audio.ctx;
  const t = ctx ? ctx.currentTime + 0.01 : 0;
  const patch = jamLeadPatch();
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 0.25) : null;
  midis.forEach((m, i) => {
    const v = i === 0 ? vel : vel * 0.92;
    jamRenderNote(m, v, t + i * 0.012, patch);
    jamBroadcastNote({ midi: m, vel: v, beat, inst: 'lead', patch });
  });
  const top = Math.max(...midis);
  jam.glideFrom = 440 * Math.pow(2, (top - 69) / 12);
  jamMarkJammer(myName, 'lead');
  renderJamJammers();
}

function jamPlayBassLocal(midi, vel = 0.9) {
  audioEnsureRunning(); // pad taps are gestures — iOS resumes the context here
  const ctx = audio.ctx;
  jamRenderBass(midi, vel, ctx ? ctx.currentTime + 0.01 : 0);
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 0.25) : null;
  jamBroadcastNote({ midi, vel, beat, inst: 'bass' });
  jamMarkJammer(myName, 'bass');
  renderJamJammers();
}

function jamHitDrumLocal(drum, vel = 0.95) {
  audioEnsureRunning(); // pad taps are gestures — iOS resumes the context here
  if (!JAM_DRUMS.includes(drum)) return;
  const ctx = audio.ctx;
  const vi = jamDrumVariant(drum);
  jamRenderDrum(drum, vel, ctx ? ctx.currentTime + 0.01 : 0, vi);
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 0.25) : null;
  jamBroadcastNote({ midi: JAM_DRUMS.indexOf(drum), vel, beat, inst: 'drums', drum, dv: vi });
  jamMarkJammer(myName, 'drums');
  renderJamJammers();
}

/* Build 47: chord readout — when anyone (you or a jammer) plays a chord,
   the transport shows its name big. The pink pad flash stays; this is the
   part you can actually read. */
const jamChordDispEl = document.getElementById('jam-chord-disp');
const jamChordWhoEl = document.getElementById('jam-chord-who');
function jamShowChord(name, who) {
  if (!jamChordDispEl) return;
  jamChordDispEl.textContent = String(name || '–');
  if (jamChordWhoEl) jamChordWhoEl.textContent = String(who || 'CHORD').toUpperCase().slice(0, 16);
  // re-trigger the pop animation
  jamChordDispEl.classList.remove('hit');
  void jamChordDispEl.offsetWidth;
  jamChordDispEl.classList.add('hit');
}

/* Chord stabs quantize to the bar — changes land like an arrangement. */
function jamHitChordLocal(chord, vel = 0.85) {
  audioEnsureRunning(); // pad taps are gestures — iOS resumes the context here
  chord = Math.max(0, Math.min(JAM_CHORDS.length - 1, chord | 0));
  const ctx = audio.ctx;
  jamRenderChord(chord, vel, ctx ? ctx.currentTime + 0.01 : 0);
  jamShowChord(JAM_CHORDS[chord].name, myName);
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 4) : null;
  jamBroadcastNote({ midi: 48, vel, beat, inst: 'pad', chord });
  jamMarkJammer(myName, 'pad');
  renderJamJammers();
}

/* Someone else's note: schedule it on the grid (or play now, free-time).
   Routes to the SENDER's instrument voice — the inst rides the message.
   Their wisp glow takes their instrument's color (jam notes only exist
   in the sound room, so the peer is here with us). */
function handleJamNote(peerId, d) {
  if (!d || !Number.isFinite(Number(d.midi))) return;
  const midi = Math.max(0, Math.min(127, Math.round(Number(d.midi))));
  const vel = Math.max(0.05, Math.min(1.2, Number(d.vel) || 0.9));
  const name = String(d.n || 'drifter').slice(0, 16);
  const beat = d.beat == null ? null : Number(d.beat);
  const inst = JAM_INSTRUMENTS[d.inst] ? d.inst : 'lead';
  // build 39: notes carry a nested patch object; pre-39 clients sent flat w/c/r.
  const p = (d.patch && typeof d.patch === 'object') ? d.patch : {};
  const pick = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  const patch = jamPatchFromBroadcast(p, d);
  // build 63: note-off — release the sustained remote voice, if any.
  if (d.off && inst === 'lead') { jamRemoteNoteOff(peerId, midi); return; }
  const drum = JAM_DRUMS.includes(d.drum) ? d.drum : null;
  const chord = Number.isInteger(Number(d.chord)) ? Number(d.chord) : null;
  // build 47: a jammer's chord stab lights the readout with their name
  if (chord != null && JAM_CHORDS[chord]) jamShowChord(JAM_CHORDS[chord].name, name);
  jamMarkJammer(name, inst);
  renderJamJammers();
  if (peerId) {
    jamPeerInst.set(peerId, inst);
    const pv = peerVisuals.get(peerId);
    if (pv && pv.glow) {
      try { pv.glow.material.color.setHex(JAM_INSTRUMENTS[inst].glow); } catch (e) {}
    }
  }
  const remote = { inst, midi, vel, drum, chord, patch, on: d.on ? 1 : 0 };
  if (beat != null && Number.isFinite(beat) && jamBeatNow() != null) {
    jamEnqueue({ beat, play: (at) => jamRenderRemote(remote, at, peerId) });
  } else {
    jamRenderRemote(remote, audio.ctx ? audio.ctx.currentTime + 0.01 : 0, peerId);
  }
}

/* Pad trigger from a peer: play OUR local copy of that dub. Clients
   that never grabbed the loop have nothing in the slot — skipped
   silently. */
function handleJamPad(peerId, d) {
  if (!d || !Number.isInteger(d.pad) || d.pad < 0 || d.pad > 3) return;
  const name = String(d.n || 'drifter').slice(0, 16);
  const buf = jam.pads[d.pad];
  jamMarkJammer(name, peerId ? jamPeerInst.get(peerId) : undefined);
  renderJamJammers();
  if (!buf) return;
  const beat = d.beat == null ? null : Number(d.beat);
  if (beat != null && Number.isFinite(beat) && jamBeatNow() != null) {
    jamEnqueue({ beat, play: (at) => jamPlayPad(d.pad, at) });
  } else if (audio.ctx) {
    jamPlayPad(d.pad, audio.ctx.currentTime + 0.01);
  }
}

/* Clock from the room: only the current DJ's clock counts. Stale clocks
   from a deposed DJ are ignored — the new DJ's grid takes over. */
function handleJamClock(peerId, d) {
  if (!d || !Number.isFinite(Number(d.bpm)) || !Number.isFinite(Number(d.startWall))) return;
  if (peerId && net.clientId && String(peerId) === String(net.clientId)) return; // never follow our own echo
  const t = Number(d.t) || 0;
  if (jam.startWall != null && t < (jam.clockMsgT || 0)) return; // stale: a newer grid already won
  jam.bpm = Math.max(60, Math.min(200, Number(d.bpm)));
  jam.startWall = Number(d.startWall);
  jam.clockBy = String(d.by || 'drifter').slice(0, 16);
  jam.clockMsgT = t;
  jam.clockLastRemote = Date.now();
  jamSyncDelayToBpm();
  renderJamTransport();
}

/* Clock leadership (build 28): with no DJ, the grid is whoever's is
   freshest. We hold the clock when no one else's has been heard recently;
   only the holder re-broadcasts, so the room converges instead of fighting. */
function jamClockOurs() {
  return Date.now() - (jam.clockLastRemote || 0) > 20000;
}

function jamBroadcastClock() {
  if (!net.enabled || !net.sendJamClock) return;
  if (jam.startWall == null) return;
  if (!jamClockOurs()) return; // someone fresher holds the grid
  const t = Date.now();
  jam.clockMsgT = t;
  jam.clockBy = myName;
  try {
    net.sendJamClock({ bpm: jam.bpm, startWall: jam.startWall, by: myName, t });
  } catch (e) { /* ignore */ }
}

/* The grid starts when the music starts: the first local note with no
   clock running claims a fresh clock and tells the room. */
function jamEnsureClock() {
  if (jam.startWall != null) return;
  jam.manual = false;
  jam.detector = new OnsetDetector();
  jam.detStable = 0;
  jam.detLast = null;
  jamTaps = [];
  jam.startWall = Date.now();
  jam.clockBy = myName;
  jam.clockMsgT = jam.startWall;
  jamBroadcastClock();
  renderJamTransport();
}

/* Set the tempo. Phase-preserving: the grid doesn't jump — the current
   beat stays continuous under the new BPM. */
function jamSetBpm(bpm, opts = {}) {
  const { manual = false, broadcast = true } = opts;
  bpm = Math.max(60, Math.min(200, Math.round(Number(bpm) * 10) / 10));
  if (!Number.isFinite(bpm)) return;
  const nowBeat = jamBeatNow();
  jam.bpm = bpm;
  jam.startWall = Date.now() - (nowBeat != null ? nowBeat : 0) * (60000 / bpm);
  if (manual) jam.manual = true; // DJ override pauses auto-detect for the session
  if (broadcast) jamBroadcastClock();
  jamSyncDelayToBpm(); // the dotted-eighth stays musical
  renderJamTransport();
}

function jamStopClock() {
  jam.startWall = null;
  jam.clockBy = null;
  renderJamTransport();
}

/* Tap tempo: 3+ taps set the BPM from the median interval. Any manual
   tempo move pauses auto-detect for the rest of the session. */
function jamTapTempo() {
  const now = Date.now();
  if (jamTaps.length && now - jamTaps[jamTaps.length - 1] > 2000) jamTaps = [];
  jamTaps.push(now);
  if (jamTaps.length > 6) jamTaps.shift();
  if (jamTaps.length >= 3) {
    const iv = [];
    for (let i = 1; i < jamTaps.length; i++) iv.push(jamTaps[i] - jamTaps[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    if (med > 240 && med < 1200) jamSetBpm(60000 / med, { manual: true });
  }
  if (jamTapEl) {
    jamTapEl.classList.add('tapped');
    setTimeout(() => jamTapEl.classList.remove('tapped'), 120);
  }
}

/* Auto-BPM: once a second, feed an analyser to the onset detector and
   adopt a stable new estimate. Runs only while we hold the clock, and
   only until a manual override. Build 46: when "listen" is on, the
   analyser is the mic's — the mic hears the jukebox (phone speaker /
   room PA), so the tempo follows the track, not just our instruments. */
function jamDetectTick() {
  if (jam.manual) return;
  if (!(active && active.key === SOUND_ROOM_KEY)) return;
  if (!jamClockOurs()) return; // only the clock holder auto-detects
  let an = null;
  if (jam.listen && jamMic.on && jamMic.analyser) {
    an = jamMic.analyser; // listening to the jukebox through the room
  } else {
    const ra = roomAnalyserGet(true);
    an = ra && ra.analyser;
  }
  if (!an) return;
  if (!jam.detector) jam.detector = new OnsetDetector();
  const est = estimateBpm(jam.detector.process(an));
  if (est == null) return;
  const r = Math.round(est);
  if (Math.abs(r - Math.round(jam.bpm)) <= 2) {
    jam.detStable = 0;
    jam.detLast = null;
    return;
  }
  if (jam.detLast === r) jam.detStable++;
  else { jam.detLast = r; jam.detStable = 1; }
  // Adopt only if the estimate persists ~4s — no jumpy tempos.
  if (jam.detStable >= 4) {
    jamSetBpm(r);
    jam.detStable = 0;
    jam.detLast = null;
  }
}
setInterval(jamDetectTick, 1000);
/* Build 28: the shared grid re-broadcasts every 15s so late joiners land
   on the beat (replaces the old DJ heartbeat). */
setInterval(() => {
  try { if (active && active.key === SOUND_ROOM_KEY) jamBroadcastClock(); } catch (e) {}
}, 15000);

/* ---------------- sampler: ring buffer on the jam bus ----------------
   A ScriptProcessorNode taps the jam master bus (post-limiter: jam +
   jukebox + mic, i.e. what the room hears) into a 12s mono ring
   buffer. "Grab loop" copies the last 2 bars into the next pad — aligned
   to the most recent 2-bar boundary when the beat clock is on, so the pad
   starts exactly on a bar line and loops cleanly (build 17; before that,
   grabs ended at wall-clock "now" and always started mid-beat). With no
   clock the grab is 4s of free time, unchanged. ScriptProcessor is
   deprecated but universally supported; an AudioWorklet ring would be the
   upgrade path — capture latency is irrelevant here since we only ever
   read the buffer on demand. */

function jamStopRecorder() {
  const rec = jam.rec;
  jam.rec = null;
  if (!rec) return;
  try { rec.proc.onaudioprocess = null; } catch (e) {}
  try { if (rec.bus && rec.tap) rec.bus.disconnect(rec.tap); } catch (e) {}
  try { rec.src.disconnect(); } catch (e) {}
  try { rec.proc.disconnect(); } catch (e) {}
  try { rec.sink.disconnect(); } catch (e) {}
}

function jamEnsureRecorder() {
  const ch = jamEnsureChain();
  if (!ch || !ch.comp) return null;
  if (jam.rec && jam.rec.bus === ch.comp) return jam.rec;
  jamStopRecorder();
  try {
    const ctx = audio.ctx;
    if (!ctx || typeof ctx.createScriptProcessor !== 'function') return null;
    // Tap head straight on the post-limiter bus: the ring hears the whole
    // local room mix (jam + jukebox + mic), exactly what the room hears.
    const tap = ctx.createGain();
    tap.gain.value = 1;
    ch.comp.connect(tap);
    const src = tap;
    const proc = ctx.createScriptProcessor(4096, 2, 1);
    const ringLen = Math.floor(ctx.sampleRate * 12);
    const rec = { bus: ch.comp, tap, ctx, src, proc, ring: new Float32Array(ringLen), w: 0, total: 0, sink: null };
    const sink = ctx.createGain();
    sink.gain.value = 0; // ScriptProcessor needs a connected output to run
    rec.sink = sink;
    proc.onaudioprocess = (e) => {
      const ib = e.inputBuffer;
      const c0 = ib.getChannelData(0);
      const c1 = ib.numberOfChannels > 1 ? ib.getChannelData(1) : null;
      for (let i = 0; i < c0.length; i++) {
        rec.ring[rec.w] = c1 ? (c0[i] + c1[i]) * 0.5 : c0[i];
        rec.w = (rec.w + 1) % ringLen;
        rec.total++;
      }
    };
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    jam.rec = rec;
    return rec;
  } catch (e) {
    return null;
  }
}

function jamGrabLoop() {
  const rec = jamEnsureRecorder();
  if (!rec) {
    showUnlockToast(['nothing to sample yet \u{1F3A7}']);
    renderJamSamplerHint();
    return false;
  }
  const beatNow = jamBeatNow();
  const clockOn = beatNow != null;
  const bpm = jam.bpm;
  const lenSec = clockOn ? (8 * 60) / bpm : 4; // 2 bars, or 4s free-time
  const ctx = rec.ctx;
  const L = rec.ring.length;
  const n = Math.max(1, Math.min(Math.floor(lenSec * ctx.sampleRate), L));
  // Tight grabs (build 17): "now" is almost never on a bar line, so ending
  // the grab at wall-clock time starts every loop mid-beat. Instead, end at
  // the most recent 2-bar boundary: phase the beat clock into samples and
  // step back from the write cursor. Falls back to the old unaligned grab
  // when the clock is off, the bpm is unusable, or the recorder hasn't
  // captured enough history to reach the boundary yet.
  let endIdx = rec.w;
  let aligned = false;
  if (clockOn && Number.isFinite(bpm) && bpm > 0) {
    const samplesPerBeat = ctx.sampleRate * 60 / bpm;
    const phaseSamples = Math.round((beatNow % 8) * samplesPerBeat); // 8 beats = 2 bars, 4/4
    if (phaseSamples >= 0 && rec.total >= n + phaseSamples) {
      endIdx = (((rec.w - phaseSamples) % L) + L) % L;
      aligned = true;
    }
  }
  jam.lastGrab = { aligned, endIdx, n, w: rec.w, total: rec.total, bpm: clockOn ? bpm : null };
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const out = buf.getChannelData(0);
  let r = (((endIdx - n) % L) + L) % L;
  for (let i = 0; i < n; i++) {
    out[i] = rec.ring[r];
    r = (r + 1) % L;
  }
  const slot = jam.padRound;
  jam.pads[slot] = buf;
  jam.lastGrabSlot = slot; // build 25 test seam
  jam.padRound = (jam.padRound + 1) % jam.pads.length;
  addSystemLine(`loop grabbed — pad ${slot + 1} is loaded`);
  renderJamPads();
  renderJamSamplerHint();
  return true;
}

/* ---------------- room sampler: capture the jukebox (build 24) ------------
   The jukebox plays through YouTube/SoundCloud IFRAMES, whose audio is
   completely invisible to page JavaScript (no WebAudio node, no
   captureStream — nothing). So "sample the jukebox" means capturing the
   whole room mix (jukebox + jam + mic) via the only browser-native path:
   tab-audio capture with getDisplayMedia. That API exists on desktop
   Chrome/Edge only — mobile browsers offer no tab-audio track at all, so
   on phones the button explains itself honestly instead of failing
   silently. The captured stream is recorded with MediaRecorder and NEVER
   touches the WebAudio graph, so it can never feed back into the
   speakers. */
const ROOM_DESKTOP_NOTE =
  'Room sampling needs Chrome or Edge on desktop — phones can\u2019t capture the embedded player\u2019s audio.';
jam.room = { sampling: false, requesting: false, lastCapture: null, lenOverride: null };

function jamRoomSupported() {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
    typeof window.MediaRecorder === 'function'
  );
}

function jamRoomGrabLenSec() {
  if (jam.room.lenOverride != null) return jam.room.lenOverride;
  const beatNow = jamBeatNow();
  return beatNow != null && Number.isFinite(jam.bpm) && jam.bpm > 0 ? (8 * 60) / jam.bpm : 4;
}

function jamRenderRoomNote() {
  if (!jamRoomNoteEl) return;
  if (jamRoomSupported()) {
    jamRoomNoteEl.hidden = true;
    jamRoomNoteEl.textContent = '';
    return;
  }
  jamRoomNoteEl.hidden = false;
  jamRoomNoteEl.textContent = ROOM_DESKTOP_NOTE;
}

function jamRoomCount(sec) {
  if (!jamGrabRoomEl) return;
  if (sec == null) {
    jamGrabRoomEl.innerHTML = '&#127908; sample the room';
    return;
  }
  jamGrabRoomEl.textContent = `\u25CF rec ${Math.ceil(sec)}s`;
}

function jamRoomStopStream(stream) {
  if (!stream) return;
  try {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (e) {}
    });
  } catch (e) {}
}

async function jamRoomSample() {
  if (jam.room.sampling || jam.room.requesting) return false; // double-tap guard
  if (!jamRoomSupported()) {
    jamRenderRoomNote();
    showUnlockToast([ROOM_DESKTOP_NOTE]);
    return false;
  }
  jam.room.requesting = true;
  const doneRequesting = () => { jam.room.requesting = false; };
  let stream = null;
  try {
    try {
      // Audio-only first: the picker stays simple and honest.
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
    } catch (e1) {
      // Older Chrome builds only offer tab audio when video is requested too;
      // the video track is stopped immediately — we never look at it.
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    }
  } catch (e) {
    doneRequesting();
    const n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      showUnlockToast(['tab capture blocked \u2014 check the browser prompt \u{1F3A7}']);
    } else {
      showUnlockToast(['room capture cancelled']);
    }
    return false;
  }
  stream.getVideoTracks().forEach((t) => {
    try {
      t.stop();
    } catch (e) {}
  });
  if (!stream.getAudioTracks().length) {
    doneRequesting();
    jamRoomStopStream(stream);
    showUnlockToast(['no audio from that tab \u2014 pick the LIMBO tab and enable tab audio']);
    return false;
  }
  const ctx = audio.ctx;
  if (!ctx || typeof ctx.decodeAudioData !== 'function') {
    doneRequesting();
    jamRoomStopStream(stream);
    showUnlockToast(['audio isn\u2019t ready yet \u2014 tap something in the room first']);
    return false;
  }
  let mr = null;
  try {
    mr = new MediaRecorder(stream);
  } catch (e) {
    doneRequesting();
    jamRoomStopStream(stream);
    showUnlockToast(['this browser can\u2019t record tab audio']);
    return false;
  }
  doneRequesting();
  const lenSec = jamRoomGrabLenSec();
  const chunks = [];
  const mime = mr.mimeType || '';
  jam.room.sampling = true;
  if (jamGrabRoomEl) {
    jamGrabRoomEl.disabled = true;
    jamGrabRoomEl.classList.add('rec');
  }
  jamRoomCount(lenSec);
  const stopped = new Promise((resolve) => {
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    mr.onstop = () => resolve();
    mr.onerror = () => resolve();
  });
  let remaining = lenSec;
  const countTick = setInterval(() => {
    remaining -= 0.25;
    if (remaining <= 0) {
      clearInterval(countTick);
      try {
        mr.stop();
      } catch (e) {}
    } else {
      jamRoomCount(remaining);
    }
  }, 250);
  // hard safety net in case the interval stalls
  setTimeout(() => {
    try {
      mr.stop();
    } catch (e) {}
  }, (lenSec + 3) * 1000);
  try {
    mr.start(250);
  } catch (e) {
    clearInterval(countTick);
    jamRoomStopStream(stream);
    jam.room.sampling = false;
    if (jamGrabRoomEl) {
      jamGrabRoomEl.disabled = false;
      jamGrabRoomEl.classList.remove('rec');
    }
    jamRoomCount(null);
    showUnlockToast(['this browser can\u2019t record tab audio']);
    return false;
  }
  await stopped;
  clearInterval(countTick);
  jamRoomStopStream(stream); // release the share the instant we have the take
  try {
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    const ab = await blob.arrayBuffer();
    // The take never entered the WebAudio graph (MediaRecorder only), so
    // connectedToDestination is false by construction — no feedback possible.
    const buf = await ctx.decodeAudioData(ab.slice(0));
    const slot = jam.padRound;
    jam.pads[slot] = buf;
    jam.padRound = (jam.padRound + 1) % jam.pads.length;
    jam.room.lastCapture = {
      pad: slot,
      length: buf.length,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      mime,
      lenSec,
      connectedToDestination: false,
    };
    addSystemLine(`room sampled \u2014 pad ${slot + 1} is loaded`);
    renderJamPads();
  } catch (e) {
    showUnlockToast(['couldn\u2019t decode that take \u2014 try again']);
  }
  jam.room.sampling = false;
  if (jamGrabRoomEl) {
    jamGrabRoomEl.disabled = false;
    jamGrabRoomEl.classList.remove('rec');
  }
  jamRoomCount(null);
  renderJamSamplerHint();
  return true;
}

function jamPlayPad(i, audioTime) {
  const ctx = audio.ctx;
  const buf = jam.pads[i];
  if (!ctx || !buf || !audio.master) return;
  try {
    const t = Math.max(audioTime || 0, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.85;
    src.connect(g);
    g.connect(jamDestFor('pad')); // through the jam bus: room sound, not dry
    src.start(t);
  } catch (e) { /* ignore */ }
}

/* Tap a pad: quantized to the next bar (or immediately, no clock).
   The trigger is broadcast; every client plays its OWN local copy. */
function jamTriggerPad(i) {
  if (active && active.key === SOUND_ROOM_KEY) jamEnsureClock();
  if (!jam.pads[i]) {
    showUnlockToast(['pad empty — grab a loop first']);
    return false;
  }
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 4) : null;
  if (net.enabled && net.sendJamPad && active && active.key === SOUND_ROOM_KEY) {
    try {
      net.sendJamPad({ n: myName, pad: i, beat, lenBars: beatNow != null ? 2 : 0 });
    } catch (e) { /* ignore */ }
  }
  if (beat != null) jamEnqueue({ beat, play: (at) => jamPlayPad(i, at) });
  else if (audio.ctx) jamPlayPad(i, audio.ctx.currentTime + 0.01);
  jamMarkJammer(myName);
  renderJamJammers();
  return true;
}

/* ---------------- the loop (build 66: simplified) ---------------- */

const loopBtnEl = document.getElementById('jam-loop-btn');
const loopGlyphEl = document.getElementById('jam-loop-glyph');
const loopRingEl = document.getElementById('jam-loop-ring');
const loopStateEl = document.getElementById('jam-loop-state');
const loopMetaEl = document.getElementById('jam-loop-meta');
const LOOP_RING_C = 2 * Math.PI * 27;

function loopStopCapture() {
  const tk = dub.take;
  dub.take = null;
  if (!tk) return;
  try { tk.proc.onaudioprocess = null; } catch (e) {}
  try { tk.tap.disconnect(); } catch (e) {}
  try { tk.proc.disconnect(); } catch (e) {}
  try { tk.sink.disconnect(); } catch (e) {}
}

/* Stereo capture of exactly `len` samples off the post-limiter bus,
   starting sample-accurately at `startAt` (blocks straddling the start
   are trimmed). Calls `done(L, R)` when the take is full. */
function loopStartCapture(startAt, len, done) {
  const ch = jamEnsureChain();
  const ctx = audio.ctx;
  if (!ch || !ctx || typeof ctx.createScriptProcessor !== 'function') return false;
  loopStopCapture();
  try {
    const tap = ctx.createGain();
    tap.gain.value = 1;
    ch.comp.connect(tap);
    const proc = ctx.createScriptProcessor(4096, 2, 2);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    const take = {
      proc, tap, sink, len,
      L: new Float32Array(len), R: new Float32Array(len), idx: 0,
    };
    dub.take = take;
    proc.onaudioprocess = (e) => {
      if (dub.take !== take) return;
      const bt = e.playbackTime;
      const ib = e.inputBuffer;
      const c0 = ib.getChannelData(0);
      const c1 = ib.numberOfChannels > 1 ? ib.getChannelData(1) : c0;
      const sr = ctx.sampleRate;
      let skip = 0;
      // Without a usable playbackTime we can't trim to the start -- record
      // from the first block instead of dropping everything.
      if (Number.isFinite(bt) && bt < startAt) {
        skip = Math.min(c0.length, Math.round((startAt - bt) * sr));
        if (skip >= c0.length) return; // whole block is before the start
      }
      const n = Math.min(c0.length - skip, take.len - take.idx);
      for (let i = 0; i < n; i++) {
        take.L[take.idx] = c0[skip + i];
        take.R[take.idx] = c1[skip + i];
        take.idx++;
      }
      // Keep the processor's output silent (the sink is zeroed anyway).
      const ob = e.outputBuffer;
      for (let chI = 0; chI < ob.numberOfChannels; chI++) {
        ob.getChannelData(chI).fill(0);
      }
      if (take.idx >= take.len) {
        loopStopCapture();
        try { done(take.L, take.R); } catch (err) { /* ignore */ }
      }
    };
    tap.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    return true;
  } catch (e) {
    loopStopCapture();
    return false;
  }
}

function loopStartPlayback(buf, atTime) {
  const ch = jamEnsureChain();
  const ctx = audio.ctx;
  if (!ch || !ctx || !buf) return false;
  loopStopPlayback();
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g);
    // build 40: the loop drifts through its own mixer fader, then the room bus
    g.connect((ch.gains && ch.gains.loop) || ch.bus); // space + limiter
    src.start(Math.max(atTime, ctx.currentTime + 0.01));
    dub.src = src;
    dub.srcGain = g;
    return true;
  } catch (e) {
    return false;
  }
}

function loopStopPlayback() {
  const src = dub.src;
  dub.src = null;
  dub.srcGain = null;
  if (!src) return;
  try { src.stop(); } catch (e) {}
  try { src.disconnect(); } catch (e) {}
}

/* The big button. Four moves, that's the whole looper. */
function loopMainButton() {
  audioEnsureRunning();
  if (!audio.ctx || !jamEnsureChain()) return false;
  if (dub.state === 'empty') return loopRecord();
  if (dub.state === 'recording') return loopClose();
  if (dub.state === 'playing') return loopStop();
  if (dub.state === 'stopped' && dub.buf) return loopPlay();
  return false;
}

/* Start a capture of the room mix. `done` fires when the take is full
   (ran the LOOP_MAX_SEC cap) -- a tap shuts it early via loopClose. */
function loopBeginCapture() {
  const ctx = audio.ctx;
  const len = Math.max(1, Math.round(LOOP_MAX_SEC * ctx.sampleRate));
  return loopStartCapture(ctx.currentTime + 0.05, len, (L, R) => {
    if (dub.state === 'recording') loopFinishFromArrays(L, R, L.length);
  });
}

/* Tap on empty: start recording, right now. */
function loopRecord() {
  if (dub.state !== 'empty' || !audio.ctx || !jamEnsureChain()) return false;
  if (!loopBeginCapture()) return false;
  dub.state = 'recording';
  loopRenderUI();
  return true;
}

/* Tap while recording: close the loop and start it looping. */
function loopClose() {
  if (dub.state !== 'recording' || !dub.take || !audio.ctx) return false;
  const take = dub.take;
  loopStopCapture();
  const idx = take.idx;
  if (idx < Math.floor(audio.ctx.sampleRate * 0.25)) {
    // A blip, not a loop -- keep recording.
    if (!loopBeginCapture()) { dub.state = 'empty'; loopRenderUI(); }
    return true;
  }
  return loopFinishFromArrays(take.L, take.R, idx);
}

/* Slice the take to what was actually played and start it looping. */
function loopFinishFromArrays(L, R, n) {
  const ctx = audio.ctx;
  if (!ctx) { dub.state = 'empty'; loopRenderUI(); return false; }
  try {
    const len = Math.max(1, n | 0);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    buf.getChannelData(0).set(L.subarray(0, len));
    buf.getChannelData(1).set(R.subarray(0, len));
    const at = ctx.currentTime + 0.05;
    if (!loopStartPlayback(buf, at)) { dub.state = 'empty'; loopRenderUI(); return false; }
    dub.buf = buf;
    dub.dur = len / ctx.sampleRate;
    dub.t0 = at;
    dub.state = 'playing';
  } catch (e) {
    dub.state = 'empty';
  }
  loopRenderUI();
  return dub.state === 'playing';
}

/* Tap while playing: rest the loop, keep the take. */
function loopStop() {
  loopStopCapture();
  loopStopPlayback();
  dub.state = dub.buf ? 'stopped' : 'empty';
  loopRenderUI();
  return true;
}

/* Tap while stopped: drift the loop again. */
function loopPlay() {
  if (!dub.buf || !audio.ctx) return false;
  const at = audio.ctx.currentTime + 0.05;
  if (!loopStartPlayback(dub.buf, at)) return false;
  dub.t0 = at;
  dub.state = 'playing';
  loopRenderUI();
  return true;
}

/* Hold: clear the loop entirely. */
function loopClear() {
  loopStopCapture();
  loopStopPlayback();
  dub.buf = null;
  dub.dur = 0;
  dub.t0 = 0;
  dub.state = 'empty';
  loopRenderUI();
  return true;
}

function loopRenderUI() {
  if (loopGlyphEl) {
    loopGlyphEl.innerHTML =
      dub.state === 'playing' ? '&#9632;' : // stop
      dub.state === 'stopped' ? '&#9654;' : // play
      '&#9679;';                            // record
  }
  if (loopBtnEl) {
    loopBtnEl.classList.toggle('rec', dub.state === 'recording');
    const aria = {
      empty: 'loop: tap to record',
      recording: 'loop: tap to close the loop',
      playing: 'loop: tap to stop',
      stopped: 'loop: tap to play again',
    };
    loopBtnEl.setAttribute('aria-label', aria[dub.state] || 'loop');
  }
  if (loopStateEl) {
    const m = {
      empty: 'tap &#9679; to record a loop',
      recording: 'recording &mdash; tap &#9679; to close the loop',
      playing: 'looping &mdash; tap &#9632; to stop',
      stopped: 'resting &mdash; tap &#9654; to play again',
    };
    loopStateEl.innerHTML = m[dub.state] || '';
  }
  if (loopMetaEl) {
    loopMetaEl.textContent = dub.buf
      ? `${dub.dur.toFixed(1)}s loop`
      : 'hold the button to clear';
  }
}

/* Progress ring, while the jam panel is open. */
function loopUiTick() {
  if (!jam.open) return;
  if (!loopRingEl || !audio.ctx) return;
  let pos = 0;
  const now = audio.ctx.currentTime;
  if (dub.state === 'recording' && dub.take) {
    pos = Math.min(1, dub.take.idx / Math.max(1, dub.take.len));
  } else if (dub.state === 'playing' && dub.dur > 0) {
    pos = ((now - dub.t0) / dub.dur) % 1;
    if (pos < 0) pos += 1;
  }
  loopRingEl.style.strokeDashoffset = String(LOOP_RING_C * (1 - pos));
}
function loopUiEnsure() {
  if (dub.uiRaf) return;
  const tick = () => {
    dub.uiRaf = 0;
    if (!jam.open) return;
    loopUiTick();
    dub.uiRaf = requestAnimationFrame(tick);
  };
  dub.uiRaf = requestAnimationFrame(tick);
}

/* Hold the big button to clear the loop; a plain tap runs the 4 moves. */
let loopHoldTimer = 0, loopHoldFired = false;
if (loopBtnEl) {
  loopBtnEl.addEventListener('pointerdown', () => {
    loopHoldFired = false;
    clearTimeout(loopHoldTimer);
    loopHoldTimer = setTimeout(() => { loopHoldFired = true; loopClear(); }, 800);
  });
  loopBtnEl.addEventListener('pointerup', () => clearTimeout(loopHoldTimer));
  loopBtnEl.addEventListener('pointercancel', () => clearTimeout(loopHoldTimer));
  loopBtnEl.addEventListener('pointerleave', () => clearTimeout(loopHoldTimer));
  loopBtnEl.addEventListener('click', () => {
    if (loopHoldFired) { loopHoldFired = false; loopBtnEl.blur(); return; }
    loopMainButton(); loopBtnEl.blur();
  });
}

/* ---------------- rhythm sequencer (build 39: optional beats) ----------------
 * A 16-step, 4-voice pattern player for the synthesized kit — OFF by
 * default, so the room's generative drift is untouched until YOU tap
 * "beats". Runs on jam.bpm and follows tap-tempo live; steps render
 * through the jam bus, so the overdub looper catches them like anything
 * else you play. Local only — never broadcast (your pattern, your room).
 * All drums are synthesized DSP: no samples, no downloads, works offline. */
const SEQ_VOICES = [
  { drum: 'kick', label: 'kick' },
  { drum: 'snare', label: 'snare' },
  { drum: 'chat', label: 'hat' },
  { drum: 'shaker', label: 'perc' },
];
const SEQ_PRESETS = {
  pulse: [
    [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],
    [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
    [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0],
    [0,0,0,0, 0,0,1,0, 0,0,0,0, 0,1,0,0],
  ],
  sway: [
    [1,0,0,1, 0,0,1,0, 0,0,1,0, 0,1,0,0],
    [0,0,0,0, 1,0,0,0, 0,0,0,1, 0,0,0,0],
    [0,0,1,0, 0,1,0,0, 1,0,0,1, 0,0,1,0],
    [0,0,0,0, 0,0,0,1, 0,0,0,0, 0,0,1,0],
  ],
  embers: [
    [1,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0],
    [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
    [1,0,0,1, 0,0,1,0, 0,1,0,0, 1,0,0,0],
    [0,0,0,0, 0,1,0,0, 0,0,0,0, 0,0,0,1],
  ],
};
const seq = {
  on: false, // the flock drifts free until you say otherwise
  steps: SEQ_PRESETS.pulse.map((row) => row.slice()), // a groove waiting
  swing: 0, // 0..0.6 — sway on the off-16ths
  step: 0, nextT: 0, hits: 0,
  lastShownStep: -1,
};
function seqStepDur() {
  return 60 / Math.max(40, Math.min(220, Number(jam.bpm) || 120)) / 4;
}
/* Lookahead scheduler: hits are placed ahead of time so they land on the
 * grid even if the tab hiccups. Reads jam.bpm live — tap-tempo bends the
 * groove without restarting it. */
function seqTick() {
  if (!seq.on || !audio.ctx || !audio.master) return;
  const ctx = audio.ctx;
  const stepDur = seqStepDur();
  // If the tab slept (screen lock), drop the missed steps and resume from
  // now — never machine-gun a catch-up burst.
  if (seq.nextT < ctx.currentTime - 0.5) {
    seq.step += Math.ceil((ctx.currentTime - seq.nextT) / stepDur);
    seq.nextT = ctx.currentTime + 0.05;
  }
  while (seq.nextT < ctx.currentTime + 0.15) {
    const s = seq.step % 16;
    const at = seq.nextT + (s % 2 === 1 ? seq.swing * stepDur : 0);
    for (let vi = 0; vi < SEQ_VOICES.length; vi++) {
      if (seq.steps[vi][s]) jamRenderDrum(SEQ_VOICES[vi].drum, vi === 0 ? 1 : 0.85, at);
    }
    seq.hits++;
    seq.step++;
    seq.nextT += stepDur;
  }
  if (jam.open) seqRenderStep();
}
setInterval(() => seqTick(), 25);
function seqSetOn(on) {
  seq.on = !!on;
  if (seq.on) {
    audioEnsureRunning(); // the toggle is a gesture — iOS resumes here
    jamEnsureChain();
    seq.step = 0;
    seq.lastShownStep = -1;
    seq.nextT = audio.ctx ? audio.ctx.currentTime + 0.08 : 0;
  }
  seqRenderUI();
}
function seqBuildGrid() {
  if (!jamSeqGridEl) return;
  jamSeqGridEl.innerHTML = '';
  SEQ_VOICES.forEach((v, vi) => {
    const row = document.createElement('div');
    row.className = 'jam-seq-row';
    const lab = document.createElement('span');
    lab.className = 'jam-seq-label';
    lab.textContent = v.label;
    row.appendChild(lab);
    for (let s = 0; s < 16; s++) {
      const b = document.createElement('button');
      b.className = 'jam-seq-step' + (s % 4 === 0 ? ' bar' : '');
      b.dataset.voice = vi;
      b.dataset.step = s;
      b.setAttribute('aria-label', v.label + ' step ' + (s + 1));
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        audioEnsureRunning();
        seq.steps[vi][s] = !seq.steps[vi][s];
        seqRenderSteps();
      });
      row.appendChild(b);
    }
    jamSeqGridEl.appendChild(row);
  });
  seqRenderSteps();
}
function seqRenderSteps() {
  if (!jamSeqGridEl) return;
  jamSeqGridEl.querySelectorAll('.jam-seq-step').forEach((b) => {
    const vi = Number(b.dataset.voice), s = Number(b.dataset.step);
    b.classList.toggle('on', !!seq.steps[vi][s]);
  });
}
/* Playhead highlight — the DOM is only touched when the step changes. */
function seqRenderStep() {
  if (!jamSeqGridEl) return;
  const s = (((seq.step - 1) % 16) + 16) % 16; // the step now sounding
  if (s === seq.lastShownStep) return;
  seq.lastShownStep = s;
  jamSeqGridEl.querySelectorAll('.jam-seq-step').forEach((b) => {
    b.classList.toggle('now', Number(b.dataset.step) === s);
  });
}
function seqRenderUI() {
  if (jamSeqToggleEl) {
    jamSeqToggleEl.classList.toggle('sel', seq.on);
    jamSeqToggleEl.innerHTML = seq.on ? 'beats &#9679;' : 'beats';
  }
  if (jamSeqBodyEl) jamSeqBodyEl.hidden = !seq.on;
  if (jamSeqStateEl) jamSeqStateEl.textContent = seq.on ? 'the flock keeps time' : 'the flock drifts free';
}
function seqApplyPreset(name) {
  const p = SEQ_PRESETS[name];
  if (!p) return;
  seq.steps = p.map((row) => row.slice());
  seqRenderSteps();
}
function seqClear() {
  seq.steps = SEQ_VOICES.map(() => new Array(16).fill(false));
  seqRenderSteps();
}

if (jamSeqToggleEl) jamSeqToggleEl.addEventListener('click', () => { seqSetOn(!seq.on); jamSeqToggleEl.blur(); });
if (jamSeqSwingEl) jamSeqSwingEl.addEventListener('input', () => { seq.swing = Number(jamSeqSwingEl.value) / 100; });
document.querySelectorAll('.jam-seq-preset').forEach((b) => {
  b.addEventListener('click', () => { seqApplyPreset(b.dataset.seqpreset); b.blur(); });
});
if (jamSeqClearEl) jamSeqClearEl.addEventListener('click', () => { seqClear(); jamSeqClearEl.blur(); });

/* ---------------- community wall (build 18; persistence: build 26) ----------------
   A shared 1024x512 paint canvas. One per client (not per room) so the
   art survives realm hops; a THREE.CanvasTexture shows it on a monumental
   wall plane inside the sound room. Strokes sync over Trystero; the room's
   lights drink the wall's colors (hues + paint energy, never content).
   Build 26: the wall remembers. A downscaled JPEG + timestamp is saved to
   localStorage after strokes land (debounced) and on pagehide; on boot the
   snapshot is redrawn before first render. When drifters meet in the sound
   room they exchange wallHello {ts} and only the NEWER wall answers with
   the wallSync JPEG — last-writer-wins, no server. */
const WALL_W = 1024, WALL_H = 512;
const WALL_BG = '#0b0b13';
const WALL_BG_RGB = [11, 11, 19];
const WALL_AMB_BASE = 0x99aacc; // sound room's default ambient tint
const wall = {
  canvas: null, ctx: null, tex: null,
  strokeCount: 0,      // local + remote strokes this session; >0 means "has ink"
  strokeTimes: [],     // Date.now() of recent strokes (5s activity window)
  texDirty: false,
  answeredReq: new Set(), // wallSyncReq ids we've already answered
  ts: 0,               // build 26: version time of my wall (last stroke/apply/restore)
  snapTimer: null,     // build 26: debounce timer for the localStorage snapshot
  snapKey: 'limbo-wall-v1', // build 26: localStorage key — never renamed, so the mural survives game updates
  // build 26 (undo): every stroke gets an id (per-session peer prefix +
  // counter). The wall is a flattened base canvas plus an undoable stroke
  // log; undo clears the canvas and replays base + remaining log.
  selfId: Math.random().toString(36).slice(2, 10),
  strokeSeq: 0,
  log: [],             // [{id, points, color, size, eraser, byMe}] — undoable strokes
  base: null, baseCtx: null, // flattened non-undoable mural underneath the log
  logCap: 500,         // over this, bake the log into the base (pixels kept, history dropped)
  lastLocalStroke: 0,  // Date.now() of my last local paint input — anti-stomp guard
  pendingSync: null,   // wallSync JPEG stashed while I was painting; applied once quiet
};
wall.canvas = document.createElement('canvas');
wall.canvas.width = WALL_W;
wall.canvas.height = WALL_H;
wall.ctx = wall.canvas.getContext('2d', { willReadFrequently: true });
wall.ctx.fillStyle = WALL_BG;
wall.ctx.fillRect(0, 0, WALL_W, WALL_H);
/* Build 26 (undo): the flattened base under the undoable log. Starts blank
   like the wall itself; wallRestoreSnapshot / wallApplySnapshot adopt a
   mural into it. */
wall.base = document.createElement('canvas');
wall.base.width = WALL_W;
wall.base.height = WALL_H;
wall.baseCtx = wall.base.getContext('2d');
wall.baseCtx.fillStyle = WALL_BG;
wall.baseCtx.fillRect(0, 0, WALL_W, WALL_H);
wall.tex = new THREE.CanvasTexture(wall.canvas);
wall.tex.colorSpace = THREE.SRGBColorSpace;

function wallMarkDirty() { wall.texDirty = true; }

function wallPruneTimes() {
  const now = Date.now();
  while (wall.strokeTimes.length && now - wall.strokeTimes[0] > 5000) wall.strokeTimes.shift();
}

/* The wall got newer paint: bump the version time and schedule the
   localStorage snapshot. Lightweight — called per stroke chunk/flush. */
function wallTouch() {
  wall.ts = Date.now(); // build 26: my wall just got newer
  wallScheduleSnapshot();
}

function wallNoteStroke() {
  wall.strokeCount++;
  wall.strokeTimes.push(Date.now());
  wallPruneTimes();
  wallMarkDirty();
  wallTouch();
}

/* Raw polyline draw — no bookkeeping. Callers note the stroke once per
   gesture/message. pts are normalized 0..1; size is wall pixels.
   blend (build 28): smudge what's already on the canvas instead of laying
   down a color — a real finger-paint, not a translucent overlay. */
function wallDrawSeg(pts, color, sizePx, blend) {
  if (blend) { wallDrawBlendSeg(pts, sizePx, wall.ctx); return; }
  const c = wall.ctx;
  if (!c || !pts || pts.length === 0) return;
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(1, sizePx);
  if (pts.length === 1) {
    c.beginPath();
    c.arc(pts[0][0] * WALL_W, pts[0][1] * WALL_H, sizePx / 2, 0, Math.PI * 2);
    c.fill();
  } else {
    c.beginPath();
    c.moveTo(pts[0][0] * WALL_W, pts[0][1] * WALL_H);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0] * WALL_W, pts[i][1] * WALL_H);
    c.stroke();
  }
  c.restore();
}

/* Build 28 (blend brush): sample a small box of the canvas and average it.
   The smudge brush paints with what it picks up — a real finger-paint. */
function wallSampleBox(ctx, x, y, half) {
  const sx = Math.max(0, Math.min(WALL_W - 1, Math.round(x - half)));
  const sy = Math.max(0, Math.min(WALL_H - 1, Math.round(y - half)));
  const sw = Math.max(1, Math.min(WALL_W - sx, half * 2 + 1));
  const sh = Math.max(1, Math.min(WALL_H - sy, half * 2 + 1));
  let d = null;
  try { d = ctx.getImageData(sx, sy, sw, sh).data; } catch (e) { return WALL_BG_RGB.slice(); }
  let r = 0, g = 0, b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return [r / n, g / n, b / n];
}

function wallStampSoft(ctx, x, y, r, rgb, alpha) {
  const col = `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},`;
  const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, col + alpha + ')');
  gr.addColorStop(0.65, col + (alpha * 0.55) + ')');
  gr.addColorStop(1, col + '0)');
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/* The smudge: drags the paint that's already on the canvas. The brush
   picks up the average color under each dab and mixes it into what it's
   carrying, then stamps a soft dab of the mix. The same algorithm runs
   for local, remote, and replayed strokes, so every client renders the
   same smudge from the same stroke data. */
function wallDrawBlendSeg(pts, sizePx, ctx) {
  const c = ctx || wall.ctx;
  if (!c || !pts || pts.length === 0) return;
  const r = Math.max(3, sizePx / 2);
  const k = 0.45, alpha = 0.55; // pickup rate, dab opacity
  let pick = wallSampleBox(c, pts[0][0] * WALL_W, pts[0][1] * WALL_H, 3);
  c.save();
  let px = pts[0][0] * WALL_W, py = pts[0][1] * WALL_H;
  wallStampSoft(c, px, py, r, pick, alpha);
  for (let i = 1; i < pts.length; i++) {
    const x = pts[i][0] * WALL_W, y = pts[i][1] * WALL_H;
    const under = wallSampleBox(c, x, y, 3);
    pick = [pick[0] + (under[0] - pick[0]) * k,
            pick[1] + (under[1] - pick[1]) * k,
            pick[2] + (under[2] - pick[2]) * k];
    // soft dabs along the segment so fast drags don't dotted-line
    const dx = x - px, dy = y - py;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(2, r * 0.45);
    const n = Math.max(1, Math.floor(dist / step));
    for (let j = 1; j <= n; j++) {
      wallStampSoft(c, px + (dx * j) / n, py + (dy * j) / n, r, pick, alpha);
    }
    px = x; py = y;
  }
  c.restore();
}

/* Build 26 (undo): the stroke log. Each entry is one full gesture:
   {id, points, color, size, eraser, byMe}. wallLogAppend either appends a
   chunk to an existing entry (same gesture id — e.g. the flush chunks of
   one remote stroke) or starts a new entry. Drawing is done by the caller;
   this only logs. Pixels are never dropped here — only undo depth. */
function wallNextStrokeId() { return wall.selfId + '-' + (wall.strokeSeq++); }

function wallLogAppend(id, points, color, size, byMe, blend) {
  let e = null;
  for (const x of wall.log) if (x.id === id) { e = x; break; }
  if (e) {
    for (const p of points) e.points.push(p);
    wallMarkDirty();
    wallTouch();
  } else {
    e = {
      id, points: points.map((p) => [p[0], p[1]]),
      color, size, eraser: color === WALL_BG, byMe: !!byMe, blend: !!blend,
    };
    wall.log.push(e);
    wallNoteStroke();
    if (wall.log.length > wall.logCap) wallBakeBase();
  }
  return e;
}

/* Over the cap: bake the whole current canvas (base + log) into the base
   and drop undo history. The mural's pixels are kept — only undo depth. */
function wallBakeBase() {
  try { wall.baseCtx.drawImage(wall.canvas, 0, 0, WALL_W, WALL_H); } catch (err) {}
  wall.log.length = 0;
}

/* Rebuild the wall canvas from scratch: background, flattened base, then
   every logged stroke in order, then my in-progress gesture if any. */
function wallRedraw() {
  const c = wall.ctx;
  c.save();
  c.fillStyle = WALL_BG;
  c.fillRect(0, 0, WALL_W, WALL_H);
  c.restore();
  try { c.drawImage(wall.base, 0, 0, WALL_W, WALL_H); } catch (err) {}
  for (const e of wall.log) wallDrawSeg(e.points, e.color, e.size, e.blend);
  if (typeof paint !== 'undefined' && paint.drawing && paint.gesture && paint.gesture.points.length) {
    wallDrawSeg(paint.gesture.points, paint.gesture.color, paint.gesture.size, paint.gesture.blend);
  }
  wallMarkDirty();
}

/* Undo: pop MY most recent logged stroke, replay the rest, persist the
   undone state now, and tell the room so peers drop it from their logs
   and replay too. Eraser strokes undo like any other. */
function wallUndoMyLast() {
  for (let i = wall.log.length - 1; i >= 0; i--) {
    if (wall.log[i].byMe) {
      const gone = wall.log.splice(i, 1)[0];
      wallRedraw();
      wallTouch();
      wallSaveSnapshot(); // the undone state is the truth now — persist it, don't wait for debounce
      if (typeof paintMirror === 'function' && typeof paint !== 'undefined' && paint.open) paintMirror();
      if (net.enabled && net.sendWallUndo && active && active.key === SOUND_ROOM_KEY) {
        try { net.sendWallUndo({ id: gone.id }); } catch (err) { /* best effort */ }
      }
      return gone.id;
    }
  }
  return null;
}

function handleWallUndo(peerId, d) {
  if (!d || typeof d.id !== 'string' || !d.id) return;
  const i = wall.log.findIndex((e) => e.id === d.id);
  if (i < 0) return; // unknown id — nothing to do
  wall.log.splice(i, 1);
  wallRedraw();
  wallTouch();
  if (typeof paintMirror === 'function' && typeof paint !== 'undefined' && paint.open) paintMirror();
}

/* Strict shape check for incoming strokes — small messages only.
   id is optional (older builds don't send one) but must be sane when present. */
function wallValidStroke(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.id !== undefined && (typeof d.id !== 'string' || d.id.length === 0 || d.id.length > 64)) return false;
  if (typeof d.c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(d.c)) return false;
  if (typeof d.s !== 'number' || !(d.s >= 1 && d.s <= 120)) return false;
  if (d.b !== undefined && d.b !== 1) return false; // build 28: blend flag
  if (!Array.isArray(d.pts) || d.pts.length === 0 || d.pts.length > 64) return false;
  for (const p of d.pts) {
    if (!Array.isArray(p) || p.length !== 2) return false;
    if (typeof p[0] !== 'number' || typeof p[1] !== 'number') return false;
    if (!(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1)) return false;
  }
  return true;
}

function handleWallStroke(peerId, d) {
  if (!wallValidStroke(d)) return;
  // Group flush chunks into one log entry by gesture id; id-less senders
  // (older builds) get one entry per chunk.
  const id = (typeof d.id === 'string' && d.id)
    ? d.id
    : 'legacy-' + String(peerId || 'x').slice(0, 24) + '-' + (wall.strokeSeq++);
  wallDrawSeg(d.pts, d.c, d.s, d.b === 1);
  wallLogAppend(id, d.pts, d.c, d.s, false, d.b === 1);
  if (paint.open) paintMirror(); // someone's painting while we paint
}

/* Late-joiner sync: downscaled JPEG snapshot. */
function wallSnapshot() {
  try {
    const t = document.createElement('canvas');
    t.width = 512;
    t.height = 256;
    t.getContext('2d').drawImage(wall.canvas, 0, 0, 512, 256);
    return t.toDataURL('image/jpeg', 0.7);
  } catch (e) { return null; }
}

/* Apply a mural JPEG to the wall.
   - 'replace' (boot restore): the snapshot becomes the flattened base and
     undo history starts fresh — the log does not survive a reload.
   - 'merge' (live wallSync): the peer's mural becomes the base but my
     undoable strokes stay on top. Their mural is newer than my wall, and
     any of my strokes they already knew are pixel-identical when replayed,
     so the room converges instead of clobbering. */
function wallApplySnapshot(dataUrl, mode) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      wall.baseCtx.drawImage(img, 0, 0, WALL_W, WALL_H);
      if (mode !== 'merge') wall.log.length = 0;
      wallRedraw();
      wall.strokeCount = Math.max(wall.strokeCount, 1); // it has ink now
      wall.ts = Date.now(); // build 26: a newly arrived mural is the newest thing I've seen
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

/* Build 26: the wall remembers. After strokes land (debounced ~2s) and on
   pagehide / tab-hidden, a downscaled JPEG + timestamp is saved to
   localStorage. On boot the snapshot is redrawn before first render. The
   key is never renamed, so the mural survives game updates on the same
   origin. Any storage failure (private mode, quota) is silent — the wall
   just doesn't persist, never a crash, never a toast. */
function wallScheduleSnapshot() {
  try {
    clearTimeout(wall.snapTimer);
    wall.snapTimer = setTimeout(wallSaveSnapshot, 2000);
  } catch (e) { /* timers can't fail; belt and braces */ }
}
function wallSaveSnapshot() {
  // Quiet point (~2s after the last stroke): if a wallSync arrived while I
  // was painting, apply it now as a merge — my strokes stay on top.
  if (wall.pendingSync && Date.now() - wall.lastLocalStroke >= 1500) {
    const u = wall.pendingSync;
    wall.pendingSync = null;
    wallApplySnapshot(u, 'merge');
  }
  if (wall.strokeCount <= 0) return; // never touched: don't clobber an older snapshot with blank
  try {
    const img = wallSnapshot();
    if (!img) return;
    wall.ts = Date.now();
    localStorage.setItem(wall.snapKey, JSON.stringify({ dataUrl: img, ts: wall.ts }));
  } catch (e) { /* persistence is best-effort */ }
}
function wallRestoreSnapshot() {
  let raw = null;
  try { raw = localStorage.getItem(wall.snapKey); } catch (e) { return Promise.resolve(false); }
  if (!raw) return Promise.resolve(false);
  let snap = null;
  try { snap = JSON.parse(raw); } catch (e) { return Promise.resolve(false); }
  if (!snap || typeof snap.dataUrl !== 'string' || !snap.dataUrl.startsWith('data:image/')) {
    return Promise.resolve(false);
  }
  return wallApplySnapshot(snap.dataUrl).then((ok) => {
    if (ok && typeof snap.ts === 'number' && snap.ts > wall.ts) wall.ts = snap.ts;
    return ok;
  });
}

function handleWallSyncReq(peerId, d) {
  if (!d || typeof d.reqId !== 'string' || !d.reqId) return;
  if (wall.answeredReq.has(d.reqId)) return; // answer each request once
  if (wall.strokeCount <= 0) return;         // blank wall: nothing to share
  // Build 26: only answer when my wall is NEWER than the requester's
  // (they send their wall.ts along). Peers on older builds send no ts —
  // treat as 0, i.e. the pre-26 behavior.
  const theirTs = (typeof d.ts === 'number' && d.ts >= 0) ? d.ts : 0;
  if (!(wall.ts > theirTs)) return;
  wall.answeredReq.add(d.reqId);
  if (wall.answeredReq.size > 40) {
    const oldest = wall.answeredReq.values().next().value;
    wall.answeredReq.delete(oldest);
  }
  if (!net.enabled || !net.sendWallSync) return;
  try {
    const img = wallSnapshot();
    if (img) net.sendWallSync({ reqId: d.reqId, img });
  } catch (e) { /* best effort */ }
}

function handleWallSync(peerId, d) {
  if (!d || typeof d.img !== 'string' || !d.img.startsWith('data:image/')) return;
  // Never stomp a wall that's actively being painted: if my own brush
  // landed in the last ~3s, stash the mural and merge it once I'm quiet
  // (drained by wallSaveSnapshot at the debounce quiet point). Otherwise
  // merge now — their mural becomes the base, my strokes stay on top.
  if (Date.now() - wall.lastLocalStroke < 3000) {
    wall.pendingSync = d.img; // latest wins
    return;
  }
  wall.pendingSync = null;
  wallApplySnapshot(d.img, 'merge');
}

/* Build 26: last-writer-wins convergence. A newcomer announces its wall's
   version time; any peer whose wall is NEWER answers with the existing
   wallSync JPEG flow so the newcomer converges to the latest mural.
   Strokes stay the live truth while painting — the snapshot is the backstop. */
function wallValidHello(d) {
  return d && typeof d === 'object' &&
    typeof d.ts === 'number' && d.ts >= 0 && d.ts < Date.now() + 60000;
}
function handleWallHello(peerId, d) {
  if (!wallValidHello(d)) return;
  if (!(wall.ts > d.ts)) return;    // only the newer wall speaks
  if (wall.strokeCount <= 0) return; // blank wall: nothing to share
  if (!net.enabled || !net.sendWallSync) return;
  try {
    const img = wallSnapshot();
    if (img) net.sendWallSync({ reqId: 'hello-' + Date.now().toString(36), img });
  } catch (e) { /* best effort */ }
}

/* NOTE: there is deliberately no wall-clear action. The only way paint
   leaves the wall is the eraser tool in paint mode (bg-colored strokes
   over the same wallStroke path) — otherwise the wall persists. */

/* Build 26: redraw the last snapshot before first render, and keep it
   fresh on pagehide / tab-hidden. */
wallRestoreSnapshot();
try {
  window.addEventListener('pagehide', wallSaveSnapshot);
/* Build 53: a leaving holder hands the line off — one last canonical sync
   so every peer's remembered line is fresh for the next election. */
window.addEventListener('pagehide', () => {
  try { if (jukeIAmHolder && !jukeHolderCatchingUp) jukeBroadcastSync(); } catch (e) {}
  try { jukePersist(); } catch (e) {} // build 60: freshest line saved on the way out
});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') wallSaveSnapshot();
  });
} catch (e) { /* best effort */ }

/* 8x8 downsample: average color + ink coverage + recent-stroke activity.
   Colors and paint energy only — no content recognition. */
const wallSampleCanvas = document.createElement('canvas');
wallSampleCanvas.width = 8;
wallSampleCanvas.height = 8;
const wallSampleCtx = wallSampleCanvas.getContext('2d', { willReadFrequently: true });
const _wallTmpColor = new THREE.Color(); // scratch for the room-reactivity lerp
/* One room-reactivity sample: read the wall's colors + paint energy and
   retarget the room lights. Called ~1s from the sound room's update(). */
function wallReactSample(a) {
  const s = wallSample();
  if (wall.strokeCount === 0 || s.coverage <= 0.001) {
    a.wallTarget.set(WALL_AMB_BASE);
  } else {
    // 55% toward the wall's average hue — never near-black, since the
    // other 45% is always the room's base tint.
    a.wallTarget.set(WALL_AMB_BASE).lerp(_wallTmpColor.setRGB(s.r, s.g, s.b), 0.55);
  }
  const energy = Math.min(1, (s.recent / 6) * 0.8 + s.coverage * 1.5);
  a.wallPulse += (energy - a.wallPulse) * 0.5;
}
function wallSample() {
  wallPruneTimes();
  let r = 0, g = 0, b = 0, ink = 0;
  try {
    wallSampleCtx.drawImage(wall.canvas, 0, 0, 8, 8);
    const px = wallSampleCtx.getImageData(0, 0, 8, 8).data;
    for (let i = 0; i < 64; i++) {
      const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
      r += R; g += G; b += B;
      const dist = Math.abs(R - WALL_BG_RGB[0]) + Math.abs(G - WALL_BG_RGB[1]) + Math.abs(B - WALL_BG_RGB[2]);
      if (dist > 24) ink++;
    }
  } catch (e) { /* keep zeros */ }
  return {
    r: r / 64 / 255, g: g / 64 / 255, b: b / 64 / 255,
    coverage: ink / 64,
    recent: wall.strokeTimes.length,
    strokes: wall.strokeCount,
  };
}

/* ---------------- jukebox: synced queue playback (build 21) ----------------
   The honest architecture: we cannot relay Spotify/SoundCloud audio between
   users (DRM + ToS + no API for it), and we don't try. Instead every client
   plays the SAME track at the SAME wall-clock offset through an embedded
   player on their own device. Same song, same moment, ~1s sync — good
   enough for hanging out. Everyone can queue; anyone's preferred listening
   method is honored via the "open in my app" + manual countdown path.

   Protocol (sound-room scoped, same pattern as jam/wall actions):
     jukeAdd      {id, url, provider, videoId, title, addedBy, addedAt}
     jukeRemove   {id, by}
     jukePlay     {id, url, provider, videoId, title, addedBy, startedAt,
                   durationMs, by} | {stopped:true, by}
     jukeSkipVote {id, voter}  — legacy name; instant skip, no voting
     jukeStateReq {reqId} / jukeState {reqId, now, queue}
   Advance duty: whoever queued the finished track broadcasts the next
   jukePlay. Watchdog: if a track has been over >8s with no new jukePlay,
   ANY peer may broadcast the advance — first jukePlay wins, ties broken
   by earliest startedAt (1.5s contention window).
   (Build 28: the old "DJ live pauses the jukebox" rule died with the
   broadcast relay — the jukebox just keeps playing.) */

const juke = {
  open: false,
  queue: [],          // FIFO of {id, url, provider, videoId, title, addedBy, addedAt}
  now: null,          // current play payload (not stopped)
  nowStartedAt: 0,    // adopted startedAt (tie-breaks)
  adoptedAt: 0,       // Date.now() when we adopted the current play
  lastPlaySeenAt: 0,  // newest startedAt we've seen (watchdog + resume guards)
  answeredReq: new Set(),
  player: null,       // {kind, play, pause, seekTo(sec), pos()->sec|null, dur()->sec|null, setVolume(0-100), destroy}
  volume: 0.7,
  ytApiReady: false, ytApiLoading: false, ytApiQueue: [],
  scApiReady: false, scApiLoading: false, scApiQueue: [],
  resyncTimer: null, endTimer: null, progressRaf: null,
  overSince: 0,       // Date.now() when the current track was first seen over
  joinWaiting: false, // autoplay blocked: pulsing "tap to join the music"
  prewarmed: false,   // build 25: first user gesture warms the provider players
  warmYt: null,       // {player, ready, queue} persistent invisible YT player
  watchT: null,       // build 25: hardened playback watchdog timer
  playerErrored: false, // a provider error event fired for the current track
  phoneFiles: {},   // build 27: fileId -> {buf: Uint8Array, name, size, type} (uploader or fetched)
  phoneFetch: {},   // build 27: fileId -> chunk-reassembly state
  phoneHave: {},    // build 27: fileId -> Set of names holding the bytes
  direct: null,       // build 25: direct-audio playback state
  playerFactory: null, // test seam: {youtube(d, offset, hooks), soundcloud(d, offset, hooks), direct(d, offset, hooks)}
  extTimer: null, extCount: 0,
};
const JUKE_RESYNC_MS = 20000;  // resync nudge cadence
const JUKE_DRIFT_S = 2.5;      // seek if further off than this
const JUKE_WATCHDOG_MS = 8000; // track over this long with no advance -> anyone may advance
const JUKE_CONTENTION_MS = 1500; // competing jukePlays: earliest startedAt wins

/* Provider detection from a pasted URL (build 23: mobile share links,
   set/playlist URLs, and query-param-laden shares all resolve).
   Providers: youtube | youtube-playlist | soundcloud | soundcloud-set |
              soundcloud-short | direct-audio | external | invalid.
   The transient ones (youtube-playlist, soundcloud-set, soundcloud-short)
   are expanded/resolved at queue time into plain youtube/soundcloud items.
   direct-audio (build 25): .mp3/.ogg/.wav/.m4a links play through the game's
   own WebAudio chain — sampler, FX and volume all work on them. */
/* Build 57: every SoundCloud short-link shape — the current mobile share
   host (on.soundcloud.com), the older snd.sc shortener, and the app's
   Firebase Dynamic Links (soundcloud.app.goo.gl). All of them 404 in the
   widget; all resolve through jukeResolveShortLink. */
function jukeIsShortSCLink(url) {
  try {
    const h = new URL(String(url || '')).hostname.toLowerCase();
    return h === 'on.soundcloud.com' || h === 'snd.sc' || h === 'soundcloud.app.goo.gl';
  } catch (e) { return false; }
}

function jukeDetectProvider(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); }
  catch (e) { return { provider: 'invalid' }; }
  if (!/^https?:$/.test(u.protocol)) return { provider: 'invalid' };
  const host = u.hostname.replace(/^(www\.|m\.|mobile\.)/, '').toLowerCase();
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com' ||
      host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    let vid = null;
    if (host === 'youtu.be') vid = u.pathname.slice(1).split(/[?/#]/)[0];
    else if (u.pathname === '/watch') vid = u.searchParams.get('v');
    else if (u.pathname.startsWith('/shorts/')) vid = u.pathname.split('/')[2];
    else if (u.pathname.startsWith('/embed/')) vid = u.pathname.split('/')[2];
    else if (u.pathname.startsWith('/live/')) vid = u.pathname.split('/')[2];
    vid = (vid || '').split(/[?/#]/)[0];
    if (!(vid && /^[A-Za-z0-9_-]{6,20}$/.test(vid))) vid = null;
    // A playlist param means "queue every track", even when a video is attached.
    if (list && /^[A-Za-z0-9_-]{8,48}$/.test(list)) {
      return { provider: 'youtube-playlist', videoId: vid, playlistId: list };
    }
    if (vid) return { provider: 'youtube', videoId: vid };
    return { provider: 'external' }; // some other youtube page (channel, bare /playlist…)
  }
  // Short share links (mobile share, snd.sc, app Firebase links) — resolve at queue time.
  if (jukeIsShortSCLink(u.href)) return { provider: 'soundcloud-short' };
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
    const parts = u.pathname.split('/').filter(Boolean);
    // api.soundcloud.com URLs come from oEmbed resolution of short links.
    if (host === 'api.soundcloud.com') {
      if (parts[0] === 'playlists') return { provider: 'soundcloud-set' };
      if (parts[0] === 'tracks') return { provider: 'soundcloud' };
      return { provider: 'external' };
    }
    if (parts.includes('sets')) return { provider: 'soundcloud-set' };
    if (parts.length >= 2) return { provider: 'soundcloud' };
    return { provider: 'external' }; // profile page, likes, stream…
  }
  // Build 25: direct audio links ride the game's own WebAudio chain —
  // extension sniff here; extensionless audio URLs get a content-type
  // sniff at queue time (jukeSniffAudioContentType).
  try {
    if (/\.(mp3|ogg|oga|wav|m4a|aac|opus|flac)$/i.test(u.pathname)) {
      return { provider: 'direct-audio' };
    }
  } catch (e) {}
  return { provider: 'external' };
}

/* Generic queue title per provider, shown until the real title resolves. */
function jukeFallbackTitle(provider) {
  return provider === 'youtube' || provider === 'youtube-playlist' ? 'a youtube track'
    : provider === 'soundcloud' || provider === 'soundcloud-set' || provider === 'soundcloud-short' ? 'a soundcloud track'
    : provider === 'direct-audio' ? 'an audio file'
    : 'a track';
}

/* Build 25: one HEAD request to sniff an extensionless URL's content-type.
   Returns true only for audio/*. CORS-blocked or slow -> false (stays external). */
async function jukeSniffAudioContentType(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(url, { method: 'HEAD', signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    return r.ok && (ct.startsWith('audio/') || ct === 'application/octet-stream');
  } catch (e) { return false; }
}

/* Best-effort title for a link: noembed for youtube, oEmbed for soundcloud
   (both keyless); 4s timeout, silent fallback. */
async function jukeFetchTitle(url, provider) {
  const fb = jukeFallbackTitle(provider);
  const endpoint = provider === 'youtube' || provider === 'youtube-playlist'
    ? 'https://noembed.com/embed?url=' + encodeURIComponent(url)
    : (provider === 'soundcloud' || provider === 'soundcloud-set' || provider === 'soundcloud-short')
    ? 'https://soundcloud.com/oembed?url=' + encodeURIComponent(url) + '&format=json'
    : null;
  if (!endpoint) return fb;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(endpoint, { signal: ctl.signal });
    clearTimeout(t);
    const jj = await r.json();
    if (jj && jj.title) return String(jj.title).slice(0, 120);
  } catch (e) { /* offline / blocked -> fallback */ }
  return fb;
}

/* Resolve a mobile short share link (on.soundcloud.com/xxx) to its canonical
   URL via SoundCloud's own oEmbed (CORS-open, keyless): the returned iframe
   html carries the canonical url= param, and we get the real title for free.
   Returns { url, title } or null. */
/* Resolve a SoundCloud short share link to its canonical track URL.
   Build 57: soundcloud.app.goo.gl (Firebase Dynamic Links from the app)
   won't answer oEmbed — follow the redirect first, then oEmbed the real
   URL. Everything else goes straight to oEmbed. */
async function jukeResolveShortLink(url) {
  try {
    // Firebase app-share links: chase the redirect to the real track URL.
    try {
      const h = new URL(String(url || '')).hostname.toLowerCase();
      if (h === 'soundcloud.app.goo.gl') {
        const ctl2 = new AbortController();
        const t2 = setTimeout(() => ctl2.abort(), 10000);
        try {
          const rr = await fetch(url, { redirect: 'follow', signal: ctl2.signal });
          if (rr && rr.url && !jukeIsShortSCLink(rr.url)) url = rr.url;
        } catch (e) { /* fall through to oEmbed with the original */ }
        clearTimeout(t2);
      }
    } catch (e) { /* keep the original url */ }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000); // build 54: was 8s — slow mobile networks need more
    const r = await fetch('https://soundcloud.com/oembed?url=' + encodeURIComponent(url) + '&format=json',
      { signal: ctl.signal });
    clearTimeout(t);
    const jj = await r.json();
    if (jj && jj.html) {
      const m = String(jj.html).match(/src="([^"]*w\.soundcloud\.com\/player\/[^"]*)"/);
      if (m) {
        const src = m[1].replace(/&amp;/g, '&');
        const canonical = new URL(src).searchParams.get('url');
        if (canonical && /(^|\.)soundcloud\.com/.test(new URL(canonical).hostname)) {
          return {
            url: canonical,
            title: jj.title ? String(jj.title).slice(0, 120) : null,
          };
        }
      }
    }
  } catch (e) { /* offline / dead link -> null */ }
  return null;
}

/* Resolve a SoundCloud set URL into its tracks via a hidden widget:
   READY -> getSounds() needs no API key. Returns
   [{url: permalink, title, durationMs, provider:'soundcloud'}] or null. */
function jukeResolveSCSet(setUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tracks) => {
      if (done) return; done = true;
      clearTimeout(to);
      try { document.getElementById('juke-set-resolver').remove(); } catch (e) {}
      resolve(tracks);
    };
    const to = setTimeout(() => finish(null), 25000);
    const div = document.createElement('div');
    div.id = 'juke-set-resolver';
    div.style.display = 'none';
    document.body.appendChild(div);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('frameborder', '0');
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(setUrl) +
      '&auto_play=false&visual=false&hide_related=true';
    div.appendChild(iframe);
    jukeLoadSCApi((ok) => {
      if (!ok) { finish(null); return; }
      try {
        const w = window.SC.Widget(iframe);
        w.bind(window.SC.Widget.Events.READY, () => {
          try {
            w.getSounds((sounds) => {
              if (!sounds || !sounds.length) { finish(null); return; }
              finish(sounds
                .filter((s) => s && (s.permalink_url || s.uri))
                .map((s) => ({
                  url: s.permalink_url || setUrl,
                  title: (s.title || 'untitled').toString().slice(0, 120),
                  durationMs: s.duration || null,
                  provider: 'soundcloud',
                })));
            });
          } catch (e) { finish(null); }
        });
        w.bind(window.SC.Widget.Events.ERROR, () => finish(null));
      } catch (e) { finish(null); }
    });
  });
}

/* Resolve a YouTube playlist ID into its videos via a transient hidden
   player: cuePlaylist (keyless), wait for the CUED state, then getPlaylist()
   IDs -> noembed titles.
   Returns [{url, title, durationMs, provider:'youtube', videoId}] or null. */
function jukeResolveYTPlaylist(playlistId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tracks) => {
      if (done) return; done = true;
      clearTimeout(to);
      try { document.getElementById('juke-pl-resolver').remove(); } catch (e) {}
      resolve(tracks);
    };
    const to = setTimeout(() => finish(null), 30000);
    const div = document.createElement('div');
    div.id = 'juke-pl-resolver';
    div.style.cssText = 'position:absolute;left:-9999px;top:0;width:8px;height:8px;overflow:hidden;';
    document.body.appendChild(div);
    const el = document.createElement('div');
    div.appendChild(el);
    jukeLoadYTApi((ok) => {
      if (!ok || !window.YT) { finish(null); return; }
      try {
        const p = new window.YT.Player(el, {
          width: '8', height: '8',
          playerVars: { autoplay: 0, controls: 0, disablekb: 1 },
          events: {
            onReady: (ev) => {
              try { ev.target.cuePlaylist({ list: playlistId, index: 0 }); }
              catch (e) { finish(null); }
            },
            onStateChange: async (ev) => {
              if (!ev.target || ev.data !== window.YT.PlayerState.CUED) return;
              let ids = null;
              try { ids = ev.target.getPlaylist(); } catch (e) {}
              try { ev.target.destroy(); } catch (e) {}
              if (!ids || !ids.length) { finish(null); return; }
              const tracks = await Promise.all(ids.slice(0, 50).map(async (vid) => {
                const url = 'https://www.youtube.com/watch?v=' + vid;
                const title = await jukeFetchTitle(url, 'youtube');
                return { url, title, durationMs: null, provider: 'youtube', videoId: vid };
              }));
              finish(tracks);
            },
            onError: () => finish(null),
          },
        });
      } catch (e) { finish(null); }
    });
  });
}

const JUKE_PROVIDERS = ['youtube', 'youtube-playlist', 'soundcloud', 'soundcloud-set', 'soundcloud-short', 'direct-audio', 'external', 'phone-file'];
function jukeValidAdd(d) {
  if (!d || typeof d !== 'object') return false;
  if (typeof d.id !== 'string' || !d.id || d.id.length > 40) return false;
  if (!JUKE_PROVIDERS.includes(d.provider)) return false;
  if (d.provider === 'phone-file') {
    // P2P track: no URL — the bytes travel over the data channel.
    if (typeof d.fileId !== 'string' || !d.fileId || d.fileId.length > 40) return false;
    if (typeof d.fileName !== 'string' || !d.fileName || d.fileName.length > 120) return false;
  } else if (typeof d.url !== 'string' || !d.url || d.url.length > 500) return false;
  if (typeof d.title !== 'string' || !d.title || d.title.length > 140) return false;
  if (typeof d.addedBy !== 'string' || !d.addedBy || d.addedBy.length > 16) return false;
  if (typeof d.addedAt !== 'number') return false;
  if (d.videoId != null && (typeof d.videoId !== 'string' || d.videoId.length > 24)) return false;
  return true;
}
function jukeValidPlay(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.stopped) return typeof d.by === 'string';
  if (typeof d.id !== 'string' || !d.id) return false;
  if (!JUKE_PROVIDERS.includes(d.provider)) return false;
  if (d.provider === 'phone-file') {
    if (typeof d.fileId !== 'string' || !d.fileId) return false;
  } else if (typeof d.url !== 'string' || !d.url) return false;
  if (typeof d.title !== 'string') return false;
  if (typeof d.startedAt !== 'number' || typeof d.by !== 'string') return false;
  if (typeof d.addedBy !== 'string') return false;
  if (d.durationMs != null && typeof d.durationMs !== 'number') return false;
  return true;
}

/* ---------- queue ops ---------- */

function jukeMakeId() {
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/* Queue a link. The item goes in IMMEDIATELY (inside the user's tap gesture,
   so playback starts with zero extra taps); the real title resolves
   afterwards and pops in. Mobile short links are resolved to their canonical
   URL first; set/playlist URLs expand into one item per track.
   titleHint skips the network fetch (tests). */
async function jukeAddTrack(rawUrl, titleHint) {
  // Build 45: share text carries promo words around the link
  // ("Listen to X by Y on #SoundCloud https://on.soundcloud.com/abc") —
  // fish out the first https URL and queue that.
  const _m45 = String(rawUrl || '').match(/https?:\/\/[^\s<>"'`]+/i);
  const cleanUrl = _m45 ? _m45[0].replace(/[.,;:!?)\]}>]+$/, '') : '';
  let det = jukeDetectProvider(cleanUrl);
  if (det.provider === 'invalid') {
    jukeHint('that link doesn\u2019t look right — paste a full https url');
    return null;
  }
  let url = cleanUrl; // build 45: extracted from pasted share text
  let resolvedTitle = titleHint || null;
  // Short share links (on.soundcloud.com, snd.sc, soundcloud.app.goo.gl):
  // resolve to the canonical track/set URL via oEmbed (also yields the real
  // title). If it won't resolve here, the track keeps the short URL and gets
  // one more resolve at play time (build 54) — the widget itself 404s on short
  // links, so it is never handed one.
  if (det.provider === 'soundcloud-short') {
    jukeHint('resolving that soundcloud link…');
    const r = await jukeResolveShortLink(url);
    if (r) { url = r.url; det = jukeDetectProvider(url); if (r.title) resolvedTitle = r.title; }
    else det = { provider: 'soundcloud' };
  }
  // Sets / playlists: one queue item per track.
  if (det.provider === 'soundcloud-set' || det.provider === 'youtube-playlist') {
    return jukeAddPlaylist(url, det, resolvedTitle || titleHint);
  }
  // Build 25: direct-audio titles start as the file name — friendlier than
  // "an audio file", and decoding can't give us a real title anyway.
  if (det.provider === 'direct-audio' && !resolvedTitle) {
    try {
      const leaf = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      const stem = leaf.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+\-]+/g, ' ').trim();
      if (stem) resolvedTitle = stem.slice(0, 120);
    } catch (e) {}
  }
  // Extensionless audio URLs (signed links, redirects): sniff content-type
  // once at queue time; a CORS-blocked HEAD just leaves it external.
  if (det.provider === 'external' && !resolvedTitle) {
    try {
      if (await jukeSniffAudioContentType(url)) det = { provider: 'direct-audio' };
    } catch (e) {}
  }
  const t = {
    id: jukeMakeId(), url, provider: det.provider,
    videoId: det.videoId || null, title: resolvedTitle || jukeFallbackTitle(det.provider),
    addedBy: myName, addedAt: Date.now(),
  };
  if (juke.queue.length >= JUKE_MAX_QUEUE) {
    jukeHint('the line is full at ' + JUKE_MAX_QUEUE + ' — let a track drift off first');
    return null;
  }
  juke.queue.push(t);
  jukeSortQueue(); // the adder sorts too — same list as everyone else
  jukeSendAdd(t); // build 44: broadcast + watch for the holder's ack
  renderJuke();
  // Room idle: we queued it, we start it — inside the tap gesture.
  if (!juke.now) jukeAdvance();
  if (!resolvedTitle) jukeEnrichTitle(t);
  return t;
}

/* Fire-and-forget: upgrade a generic queue title to the real one, locally.
   Every client does this for items it receives, so titles pop in everywhere. */
async function jukeEnrichTitle(t) {
  if (!t || t.title !== jukeFallbackTitle(t.provider)) return;
  const title = await jukeFetchTitle(t.url, t.provider);
  if (title === jukeFallbackTitle(t.provider)) return;
  t.title = title;
  if (juke.now && juke.now.id === t.id) juke.now.title = title;
  renderJuke();
}

/* A set/playlist URL becomes one queue item per track, grouped so the panel
   shows "playlist • N tracks" and one tap can pull the whole group. */
async function jukeAddPlaylist(url, det, titleHint) {
  jukeHint('pulling the track list…');
  let tracks = null;
  try {
    tracks = det.provider === 'soundcloud-set'
      ? await jukeResolveSCSet(url)
      : await jukeResolveYTPlaylist(det.playlistId);
  } catch (e) { tracks = null; }
  if (!tracks || !tracks.length) {
    jukeHint('couldn\u2019t load that playlist — is it public?');
    return null;
  }
  const gid = 'pl-' + jukeMakeId();
  const groupTitle = titleHint ||
    (det.provider === 'soundcloud-set' ? 'soundcloud set' : 'youtube playlist');
  const now = Date.now();
  const items = [];
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    const t = {
      id: jukeMakeId(), url: tr.url, provider: tr.provider,
      videoId: tr.videoId || null, title: (tr.title || ('track ' + (i + 1))).toString().slice(0, 120),
      durationMs: tr.durationMs || null,
      addedBy: myName, addedAt: now + i, // preserve set order under the FIFO sort
      group: gid, groupTitle, groupCount: tracks.length,
    };
    if (!jukeValidAdd(t)) continue;
    if (juke.queue.length >= JUKE_MAX_QUEUE) {
      jukeHint('the line is full at ' + JUKE_MAX_QUEUE + ' — queuing what fits');
      break;
    }
    items.push(t);
    juke.queue.push(t);
    jukeSortQueue();
    jukeSendAdd(t); // build 44: broadcast + watch for the holder's ack
  }
  renderJuke();
  if (items.length) jukeHint(`queued ${items.length} track${items.length === 1 ? '' : 's'} — enjoy the set`);
  if (!juke.now) jukeAdvance();
  return items;
}

/* Pull a whole playlist group back out of the queue (remaining tracks). */
function jukeRemoveGroup(gid) {
  const mine = juke.queue.filter((t) => t.group === gid);
  if (!mine.length) return false;
  if (mine.some((t) => t.addedBy !== myName)) {
    jukeHint('only the drifter who queued it can pull it');
    return false;
  }
  juke.queue = juke.queue.filter((t) => t.group !== gid);
  if (net.enabled && net.sendJukeRemove) {
    for (const t of mine) { try { net.sendJukeRemove({ id: t.id, by: myName }); } catch (e) {} }
  }
  renderJuke();
  return true;
}

/* Build 40: one shared list — every phone sorts the same way. addedAt
   orders the line; the id breaks ties so two phones never disagree, even
   when two tracks land in the same millisecond. */
function jukeSortQueue() {
  juke.queue.sort((a, b) =>
    (a.addedAt - b.addedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function handleJukeAdd(peerId, d) {
  if (!jukeSrvOk(d)) { jukeDrops.srv++; return; }
  if (!jukeValidAdd(d)) { jukeDrops.valid++; return; }
  if (juke.now && juke.now.id === d.id) { jukeDrops.playing++; return; } // the play beat the add here — already spinning
  if (juke.queue.some((t) => t.id === d.id)) { jukeDrops.dup++; return; } // dedupe
  if (juke.queue.length >= JUKE_MAX_QUEUE) { jukeDrops.full++; return; } // line is full — the adder was told
  juke.queue.push(d);
  jukeSortQueue(); // FIFO by queue time, identical on every phone
  renderJuke();
  jukeEnrichTitle(d); // everyone resolves the real title locally
  if (jukeIAmHolder) jukeBroadcastSync(); // holder confirms the canonical line
}

/* Remove your own queued track. If it's the one playing, that counts as a
   skip — the queue advances. */
function jukeRemoveTrack(id) {
  const i = juke.queue.findIndex((t) => t.id === id);
  const isNow = juke.now && juke.now.id === id;
  if (i === -1 && !isNow) return false;
  const t = isNow ? juke.now : juke.queue[i];
  if (t.addedBy !== myName && t.by !== myName) {
    jukeHint('only the drifter who queued it can pull it');
    return false;
  }
  if (i !== -1) juke.queue.splice(i, 1);
  try { jukeRemovedIds.set(id, Date.now()); } catch (e) {}
  try { jukePendingAck.delete(id); } catch (e) {} // build 44: stop retrying a pulled track
  if (net.enabled && net.sendJukeRemove) {
    try { net.sendJukeRemove({ id, by: myName }); } catch (e) {}
  }
  if (isNow) jukeAdvance(); else renderJuke();
  return true;
}

function handleJukeRemove(peerId, d) {
  if (!jukeSrvOk(d)) return;
  if (!d || typeof d.id !== 'string') return;
  try { jukeRemovedIds.set(d.id, Date.now()); } catch (e) {} // build 44: tombstone — a racing snapshot can't resurrect it
  try { jukePendingAck.delete(d.id); } catch (e) {} // build 44: stop retrying a pulled track
  const i = juke.queue.findIndex((t) => t.id === d.id);
  if (i !== -1) juke.queue.splice(i, 1);
  if (juke.now && juke.now.id === d.id) {
    // Someone pulled the playing track: advance, but only the puller
    // broadcasts — everyone else just clears and waits for the jukePlay.
    jukeStopPlayback();
    juke.now = null;
    renderJuke();
  } else renderJuke();
  if (jukeIAmHolder) jukeBroadcastSync();
}

/* ---------- instant skip (build 27) ----------
   Anyone can skip: one tap advances the track immediately, no votes.
   The wire action is still called 'jukeSkipVote' (net.js) — the name is
   legacy, the semantics are now "skip now". Both the tapper and every
   receiver call jukeAdvance(); competing jukePlay broadcasts resolve via
   the existing earliest-startedAt contention rule. */
function jukeSkipNow() {
  if (!juke.now || juke.now.stopped) return;
  const id = juke.now.id;
  if (net.enabled && net.sendJukeSkipVote) {
    try { net.sendJukeSkipVote({ id, voter: myName }); } catch (e) {}
  }
  handleJukeSkip('self', { id, voter: myName }); // build 80: (peerId, d) order — was flipped by the build-79 swap, so the skipper never skipped locally
}

function handleJukeSkip(peerId, d) {
  if (!jukeSrvOk(d)) return;
  if (!d || typeof d.id !== 'string') return;
  if (!juke.now || juke.now.id !== d.id) return; // stale skip — already moved on
  jukeAdvance();
}

/* build 40: are we on the broadcast relay? (chunked phone-file transfers
   can't ride it — the relay skips them by design.) */
function netIsRelay() {
  try { return !!(typeof net !== 'undefined' && net && net.relayMode); } catch (e) { return false; }
}

/* ---------- phone files (build 27) ----------
   "Play from my phone": the picked audio file travels to the room over
   Trystero's data channel — no upload site, no link that can expire, no
   CORS games. Queue items carry metadata only (provider 'phone-file');
   the bytes fan out peer-to-peer in 48KB base64 chunks, each client
   assembles a local blob and plays it through the normal direct-audio
   path (fetch + decodeAudioData on a blob: URL — full jam-bus chain, so
   phone tracks are grab-able and FX-able like any direct link).
   Protocol (sound-room scoped):
     jukeFileReq   {fileId, from}        — receiver -> room (targeted after the first chunk)
     jukeFileChunk {fileId, i, n, data}  — holder -> receiver, base64 48KB slices
     jukeFileHave  {fileId, by}          — "I have the whole file, ask me too" */
const JUKE_PHONE_CHUNK = 48 * 1024; // bytes per chunk (base64 ~64KB, data-channel safe)
const JUKE_PHONE_BATCH = 8;         // chunks served per request
const JUKE_PHONE_MAX = 50 * 1024 * 1024; // 50MB cap — the room hears it tonight, not forever
const JUKE_PHONE_FETCH_MS = 20000;  // no chunks this long -> honest error, move on

function jukeB64encode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  }
  return btoa(s);
}
function jukeB64decode(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/* File picker -> queue. Runs inside the tap gesture; the file is read
   once, queued as metadata, and the bytes stay on this device until the
   track plays. */
async function jukeAddPhoneFile(file) {
  if (!file) return null;
  const size = file.size || 0;
  if (size > JUKE_PHONE_MAX) {
    jukeHint('that file is over 50MB \u2014 trim it down and try again');
    return null;
  }
  if (size <= 0) { jukeHint('that file looks empty'); return null; }
  const name = file.name || 'phone track';
  const type = file.type || '';
  const audioish = /audio\//i.test(type) ||
    /\.(mp3|m4a|aac|ogg|oga|wav|wave|flac|opus|weba)$/i.test(name);
  if (!audioish) { jukeHint('that doesn\u2019t look like an audio file'); return null; }
  // build 40: the relay is broadcast-only and skips file chunks by design,
  // so phone bytes can never reach the room — refuse honestly at queue time
  // instead of letting the room hang on a fetch that can't land.
  if (netIsRelay()) {
    jukeHint('phone tracks can\u2019t drift over the relay \u2014 paste a link instead');
    return null;
  }
  let ab = null;
  try { ab = await file.arrayBuffer(); }
  catch (e) { jukeHint('couldn\u2019t read that file'); return null; }
  const fileId = jukeMakeId();
  juke.phoneFiles[fileId] = { buf: new Uint8Array(ab), name, size, type };
  const stem = name.replace(/\.[a-z0-9]+$/i, '').slice(0, 100) || 'phone track';
  const item = {
    id: jukeMakeId(), provider: 'phone-file', fileId,
    fileName: name.slice(0, 120), title: stem,
    addedBy: myName, addedAt: Date.now(),
  };
  juke.queue.push(item);
  jukeSortQueue();
  jukeSendAdd(item); // build 44: broadcast + watch for the holder's ack
  jukeHint(`\u{1F4F1} "${stem}" queued \u2014 the room pulls it from your phone when it plays`);
  renderJuke();
  if (!juke.now) jukeAdvance(); // empty room: starts now
  return item;
}

/* Play entry for phone files. The uploader (or anyone who already has
   the bytes) plays immediately; everyone else pulls chunks first and
   the assemble step starts them at the wall-clock offset. */
function jukePlayPhoneFile(d, offset) {
  const local = juke.phoneFiles[d.fileId];
  if (local && local.buf) {
    let st = juke.phoneFetch[d.fileId];
    let url = st && st.blobUrl;
    if (!url) {
      url = URL.createObjectURL(new Blob([local.buf], { type: local.type || 'audio/mpeg' }));
      st = { blobUrl: url, done: true, buf: local.buf, chunks: [], n: 0, got: 0 };
      juke.phoneFetch[d.fileId] = st;
    }
    // Late joiners can pull from us too.
    if (net.enabled && net.sendJukeFileHave) { try { net.sendJukeFileHave({ fileId: d.fileId, by: myName }); } catch (e) {} }
    jukePlayDirect({ ...d, url }, offset);
    return;
  }
  // build 40: on the relay the chunks never come (skipped by design) — say
  // so plainly and hold the room's place instead of hanging at 0%. The
  // uploader hears it on their phone; their advance broadcast resyncs us.
  if (netIsRelay()) {
    jukeHint(`\u201c${(d.fileName || 'phone track').slice(0, 40)}\u201d lives on ${(d.addedBy || d.by || 'a drifter').slice(0, 16)}\u2019s phone \u2014 the relay can\u2019t carry it, drifting on`);
    renderJuke();
    return;
  }
  // Receiving: show progress until the bytes land.
  jukePhoneProgress(d, 0);
  jukeRequestPhoneFile(d);
}

/* Do we hold this phone file's audio bytes locally? */
function jukeHasPhoneBytes(d) {
  if (!d || !d.fileId) return false;
  const rec = juke.phoneFiles[d.fileId];
  return !!(rec && rec.buf);
}

/* When the now-playing track is someone else's phone file and the bytes
   haven't landed, the title slot shows the honest fetch state instead of
   the track title — so a later re-render can never clobber the progress. */
function jukePhonePendingText() {
  const d = juke.now;
  if (!d || d.provider !== 'phone-file' || jukeHasPhoneBytes(d)) return null;
  const st = juke.phoneFetch[d.fileId];
  const pct = st && st.n ? Math.round((st.got / st.n) * 100) : 0;
  return `fetching from ${(d.addedBy || d.by || 'a drifter')}'s phone… ${pct}%`;
}

/* Progress readout for an in-flight phone-file fetch: the now-playing
   title slot doubles as the progress bar. */
function jukePhoneProgress(d, pct) {
  if (!juke.now || juke.now.id !== (d && d.id)) return;
  renderJuke(); // the title slot shows jukePhonePendingText() while fetching
}

function jukeRequestPhoneFile(d) {
  const fileId = d.fileId;
  let st = juke.phoneFetch[fileId];
  if (!st) {
    st = { chunks: [], n: 0, got: 0, server: null, done: false, timer: null, d };
    juke.phoneFetch[fileId] = st;
  } else if (st.done) return;
  st.d = d;
  clearTimeout(st.timer);
  st.timer = setTimeout(() => jukePhoneFetchTimeout(fileId), JUKE_PHONE_FETCH_MS);
  const target = st.server || undefined; // pin to the first responder
  if (net.enabled && net.sendJukeFileReq) {
    try { net.sendJukeFileReq({ fileId, from: st.got }, target); } catch (e) {}
  }
}

function handleJukeFileReq(peerId, d) {
  if (!d || typeof d.fileId !== 'string' || typeof d.from !== 'number' || d.from < 0) return;
  const f = juke.phoneFiles[d.fileId];
  if (!f || !f.buf || !f.buf.length) return;
  const n = Math.ceil(f.buf.length / JUKE_PHONE_CHUNK);
  const end = Math.min(n, Math.floor(d.from) + JUKE_PHONE_BATCH);
  for (let i = Math.floor(d.from); i < end; i++) {
    const slice = f.buf.subarray(i * JUKE_PHONE_CHUNK, Math.min(f.buf.length, (i + 1) * JUKE_PHONE_CHUNK));
    try {
      if (net.enabled && net.sendJukeFileChunk) {
        net.sendJukeFileChunk({ fileId: d.fileId, i, n, data: jukeB64encode(slice) }, peerId);
      }
    } catch (e) { return; }
  }
}

function handleJukeFileChunk(peerId, d) {
  if (!d || typeof d.fileId !== 'string' || typeof d.i !== 'number' ||
      typeof d.n !== 'number' || typeof d.data !== 'string') return;
  const st = juke.phoneFetch[d.fileId];
  if (!st || st.done) return;
  if (st.n && st.n !== d.n) return; // mismatched sender
  st.n = d.n;
  if (!st.server) st.server = peerId; // pin to the first responder
  if (peerId !== st.server) return; // ignore duplicate servers
  if (st.chunks[d.i]) return; // duplicate chunk
  let u8 = null;
  try { u8 = jukeB64decode(d.data); } catch (e) { return; }
  st.chunks[d.i] = u8;
  st.got++;
  clearTimeout(st.timer); // bytes are flowing — keep waiting
  st.timer = setTimeout(() => jukePhoneFetchTimeout(d.fileId), JUKE_PHONE_FETCH_MS);
  jukePhoneProgress(st.d, Math.round(st.got / st.n * 100));
  if (st.got < st.n) {
    // Next batch, targeted at our server.
    if (net.enabled && net.sendJukeFileReq) {
      try { net.sendJukeFileReq({ fileId: d.fileId, from: st.got }, st.server); } catch (e) {}
    }
    return;
  }
  jukePhoneAssemble(d.fileId);
}

function jukePhoneAssemble(fileId) {
  const st = juke.phoneFetch[fileId];
  if (!st || st.done) return;
  clearTimeout(st.timer);
  let len = 0;
  for (const c of st.chunks) { if (c) len += c.length; }
  const buf = new Uint8Array(len);
  let off = 0;
  for (const c of st.chunks) { if (c) { buf.set(c, off); off += c.length; } }
  const name = (st.d && st.d.fileName) || 'phone track';
  juke.phoneFiles[fileId] = { buf, name, size: len, type: 'audio/mpeg' };
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
  st.blobUrl = url; st.done = true; st.buf = buf;
  if (net.enabled && net.sendJukeFileHave) { try { net.sendJukeFileHave({ fileId, by: myName }); } catch (e) {} }
  // Still the now-playing track: start it at the wall-clock offset, like a late joiner.
  if (juke.now && juke.now.fileId === fileId && juke.now.provider === 'phone-file') {
    jukePlayDirect({ ...juke.now, url }, jukeOffsetFor(juke.now));
  } else renderJuke();
}

function jukePhoneFetchTimeout(fileId) {
  const st = juke.phoneFetch[fileId];
  if (!st || st.done) return;
  st.done = true;
  if (juke.now && juke.now.fileId === fileId && juke.now.provider === 'phone-file') {
    // Nobody served the bytes — the uploader probably left.
    const who = (st.d && st.d.addedBy) || 'the uploader';
    jukeHint(`that phone track is gone \u2014 ${who} may have left the room`);
    jukeOnTrackError(); // honest error path: the room moves on
  }
}

function handleJukeFileHave(peerId, d) {
  if (!d || typeof d.fileId !== 'string') return;
  if (!juke.phoneHave[d.fileId]) juke.phoneHave[d.fileId] = new Set();
  juke.phoneHave[d.fileId].add(d.by || peerId);
}

/* ---------- playback ---------- */

/* Pop the next track FIFO and broadcast it. Whoever calls this becomes
   the broadcaster (queuer of the finished track, skipper, watchdog,
   DJ-leave resumer). */
function jukeAdvance() {
  const next = juke.queue.shift() || null;
  if (!next) {
    const msg = { stopped: true, by: myName, startedAt: Date.now() };
    if (net.enabled && net.sendJukePlay) {
      try { net.sendJukePlay(msg); } catch (e) {}
    }
    jukeStopPlayback();
    juke.now = null;
    juke.nowStartedAt = 0;
    juke.lastPlaySeenAt = Date.now();
    renderJuke();
    return null;
  }
  const play = {
    id: next.id, url: next.url, provider: next.provider,
    videoId: next.videoId, title: next.title,
    addedBy: next.addedBy, startedAt: Date.now(),
    durationMs: 0, by: myName,
  };
  if (next.provider === 'phone-file') {
    play.fileId = next.fileId;
    play.fileName = next.fileName;
  }
  // Playlist grouping survives the queue -> now-playing hop (and the broadcast).
  if (next.group) {
    play.group = next.group;
    play.groupTitle = next.groupTitle;
    play.groupCount = next.groupCount;
  }
  if (net.enabled && net.sendJukePlay) {
    try { net.sendJukePlay(play); } catch (e) {}
  }
  jukeAdoptPlay(play);
  return play;
}

function handleJukePlay(peerId, d) {
  if (!jukeSrvOk(d)) return;
  if (!jukeValidPlay(d)) return;
  if (d.stopped) {
    jukeStopPlayback();
    juke.now = null;
    juke.nowStartedAt = 0;
    juke.lastPlaySeenAt = Math.max(juke.lastPlaySeenAt, d.startedAt || Date.now());
    renderJuke();
    if (jukeIAmHolder) jukeBroadcastSync();
    return;
  }
  const inContention = Date.now() - juke.adoptedAt < JUKE_CONTENTION_MS;
  if (juke.now && d.id === juke.now.id && !inContention) return; // duplicate
  if (inContention && juke.now && d.startedAt >= juke.nowStartedAt) return; // we hold the earlier claim
  jukeAdoptPlay(d);
  if (jukeIAmHolder) jukeBroadcastSync();
}

function jukeAdoptPlay(d) {
  juke.now = { ...d };
  juke.nowStartedAt = d.startedAt;
  juke.adoptedAt = Date.now();
  juke.lastPlaySeenAt = Math.max(juke.lastPlaySeenAt, d.startedAt);
  juke.overSince = 0;
  // The broadcaster popped it locally; receivers drop it from their queue.
  const i = juke.queue.findIndex((t) => t.id === d.id);
  if (i !== -1) juke.queue.splice(i, 1);
  jukeStartPlayback(d);
}

/* offset math, shared by the real players and the tests */
function jukeOffsetFor(d, nowMs) {
  return Math.max(0, ((nowMs == null ? Date.now() : nowMs) - d.startedAt) / 1000);
}

function jukeStartPlayback(d) {
  jukeStopPlayer();
  juke.joinWaiting = false;
  juke.playerErrored = false;
  soundPillHide(); // fresh track, fresh state — the track's own path re-shows it if blocked
  const offset = jukeOffsetFor(d);
  if (d.provider === 'youtube') jukePlayYT(d, offset);
  else if (d.provider === 'soundcloud') jukePlaySC(d, offset);
  else if (d.provider === 'direct-audio') jukePlayDirect(d, offset);
  else if (d.provider === 'phone-file') jukePlayPhoneFile(d, offset);
  else jukePlayExternal(d);
  jukeArmEndWatcher();
  jukeArmResync();
  jukeArmProgress();
  renderJuke();
}

/* ---------- embedded players ---------- */

function jukeLoadYTApi(cb) {
  if (juke.ytApiReady) { cb(true); return; }
  juke.ytApiQueue.push(cb);
  if (juke.ytApiLoading) return;
  juke.ytApiLoading = true;
  window.onYouTubeIframeAPIReady = () => {
    juke.ytApiReady = true; juke.ytApiLoading = false;
    const q = juke.ytApiQueue.splice(0); q.forEach((f) => { try { f(true); } catch (e) {} });
  };
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => {
    juke.ytApiLoading = false;
    const q = juke.ytApiQueue.splice(0); q.forEach((f) => { try { f(false); } catch (e) {} });
  };
  document.head.appendChild(s);
}

function jukeLoadSCApi(cb) {
  if (juke.scApiReady) { cb(true); return; }
  juke.scApiQueue.push(cb);
  if (juke.scApiLoading) return;
  juke.scApiLoading = true;
  const s = document.createElement('script');
  s.src = 'https://w.soundcloud.com/player/api.js';
  s.onload = () => {
    juke.scApiReady = !!(window.SC && window.SC.Widget);
    juke.scApiLoading = false;
    const q = juke.scApiQueue.splice(0); q.forEach((f) => { try { f(juke.scApiReady); } catch (e) {} });
  };
  s.onerror = () => {
    juke.scApiLoading = false;
    const q = juke.scApiQueue.splice(0); q.forEach((f) => { try { f(false); } catch (e) {} });
  };
  document.head.appendChild(s);
}

/* ---------- hardened playback (build 25) ----------
   After play() is called: poll ~6s for real PLAYING state. If the provider
   never gets there, recover once (re-cue / reload), poll another ~6s, then:
   - a provider ERROR event fired -> the honest toast + auto-advance path
     (jukeOnTrackError, already triggered by the binding) — stop watching.
   - still silent, no error -> the browser blocked autoplay: raise the
     single "tap to join the music" pulse button; the user's tap unblocks it. */
function jukeArmPlayWatchdog(kind, d, recover) {
  clearTimeout(juke.watchT);
  juke.watchT = null;
  let tries = 0, phase = 0;
  const isPlaying = () => {
    try {
      if (!juke.player || juke.player.kind !== kind) return false;
      if (kind === 'youtube') return juke.player.state() === 1;
      if (kind === 'soundcloud') return juke.player.playingFlag === true;
      if (kind === 'direct-audio') return juke.player.playing() === true;
      return false;
    } catch (e) { return false; }
  };
  const tick = () => {
    juke.watchT = null;
    if (!juke.now || juke.now.id !== d.id) return;
    if (!juke.player || juke.player.kind !== kind) return;
    if (juke.playerErrored) return; // error binding fired the honest path
    if (isPlaying()) return;
    tries++;
    if (tries < 9) { juke.watchT = setTimeout(tick, 700); return; } // ~6s per phase
    if (phase === 0) {
      phase = 1; tries = 0;
      try { if (recover) recover(); } catch (e) {}
      juke.watchT = setTimeout(tick, 700);
      return;
    }
    // Recovered once, still silent, no provider error: autoplay is blocked.
    // Build 70: raise the GLOBAL pill too — the in-panel join button is
    // invisible while the jukebox is closed, which is exactly when a remote
    // track on a fresh phone needs it. One tap seeks to the wall-clock
    // offset and plays.
    juke.joinWaiting = true;
    renderJuke();
    soundPillShow();
  };
  juke.watchT = setTimeout(tick, 700);
}

/* One-tap join: the user's gesture unblocks provider autoplay. */
function jukeJoinTap() {
  if (!juke.player) return;
  try {
    const off = juke.now ? jukeOffsetFor(juke.now) : 0;
    if (juke.player.kind === 'soundcloud') {
      // Build 56: the SC widget can wedge playing-silently if the autoplay
      // block hit it mid-buffer. A seek inside this real gesture forces the
      // audio element to re-engage; play() then starts it with sound.
      try { juke.player.seekTo(Math.max(0, off)); } catch (e) {}
    } else if (off > 1) {
      try { juke.player.seekTo(off); } catch (e) {}
    }
    juke.player.play();
  } catch (e) {}
  juke.joinWaiting = false;
  renderJuke();
}

/* ---------- sound unlock pill (build 30) ----------
   iOS Safari locks audio until a real user gesture. The drift tap unlocks
   it, but a remote-triggered track (or an OS-suspended context) can still
   hit a block. This one floating pill covers both audio paths: the tap IS
   a gesture, so audioEnsureRunning() resumes the context here, then the
   join-tap path seeks to the wall-clock offset and plays. */
const soundPillEl = document.getElementById('sound-pill');
function soundPillShow() {
  if (!soundPillEl) return;
  // build 40: when the block is the jukebox waiting on a gesture, the pill
  // says so in the room's own language.
  try {
    soundPillEl.innerHTML = juke.joinWaiting
      ? '&#128263; tap to join the music'
      : '&#128263; tap for sound';
  } catch (e) {}
  soundPillEl.style.display = '';
}
function soundPillHide() {
  if (soundPillEl) soundPillEl.style.display = 'none';
}
function soundPillBlockedErr(e) {
  const n = (e && e.name) || '';
  return n === 'NotAllowedError' || n === 'SecurityError' || n === 'NotSupportedError';
}
function soundPillTap() {
  audioEnsureRunning(); // real gesture: iOS lets the context resume here
  jukeJoinTap();        // seek to the room's wall-clock offset + play
  soundPillHide();
}
if (soundPillEl) {
  soundPillEl.addEventListener('click', () => { soundPillTap(); soundPillEl.blur(); });
}

/* ---------- invisible players (build 25, simplified build 55) ----------
   The provider iframes are permanently invisible (1px, off-screen, no
   pointer events — never display:none, which throttles some players).
   YouTube keeps ONE persistent warm player (loadVideoById is solid);
   SoundCloud plays one fresh widget per track, aimed straight at the URL —
   simpler, and the proven path. */

function jukePrewarm() {
  if (juke.prewarmed) return;
  juke.prewarmed = true;
  jukeEnsureWarmYT(() => {});
}

function jukeEnsureWarmYT(cb) {
  if (juke.warmYt && juke.warmYt.ready) { cb(juke.warmYt); return; }
  juke.warmYt = juke.warmYt || { player: null, ready: false, queue: [] };
  juke.warmYt.queue.push(cb);
  if (juke.warmYt.player) return; // building already
  jukeLoadYTApi((ok) => {
    const w = juke.warmYt;
    if (!w) return;
    if (!ok || !window.YT) {
      w.queue.splice(0).forEach((f) => { try { f(null); } catch (e) {} });
      juke.warmYt = null;
      return;
    }
    try {
      const holder = document.getElementById('juke-yt-holder');
      const el = document.createElement('div');
      el.id = 'juke-yt-warm';
      holder.appendChild(el);
      const p = new window.YT.Player(el, {
        width: '1', height: '1',
        videoId: 'aqz-KE-bpKQ', // warmup cue only (Big Buck Bunny, reliably embeddable) — never plays
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, rel: 0 },
        events: {
          onReady: (ev) => {
            w.ready = true;
            try { ev.target.setVolume(Math.round(juke.volume * 100)); } catch (e) {}
            w.queue.splice(0).forEach((f) => { try { f(w); } catch (e) {} });
          },
          onStateChange: (ev) => { jukeWarmYtState(ev); },
          onError: () => { juke.playerErrored = true; jukeOnTrackError(); },
        },
      });
      w.player = p;
      // API wedged and onReady never fires: don't hang the queue forever.
      setTimeout(() => {
        if (w && !w.ready && w.queue.length) {
          w.queue.splice(0).forEach((f) => { try { f(null); } catch (e) {} });
        }
      }, 20000);
    } catch (e) {
      juke.warmYt = null;
    }
  });
}

/* Persistent handler for the warm YT player: CUED (after cueVideoById)
   means play; ENDED advances the room. Ignores anything that isn't the
   warm player or the current track. */
function jukeWarmYtState(ev) {
  if (!juke.player || !juke.player.warm || juke.player.kind !== 'youtube') return;
  if (!juke.now) return;
  try {
    if (ev.data === window.YT.PlayerState.CUED) ev.target.playVideo();
    else if (ev.data === window.YT.PlayerState.ENDED) jukeOnPlayerEnded();
  } catch (e) {}
}

function jukePlayYT(d, offset) {
  if (juke.playerFactory && juke.playerFactory.youtube) {
    const hooks = { onEnded: () => jukeOnPlayerEnded() };
    juke.player = juke.playerFactory.youtube(d, offset, hooks);
    try { juke.player.setVolume(Math.round(juke.volume * 100)); } catch (e) {}
    return;
  }
  jukeEnsureWarmYT((w) => {
    if (!juke.now || juke.now.id !== d.id) return; // stale track
    if (w && w.ready) { jukeUseWarmYT(w, d, offset); return; }
    jukePlayYTFresh(d, offset);
  });
}

function jukeUseWarmYT(w, d, offset) {
  const p = w.player;
  juke.player = {
    kind: 'youtube', warm: true,
    play: () => { try { p.playVideo(); } catch (e) {} },
    pause: () => { try { p.pauseVideo(); } catch (e) {} },
    seekTo: (s) => { try { p.seekTo(s, true); } catch (e) {} },
    pos: () => { try { return p.getCurrentTime(); } catch (e) { return null; } },
    dur: () => { try { return p.getDuration(); } catch (e) { return null; } },
    state: () => { try { return p.getPlayerState(); } catch (e) { return -1; } },
    setVolume: (v) => { try { p.setVolume(v); } catch (e) {} },
    destroy: () => { try { p.stopVideo(); } catch (e) {} }, // warm player lives on
  };
  try { p.setVolume(Math.round(juke.volume * 100)); } catch (e) {}
  try {
    p.cueVideoById(d.videoId, Math.max(0, offset));
  } catch (e) { jukeOnTrackError(); return; }
  jukeArmPlayWatchdog('youtube', d, () => {
    // one recovery: re-cue at the room's current offset
    if (!juke.now || juke.now.id !== d.id) return;
    try { p.cueVideoById(d.videoId, Math.max(0, jukeOffsetFor(juke.now))); } catch (e) {}
  });
}

/* Fallback when the warm player couldn't be built: the old per-track
   player, still invisible. destroy() removes its own DOM only — the warm
   player (if any) is never touched. */
function jukePlayYTFresh(d, offset) {
  const holder = document.getElementById('juke-yt-holder');
  if (!holder) { jukeOnTrackError(); return; }
  const div = document.createElement('div');
  div.id = 'juke-yt-fresh';
  holder.appendChild(div);
  jukeLoadYTApi((ok) => {
    if (!ok || !juke.now || juke.now.id !== d.id) { try { div.remove(); } catch (e) {} return; }
    try {
      const p = new window.YT.Player(div, {
        width: '1', height: '1',
        videoId: d.videoId,
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, rel: 0 },
        events: {
          onReady: (ev) => {
            const off = juke.now && juke.now.id === d.id ? jukeOffsetFor(juke.now) : 0;
            try { if (off > 1) ev.target.seekTo(off, true); } catch (e) {}
            try { ev.target.setVolume(Math.round(juke.volume * 100)); } catch (e) {}
            try { ev.target.playVideo(); } catch (e) {}
            jukeArmPlayWatchdog('youtube', d, () => {
              if (!juke.now || juke.now.id !== d.id) return;
              try { ev.target.loadVideoById(d.videoId, Math.max(0, jukeOffsetFor(juke.now))); } catch (e) {}
            });
          },
          onStateChange: (ev) => {
            if (ev.data === window.YT.PlayerState.ENDED) jukeOnPlayerEnded();
          },
          onError: () => { juke.playerErrored = true; jukeOnTrackError(); },
        },
      });
      juke.player = {
        kind: 'youtube', fresh: true,
        play: () => p.playVideo(),
        pause: () => p.pauseVideo(),
        seekTo: (s) => p.seekTo(s, true),
        pos: () => { try { return p.getCurrentTime(); } catch (e) { return null; } },
        dur: () => { try { return p.getDuration(); } catch (e) { return null; } },
        state: () => { try { return p.getPlayerState(); } catch (e) { return -1; } },
        setVolume: (v) => { try { p.setVolume(v); } catch (e) {} },
        destroy: () => { try { p.destroy(); } catch (e) {} try { div.remove(); } catch (e) {} },
      };
    } catch (e) { jukeOnTrackError(); }
  });
}

/* A track the provider refused to load (private, deleted, region-blocked):
   tell the room plainly instead of sitting in silence, and let the queuer
   move the room on to the next track. */
let jukeErrAdvancedFor = null;
function jukeOnTrackError(msg) {
  if (!juke.now) return;
  if (jukeErrAdvancedFor === juke.now.id) return; // already handling it
  jukeErrAdvancedFor = juke.now.id;
  jukeHint(msg || 'couldn\u2019t load that link — is it public?');
  if (juke.now.addedBy === myName) {
    setTimeout(() => {
      if (juke.now && jukeErrAdvancedFor === juke.now.id) jukeAdvance();
    }, 2500);
  }
}

/* Build 54: the widget 404s on on.soundcloud.com short links (verified),
   so a track whose URL never resolved at queue time gets one more resolve
   here, before any widget sees it. If it still won't resolve, say so
   plainly and skip — never feed a known-bad URL to the widget. */
async function jukePlaySC(d, offset) {
  if (juke.playerFactory && juke.playerFactory.soundcloud) {
    const hooks = { onEnded: () => jukeOnPlayerEnded() };
    juke.player = juke.playerFactory.soundcloud(d, offset, hooks);
    try { juke.player.setVolume(Math.round(juke.volume * 100)); } catch (e) {}
    return;
  }
  if (jukeIsShortSCLink(d.url)) {
    jukeHint('resolving that soundcloud link…');
    let r = null;
    try { r = await jukeResolveShortLink(d.url); } catch (e) { r = null; }
    if (!juke.now || juke.now.id !== d.id) return; // skipped while resolving
    if (r && r.url) {
      d.url = r.url;
      juke.now.url = r.url;
      if (r.title) { d.title = r.title; juke.now.title = r.title; }
      renderJuke();
    } else {
      jukeOnTrackError('that soundcloud link won\u2019t open — paste the full soundcloud.com link');
      return;
    }
  }
  // Build 55: one path — a fresh widget per track, aimed straight at the
  // URL. (The warm widget's load() was a second failure mode with no upside
  // for a jukebox; the per-track iframe is the proven player.)
  if (!juke.now || juke.now.id !== d.id) return; // skipped while resolving
  jukePlaySCFresh(d, offset);
}

/* The per-track widget: a fresh invisible iframe aimed straight at the
   track URL. destroy() only unbinds — the transient iframe is removed. */
function jukePlaySCFresh(d, offset) {
  const holder = document.getElementById('juke-sc-holder');
  if (!holder) { jukeOnTrackError(); return; }
  const iframe = document.createElement('iframe');
  iframe.id = 'juke-sc-fresh';
  iframe.width = '1'; iframe.height = '1';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('allow', 'autoplay; encrypted-media');
  iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(d.url) +
    '&auto_play=false&hide_related=true&show_comments=false&show_user=false&visual=false';
  holder.appendChild(iframe);
  jukeLoadSCApi((ok) => {
    if (!juke.now || juke.now.id !== d.id) { try { iframe.remove(); } catch (e) {} return; }
    if (!ok) {
      jukeHint('soundcloud isn\u2019t loading — check your connection');
      juke.playerErrored = true;
      jukeOnTrackError();
      return;
    }
    try {
      const w = window.SC.Widget(iframe);
      let playingFlag = false;
      let playAt = 0;   // build 58: last PLAY timestamp
      let peakMs = 0;   // build 58: furthest real widget position seen
      let posIv = null; // build 58: position sampler (PLAY fires before the stream is confirmed)
      w.bind(window.SC.Widget.Events.PLAY, () => {
        playingFlag = true;
        playAt = Date.now();
        // Build 56: the track beat the watchdog on its own (slow network) —
        // clear the stale "tap to join" pill instead of leaving it up.
        if (juke.joinWaiting) { juke.joinWaiting = false; renderJuke(); }
        if (!posIv) posIv = setInterval(() => {
          try { w.getPosition((ms) => { if (ms > peakMs) peakMs = ms; }); } catch (e) {}
        }, 1000);
      });
      w.bind(window.SC.Widget.Events.PAUSE, () => {
        playingFlag = false;
        // Build 58: PLAY followed quickly by PAUSE with the needle never
        // moving means SoundCloud's audio stream died upstream (the track
        // itself is broken — metadata loads, media 404s). Say so honestly
        // and move on instead of sitting silent with a moving progress bar.
        if (playAt && Date.now() - playAt < 12000 && peakMs < 2000) {
          playAt = 0;
          if (posIv) { clearInterval(posIv); posIv = null; }
          juke.playerErrored = true;
          jukeOnTrackError('that track\u2019s audio wouldn\u2019t load on soundcloud');
        }
      });
      w.bind(window.SC.Widget.Events.FINISH, () => {
        playingFlag = false;
        if (posIv) { clearInterval(posIv); posIv = null; }
        jukeOnPlayerEnded();
      });
      w.bind(window.SC.Widget.Events.ERROR, () => {
        playingFlag = false;
        if (posIv) { clearInterval(posIv); posIv = null; }
        juke.playerErrored = true; jukeOnTrackError();
      });
      w.bind(window.SC.Widget.Events.READY, () => {
        const off = juke.now && juke.now.id === d.id ? jukeOffsetFor(juke.now) : 0;
        try { w.setVolume(Math.round(juke.volume * 100)); } catch (e) {}
        try { if (off > 1) w.seekTo(Math.round(off * 1000)); } catch (e) {}
        try { w.play(); } catch (e) {}
        try {
          w.getDuration((ms) => {
            if (juke.now && juke.now.id === d.id && ms > 0) juke.now.durationMs = ms;
          });
        } catch (e) {}
        jukeArmPlayWatchdog('soundcloud', d, () => {
          if (!juke.now || juke.now.id !== d.id) return;
          try { if (off > 1) w.seekTo(Math.round(jukeOffsetFor(juke.now) * 1000)); } catch (e) {}
          try { w.play(); } catch (e) {}
        });
      });
      let lastPos = null;
      let lastDur = null;
      juke.player = {
        kind: 'soundcloud', fresh: true,
        get playingFlag() { return playingFlag; }, // live read for the autoplay watchdog
        play: () => w.play(),
        pause: () => w.pause(),
        seekTo: (s) => w.seekTo(Math.round(s * 1000)),
        pos: () => {
          try { w.getPosition((ms) => { lastPos = ms / 1000; }); } catch (e) {}
          return lastPos;
        },
        dur: () => {
          try { w.getDuration((ms) => { lastDur = ms / 1000; }); } catch (e) {}
          return lastDur;
        },
        setVolume: (v) => { try { w.setVolume(v); } catch (e) {} },
        destroy: () => { try { if (posIv) clearInterval(posIv); } catch (e) {} try { w.unbind(window.SC.Widget.Events.FINISH); } catch (e) {} try { iframe.remove(); } catch (e) {} },
      };
    } catch (e) { jukeOnTrackError(); }
  });
}

/* ---------- direct audio: mp3/etc through the game's own chain (build 25) --
   A pasted .mp3/.ogg/.wav/.m4a URL plays through WebAudio into the jam bus
   (reverb + delay sends, limiter, master) — so the sampler's "grab loop"
   captures it natively, the volume slider drives it, and aura-ducking rules
   apply like any other game audio.
   Path A: fetch + decodeAudioData (needs CORS on the host).
   No-CORS fallback: plain <audio> playback — audible, but outside the chain
   (the room is told plainly). captureStream() is NOT an option for
   cross-origin media: Chromium throws SecurityError ("Cannot capture from
   element with cross-origin data") — verified live, so no capture path is
   attempted. */

function jukeDirectDest() {
  const ch = jamEnsureChain();
  if (ch && ch.bus) return ch.bus;
  return (typeof audio !== 'undefined' && audio.master) || null;
}

function jukeDirectTeardownNodes(st) {
  st.gen = (st.gen || 0) + 1; // invalidates any pending onended
  if (st.src) { try { st.src.onended = null; st.src.stop(); } catch (e) {} try { st.src.disconnect(); } catch (e) {} st.src = null; }
  if (st.mss) { try { st.mss.disconnect(); } catch (e) {} st.mss = null; }
  if (st.gain) { try { st.gain.disconnect(); } catch (e) {} st.gain = null; }
  if (st.an) { try { st.an.disconnect(); } catch (e) {} st.an = null; }
  st.startCtx = null;
}

function jukeDirectDestroy(st) {
  jukeDirectTeardownNodes(st);
  if (st.el) { try { st.el.pause(); } catch (e) {} try { st.el.removeAttribute('src'); st.el.load(); } catch (e) {} }
  st.playing = false;
  st.paused = true;
  if (juke.direct === st) juke.direct = null;
}

function jukeStopDirect() {
  if (juke.direct) { try { jukeDirectDestroy(juke.direct); } catch (e) {} juke.direct = null; }
}

function jukePlayDirect(d, offset) {
  if (juke.playerFactory && juke.playerFactory.direct) {
    const hooks = { onEnded: () => jukeOnPlayerEnded(), onError: () => jukeOnTrackError() };
    juke.player = juke.playerFactory.direct(d, offset, hooks);
    try { juke.player.setVolume(Math.round(juke.volume * 100)); } catch (e) {}
    return;
  }
  if (!audio.ctx) { jukeOnTrackError(); return; }
  const st = { mode: 'loading', d, offset, vol: juke.volume, gen: 0, captureOk: false };
  juke.direct = st;
  juke.player = {
    kind: 'direct-audio',
    play: () => jukeDirectPlay(st),
    pause: () => jukeDirectPause(st),
    seekTo: (s) => jukeDirectSeek(st, s),
    pos: () => jukeDirectPos(st),
    dur: () => jukeDirectDur(st),
    playing: () => !!st.playing,
    setVolume: (v) => {
      st.vol = v / 100;
      if (st.gain && audio.ctx) {
        try { st.gain.gain.setTargetAtTime(st.vol, audio.ctx.currentTime, 0.05); } catch (e) {}
      }
    },
    destroy: () => jukeDirectDestroy(st),
  };
  jukeDirectLoad(st);
  jukeArmPlayWatchdog('direct-audio', d, () => {
    // one recovery: rebuild from the cached buffer / re-seek the element
    if (!juke.now || juke.now.id !== d.id || juke.direct !== st) return;
    if (st.mode === 'webaudio' && st.buffer) jukeDirectStartBuffer(st, jukeDirectPos(st) || 0);
    else if (st.el) { try { st.el.play(); } catch (e) {} }
  });
}

async function jukeDirectLoad(st) {
  const d = st.d;
  const alive = () => juke.now && juke.now.id === d.id && juke.direct === st;
  // Path A: fetch + decode (needs CORS on the host).
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(d.url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(to);
    if (!alive()) return;
    if (!r.ok) throw new Error('http ' + r.status);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct && !(ct.startsWith('audio/') || ct === 'application/octet-stream' || ct.startsWith('video/'))) {
      throw new Error('not audio: ' + ct);
    }
    const ab = await r.arrayBuffer();
    if (!alive()) return;
    const buf = await audio.ctx.decodeAudioData(ab);
    if (!alive()) return;
    st.buffer = buf;
    st.mode = 'webaudio';
    // The buffer rides the game's own WebAudio chain (jam bus) — the
    // sampler's "grab loop" captures it natively, no tab capture needed.
    st.captureOk = true;
    if (juke.now && juke.now.id === d.id && !juke.now.durationMs) {
      juke.now.durationMs = Math.round(buf.duration * 1000);
    }
    jukeDirectStartBuffer(st, Math.max(0, jukeOffsetFor(d)));
    return;
  } catch (e) { /* CORS / decode / http failure -> plain <audio> element */ }
  if (!alive()) return;
  jukeDirectLoadElement(st);
}

/* Start (or restart) the buffer source at an offset. The generation token
   keeps pause()/seekTo() from tripping the natural-end handler. */
function jukeDirectStartBuffer(st, offsetSec) {
  const ctx = audio.ctx;
  const dest = jukeDirectDest();
  if (!ctx || !dest || !st.buffer) { jukeOnTrackError(); return; }
  jukeDirectTeardownNodes(st);
  const dur = st.buffer.duration;
  let off = Math.max(0, offsetSec || 0);
  if (off >= dur) off = Math.max(0, dur - 1); // late joiner: catch the tail
  const gain = ctx.createGain();
  gain.gain.value = st.vol != null ? st.vol : juke.volume;
  const an = ctx.createAnalyser(); // test seam + future visuals; doesn't touch the signal
  an.fftSize = 1024;
  gain.connect(an);
  gain.connect(dest);
  const src = ctx.createBufferSource();
  src.buffer = st.buffer;
  src.connect(gain);
  st.gain = gain; st.an = an; st.src = src;
  st.startCtx = ctx.currentTime + 0.05;
  st.startOff = off;
  st.playing = true; st.paused = false;
  const gen = st.gen;
  src.onended = () => {
    if (st.gen !== gen || st.paused) return;
    if (juke.now && juke.now.id === st.d.id) { st.playing = false; jukeOnPlayerEnded(); }
  };
  try { src.start(st.startCtx, off); } catch (e) { jukeOnTrackError(); }
  // WebAudio path: a suspended AudioContext (iOS backgrounding) schedules
  // silence with no error. Try to resume; if the OS still says no, the
  // pill is the honest path back in.
  if (ctx.state === 'suspended') {
    try {
      const pr = ctx.resume();
      if (pr && pr.then) pr.then(() => { if (ctx.state === 'suspended') soundPillShow(); });
      else if (ctx.state === 'suspended') soundPillShow();
    } catch (e) { soundPillShow(); }
  }
}

function jukeDirectPlay(st) {
  if (!st || juke.direct !== st) return;
  if (st.mode === 'webaudio' && st.buffer) {
    if (st.paused) jukeDirectStartBuffer(st, st.pauseOff || 0);
  } else if (st.el) {
    // Programmatic play (resume / join tap): if iOS still refuses, the
    // global pill is the honest path back in.
    try {
      const pr = st.el.play();
      if (pr && pr.catch) pr.catch((e) => { if (soundPillBlockedErr(e)) soundPillShow(); });
    } catch (e) {}
    st.playing = true; st.paused = false;
  }
}

function jukeDirectPause(st) {
  if (!st || juke.direct !== st) return;
  st.gen = (st.gen || 0) + 1;
  if (st.mode === 'webaudio' && st.src) {
    st.pauseOff = jukeDirectPos(st);
    try { st.src.stop(); } catch (e) {}
    st.src = null;
  } else if (st.el) {
    try { st.el.pause(); } catch (e) {}
  }
  st.playing = false; st.paused = true;
}

function jukeDirectSeek(st, s) {
  if (!st || juke.direct !== st) return;
  if (st.mode === 'webaudio' && st.buffer) {
    const wasPaused = st.paused;
    jukeDirectStartBuffer(st, Math.max(0, s));
    if (wasPaused) jukeDirectPause(st);
  } else if (st.el) {
    try { st.el.currentTime = Math.max(0, s); } catch (e) {}
  }
}

function jukeDirectPos(st) {
  if (!st) return null;
  if (st.mode === 'webaudio' && st.buffer && audio.ctx) {
    if (st.paused) return st.pauseOff || 0;
    if (st.startCtx == null) return 0;
    return Math.max(0, (st.startOff || 0) + (audio.ctx.currentTime - st.startCtx));
  }
  if (st.el) { try { return st.el.currentTime || 0; } catch (e) { return null; } }
  return null;
}

function jukeDirectDur(st) {
  if (!st) return null;
  if (st.mode === 'webaudio' && st.buffer) return st.buffer.duration;
  if (st.el) { try { const dd = st.el.duration; return Number.isFinite(dd) ? dd : null; } catch (e) { return null; } }
  return null;
}

/* No-CORS host: fetch/decode is impossible AND captureStream() throws
   SecurityError on cross-origin media without CORS ("Cannot capture from
   element with cross-origin data" — verified live in Chromium), so there is
   no page-API path into the chain. The element just plays: audible and
   synced, but outside the game audio — the room is told plainly. */
function jukeDirectLoadElement(st) {
  const d = st.d;
  const alive = () => juke.now && juke.now.id === d.id && juke.direct === st;
  try {
    const ctx = audio.ctx;
    const dest = jukeDirectDest();
    if (!ctx || !dest) { jukeOnTrackError(); return; }
    jukeDirectTeardownNodes(st);
    let el = document.getElementById('juke-direct-el');
    if (!el) {
      el = document.createElement('audio');
      el.id = 'juke-direct-el';
      el.preload = 'auto';
      el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(el);
    }
    try { el.pause(); } catch (e) {}
    el.onloadedmetadata = null; el.onended = null; el.onerror = null;
    st.el = el; st.mode = 'element';
    const off = Math.max(0, jukeOffsetFor(d));
    el.onloadedmetadata = () => {
      if (!alive()) return;
      const dur = el.duration;
      if (Number.isFinite(dur) && dur > 0 && juke.now && juke.now.id === d.id && !juke.now.durationMs) {
        juke.now.durationMs = Math.round(dur * 1000);
      }
      try { el.currentTime = Math.min(off, Math.max(0, (Number.isFinite(dur) ? dur : off + 1) - 1)); } catch (e) {}
      // No capture path exists for cross-origin media without CORS
      // (captureStream throws SecurityError), so the element plays
      // standalone — audible and synced, but the sampler can't grab it.
      st.captureOk = false;
      st.mode = 'plain';
      jukeHint('that host blocks audio capture — it\u2019ll play, but the sampler can\u2019t grab it');
      el.onended = () => { if (alive() && !st.paused) { st.playing = false; jukeOnPlayerEnded(); } };
      try {
        const pr = el.play();
        // iOS Safari rejects instantly (NotAllowedError) when there's been
        // no recent gesture — raise the global pill NOW instead of waiting
        // ~12s for the autoplay watchdog. The watchdog stays as backup.
        if (pr && pr.catch) pr.catch((e) => { if (soundPillBlockedErr(e)) soundPillShow(); });
        st.playing = true; st.paused = false;
      } catch (e) { /* watchdog handles it */ }
    };
    el.onerror = () => { if (alive()) { juke.playerErrored = true; jukeOnTrackError(); } };
    el.src = d.url;
    try { el.load(); } catch (e) {}
  } catch (e) { jukeOnTrackError(); }
}

/* Test seam: time-domain RMS of whatever the direct path is feeding the
   chain right now (null when nothing is routed). */
function jukeDirectRms() {
  const st = juke.direct;
  if (!st || !st.an) return null;
  try {
    const b = new Float32Array(st.an.fftSize);
    st.an.getFloatTimeDomainData(b);
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  } catch (e) { return null; }
}

/* External links (spotify, bandcamp, anything else): no embed exists, so
   the room counts down together and everyone presses play in their own
   app. Manual skip ends it — no auto-advance without a duration. */
function jukePlayExternal(d) {
  // Holders are permanently invisible (build 25 CSS); stopping the player
  // is all it takes.
  jukeStopPlayer();
  juke.player = {
    kind: 'external',
    play: () => {}, pause: () => {},
    seekTo: () => {}, pos: () => null, dur: () => null,
    setVolume: () => {}, destroy: () => {},
  };
  const cd = document.getElementById('juke-countdown');
  juke.extCount = 5;
  const tick = () => {
    if (!juke.now || juke.now.id !== d.id) return;
    if (juke.extCount > 0) {
      if (cd) { cd.style.display = ''; cd.textContent = `press play in your app in ${juke.extCount}\u2026`; }
      juke.extCount--;
      juke.extTimer = setTimeout(tick, 1000);
    } else if (cd) {
      cd.textContent = 'playing on your device — skip when it\u2019s done';
    }
  };
  tick();
  renderJuke();
}

/* ---------- end detection + watchdog ---------- */

function jukeTrackOver() {
  if (!juke.now) return false;
  if (juke.player && juke.player.kind !== 'external') {
    try {
      const dur = juke.player.dur();
      const pos = juke.player.pos();
      if (dur && dur > 0 && pos != null && pos >= dur - 0.5) return true;
    } catch (e) {}
  }
  const dm = juke.now.durationMs;
  if (dm && dm > 0 && Date.now() - juke.now.startedAt >= dm) return true;
  return false;
}

function jukeOnPlayerEnded() {
  if (!juke.now) return;
  // The queuer advances; everyone else waits for the broadcast (watchdog
  // covers the queuer vanishing).
  if (juke.now.addedBy === myName) {
    setTimeout(() => {
      if (juke.now && jukeTrackOver() && juke.now.addedBy === myName) jukeAdvance();
    }, 1200);
  }
}

function jukeArmEndWatcher() {
  clearInterval(juke.endTimer);
  juke.endTimer = setInterval(() => {
    if (!juke.now) return;
    if (!jukeTrackOver()) { juke.overSince = 0; return; }
    if (!juke.overSince) juke.overSince = Date.now();
    const overFor = Date.now() - juke.overSince;
    // Queuer's duty first…
    if (juke.now.addedBy === myName && overFor > 2000) {
      if (Date.now() - juke.lastPlaySeenAt > 2000) jukeAdvance();
      return;
    }
    // …watchdog: anyone may advance once it's been over 8s with silence.
    if (overFor > JUKE_WATCHDOG_MS && Date.now() - juke.lastPlaySeenAt > JUKE_WATCHDOG_MS) {
      jukeAdvance();
    }
  }, 2000);
}

/* Every 20s: if our player drifted >2.5s from the room's clock, snap it. */
function jukeResyncTick() {
  if (!juke.now) return false;
  if (!juke.player || juke.player.kind === 'external') return false;
  const expected = jukeOffsetFor(juke.now);
  let pos = null;
  try { pos = juke.player.pos(); } catch (e) {}
  if (pos == null || expected < 0) return false;
  if (Math.abs(pos - expected) > JUKE_DRIFT_S) {
    try { juke.player.seekTo(expected); } catch (e) { return false; }
    return true;
  }
  return false;
}
function jukeArmResync() {
  clearInterval(juke.resyncTimer);
  juke.resyncTimer = setInterval(jukeResyncTick, JUKE_RESYNC_MS);
}

function jukeArmProgress() {
  cancelAnimationFrame(juke.progressRaf);
  /* Build 61: frame-synced, monotonic. The bar is wall-clock driven, so a
     startedAt bump (sync) or duration refinement used to make it leap.
     Within a track it now never moves backward, and rAF (no CSS transition
     fighting the timer) keeps motion fluid even when ticks jitter. */
  let lastP = -1, lastTrackId = null;
  const tick = () => {
    juke.progressRaf = requestAnimationFrame(tick);
    const fill = document.getElementById('juke-progress-fill');
    if (!fill || !juke.now) return;
    const tid = juke.now.id;
    if (tid !== lastTrackId) { lastP = -1; lastTrackId = tid; }
    const dm = juke.now.durationMs;
    if (dm && dm > 0) {
      let p = Math.min(1, (Date.now() - juke.now.startedAt) / dm);
      if (lastP >= 0 && p < lastP) p = lastP; // never backward within a track
      lastP = p;
      fill.classList.remove('pulse');
      fill.style.width = (p * 100).toFixed(2) + '%';
    } else {
      fill.style.width = '';
      fill.classList.add('pulse');
    }
  };
  juke.progressRaf = requestAnimationFrame(tick);
}

function jukeStopPlayer() {
  clearTimeout(juke.extTimer);
  clearTimeout(juke.watchT); juke.watchT = null;
  const cd = document.getElementById('juke-countdown');
  if (cd) { cd.style.display = 'none'; cd.textContent = ''; }
  if (juke.player) {
    try { juke.player.destroy(); } catch (e) {}
    // Warm provider players live on (their destroy() only stops playback);
    // transient per-track players and direct-audio nodes tear down fully.
    juke.player = null;
  }
  juke.playerErrored = false;
  jukeStopDirect();
  // Holders stay in the DOM, permanently invisible (build 25) — the warm
  // players inside them must never be nuked here.
}
function jukeStopPlayback() {
  jukeStopPlayer();
  clearInterval(juke.endTimer); juke.endTimer = null;
  clearInterval(juke.resyncTimer); juke.resyncTimer = null;
  try { cancelAnimationFrame(juke.progressRaf); } catch (e) {}
  juke.progressRaf = null;
  juke.overSince = 0;
  juke.joinWaiting = false;
}

/* ---------- DJ interaction ---------- */

/* ---------- late-joiner state sync ---------- */

function handleJukeStateReq(peerId, d) {
  if (!jukeSrvOk(d)) return;
  /* Build 43: one canonical answer — the holder's. (Pre-relay, before any
     election can run, fall back to anyone-answers like before.)
     Build 53: a handoff request (freshly elected holder inheriting the
     line) is answered by ANY peer holding the line — that's the point. */
  const isHandoff = !!(d && typeof d.reqId === 'string' && d.reqId.indexOf('handoff-') === 0);
  if (!jukeIAmHolder && net.relayMode && !isHandoff) return;
  if (!d || typeof d.reqId !== 'string' || !d.reqId) return;
  if (juke.answeredReq.has(d.reqId)) return;
  /* Build 53: answer from the remembered canonical line when it's fresher
     than local drift — a peer that never got the last sync still shares
     what the holder last told it. */
  const src = (jukeLastKnown && (jukeLastKnown.queue.length || jukeLastKnown.now))
    ? jukeLastKnown : null;
  const shareQueue = src ? src.queue : juke.queue;
  const shareNow = src ? src.now : juke.now;
  const shareAt = src ? src.at : Date.now();
  if (!shareNow && shareQueue.length === 0) return; // nothing to share
  juke.answeredReq.add(d.reqId);
  if (juke.answeredReq.size > 40) {
    const oldest = juke.answeredReq.values().next().value;
    juke.answeredReq.delete(oldest);
  }
  if (!net.enabled || !net.sendJukeState) return;
  try {
    net.sendJukeState({ reqId: d.reqId, at: shareAt, now: shareNow, queue: shareQueue.slice(0, JUKE_MAX_QUEUE) });
  } catch (e) { /* best effort */ }
}

function handleJukeState(peerId, d) {
  if (!jukeSrvOk(d)) return;
  if (!d || typeof d.reqId !== 'string') return;
  /* Build 53: collecting handoff answers — the freshest one wins when the
     timer fires; don't adopt the first answer blind. */
  if (jukeHolderCatchingUp && d.reqId === jukeHandoffReqId) {
    const q = Array.isArray(d.queue) ? d.queue.filter(jukeValidAdd) : [];
    jukeHandoffAnswers.push({ queue: q, now: d.now || null, at: d.at || 0 });
    return;
  }
  if (juke.now || juke.queue.length) return; // we already have state; first answer wins
  if (d.at && jukeLastClearAt && d.at < jukeLastClearAt - 5000) return; // built before our clear
  const q = Array.isArray(d.queue) ? d.queue.filter(jukeValidAdd) : [];
  juke.queue = q.slice(0, JUKE_MAX_QUEUE);
  if (d.now && jukeValidPlay(d.now) && !d.now.stopped) {
    jukeAdoptPlay(d.now); // offset math puts us in sync mid-track
  } else renderJuke();
}

/* ---------- journey room: like + follow (build 33) ---------- */
if (jukeLikeBtn) jukeLikeBtn.addEventListener('click', () => { jukeSendLike(); jukeLikeBtn.blur(); });
if (jukeFollowBtn) jukeFollowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (jukeFollowMenu) jukeFollowMenu.style.display = jukeFollowMenu.style.display === 'none' ? '' : 'none';
  jukeFollowBtn.blur();
});
document.addEventListener('click', () => {
  if (jukeFollowMenu && jukeFollowMenu.style.display !== 'none') jukeFollowMenu.style.display = 'none';
});

/* ---------- leaving the room ---------- */

/* Build 41: the queue belongs to the SERVER, not the world room — it
   survives hops between the nexus, the sound room and the journey. Only
   a server change (or going offline) starts a fresh party. */
function jukeLeaveServer() {
  jukeStopPlayback();
  juke.now = null;
  juke.queue = [];
  if (juke.open) setJukePanel(false);
  renderJuke();
}

/* ---------- UI ---------- */

function setJukePanel(open) {
  juke.open = !!open;
  if (jukePanel) jukePanel.style.display = juke.open ? '' : 'none';
  chatFocused = juke.open; // same guard as jam: keys never fly the wisp
  if (juke.open) renderJuke();
  if (jukeBtn) jukeBtn.blur();
}

function jukeHint(msg) {
  const el = document.getElementById('juke-hint');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(jukeHint._t);
  jukeHint._t = setTimeout(() => {
    el.textContent = 'everyone hears the same track at the same time — on their own device';
  }, 4000);
}

function jukeProviderIcon(p) {
  return p === 'youtube' ? '▶ yt'
    : p === 'youtube-playlist' ? '▶ playlist'
    : p === 'soundcloud' ? '☁ sc'
    : p === 'soundcloud-set' || p === 'soundcloud-short' ? '☁ set'
    : p === 'direct-audio' ? '⚡ direct'
    : p === 'phone-file' ? '📱 phone'
    : '↗ ext';
}

function renderJuke() {
  if (!jukePanel) return;
  const titleEl = document.getElementById('juke-now-title');
  const provEl = document.getElementById('juke-now-provider');
  const byEl = document.getElementById('juke-now-by');
  const skipBtn = document.getElementById('juke-skip');
  const openApp = document.getElementById('juke-open-app');
  const joinBtn = document.getElementById('juke-join');
  const qEl = document.getElementById('juke-queue');
  if (juke.now && !juke.now.stopped) {
    if (titleEl) titleEl.textContent = jukePhonePendingText() || juke.now.title || 'untitled';
    if (provEl) provEl.textContent = jukeProviderIcon(juke.now.provider);
    if (byEl) byEl.textContent = juke.now.provider === 'phone-file'
      ? `\u{1F4F1} from ${(juke.now.addedBy || juke.now.by || 'a drifter')}'s phone`
      : `queued by ${juke.now.addedBy || juke.now.by || 'a drifter'}`;
    if (skipBtn) skipBtn.disabled = false;
    if (openApp) {
      openApp.disabled = false;
      openApp.onclick = () => { try { window.open(juke.now.url, '_blank', 'noopener'); } catch (e) {} };
    }
  } else {
    if (titleEl) titleEl.textContent = 'nothing playing';
    if (provEl) provEl.textContent = '';
    if (byEl) byEl.textContent = '';
    if (skipBtn) skipBtn.disabled = true;
    if (openApp) { openApp.disabled = true; openApp.onclick = null; }
  }
  if (joinBtn) {
    joinBtn.style.display = juke.joinWaiting ? '' : 'none';
    joinBtn.classList.toggle('pulse', juke.joinWaiting);
  }
  if (qEl) {
    qEl.innerHTML = '';
    if (!juke.queue.length) {
      qEl.innerHTML = '<div class="juke-empty">queue is empty — drop a link</div>';
    } else {
      let lastGroup = null;
      juke.queue.forEach((t) => {
        // Playlist grouping: one header per set, with a pull-the-whole-set ✕.
        if (t.group && t.group !== lastGroup) {
          const gh = document.createElement('div');
          gh.className = 'juke-group-head';
          const gl = document.createElement('span');
          const n = juke.queue.filter((x) => x.group === t.group).length;
          gl.textContent = `🎶 ${t.groupTitle || 'playlist'} • ${n} track${n === 1 ? '' : 's'} left`;
          gh.appendChild(gl);
          if (t.addedBy === myName) {
            const grm = document.createElement('button');
            grm.className = 'juke-rm';
            grm.textContent = '✕';
            grm.setAttribute('aria-label', 'remove playlist');
            grm.addEventListener('click', () => jukeRemoveGroup(t.group));
            gh.appendChild(grm);
          }
          qEl.appendChild(gh);
        }
        lastGroup = t.group || null;
        const row = document.createElement('div');
        row.className = 'juke-row';
        const nm = document.createElement('span');
        nm.className = 'juke-row-title';
        nm.textContent = t.title;
        const meta = document.createElement('span');
        meta.className = 'juke-row-meta';
        meta.textContent = t.provider === 'phone-file'
        ? `\u{1F4F1} from ${t.addedBy}'s phone`
        : `${jukeProviderIcon(t.provider)} · ${t.addedBy}`;
        row.appendChild(nm);
        row.appendChild(meta);
        if (t.addedBy === myName) {
          const rm = document.createElement('button');
          rm.className = 'juke-rm';
          rm.textContent = '✕';
          rm.setAttribute('aria-label', 'remove');
          rm.addEventListener('click', () => jukeRemoveTrack(t.id));
          row.appendChild(rm);
        }
        qEl.appendChild(row);
      });
    }
  }
  jukeBadge(); // build 40: the shared list is visible on the button itself
  jukeRenderDiag(); // build 73: keep the link diagnostic fresh
}

/* Build 73: jukebox link diagnostic — one line read off the phones.
   sent = broadcasts this phone fired, got = jukebox messages arrived,
   relay = relay transport engaged, peers = data-channel peers seen. */
function jukeRenderDiag() {
  const el = document.getElementById('juke-diag');
  if (!el) return;
  let d = null;
  try { d = net.jukeDiag(); } catch (e) {}
  if (!d) { el.textContent = 'link: —'; return; }
  // build 74: drop reasons — which gate kills arrivals (srv/valid/playing/dup/full)
  const dr = jukeDrops;
  const drops = (dr.srv + dr.valid + dr.playing + dr.dup + dr.full) > 0
    ? ` · drops srv:${dr.srv}/valid:${dr.valid}/play:${dr.playing}/dup:${dr.dup}/full:${dr.full}` : '';
  el.textContent = `link: sent ${d.tx} · got ${d.rx} · relay ${d.relay ? 'on' : 'off'} · peers ${d.peers}${drops}`;
}
// refresh the line while the panel is open — counters move live
setInterval(() => {
  const p = document.getElementById('juke-panel');
  if (p && p.style.display !== 'none') { try { jukeRenderDiag(); } catch (e) {} }
}, 1000);

/* ---------------- theatre (build 75) ----------------
   Synced video watching. One video at a time per server; whoever queues
   or hits play/pause drives — last action wins, timestamps keep everyone
   on the same frame. The player is global (body level) so audio continues
   in every room; the panel shows the video large only in the theatre. */
const theatre = {
  videoId: null, title: '', addedBy: '',
  playing: false, position: 0, startedAt: 0,
  player: null, playerReady: false,
  volume: 0.7, muted: false, // build 77: living-room mute — video room audio
  playBlocked: false, // build 79: mobile blocked our programmatic play() — needs a tap
  playerError: 0, errorMsg: '', // build 80: YT player error code + human message
  seq: 0, // build 80: monotonic state version, bumped on every local play/pause
          // broadcast so a late stateReq answer can't resurrect a paused movie
  peerSeq: {}, // build 80: last applied theatre seq per sender cid
};
// build 80: stamp the next local state version on an outgoing broadcast
function theatreNextSeq() { theatre.seq += 1; return theatre.seq; }
// build 80: drop stale theatre state (seq at or behind what we already applied
// from this sender). A late-joiner's stateReq answer is a rebroadcast of the
// sender's CURRENT state — if a newer pause already landed, the older play
// answer must not win. Payloads without seq (older builds) always apply.
function theatreSeqFresh(peerId, d) {
  const s = (d && typeof d.seq === 'number') ? d.seq : 0;
  if (s <= 0) return true;
  const last = theatre.peerSeq[peerId] || 0;
  if (s <= last) return false;
  theatre.peerSeq[peerId] = s;
  return true;
}
const theatrePanel = document.getElementById('theatre-panel');
const theatreScreen3dEl = document.getElementById('theatre-screen3d');
// build 80: the player target lives INSIDE the projection layer. The YT
// IFrame API replaces its target element with the <iframe> — if we handed it
// the layer itself, the captured reference would point at a detached node
// and every matrix3d write in theatreScreenTick() would silently no-op,
// leaving the video as a flat 2D box instead of on the 3D screen.
const theatreScreenSlotEl = document.getElementById('theatre-screen3d-slot');
const theatreNoteEl = document.getElementById('theatre-screen-note');
const theatreUrlEl = document.getElementById('theatre-url');
const theatreByEl = document.getElementById('theatre-by');
const theatrePlayPauseEl = document.getElementById('theatre-playpause');

function theatreExtractId(url) {
  if (!url) return null;
  // build 79: also accept youtube.com/live/ links
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function theatreEnsurePlayer() {
  if (theatre.player) return;
  // load the YouTube IFrame API via the jukebox's loader if needed
  const make = () => {
    if (theatre.player || !window.YT) return;
    try {
      // build 80: callbacks ignore events from a stale player — the YT API
      // can fire onError/onReady late, after theatre.player was replaced
      // (a late onError must not nuke the current playing state).
      const p = new window.YT.Player(theatreScreenSlotEl, {
        width: '100%', height: '100%',
        videoId: '',
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: (ev) => {
            if (theatre.player !== p) return;
            theatre.playerReady = true;
            theatreApplyVolume();
            if (theatre.videoId) theatreApplyState();
          },
          onStateChange: (ev) => {
            if (theatre.player !== p) return;
            // keep the play/pause button honest
            if (theatrePlayPauseEl) {
              const playing = ev.data === window.YT.PlayerState.PLAYING;
              theatrePlayPauseEl.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
            }
            // build 79: a real PLAYING state clears the autoplay-block flag
            if (ev.data === window.YT.PlayerState.PLAYING) theatreClearPlayBlock();
          },
          // build 80: surface player failures — an embedding-disabled or
          // deleted video used to fail silently to a black 3D screen.
          onError: (ev) => { if (theatre.player === p) theatreOnPlayerError(ev && ev.data); },
        },
      });
      theatre.player = p;
    } catch (e) { /* player failed — panel still shows the empty state */ }
  };
  if (window.YT && window.YT.Player) { make(); return; }
  try { jukeLoadYTApi((ok) => { if (ok) make(); }); } catch (e) {}
}

/* Apply the current theatre state to the local player: seek to the synced
   position and play or pause. */
function theatreOnPlayerError(code) {
  // build 80: the YT player failed on this video — say why instead of a
  // black 3D screen. 101/150 = owner disabled embedding, 100 = not
  // found/private/deleted, 5 = HTML5 player error, 2 = bad video id.
  theatre.playerError = code || 'unknown';
  const msg = (code === 101 || code === 150)
    ? 'this video can\u2019t play here \u2014 the owner turned off embedding. try another link.'
    : (code === 100
      ? 'youtube can\u2019t find this video \u2014 it may be private or deleted.'
      : 'the video player hit an error — try another link.');
  theatre.errorMsg = msg;
  theatre.playing = false;
  try { theatreRender(); } catch (e) {}
}
function theatreClearPlayerError() {
  if (!theatre.playerError) return;
  theatre.playerError = 0; theatre.errorMsg = '';
  try { theatreRender(); } catch (e) {}
}
function theatreApplyState() {
  if (!theatre.player || !theatre.playerReady || !theatre.videoId) return;
  try {
    const p = theatre.player;
    // only load if it's a different video
    let curId = '';
    try { curId = p.getVideoData().video_id || ''; } catch (e) {}
    if (curId !== theatre.videoId) {
      theatreClearPlayerError(); // build 80: new video, fresh chance
      p.cueVideoById(theatre.videoId);
    }
    if (theatre.playing) {
      const pos = theatre.position + (Date.now() - theatre.startedAt) / 1000;
      try { p.seekTo(Math.max(0, pos), true); } catch (e) {}
      p.playVideo();
      theatreWatchPlayBlock(); // build 79: catch the mobile autoplay block
    } else {
      try { p.seekTo(Math.max(0, theatre.position), true); } catch (e) {}
      p.pauseVideo();
    }
  } catch (e) {}
  theatreRender();
}

function theatreRender() {
  if (theatreNoteEl) theatreNoteEl.textContent = theatre.playerError
    ? theatre.errorMsg // build 80: the player said why — not a black screen
    : (theatre.playBlocked
      ? 'tap \u25b6 on this phone to start the movie' // build 79: autoplay-block hint
      : (theatre.videoId
        ? 'now showing on the big screen — look up'
        : 'paste a youtube link — it plays on the big screen'));
  if (theatreByEl) theatreByEl.textContent = theatre.videoId ? ('queued by ' + (theatre.addedBy || 'a drifter')) : '';
  if (theatrePlayPauseEl) theatrePlayPauseEl.innerHTML = theatre.playing ? '&#10074;&#10074;' : '&#9654;';
  // build 79: link diagnostic — the read-back line for sync issues
  const linkEl = document.getElementById('theatre-link');
  if (linkEl) {
    let tx = 0, rx = 0;
    try { tx = net._theatreTx || 0; rx = net._theatreRx || 0; } catch (e) {}
    const pst = !theatre.player ? 'no player' : (theatre.playerReady ? 'ready' : 'loading\u2026');
    // build 80: a player error (e.g. embedding disabled) shows on the read-back line
    const perr = theatre.playerError ? ' \u00b7 err ' + theatre.playerError : '';
    // build 80: screen state is the read-back for the 3D-screen fix —
    // '3D screen' means the layer is projected onto the cinema screen mesh.
    const scr = theatreScreen3dEl && theatreScreen3dEl.style.display !== 'none' ? '3D screen' : 'off';
    linkEl.textContent = 'link: sent ' + tx + ' \u00b7 got ' + rx + ' \u00b7 player ' + pst + perr + ' \u00b7 screen ' + scr;
  }
  // jam monitor visibility — show when there's a video and we're in the sound room
  theatreUpdateJamMonitor();
}

/* Queue a video: broadcast it, then start playing from 0. */
function theatreQueue(url) {
  const videoId = theatreExtractId(url);
  if (!videoId) {
    // build 79: a bad paste used to die silently — say so
    if (theatreNoteEl) theatreNoteEl.textContent = 'that link didn\u2019t look like a youtube link \u2014 try again';
    return;
  }
  const data = { videoId, title: '', addedBy: myName };
  theatre.videoId = videoId;
  theatre.title = '';
  theatre.addedBy = myName;
  theatre.playing = true;
  theatre.position = 0;
  theatre.startedAt = Date.now();
  theatreClearPlayerError(); // build 80: a fresh queue clears a stale player error
  try { if (net && net.sendTheatreAdd) net.sendTheatreAdd(data); } catch (e) {}
  try { if (net && net.sendTheatrePlay) net.sendTheatrePlay({ videoId, position: 0, startedAt: Date.now(), by: myName, seq: theatreNextSeq() }); } catch (e) {}
  theatreEnsurePlayer();
  theatreApplyState();
}

function theatreTogglePlay() {
  if (!theatre.videoId || !theatre.player || !theatre.playerReady) return;
  // build 79: a blocked play means the tap is "start the movie", not pause —
  // otherwise the first tap would pause the whole room instead of unlocking
  const wasBlocked = theatre.playBlocked;
  theatreClearPlayBlock(); // this tap is a real gesture — it unlocks play
  theatreClearPlayerError(); // build 80: a tap retries — drop the old error
  try {
    const p = theatre.player;
    const now = Date.now();
    if (theatre.playing && !wasBlocked) {
      const pos = p.getCurrentTime ? p.getCurrentTime() : theatre.position;
      theatre.playing = false;
      theatre.position = pos;
      theatre.startedAt = 0; // build 79: no live clock while paused
      p.pauseVideo();
      try { if (net && net.sendTheatrePause) net.sendTheatrePause({ videoId: theatre.videoId, position: pos, by: myName, seq: theatreNextSeq() }); } catch (e) {}
    } else {
      // build 79: resume from the LIVE position — a phone whose synced play
      // was autoplay-blocked taps ▶ and lands on the same spot as everyone
      const live = theatre.startedAt > 0
        ? theatre.position + (now - theatre.startedAt) / 1000
        : theatre.position;
      theatre.playing = true;
      theatre.position = Math.max(0, live);
      theatre.startedAt = now;
      try { p.seekTo(theatre.position, true); } catch (e) {}
      p.playVideo();
      try { if (net && net.sendTheatrePlay) net.sendTheatrePlay({ videoId: theatre.videoId, position: theatre.position, startedAt: now, by: myName, seq: theatreNextSeq() }); } catch (e) {}
    }
  } catch (e) {}
  theatreRender();
}

function handleTheatreAdd(peerId, d) {
  if (!d || typeof d.videoId !== 'string' || !d.videoId) return;
  // server check — same as jukebox
  if (d.srv != null && String(d.srv) !== nexusServerKey(selectedServer)) return;
  // build 81: add+play ride different channels with no ordering guarantee. If
  // the paired play already landed for this same video, don't clobber it back
  // to paused — only reset playback state for a genuinely new video.
  const isNewVideo = theatre.videoId !== d.videoId;
  theatre.videoId = d.videoId;
  theatre.title = d.title || '';
  theatre.addedBy = d.addedBy || 'a drifter';
  if (isNewVideo) {
    theatre.playing = false;
    theatre.position = 0;
  }
  theatreEnsurePlayer();
  theatreRender();
}

function handleTheatrePlay(peerId, d) {
  if (!d || typeof d.videoId !== 'string' || !d.videoId) return;
  if (d.srv != null && String(d.srv) !== nexusServerKey(selectedServer)) return;
  if (!theatreSeqFresh(peerId, d)) return; // build 80: stale (late answer) — drop
  // build 79: already watching this one in sync — don't re-seek. Walk-ins
  // ask for state on entry and the rebroadcast must not skip the room.
  if (theatre.playing && theatre.videoId === d.videoId && theatre.player && theatre.playerReady) {
    try {
      const target = (typeof d.position === 'number' ? d.position : 0) +
        (typeof d.startedAt === 'number' ? (Date.now() - d.startedAt) / 1000 : 0);
      const cur = theatre.player.getCurrentTime ? theatre.player.getCurrentTime() : -99;
      if (cur >= 0 && Math.abs(cur - target) < 4) {
        theatre.position = typeof d.position === 'number' ? d.position : theatre.position;
        theatre.startedAt = typeof d.startedAt === 'number' ? d.startedAt : theatre.startedAt;
        if (d.by) theatre.addedBy = d.by;
        theatreRender();
        return;
      }
    } catch (e) {}
  }
  theatre.videoId = d.videoId;
  theatre.playing = true;
  theatre.position = typeof d.position === 'number' ? d.position : 0;
  theatre.startedAt = typeof d.startedAt === 'number' ? d.startedAt : Date.now();
  if (d.by) theatre.addedBy = d.by;
  theatreEnsurePlayer();
  theatreApplyState();
}

function handleTheatrePause(peerId, d) {
  if (!d || typeof d.videoId !== 'string' || !d.videoId) return;
  if (d.srv != null && String(d.srv) !== nexusServerKey(selectedServer)) return;
  if (!theatreSeqFresh(peerId, d)) return; // build 80: stale (late answer) — drop
  if (theatre.videoId !== d.videoId) return;
  theatre.playing = false;
  theatre.position = typeof d.position === 'number' ? d.position : theatre.position;
  theatre.startedAt = 0; // build 79: no live clock while paused
  theatreEnsurePlayer();
  theatreApplyState();
}

/* Build 79: mobile browsers block playVideo() unless it follows a tap. The
   queue tap is long gone by the time the player is ready, and a synced play
   arriving on another phone never had a tap at all — so the movie can sit
   cued on a black screen with no hint. If we asked for play and the player
   still isn't playing a few seconds later, flag it: tapping ▶ is a real
   gesture and unlocks it. */
let theatrePlayWatchTimer = 0;
function theatreWatchPlayBlock() {
  theatre.playBlocked = false;
  if (theatrePlayWatchTimer) { clearTimeout(theatrePlayWatchTimer); theatrePlayWatchTimer = 0; }
  theatrePlayWatchTimer = setTimeout(() => {
    theatrePlayWatchTimer = 0;
    if (!theatre.playing) return;
    try {
      const st = theatre.player && theatre.player.getPlayerState
        ? theatre.player.getPlayerState() : -1;
      const YTST = window.YT && window.YT.PlayerState;
      const playing = !!(YTST && (st === YTST.PLAYING || st === YTST.BUFFERING));
      if (!playing && theatre.playing) {
        theatre.playBlocked = true;
        theatreRender();
      }
    } catch (e) {}
  }, 2500);
}
function theatreClearPlayBlock() {
  if (theatrePlayWatchTimer) { clearTimeout(theatrePlayWatchTimer); theatrePlayWatchTimer = 0; }
  if (theatre.playBlocked) { theatre.playBlocked = false; theatreRender(); }
}

/* Late joiner asks what's playing — anyone holding a video rebroadcasts
   the full state as a play (or pause). */
function handleTheatreStateReq(peerId, d) {
  if (!theatre.videoId) return;
  if (d && d.srv != null && String(d.srv) !== nexusServerKey(selectedServer)) return;
  try {
    if (theatre.playing) {
      if (net && net.sendTheatrePlay) net.sendTheatrePlay({
        videoId: theatre.videoId, position: theatre.position,
        startedAt: theatre.startedAt, by: theatre.addedBy, seq: theatre.seq,
      });
    } else {
      if (net && net.sendTheatrePause) net.sendTheatrePause({
        videoId: theatre.videoId, position: theatre.position, by: theatre.addedBy,
        seq: theatre.seq,
      });
    }
  } catch (e) {}
}

/* Show the theatre panel only in the theatre room; the player (and its
   audio) is global. Called on realm change. */
function theatreOnRealm(key) {
  if (!theatrePanel) return;
  const inTheatre = key === THEATRE_ROOM_KEY;
  theatrePanel.style.display = inTheatre ? '' : 'none';
  if (inTheatre) {
    theatreEnsurePlayer();
    theatreRender();
    // build 79: late joiner always asks what's playing — a phone holding a
    // stale videoId would otherwise never catch up. The in-sync skip in
    // handleTheatrePlay keeps the rebroadcast from skipping the room.
    setTimeout(() => {
      try { if (net && net.sendTheatreStateReq) net.sendTheatreStateReq({}); } catch (e) {}
    }, 1500);
  }
  theatreUpdateJamMonitor();
}

/* Jam monitor: while in the sound room with a video playing, show a tiny
   volume strip so the theatre audio can sit under the jam. */
function theatreUpdateJamMonitor() {
  const el = document.getElementById('jam-theatre');
  if (!el) return;
  const inJam = active && active.key === SOUND_ROOM_KEY;
  const show = inJam && !!theatre.videoId;
  el.style.display = show ? '' : 'none';
}

function theatreSetVolume(v) {
  theatre.volume = Math.max(0, Math.min(1, v));
  theatreApplyVolume();
}

/* The player's real level: muted pins it at 0, otherwise the fader level. */
function theatreApplyVolume() {
  try {
    if (theatre.player && theatre.playerReady) {
      theatre.player.setVolume(theatre.muted ? 0 : Math.round(theatre.volume * 100));
    }
  } catch (e) {}
}

/* Build 77: living-room mute for the video room. Every mute button with
   .theatre-mutebtn stays in sync — there's one in the theatre strip and
   one on the jam panel's theatre monitor. */
function theatreSetMuted(m) {
  theatre.muted = !!m;
  theatreApplyVolume();
  const icon = theatre.muted ? '&#128263;' : '&#128250;'; // 🔇 / 📺
  for (const b of document.querySelectorAll('.theatre-mutebtn')) {
    b.innerHTML = icon;
    b.classList.toggle('muted', theatre.muted);
    b.setAttribute('aria-label', theatre.muted ? 'unmute the video room' : 'mute the video room');
    b.title = theatre.muted ? 'unmute the video room' : 'mute the video room';
  }
}

/* Build 76: pin the YouTube player onto the 3D cinema screen. Every frame
   we project the screen mesh's four corners to pixels and set a CSS
   matrix3d homography on the player layer, so the video sits exactly on
   the wall — in the space, not in a 2D box. Hidden whenever we're not in
   the theatre, there's no video, or the screen faces away. */
const TS_W = 960, TS_H = 540; // player layer size, 16:9 like the screen mesh
const _tsSrc = [[0, 0], [TS_W, 0], [TS_W, TS_H], [0, TS_H]];
const _tsV = new THREE.Vector3();
const _tsQ = new THREE.Quaternion();
const _tsP = new THREE.Vector3();
const _tsN = new THREE.Vector3();

// 3x3 homography mapping src quad -> dst quad (8 unknowns, h33 = 1).
function theatreHomography(src, dst) {
  const M = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    M.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (M[i][i] || 1e-12));
}

function theatreScreenTick() {
  if (!theatreScreen3dEl) return;
  const mesh = active && active.key === THEATRE_ROOM_KEY && active.anim ? active.anim.screenMesh : null;
  const show = !!(mesh && theatre.videoId && theatre.playerReady);
  if (!show) {
    if (theatreScreen3dEl.style.display !== 'none') theatreScreen3dEl.style.display = 'none';
    return;
  }
  mesh.updateWorldMatrix(true, false);
  mesh.getWorldPosition(_tsP);
  mesh.getWorldQuaternion(_tsQ);
  _tsN.set(0, 0, 1).applyQuaternion(_tsQ); // the screen faces +Z (toward the seats)
  _tsV.copy(camera.position).sub(_tsP);
  if (_tsV.dot(_tsN) <= 0) { // behind the screen — nothing to show
    theatreScreen3dEl.style.display = 'none';
    return;
  }
  const hw = 14, hh = 7.875; // 28 x 15.75, matches the mesh
  const dst = [];
  // build 78: corner order must match _tsSrc — top-left, top-right,
  // bottom-right, bottom-left — or the picture lands upside down.
  for (const [lx, ly] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
    _tsV.set(lx, ly, 0).applyMatrix4(mesh.matrixWorld);
    _tsV.applyMatrix4(camera.matrixWorldInverse); // view space: must be in front
    if (_tsV.z > -0.1) {
      theatreScreen3dEl.style.display = 'none';
      return;
    }
    _tsV.set(lx, ly, 0).applyMatrix4(mesh.matrixWorld).project(camera);
    dst.push([(_tsV.x * 0.5 + 0.5) * window.innerWidth, (-_tsV.y * 0.5 + 0.5) * window.innerHeight]);
  }
  const h = theatreHomography(_tsSrc, dst);
  theatreScreen3dEl.style.display = '';
  // CSS matrix3d is column-major: the 2D homography sits in the x/y columns.
  theatreScreen3dEl.style.transform =
    `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
}

// wire the theatre UI
(function theatreWire() {
  const qbtn = document.getElementById('theatre-queue-btn');
  if (qbtn) qbtn.addEventListener('click', () => {
    if (theatreUrlEl && theatreUrlEl.value.trim()) {
      theatreQueue(theatreUrlEl.value.trim());
      theatreUrlEl.value = '';
    }
  });
  if (theatreUrlEl) theatreUrlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && theatreUrlEl.value.trim()) {
      theatreQueue(theatreUrlEl.value.trim());
      theatreUrlEl.value = '';
    }
  });
  if (theatrePlayPauseEl) theatrePlayPauseEl.addEventListener('click', theatreTogglePlay);
  const close = document.getElementById('theatre-close');
  if (close) close.addEventListener('click', () => { if (theatrePanel) theatrePanel.style.display = 'none'; });
  const jvol = document.getElementById('jam-theatre-vol');
  if (jvol) jvol.addEventListener('input', () => {
    if (theatre.muted && +jvol.value > 0) theatreSetMuted(false); // dragging volume unmutes
    theatreSetVolume(jvol.value / 100);
  });
  // build 77: living-room mutes — each room's mute toggle lives in both
  // rooms' UI, so you can mix from wherever you're standing.
  for (const b of document.querySelectorAll('.theatre-mutebtn')) {
    b.addEventListener('click', () => theatreSetMuted(!theatre.muted));
  }
  for (const b of document.querySelectorAll('.jam-mutebtn')) {
    b.addEventListener('click', () => setJamMuted(!jamMuted));
  }
})();

/* Build 40: the queue lives on every phone — show it without opening the
   panel. The button carries now-playing + how many are in line. */
function jukeBadge() {
  if (!jukeBtn) return;
  jukeBtn.innerHTML = '';
  const add = (html, text) => {
    if (jukeBtn.childNodes.length) jukeBtn.appendChild(document.createTextNode(' · '));
    const s = document.createElement('span');
    if (html) s.innerHTML = html; else s.textContent = text;
    jukeBtn.appendChild(s);
  };
  add('&#127925; jukebox');
  if (juke.now && !juke.now.stopped) {
    const t = (juke.now.title || 'untitled').toString().slice(0, 18);
    add(null, `now: ${t}`);
  }
  if (juke.queue.length) add(null, `${juke.queue.length} in line`);
}

function jukeSetVolume(v) {
  juke.volume = Math.max(0, Math.min(1, v));
  if (juke.player) { try { juke.player.setVolume(Math.round(juke.volume * 100)); } catch (e) {} }
  const el = document.getElementById('juke-vol');
  if (el && document.activeElement !== el) el.value = Math.round(juke.volume * 100);
  mixerSyncJuke(); // build 40: the mixer strip mirrors the jukebox fader
}

/* ---------------- per-source mixer (build 40) ----------------
   Five faders in the jam room: lead (your synth), drums (the sequencer +
   drum keys), juke (the jukebox), loop (the overdub looper), voice (room
   voices — people talking). Levels ride in localStorage so your mix is
   still yours when you drift back. */
const mixer = {
  levels: { lead: 0.9, drums: 0.85, juke: 0.7, loop: 1.0, voice: 0.9 },
  load() {
    try {
      const s = JSON.parse(localStorage.getItem('limbo-mix40') || '{}');
      for (const k of Object.keys(this.levels)) {
        const v = +s[k];
        if (isFinite(v)) this.levels[k] = Math.max(0, Math.min(1, v));
      }
    } catch (e) {}
  },
  save() {
    try { localStorage.setItem('limbo-mix40', JSON.stringify(this.levels)); } catch (e) {}
  },
};
mixer.load();
juke.volume = mixer.levels.juke; // your last jukebox level, before any player exists

/* Push stored levels into the live audio graph (no-op until audio is up). */
function jamJourneyDuck() {
  // build 41: audio zoning — in the endless journey the jam can be muted
  // outright (the jukebox and voices are never ducked).
  try {
    return (typeof journeyJamMuted !== 'undefined' && journeyJamMuted &&
      typeof active !== 'undefined' && active && active.key === JOURNEY_ROOM_KEY) ? 0 : 1;
  } catch (e) { return 1; }
}
/* Build 77: living-room mute for the sound room — the jam instruments go
   silent, voices (people talking) never do. Rides the same duck as the
   journey mute in mixerApplyGains. */
let jamMuted = false;
function setJamMuted(m) {
  jamMuted = !!m;
  try { mixerApplyGains(); } catch (e) {}
  const icon = jamMuted ? '&#128263;' : '&#127925;'; // 🔇 / 🎵
  for (const b of document.querySelectorAll('.jam-mutebtn')) {
    b.innerHTML = icon;
    b.classList.toggle('muted', jamMuted);
    b.setAttribute('aria-label', jamMuted ? 'unmute the sound room' : 'mute the sound room');
    b.title = jamMuted ? 'unmute the sound room' : 'mute the sound room';
  }
}
function mixerApplyGains() {
  const ch = (typeof audio !== 'undefined' && audio.ctx && jam.chain) || null;
  if (!ch || !ch.gains) return;
  // build 77: living-room mute — the jam bus ducks to 0, voice never does.
  const duck = jamJourneyDuck() * (jamMuted ? 0 : 1);
  try {
    if (ch.gains.lead) ch.gains.lead.gain.setTargetAtTime(mixer.levels.lead * duck, audio.ctx.currentTime, 0.02);
    if (ch.gains.drums) ch.gains.drums.gain.setTargetAtTime(mixer.levels.drums * duck, audio.ctx.currentTime, 0.02);
    if (ch.gains.loop) ch.gains.loop.gain.setTargetAtTime(mixer.levels.loop * duck, audio.ctx.currentTime, 0.02);
    if (ch.gains.bass) ch.gains.bass.gain.setTargetAtTime(1.0 * duck, audio.ctx.currentTime, 0.02);
    if (ch.gains.pad) ch.gains.pad.gain.setTargetAtTime(0.8 * duck, audio.ctx.currentTime, 0.02);
  } catch (e) {}
  // voice rides its own gain on the master (build 40) — never the bus.
  try {
    if (voice.inGain) voice.inGain.gain.setTargetAtTime(mixer.levels.voice, audio.ctx.currentTime, 0.02);
  } catch (e) {}
}

/* The jukebox fader on the mixer strip mirrors juke.volume (and the
   jukebox panel's own slider) — one level, three faces. */
function mixerSyncJuke() {
  mixer.levels.juke = juke.volume;
  mixer.save();
  const el = document.getElementById('mix-juke');
  if (el && document.activeElement !== el) el.value = Math.round(juke.volume * 100);
}

function mixerSet(src, v) {
  if (!mixer.levels.hasOwnProperty(src)) return;
  v = Math.max(0, Math.min(1, +v || 0));
  mixer.levels[src] = v;
  mixer.save();
  if (src === 'juke') jukeSetVolume(v); // fans out to player + both sliders
  else mixerApplyGains();
  const el = document.getElementById('mix-' + src);
  if (el && document.activeElement !== el) el.value = Math.round(v * 100);
}

function mixerInitUI() {
  for (const src of Object.keys(mixer.levels)) {
    const el = document.getElementById('mix-' + src);
    if (el) el.value = Math.round(mixer.levels[src] * 100);
  }
  const jv = document.getElementById('juke-vol');
  if (jv) jv.value = Math.round(juke.volume * 100);
}
for (const src of ['lead', 'drums', 'juke', 'loop', 'voice']) {
  const el = document.getElementById('mix-' + src);
  if (el) el.addEventListener('input', () => mixerSet(src, el.value / 100));
}
mixerInitUI();

if (jukeBtn) {
  jukeBtn.addEventListener('click', () => setJukePanel(!juke.open));
}
const jukeCloseBtn = document.getElementById('juke-close');
if (jukeCloseBtn) jukeCloseBtn.addEventListener('click', () => setJukePanel(false));
// Build 43: anyone in the server can clear the line — the holder
// rebroadcasts the empty canonical state.
const jukeClearBtn = document.getElementById('juke-clear');
if (jukeClearBtn) jukeClearBtn.addEventListener('click', () => { jukeClearQueue(); jukeClearBtn.blur(); });
const jukeAddBtn = document.getElementById('juke-add-btn');
const jukeAddInput = document.getElementById('juke-add-url');
if (jukeAddBtn) {
  const doAdd = () => {
    const v = jukeAddInput ? jukeAddInput.value : '';
    if (!v.trim()) return;
    jukeAddTrack(v.trim());
    if (jukeAddInput) jukeAddInput.value = '';
    jukeAddBtn.blur();
  };
  jukeAddBtn.addEventListener('click', doAdd);
  if (jukeAddInput) jukeAddInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
    e.stopPropagation(); // don't fly the wisp while typing a link
  });
}
const jukeSkipBtn = document.getElementById('juke-skip');
if (jukeSkipBtn) jukeSkipBtn.addEventListener('click', () => { jukeSkipNow(); jukeSkipBtn.blur(); });
  const jukePhoneBtn = document.getElementById('juke-phone-btn');
  const jukePhoneInput = document.getElementById('juke-phone-input');
  if (jukePhoneBtn && jukePhoneInput) {
    jukePhoneBtn.addEventListener('click', () => { jukePhoneInput.click(); jukePhoneBtn.blur(); });
    jukePhoneInput.addEventListener('change', () => {
      const f = jukePhoneInput.files && jukePhoneInput.files[0];
      jukePhoneInput.value = ''; // same file twice in a row still fires
      if (f) jukeAddPhoneFile(f);
    });
  }
const jukeJoinBtn = document.getElementById('juke-join');
if (jukeJoinBtn) jukeJoinBtn.addEventListener('click', () => { jukeJoinTap(); jukeJoinBtn.blur(); });
const jukeVolEl = document.getElementById('juke-vol');
if (jukeVolEl) jukeVolEl.addEventListener('input', () => jukeSetVolume(jukeVolEl.value / 100));

/* Test seam: inject mock providers so tests never load real iframes. */
function jukeSetFactory(f) { juke.playerFactory = f || null; }

/* ---------------- paint mode UI (build 18) ----------------
   Fullscreen overlay: the wall aspect-fit, pointer drawing, palette +
   brush sizes. Local strokes render immediately on the wall canvas;
   chunks flush over Trystero every ~80ms while drawing and on release. */
const PAINT_COLORS = [
  '#ffffff', '#000000', '#7ae0ff', '#b388ff', '#ff7ad9',
  '#ffc24d', '#8dff7a', '#ffe95c', '#ff5c5c', '#5cc8ff',
];
const paint = {
  open: false,
  color: '#7ae0ff',
  blend: false,      // build 28: blend brush — smudge the canvas, don't lay color
  lastColor: '#7ae0ff',
  lastSwatch: null,
  size: 16,
  drawing: false,
  pts: [],          // normalized [u,v] of the current stroke, not yet flushed
  gesture: null,    // build 26 (undo): the full in-progress gesture {id, points, color, size}
  lastFlush: 0,
  mirrorQueued: false,
};
const paintCtx = paintCanvas ? paintCanvas.getContext('2d') : null;
if (paintCanvas) { paintCanvas.width = WALL_W; paintCanvas.height = WALL_H; }

function paintBuildPalette() {
  if (!paintPaletteEl || paintPaletteEl.children.length) return;
  for (const c of PAINT_COLORS) {
    const b = document.createElement('button');
    b.className = 'paint-swatch' + (c === paint.color ? ' sel' : '');
    b.style.background = c;
    b.setAttribute('aria-label', c);
    b.addEventListener('click', () => {
      paint.color = c;
      paint.lastColor = c;
      paint.lastSwatch = b;
      paint.blend = false;
      if (paintBlendBtn) paintBlendBtn.classList.remove('sel');
      paintPaletteEl.querySelectorAll('.paint-swatch').forEach((x) => x.classList.toggle('sel', x === b));
      if (paintEraserBtn) paintEraserBtn.classList.remove('sel');
      b.blur();
    });
    paintPaletteEl.appendChild(b);
  }
}

function paintMirror() {
  // redraw the overlay from the wall canvas (remote strokes while open)
  if (!paint.open || !paintCtx || paint.mirrorQueued) return;
  paint.mirrorQueued = true;
  requestAnimationFrame(() => {
    paint.mirrorQueued = false;
    if (!paint.open || !paintCtx) return;
    paintCtx.drawImage(wall.canvas, 0, 0, WALL_W, WALL_H);
  });
}

function paintUvFromEvent(e) {
  const r = paintCanvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const u = (e.clientX - r.left) / r.width;
  const v = (e.clientY - r.top) / r.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [u, v];
}

/* After a blend dab lands on the wall canvas, copy the touched rect to the
   overlay so the mirror stays pixel-exact without re-running the smudge. */
function paintMirrorRect(a, b, sizePx) {
  if (!paintCtx) return;
  const r = Math.max(3, sizePx / 2) + 2;
  const x0 = Math.min(a[0], b[0]) * WALL_W - r, y0 = Math.min(a[1], b[1]) * WALL_H - r;
  const x1 = Math.max(a[0], b[0]) * WALL_W + r, y1 = Math.max(a[1], b[1]) * WALL_H + r;
  const sx = Math.max(0, Math.floor(x0)), sy = Math.max(0, Math.floor(y0));
  const sw = Math.min(WALL_W - sx, Math.ceil(x1) - sx), sh = Math.min(WALL_H - sy, Math.ceil(y1) - sy);
  if (sw <= 0 || sh <= 0) return;
  try { paintCtx.drawImage(wall.canvas, sx, sy, sw, sh, sx, sy, sw, sh); } catch (e) {}
}

function paintDrawLocalSeg(a, b) {
  if (paint.blend) {
    // smudge the wall canvas, then mirror the touched rect to the overlay
    wallDrawBlendSeg([a, b], paint.size, wall.ctx);
    paintMirrorRect(a, b, paint.size);
    return;
  }
  // wall canvas (uv space)
  wallDrawSeg([a, b], paint.color, paint.size);
  // overlay mirror (wall-pixel space; canvas is WALL_W x WALL_H)
  if (paintCtx) {
    paintCtx.save();
    paintCtx.strokeStyle = paint.color;
    paintCtx.lineCap = 'round';
    paintCtx.lineJoin = 'round';
    paintCtx.lineWidth = paint.size;
    paintCtx.beginPath();
    paintCtx.moveTo(a[0] * WALL_W, a[1] * WALL_H);
    paintCtx.lineTo(b[0] * WALL_W, b[1] * WALL_H);
    paintCtx.stroke();
    paintCtx.restore();
  }
}

function paintFlush() {
  if (!paint.pts.length) return;
  const chunk = paint.pts.splice(0, 60); // cap message size
  if (chunk.length === 0) return;
  // Anchor: if the splice emptied the buffer, leave the chunk's last point
  // behind so the next pointermove has a prev point to draw from. (Without
  // this, paint.pts[-1] is undefined and paintDrawLocalSeg crashes.)
  if (paint.pts.length === 0) paint.pts.push(chunk[chunk.length - 1]);
  if (paint.gesture) for (const p of chunk) paint.gesture.points.push(p);
  wall.lastLocalStroke = Date.now();
  wallMarkDirty();
  wallTouch(); // my wall just got newer; snapshot scheduled (bookkeeping per gesture, below)
  if (net.enabled && net.sendWallStroke && active && active.key === SOUND_ROOM_KEY) {
    try {
      net.sendWallStroke({
        id: paint.gesture ? paint.gesture.id : undefined, // groups this gesture's chunks for peers
        n: myName,
        c: paint.color,
        s: paint.size,
        b: paint.blend ? 1 : undefined, // build 28: peers render the same smudge
        pts: chunk.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]),
      });
    } catch (e) { /* best effort */ }
  }
  paint.lastFlush = Date.now();
}

function paintEndStroke() {
  if (!paint.drawing) return;
  paint.drawing = false;
  paintFlush(); // flush any remaining points into the gesture
  // One gesture = one undoable log entry (eraser included).
  if (paint.gesture && paint.gesture.points.length) {
    wallLogAppend(paint.gesture.id, paint.gesture.points, paint.gesture.color, paint.gesture.size, true, paint.gesture.blend);
  }
  paint.gesture = null;
  paint.pts.length = 0;
}

function setPaintOpen(open) {
  paint.open = !!open;
  if (paintOverlay) paintOverlay.style.display = paint.open ? '' : 'none';
  chatFocused = paint.open; // reuse the chat guard: keys never fly the wisp mid-paint
  if (paint.open) {
    paintBuildPalette();
    if (paintCtx) paintCtx.drawImage(wall.canvas, 0, 0, WALL_W, WALL_H);
  } else {
    paintEndStroke();
  }
}

if (paintCanvas) {
  paintCanvas.addEventListener('pointerdown', (e) => {
    if (!paint.open) return;
    e.preventDefault();
    const uv = paintUvFromEvent(e);
    if (!uv) return;
    paint.drawing = true;
    paint.pts = [uv];
    paint.gesture = { id: wallNextStrokeId(), points: [], color: paint.color, size: paint.size, blend: paint.blend };
    paint.lastFlush = Date.now();
    wall.lastLocalStroke = Date.now();
    if (paint.blend) {
      wallDrawBlendSeg([uv], paint.size, wall.ctx); // smudge dot for taps
      paintMirrorRect(uv, uv, paint.size);
    } else {
      wallDrawSeg([uv], paint.color, paint.size); // dot for taps
      if (paintCtx) {
        paintCtx.save();
        paintCtx.fillStyle = paint.color;
        paintCtx.beginPath();
        paintCtx.arc(uv[0] * WALL_W, uv[1] * WALL_H, paint.size / 2, 0, Math.PI * 2);
        paintCtx.fill();
        paintCtx.restore();
      }
    }
    try { paintCanvas.setPointerCapture(e.pointerId); } catch (err) {}
  });
  paintCanvas.addEventListener('pointermove', (e) => {
    if (!paint.open || !paint.drawing) return;
    e.preventDefault();
    const uv = paintUvFromEvent(e);
    if (!uv) return;
    const prev = paint.pts[paint.pts.length - 1];
    paint.pts.push(uv);
    paintDrawLocalSeg(prev, uv);
    if (Date.now() - paint.lastFlush >= 80 || paint.pts.length >= 60) paintFlush();
  });
  const endEv = (e) => { if (paint.open) paintEndStroke(); };
  paintCanvas.addEventListener('pointerup', endEv);
  paintCanvas.addEventListener('pointercancel', endEv);
}
if (paintSizesEl) {
  paintSizesEl.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      paint.size = parseInt(b.dataset.size, 10) || 16;
      paintSizesEl.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
      b.blur();
    });
  });
}
if (paintDoneBtn) paintDoneBtn.addEventListener('click', () => { setPaintOpen(false); paintDoneBtn.blur(); });
/* Eraser: just the wall's background color on the normal stroke path.
   Eraser strokes broadcast like any other stroke — the only way paint
   leaves the wall is painting over it. */
if (paintEraserBtn) paintEraserBtn.addEventListener('click', () => {
  paint.color = WALL_BG;
  paint.blend = false;
  if (paintBlendBtn) paintBlendBtn.classList.remove('sel');
  paintEraserBtn.classList.add('sel');
  if (paintPaletteEl) paintPaletteEl.querySelectorAll('.paint-swatch').forEach((x) => x.classList.remove('sel'));
  paintEraserBtn.blur();
});
/* Blend brush (build 28): smudges the paint already on the wall instead of
   laying down a color. Toggles; picking a color or the eraser exits blend,
   and exiting via the button restores the last picked color so the brush
   is never stateless. */
if (paintBlendBtn) paintBlendBtn.addEventListener('click', () => {
  paint.blend = !paint.blend;
  paintBlendBtn.classList.toggle('sel', paint.blend);
  if (paint.blend) {
    if (paintEraserBtn) paintEraserBtn.classList.remove('sel');
    if (paintPaletteEl) paintPaletteEl.querySelectorAll('.paint-swatch').forEach((x) => x.classList.remove('sel'));
  } else {
    paint.color = paint.lastColor || PAINT_COLORS[0];
    if (paintPaletteEl) {
      const swatches = paintPaletteEl.querySelectorAll('.paint-swatch');
      swatches.forEach((x) => x.classList.remove('sel'));
      if (paint.lastSwatch && paintPaletteEl.contains(paint.lastSwatch)) paint.lastSwatch.classList.add('sel');
      else if (swatches.length) swatches[0].classList.add('sel');
    }
  }
  paintBlendBtn.blur();
});
/* Save wall (build 28): manual PNG backup of the whole mural. */
function wallExportPng() {
  try {
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = wall.canvas.toDataURL('image/png');
    a.download = `limbo-wall-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (e) { return false; }
}
if (paintSaveBtn) paintSaveBtn.addEventListener('click', () => { wallExportPng(); paintSaveBtn.blur(); });
/* Undo: pops MY most recent stroke (eraser strokes included) and tells
   the room, so peers drop it from their logs and replay too. */
if (paintUndoBtn) paintUndoBtn.addEventListener('click', () => {
  wallUndoMyLast();
  paintUndoBtn.blur();
});
if (paintBtn) {
  paintBtn.addEventListener('click', () => {
    setPaintOpen(!paint.open);
    paintBtn.blur();
  });
}

/* ---------------- who's jamming ---------------- */

function jamMarkJammer(name, inst) {
  const k = String(name || 'drifter').slice(0, 16);
  const prev = jam.jammers.get(k);
  jam.jammers.set(k, {
    t: Date.now(),
    inst: (inst && JAM_INSTRUMENTS[inst]) ? inst : (prev && prev.inst) || null,
  });
}

function renderJamJammers() {
  if (!jamJammersEl) return;
  const now = Date.now();
  const entries = [];
  for (const [n, v] of jam.jammers) {
    if (now - v.t < 30000) entries.push([n, v.inst]);
    else jam.jammers.delete(n);
  }
  jamJammersEl.innerHTML = '';
  const label = document.createElement('span');
  if (!entries.length) {
    label.textContent = 'the room is quiet \u2014 play something \u{1F3B9}';
  } else {
    label.textContent = 'jamming now: ';
  }
  jamJammersEl.appendChild(label);
  entries.forEach(([n, inst], i) => {
    if (i > 0) jamJammersEl.appendChild(document.createTextNode(', '));
    const dot = document.createElement('span');
    dot.className = 'jammer-dot';
    dot.style.background = inst ? JAM_INSTRUMENTS[inst].color : '#9fd8ff';
    if (inst) dot.style.boxShadow = `0 0 8px ${JAM_INSTRUMENTS[inst].color}`;
    const nm = document.createElement('span');
    nm.textContent = n;
    const wrap = document.createElement('span');
    wrap.appendChild(dot);
    wrap.appendChild(nm);
    jamJammersEl.appendChild(wrap);
  });
  // Build 40: room voice — show who's talking on the same roster line,
  // even when nobody's playing yet.
  const talkers = voiceTalkers();
  if (talkers.length) {
    const sep = document.createElement('span');
    sep.textContent = entries.length ? ' · ' : ' — ';
    jamJammersEl.appendChild(sep);
    talkers.forEach((t, i) => {
      if (i > 0) jamJammersEl.appendChild(document.createTextNode(', '));
      const mic = document.createElement('span');
      mic.className = 'jammer-talking';
      mic.textContent = `\u{1F3A4} ${t} is talking`;
      jamJammersEl.appendChild(mic);
    });
  }
}
setInterval(() => { if (jam.open) renderJamJammers(); }, 5000);

/* ---------------- jam panel UI ---------------- */

function setJamPanel(open) {
  jam.open = !!open;
  if (jamPanel) jamPanel.classList.toggle('open', jam.open);
  chatFocused = jam.open; // reuse the chat guard: keys never fly the wisp mid-jam
  if (jam.open) {
    jamEnsureChain(); // the master bus exists before the first note
    selectJamInstrument(jam.instrument); // sync tabs, panels, wisp tint
    jamBeatUiTick();
    renderJamTransport();
    renderJamPads();
    renderJamSamplerHint();
    renderJamJammers();
    jamRenderRoomNote();
    loopRenderUI(); // looper state text + ring
    loopUiEnsure(); // progress ring rAF while the panel is open
    renderJamStageFoh(); // build 66: stage + FOH sections only in the sound room
  } else {
    try { applySkin(equipped.skin); } catch (e) {} // wisp glow back to the skin
  }
}

/* Pick an instrument: tabs + panels swap, the panel accents take the
   instrument's color, and the wisp glow takes it too. The pick rides
   every jamNote so peers render the sender's voice. */
function selectJamInstrument(id) {
  if (!JAM_INSTRUMENTS[id]) return;
  jam.instrument = id;
  if (jamInstTabsEl) {
    jamInstTabsEl.querySelectorAll('.jam-inst-tab').forEach((t) =>
      t.classList.toggle('sel', t.dataset.inst === id));
  }
  document.querySelectorAll('.jam-inst-panel').forEach((p) => {
    p.hidden = p.id !== 'jam-inst-' + id;
  });
  if (jamPanel) jamPanel.style.setProperty('--inst', JAM_INSTRUMENTS[id].color);
  try { wispGlow.material.color.setHex(JAM_INSTRUMENTS[id].glow); } catch (e) {}
  jamMarkJammer(myName, id);
  renderJamJammers();
}

function renderJamTransport() {
  if (!jamPanel) return;
  if (jamBpmEl) jamBpmEl.textContent = Math.round(jam.bpm);
  const on = jam.startWall != null;
  if (jamClockStatusEl) {
    jamClockStatusEl.textContent = !on
      ? 'clock stopped'
      : jamClockOurs()
        ? `you're the clock · ${jam.manual ? 'manual' : 'auto-detect'}`
        : `synced · ${jam.clockBy || 'drifter'}`;
  }
  if (jamClockDotEl) jamClockDotEl.classList.toggle('live', on);
  // Anyone can set the tempo — the freshest move wins the room.
  for (const b of [jamTapEl, jamBpmDownEl, jamBpmUpEl]) {
    if (b) {
      b.disabled = false;
      b.title = '';
    }
  }
}

function renderJamPads() {
  if (!jamPadsEl) return;
  jamPadsEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const b = document.createElement('button');
    b.className = 'jam-pad' + (jam.pads[i] ? ' loaded' : '');
    b.textContent = jam.pads[i] ? `${i + 1}` : '·';
    b.setAttribute('aria-label', jam.pads[i] ? `play loop ${i + 1}` : `pad ${i + 1} (empty)`);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); jamTriggerPad(i); });
    jamPadsEl.appendChild(b);
  }
}

function renderJamSamplerHint() {
  if (!jamHintEl) return;
  const live = !!(audio.ctx && jam.chain);
  jamHintEl.textContent = !live
    ? 'nothing to sample yet \u{1F3A7}'
    : jam.pads.every((p) => !p)
      ? 'grab a loop from the live mix, then tap a pad on the bar'
      : '';
}

/* Lead keys with a scale lock (build 39). Chromatic = one octave C4–C5 as
 * before; the pentatonics span two octaves so melodies stay in the flock. */
const JAM_SCALES = {
  chromatic: { base: 60, steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  minpent: { base: 57, steps: [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24] }, // A minor pent, 2 octaves
  majpent: { base: 60, steps: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24] }, // C major pent, 2 octaves
};
const JAM_SCALE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function buildJamKeys() {
  if (!jamKeysEl) return;
  jamKeysEl.innerHTML = '';
  const sc = JAM_SCALES[jam.scale] || JAM_SCALES.chromatic;
  const chromatic = jam.scale === 'chromatic';
  sc.steps.forEach((st, i) => {
    const midi = sc.base + st;
    const black = chromatic && [1, 3, 6, 8, 10].includes(st % 12);
    const b = document.createElement('button');
    b.className = 'jam-key' + (black ? ' black' : '');
    b.textContent = black ? '' : JAM_SCALE_NAMES[midi % 12];
    b.setAttribute('aria-label', JAM_SCALE_NAMES[midi % 12] + Math.floor(midi / 12 - 1));
    // pointerdown (not click): notes fire the instant the finger lands.
    // build 63: hold = sustain, lift = release — a real synth feel.
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const id = jamNoteOnLocal(midi, 0.9);
      if (id) jamHeldVoices.set(e.pointerId, { voiceId: id, midi });
      b.classList.add('held');
    });
    const keyRelease = (e) => {
      jamNoteOffLocal(e.pointerId);
      b.classList.remove('held');
    };
    b.addEventListener('pointerup', keyRelease);
    b.addEventListener('pointercancel', keyRelease);
    jamKeysEl.appendChild(b);
  });
}

/* One-touch chord pads for the lead (build 39): in chromatic, proper
 * tertian triads on the major-scale degrees (I ii iii IV V vi vii°);
 * in the pentatonics, triads stacked from the scale degrees so every
 * pad always sits inside the key you're in. Voiced through the player's
 * patch. Labels are root note names — always true, whatever the scale.
 * Rebuilt with the keys whenever the scale changes. */
const JAM_CHORD_QUALITIES = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
const JAM_CHORD_ROOTS = [0, 2, 4, 5, 7, 9, 11]; // major-scale degrees
function jamScalePitchClasses() {
  const sc = JAM_SCALES[jam.scale] || JAM_SCALES.chromatic;
  const pcs = [];
  for (const st of sc.steps) {
    const pc = ((st % 12) + 12) % 12;
    if (!pcs.includes(pc)) pcs.push(pc);
  }
  return { base: sc.base, pcs };
}
function jamLeadChordMidis(degree) {
  const { base, pcs } = jamScalePitchClasses();
  if (jam.scale === 'chromatic') {
    const d = ((degree % 7) + 7) % 7;
    const q = JAM_CHORD_QUALITIES[d];
    const third = q === 'maj' ? 4 : 3;
    const fifth = q === 'dim' ? 6 : 7;
    return [base + JAM_CHORD_ROOTS[d], base + JAM_CHORD_ROOTS[d] + third, base + JAM_CHORD_ROOTS[d] + fifth];
  }
  const len = pcs.length;
  const n = Math.min(7, len);
  const d = ((degree % n) + n) % n;
  const at = (i) => pcs[(d + i) % len] + (d + i >= len ? 12 : 0);
  return [base + at(0), base + at(2), base + at(4)];
}
function jamLeadChordRootName(degree) {
  const { base, pcs } = jamScalePitchClasses();
  if (jam.scale === 'chromatic') {
    const d = ((degree % 7) + 7) % 7;
    return JAM_SCALE_NAMES[(base + JAM_CHORD_ROOTS[d]) % 12];
  }
  const n = Math.min(7, pcs.length);
  const d = ((degree % n) + n) % n;
  return JAM_SCALE_NAMES[(base + pcs[d]) % 12];
}
function jamLeadChordPadCount() {
  if (jam.scale === 'chromatic') return 7;
  return Math.min(7, jamScalePitchClasses().pcs.length);
}
function buildJamLeadChords() {
  if (!jamLeadChordsEl) return;
  jamLeadChordsEl.innerHTML = '';
  const n = jamLeadChordPadCount();
  for (let d = 0; d < n; d++) {
    const midis = jamLeadChordMidis(d);
    const name = jamLeadChordRootName(d);
    const q = jam.scale === 'chromatic' ? JAM_CHORD_QUALITIES[((d % 7) + 7) % 7] : null;
    const dispName = name + (q === 'min' ? 'm' : q === 'dim' ? 'dim' : '');
    const b = document.createElement('button');
    b.className = 'jam-lead-chord';
    b.textContent = name;
    b.setAttribute('aria-label', 'chord on ' + name);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); jamPlayChordLocal(midis, 0.85); jamShowChord(dispName, myName); });
    jamLeadChordsEl.appendChild(b);
  }
}

function buildJamBassKeys() {
  if (!jamBassKeysEl) return;
  jamBassKeysEl.innerHTML = '';
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let i = 0; i <= 12; i++) {
    const midi = 48 + i; // C3–C4 on the keys; the voice drops an octave
    const black = [1, 3, 6, 8, 10].includes(i % 12);
    const b = document.createElement('button');
    b.className = 'jam-key' + (black ? ' black' : '');
    b.textContent = black ? '' : names[i % 12];
    b.setAttribute('aria-label', 'bass ' + names[i % 12] + (3 + Math.floor(i / 12)));
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); jamPlayBassLocal(midi, 0.95); });
    jamBassKeysEl.appendChild(b);
  }
}

function jamSaveDrumKit() {
  try { localStorage.setItem('limbo-drumkit', JSON.stringify(jam.drumVariant)); } catch (e) {}
}
/* Bake the drum kits to samples (once, after the context exists). */
let _drumKitsRendering = false;
function jamEnsureDrumKits() {
  if (!audio.ctx || _drumKitsRendering) return;
  _drumKitsRendering = true;
  try {
    renderDrumKits(audio.ctx).catch(() => {}).finally(() => { _drumKitsRendering = false; });
  } catch (e) { _drumKitsRendering = false; }
}
function buildJamDrums() {
  if (!jamDrumsEl) return;
  jamDrumsEl.innerHTML = '';
  const labels = { kick: 'KICK', snare: 'SNARE', clap: 'CLAP', chat: 'HAT', ohat: 'O-HAT', shaker: 'SHAKER' };
  for (const d of JAM_DRUMS) {
    const b = document.createElement('button');
    b.className = 'jam-drum';
    b.dataset.drum = d;
    const s = document.createElement('span');
    s.className = 'jam-drum-name';
    s.textContent = labels[d] || d;
    const v = document.createElement('span');
    v.className = 'jam-drum-var';
    v.textContent = drumVariantName(d, jamDrumVariant(d));
    b.appendChild(s);
    b.appendChild(v);
    b.setAttribute('aria-label', 'drum ' + (labels[d] || d) + ' — hold to pick a sample');
    let holdT = null;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      jamHitDrumLocal(d, 0.95);
      clearTimeout(holdT);
      holdT = setTimeout(() => { holdT = null; openDrumPicker(d); }, 600);
    });
    const cancelHold = () => { clearTimeout(holdT); holdT = null; };
    b.addEventListener('pointerup', cancelHold);
    b.addEventListener('pointercancel', cancelHold);
    b.addEventListener('pointerleave', cancelHold);
    jamDrumsEl.appendChild(b);
  }
}
/* Press-and-hold a pad -> pick which sample it fires. Tap a row to hear
 * it AND load it; the pad's sub-label follows. */
let drumPickerDrum = null;
function openDrumPicker(drum) {
  drumPickerDrum = drum;
  const sheet = document.getElementById('drum-picker');
  const title = document.getElementById('drum-picker-title');
  const list = document.getElementById('drum-picker-list');
  if (!sheet || !list) return;
  audioEnsureRunning();
  jamEnsureDrumKits();
  if (title) title.textContent = (drum || '').toUpperCase() + ' · pick a sample';
  list.innerHTML = '';
  const n = drumVariantCount(drum);
  const cur = jamDrumVariant(drum);
  for (let vi = 0; vi < n; vi++) {
    const row = document.createElement('button');
    row.className = 'drum-picker-row' + (vi === cur ? ' sel' : '');
    const nm = document.createElement('span');
    nm.className = 'drum-picker-name';
    nm.textContent = drumVariantName(drum, vi);
    const st = document.createElement('span');
    st.className = 'drum-picker-state';
    st.textContent = vi === cur ? 'loaded' : '';
    row.appendChild(nm);
    row.appendChild(st);
    row.addEventListener('click', () => {
      // Hear it, load it — one tap.
      const ctx = audio.ctx;
      if (ctx && audio.master) playDrumSample(ctx, jamDestFor('drums'), { drum, variant: vi, vel: 1, time: ctx.currentTime + 0.01 });
      jam.drumVariant[drum] = vi;
      jamSaveDrumKit();
      list.querySelectorAll('.drum-picker-row').forEach((r, i) => {
        r.classList.toggle('sel', i === vi);
        r.querySelector('.drum-picker-state').textContent = i === vi ? 'loaded' : '';
      });
      const pad = jamDrumsEl && jamDrumsEl.querySelector(`[data-drum="${drum}"] .jam-drum-var`);
      if (pad) pad.textContent = drumVariantName(drum, vi);
    });
    list.appendChild(row);
  }
  sheet.hidden = false;
}
function closeDrumPicker() {
  const sheet = document.getElementById('drum-picker');
  if (sheet) sheet.hidden = true;
  drumPickerDrum = null;
}
{ // build 63: tapping the backdrop dismisses the picker
  const bd = document.querySelector('#drum-picker .drum-picker-backdrop');
  if (bd) bd.addEventListener('click', closeDrumPicker);
}

function buildJamChords() {
  if (!jamChordsEl) return;
  jamChordsEl.innerHTML = '';
  JAM_CHORDS.forEach((ch, i) => {
    const b = document.createElement('button');
    b.className = 'jam-chord';
    const num = document.createElement('span');
    num.className = 'jam-chord-num';
    num.textContent = ch.numeral;
    const nm = document.createElement('span');
    nm.className = 'jam-chord-name';
    nm.textContent = ch.name;
    b.appendChild(num);
    b.appendChild(nm);
    b.setAttribute('aria-label', 'chord ' + ch.name);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); jamHitChordLocal(i, 0.85); });
    jamChordsEl.appendChild(b);
  });
}

if (jamBtn) {
  jamBtn.addEventListener('click', () => {
    setJamPanel(!jam.open);
    jamBtn.blur();
  });
}
if (jamCloseBtn) jamCloseBtn.addEventListener('click', () => setJamPanel(false));
if (jamTapEl) jamTapEl.addEventListener('click', () => { jamTapTempo(); jamTapEl.blur(); });
if (jamListenEl) jamListenEl.addEventListener('click', () => { jamListenToggle(); jamListenEl.blur(); });
if (jamBpmDownEl) jamBpmDownEl.addEventListener('click', () => { jamSetBpm(jam.bpm - 1, { manual: true }); jamBpmDownEl.blur(); });
if (jamBpmUpEl) jamBpmUpEl.addEventListener('click', () => { jamSetBpm(jam.bpm + 1, { manual: true }); jamBpmUpEl.blur(); });
if (jamGrabEl) jamGrabEl.addEventListener('click', () => { jamGrabLoop(); jamGrabEl.blur(); });
if (jamGrabRoomEl) jamGrabRoomEl.addEventListener('click', () => { jamRoomSample(); jamGrabRoomEl.blur(); });
if (jamMicBtnEl) jamMicBtnEl.addEventListener('click', () => { jamMicToggle(); jamMicBtnEl.blur(); });
if (jamMicMuteEl) jamMicMuteEl.addEventListener('click', () => { jamMicToggleMute(); jamMicMuteEl.blur(); });
if (jamMicLoopEl) jamMicLoopEl.addEventListener('click', () => { jamMicToggleLoop(); jamMicLoopEl.blur(); });
if (jamTalkBtnEl) jamTalkBtnEl.addEventListener('click', () => { voiceTalkToggle(); jamTalkBtnEl.blur(); });
if (jamInstTabsEl) {
  jamInstTabsEl.querySelectorAll('.jam-inst-tab').forEach((b) => {
    b.addEventListener('click', () => { selectJamInstrument(b.dataset.inst); b.blur(); });
  });
}
if (jamMetroToggleEl) jamMetroToggleEl.addEventListener('click', () => {
  jamSetMetro(!jam.metro.on);
  jamMetroToggleEl.blur();
});
if (jamMetroVolEl) jamMetroVolEl.addEventListener('input', () => {
  jamSetMetro(jam.metro.on, Number(jamMetroVolEl.value) / 100);
});
/* ---------------- lead synth panel (build 39: a real patch) ----------------
 * Every knob writes jam.synth and rides the next jamNote's patch, so the
 * room hears YOUR voice. Presets snap the whole patch at once. The key
 * scale remaps the one-octave keys (pentatonics span two octaves). */
const JAM_PRESETS = {
  spark: { wave: 'sawtooth', wave2: 'sawtooth', osc2mix: 0.45, cutoff: 3200, reso: 4, env: 0.5, attack: 0.005, decay: 0.35, sustain: 0.6, release: 0.3, sub: 0, spread: 14, echo: 0.4, glide: 0, lfoRate: 5, lfoPitch: 0, lfoFilter: 0, drive: 0.15, dlyMix: 0.3, dlyFb: 0.35, dlyDiv: 0.75 },
  acid: { wave: 'sawtooth', wave2: 'square', osc2mix: 0.3, cutoff: 700, reso: 10, env: 0.85, attack: 0.004, decay: 0.3, sustain: 0.4, release: 0.2, sub: 0.15, spread: 8, echo: 0.25, glide: 0.06, lfoRate: 5, lfoPitch: 0, lfoFilter: 0, drive: 0.45, dlyMix: 0.2, dlyFb: 0.3, dlyDiv: 0.5 },
  drift: { wave: 'sawtooth', wave2: 'triangle', osc2mix: 0.5, cutoff: 1400, reso: 2, env: 0.2, attack: 0.25, decay: 1.4, sustain: 0.8, release: 0.8, sub: 0.3, spread: 20, echo: 0.6, glide: 0.02, lfoRate: 0.4, lfoPitch: 0, lfoFilter: 0.35, drive: 0, dlyMix: 0.45, dlyFb: 0.5, dlyDiv: 0.75 },
  pluck: { wave: 'square', wave2: 'sawtooth', osc2mix: 0.35, cutoff: 2400, reso: 6, env: 0.7, attack: 0.003, decay: 0.22, sustain: 0.25, release: 0.25, sub: 0, spread: 10, echo: 0.35, glide: 0, lfoRate: 5, lfoPitch: 0, lfoFilter: 0, drive: 0.25, dlyMix: 0.25, dlyFb: 0.35, dlyDiv: 0.75 },
  pad: { wave: 'sawtooth', wave2: 'sawtooth', osc2mix: 0.6, cutoff: 1100, reso: 1.5, env: 0.15, attack: 0.6, decay: 1.2, sustain: 0.9, release: 1.2, sub: 0.25, spread: 24, echo: 0.7, glide: 0, lfoRate: 0.3, lfoPitch: 6, lfoFilter: 0.25, drive: 0, dlyMix: 0.4, dlyFb: 0.45, dlyDiv: 1 },
};
const JAM_SYNTH_SLIDERS = [
  // [element id, patch key, fromSlider, toSlider]
  ['jam-cutoff', 'cutoff', (v) => v, (v) => v],
  ['jam-reso', 'reso', (v) => v, (v) => v],
  ['jam-env', 'env', (v) => v / 100, (v) => v * 100],
  ['jam-attack', 'attack', (v) => v / 1000, (v) => v * 1000],
  ['jam-decay', 'decay', (v) => v / 100, (v) => v * 100],
  ['jam-sustain', 'sustain', (v) => v / 100, (v) => v * 100],
  ['jam-release', 'release', (v) => v / 100, (v) => v * 100],
  ['jam-lforate', 'lfoRate', (v) => v / 10, (v) => v * 10],
  ['jam-lfopitch', 'lfoPitch', (v) => v, (v) => v],
  ['jam-lfofilter', 'lfoFilter', (v) => v / 100, (v) => v * 100],
  ['jam-osc2mix', 'osc2mix', (v) => v / 100, (v) => v * 100],
  ['jam-sub', 'sub', (v) => v / 100, (v) => v * 100],
  ['jam-spread', 'spread', (v) => v, (v) => v],
  ['jam-echo', 'echo', (v) => v / 100, (v) => v * 100],
  ['jam-glide', 'glide', (v) => v / 100, (v) => v * 100],
  // build 64: the pedalboard
  ['jam-drive', 'drive', (v) => v / 100, (v) => v * 100],
  ['jam-dlymix', 'dlyMix', (v) => v / 100, (v) => v * 100],
  ['jam-dlyfb', 'dlyFb', (v) => v / 100, (v) => v * 100],
];
/* Build 64: push the pedalboard knobs into the live FX chain. */
function jamSyncSynthFx() {
  const fx = jam.chain && jam.chain.synthFx;
  if (!fx) return;
  try {
    fx.setDrive(jam.synth.drive);
    fx.setDelay(jam.synth.dlyMix, jam.synth.dlyFb, jam.synth.dlyDiv);
  } catch (e) { /* ignore */ }
}
function jamSyncSynthUI() {
  const s = jam.synth;
  for (const [id, key, , toSlider] of JAM_SYNTH_SLIDERS) {
    const el = document.getElementById(id);
    if (el) el.value = Math.round(toSlider(s[key]) * 100) / 100;
  }
  document.querySelectorAll('.jam-wave').forEach((x) => {
    const osc = x.dataset.osc || '1';
    x.classList.toggle('sel', (osc === '2' ? s.wave2 : s.wave) === x.dataset.wave);
  });
  document.querySelectorAll('.jam-dlydiv').forEach((x) =>
    x.classList.toggle('sel', Number(x.dataset.div) === s.dlyDiv));
  jamSyncSynthFx(); // build 64: presets land on the pedalboard too
}
function jamApplyPreset(name) {
  const p = JAM_PRESETS[name];
  if (!p) return;
  Object.assign(jam.synth, p);
  jamSyncSynthUI();
  document.querySelectorAll('.jam-preset').forEach((x) =>
    x.classList.toggle('sel', x.dataset.preset === name));
}
document.querySelectorAll('.jam-wave').forEach((b) => {
  b.addEventListener('click', () => {
    const osc = b.dataset.osc || '1';
    const w = b.dataset.wave || 'sawtooth';
    if (osc === '2') jam.synth.wave2 = w;
    else jam.synth.wave = w;
    document.querySelectorAll(`.jam-wave[data-osc="${osc}"]`).forEach((x) =>
      x.classList.toggle('sel', x === b));
    document.querySelectorAll('.jam-preset').forEach((x) => x.classList.remove('sel'));
    b.blur();
  });
});
document.querySelectorAll('.jam-preset').forEach((b) => {
  b.addEventListener('click', () => { jamApplyPreset(b.dataset.preset); b.blur(); });
});
for (const [id, key, fromSlider] of JAM_SYNTH_SLIDERS) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => {
    jam.synth[key] = fromSlider(Number(el.value));
    jamSyncSynthFx(); // build 64: pedalboard knobs hit the live chain
    document.querySelectorAll('.jam-preset').forEach((x) => x.classList.remove('sel'));
  });
}
/* Build 64: delay note-value buttons (1/8, dotted 1/8, 1/4). */
document.querySelectorAll('.jam-dlydiv').forEach((b) => {
  b.addEventListener('click', () => {
    jam.synth.dlyDiv = Number(b.dataset.div) || 0.75;
    document.querySelectorAll('.jam-dlydiv').forEach((x) =>
      x.classList.toggle('sel', x === b));
    jamSyncSynthFx();
    document.querySelectorAll('.jam-preset').forEach((x) => x.classList.remove('sel'));
    b.blur();
  });
});
document.querySelectorAll('.jam-scale').forEach((b) => {
  b.addEventListener('click', () => {
    jam.scale = b.dataset.scale || 'chromatic';
    document.querySelectorAll('.jam-scale').forEach((x) =>
      x.classList.toggle('sel', x === b));
    buildJamKeys(); // remap the keys to the new scale
    buildJamLeadChords(); // ...and the chord pads
    b.blur();
  });
});


// Boot: dress the wisp in the saved look; net reads the equipped look
// for every ~12Hz broadcast so peers see it too.
applySkin(equipped.skin);
applyHat(equipped.hat);
applyTrail();
renderWispSection(); // populate the settings WISP section for first open
renderPrintsSection(); // populate the settings PRINTS section
renderFriendsSection(); // populate the settings FRIENDS section
buildJamKeys(); // one-octave synth keyboard for the jam panel
buildJamBassKeys(); // bass keys (the voice drops an octave)
buildJamDrums(); // 6 synthesized drum pads
buildJamChords(); // 4 chord pads (i–VI–III–VII)
buildJamLeadChords(); // build 39: one-touch triads on the lead, in your scale
seqBuildGrid(); // build 39: the 16-step rhythm grid (beats off by default)
seqRenderUI();
jamSyncSynthUI(); // build 39: wave sel + knob positions match the patch
net.cosmetics = () => {
  const tc = TRAIL_COLORS[equipped.trailColor] || TRAIL_COLORS.white;
  return {
    s: equipped.skin,
    h: equipped.hat,
    t: equipped.trailStyle,
    c: tc.hex.toString(16).padStart(6, '0'),
  };
};

/* ---------------- world builders ---------------- */

const worlds = {};
let active = null; // the world object the wisp currently inhabits

function makeStars(count, rMin, rMax, size, color) {
  const pos = new Float32Array(count * 3);
  const rnd = mulberry32(count * 7919);
  for (let i = 0; i < count; i++) {
    const r = rMin + rnd() * (rMax - rMin);
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

// Slow-drifting dust motes with per-point phase (updated on CPU; counts are modest).
function makeDust(count, radius, color, size) {
  const pos = new Float32Array(count * 3);
  const base = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const rnd = mulberry32(count * 104729 + 7);
  for (let i = 0; i < count; i++) {
    const r = Math.cbrt(rnd()) * radius;
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    base[i * 3] = r * Math.sin(ph) * Math.cos(th);
    base[i * 3 + 1] = (rnd() - 0.5) * radius * 0.8;
    base[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    phase[i] = rnd() * Math.PI * 2;
  }
  pos.set(base);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { pts, base, phase, count };
}

// A portal ring: torus + art disc + glow + label. Faces `lookTarget`.
function makePortal(artTexture, accent, labelText, ringR = 2.2, tube = 0.16) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(ringR, tube, 16, 64),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.4, metalness: 0.7, roughness: 0.3 })
  );
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(ringR - 0.12, 48),
    new THREE.MeshBasicMaterial({ map: artTexture })
  );
  disc.position.z = -0.06;
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: accent, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  glow.scale.set(ringR * 4.6, ringR * 4.6, 1);
  glow.position.z = -0.8;
  group.add(ring, disc, glow);
  if (labelText) {
    const label = makeLabel(labelText);
    label.position.y = ringR + 1.6;
    group.add(label);
  }
  return { group, ring };
}

/* Procedural portal art for the sound room: amber EQ bars on dark. */
function makeSoundTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0703';
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(4242);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const h = 40 + rnd() * 150;
    const x = 14 + i * ((256 - 28) / n);
    const w = (256 - 28) / n - 6;
    const grad = g.createLinearGradient(0, 256 - h, 0, 256);
    grad.addColorStop(0, '#ffc24d');
    grad.addColorStop(1, '#ff7a3d');
    g.fillStyle = grad;
    g.globalAlpha = 0.92;
    g.fillRect(x, 256 - 14 - h, w, h);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* Procedural portal art for the journey room: a migrating-bird V of
   chevrons on deep blue — the flock, heading somewhere. */
function makeJourneyTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#040a18';
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(777);
  // faint stars
  g.fillStyle = '#bfe2ff';
  for (let i = 0; i < 40; i++) {
    g.globalAlpha = 0.25 + rnd() * 0.5;
    g.fillRect(rnd() * 256, rnd() * 256, 2, 2);
  }
  g.globalAlpha = 1;
  // bird chevrons in a V, leader at the apex
  g.strokeStyle = '#7af2ff';
  g.lineWidth = 5;
  g.lineCap = 'round';
  const bird = (x, y, s, a) => {
    g.globalAlpha = a;
    g.beginPath();
    g.moveTo(x - s, y);
    g.quadraticCurveTo(x - s * 0.3, y - s * 0.5, x, y);
    g.quadraticCurveTo(x + s * 0.3, y - s * 0.5, x + s, y);
    g.stroke();
  };
  bird(128, 70, 26, 1);
  bird(88, 110, 20, 0.85); bird(168, 110, 20, 0.85);
  bird(56, 148, 15, 0.7); bird(200, 148, 15, 0.7);
  bird(96, 150, 15, 0.7); bird(160, 150, 15, 0.7);
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------- the sound room (build 12) ----------------
   A 5th portal off the Nexus: a social listening space with a DJ booth
   and the four realm artworks hanging as a gallery. No echoes, no
   attunement — the room is for hanging out, not progression. */
function buildSoundRoom(textures) {
  const accent = SOUND_DEF.accent;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020204);
  scene.fog = new THREE.FogExp2(0x0a0610, 0.012);
  const amb = new THREE.AmbientLight(WALL_AMB_BASE, 0.5); // tinted by the community wall (build 18)
  scene.add(amb);

  // Floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(34, 48),
    new THREE.MeshStandardMaterial({ color: 0x0b0b12, roughness: 0.9, metalness: 0.1 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Four walls.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x080810, roughness: 1 });
  const wallGeo = new THREE.PlaneGeometry(68, 18);
  const walls = [
    { p: [0, 9, -34], r: 0 },
    { p: [34, 9, 0], r: Math.PI / 2 },
    { p: [0, 9, 34], r: Math.PI },
    { p: [-34, 9, 0], r: -Math.PI / 2 },
  ];
  for (const w of walls) {
    const m = new THREE.Mesh(wallGeo, wallMat);
    m.position.set(...w.p);
    m.rotation.y = w.r;
    scene.add(m);
  }

  // Gallery: the realm artworks, framed, one per wall — except the north
  // wall, where the community wall lives now (build 19 removed the
  // REALM_DEFS[0] piece that used to hang behind it).
  const galleryFiles = [];
  const frameDefs = [
    { def: REALM_DEFS[1], p: [33.7, 8, 0], r: -Math.PI / 2 },
    { def: REALM_DEFS[2], p: [0, 8, 33.7], r: Math.PI },
    { def: REALM_DEFS[3], p: [-33.7, 8, 0], r: Math.PI / 2 },
  ];
  for (const f of frameDefs) {
    const tex = textures[f.def.key];
    const img = tex && tex.image ? tex.image : null;
    const aspect = img ? img.width / img.height : 1;
    const AW = 15, AH = Math.min(AW / aspect, 11);
    const frame = new THREE.Group();
    frame.name = 'gallery-' + f.def.key; // test hook: build 19 removed gallery-realm1
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(AW + 1.2, AH + 1.2),
      new THREE.MeshStandardMaterial({ color: f.def.accent, emissive: f.def.accent, emissiveIntensity: 0.25, roughness: 0.4, metalness: 0.6 })
    );
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(AW, AH),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    art.position.z = 0.08;
    frame.add(back, art);
    frame.position.set(...f.p);
    frame.rotation.y = f.r;
    scene.add(frame);
    galleryFiles.push(f.def.file);
  }

  // DJ booth: platform, two decks, mixer, amber glow.
  const booth = new THREE.Group();
  const boothMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.6, metalness: 0.4 });
  const platform = new THREE.Mesh(new THREE.BoxGeometry(11, 1, 5), boothMat);
  platform.position.y = 0.5;
  booth.add(platform);
  const deckGeo = new THREE.CylinderGeometry(1.6, 1.6, 0.5, 32);
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x1c1c26, roughness: 0.4, metalness: 0.7 });
  for (const dx of [-2.6, 2.6]) {
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.set(dx, 1.3, 0);
    booth.add(deck);
    const platter = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 0.56, 32),
      new THREE.MeshStandardMaterial({ color: 0x0a0a10, roughness: 0.3, metalness: 0.8 })
    );
    platter.position.set(dx, 1.3, 0);
    booth.add(platter);
  }
  const mixer = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 1.6), boothMat);
  mixer.position.set(0, 1.3, 0.4);
  booth.add(mixer);
  const boothGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: accent, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  boothGlow.scale.set(16, 10, 1);
  boothGlow.position.y = 3.4;
  booth.add(boothGlow);
  booth.position.set(0, 0, -24);
  scene.add(booth);

  // Accent lights that pulse with the music (see update + setBass).
  const lightA = new THREE.PointLight(accent, 1.2, 60);
  lightA.position.set(-12, 9, -8);
  const lightB = new THREE.PointLight(accent, 1.2, 60);
  lightB.position.set(12, 9, -8);
  scene.add(lightA, lightB);

  const dust = makeDust(200, 40, accent, 0.6);
  scene.add(dust.pts);

  // Build 66: the stage — placed models live in this group, in front of
  // the DJ booth (booth sits at z=-24, spawn faces -Z from z=20).
  const stageGroup = new THREE.Group();
  stageGroup.position.set(0, 0, -10);
  scene.add(stageGroup);

  // Community wall (build 18; doubled to 32x16 in build 19 after the
  // north-wall gallery piece was removed): a monumental shared paint
  // canvas on the north wall behind the booth. MeshBasicMaterial so the
  // art reads in the dark; the CanvasTexture updates live as strokes land.
  const wallFrame = new THREE.Group();
  const wallBack = new THREE.Mesh(
    new THREE.PlaneGeometry(34.4, 17.4),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.6 })
  );
  const wallMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(32, 16),
    new THREE.MeshBasicMaterial({ map: wall.tex })
  );
  wallMesh.position.z = 0.08;
  wallFrame.add(wallBack, wallMesh);
  wallFrame.position.set(0, 9, -33.4);
  scene.add(wallFrame);

  // Return portal to the Nexus.
  const { group, ring } = makePortal(makeSoundTexture(), accent, 'RETURN', 1.7, 0.14);
  group.position.set(0, 3, 26);
  group.lookAt(0, 5, 10);
  scene.add(group);
  const portals = [{ group, ring, pos: group.position.clone(), target: 'nexus', phase: 0.6, baseY: 3 }];

  return {
    key: SOUND_DEF.key, name: SOUND_DEF.name, root: SOUND_DEF.root,
    scene, portals, echoes: [],
    gallery: galleryFiles, // realm artwork files on the walls — tests check these are real
    spawn: new THREE.Vector3(0, 2, 20), spawnYaw: 0, // face the booth (-Z)
    bound: 'realm',
    anim: {
      dust, lightA, lightB, boothGlow, bass: 0,
      amb, wallMesh, wallSampleAt: 0, wallPulse: 0,
      wallTarget: new THREE.Color(WALL_AMB_BASE),
      scene, stageGroup, foh, // build 66: stage builder + front of house
    },
    attunedShown: true, // n/a: no echoes here, nothing to attune
    setBass(v) { this.anim.bass = Math.max(0, Math.min(1, v)); },
    update(dt, t) {
      const { dust, lightA, lightB, boothGlow } = this.anim;
      const bass = this.anim.bass;
      dust.pts.rotation.y += dt * 0.02;
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.3;
        pt.ring.rotation.z -= dt * 0.15;
        pt.pos.copy(pt.group.position);
      }
      // The room breathes with the music; idle when nobody's live.
      // Community wall (build 18): ~1s sampler reads the wall's average
      // color + paint energy and tints the room. Blank wall -> default look.
      // (elapsedTime, not accumulated dt: dt is clamped and headless GPUs
      // run few frames per real second.)
      const a = this.anim;
      if (t - (a.wallSampleAt || 0) >= 1) {
        a.wallSampleAt = t;
        wallReactSample(a);
      }
      a.amb.color.lerp(a.wallTarget, Math.min(1, dt * 1.5));
      const wp = a.wallPulse;
      const pulse = 1 + bass * 2.2 + Math.sin(t * 1.4) * 0.08;
      lightA.intensity = 1.2 * pulse * (1 + wp * 0.15);
      lightB.intensity = (1.2 * (2 - pulse) + 1.2 + bass) * (1 + wp * 0.15); // counter-phase shimmer
      boothGlow.material.opacity = 0.4 + bass * 0.5 + wp * 0.12;
      const gs = 16 + bass * 6;
      boothGlow.scale.set(gs, gs * 0.62, 1);
      scene.fog.density = 0.012 + bass * 0.008;
      // Build 66: front of house overrides the light rig when touched.
      soundFohApply(this.anim, t);
    },
  };
}

/* ================= the model room (build 66) =================
   A workshop realm: an in-browser mini 3D modeler in the #workshop-panel
   overlay. Primitives drop onto the workbench, sliders move / spin / size
   them, models save to localStorage and feed the sound room's stage
   builder. Its own P2P room, like the sound room. */

/* Procedural portal art for the model room: a blueprint cube on dark. */
function makeWorkshopTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#060b16';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(159, 216, 255, 0.18)';
  g.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const p = (i / 16) * 256;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(256, p); g.stroke();
  }
  // Isometric cube outline.
  const cx = 128, cy = 128, s = 52;
  const P = [
    [cx - s, cy - s * 0.5], [cx, cy - s], [cx + s, cy - s * 0.5],
    [cx + s, cy + s * 0.5], [cx, cy + s], [cx - s, cy + s * 0.5],
  ];
  g.strokeStyle = '#9fd8ff';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(...P[0]); g.lineTo(...P[1]); g.lineTo(...P[2]);
  g.lineTo(...P[3]); g.lineTo(...P[4]); g.lineTo(...P[5]);
  g.closePath(); g.stroke();
  g.beginPath();
  g.moveTo(...P[5]); g.lineTo(...P[3]); g.moveTo(...P[4]); g.lineTo(...P[1]);
  g.moveTo(...P[0]); g.lineTo(...P[2]); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* Theatre portal texture (build 75): a cinema screen with play triangle. */
function makeTheatreTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0c0608';
  g.fillRect(0, 0, 256, 256);
  // screen
  g.fillStyle = '#1a0e12';
  g.fillRect(48, 64, 160, 96);
  g.strokeStyle = '#ff5566';
  g.lineWidth = 4;
  g.strokeRect(48, 64, 160, 96);
  // play triangle
  g.fillStyle = '#ff5566';
  g.beginPath();
  g.moveTo(112, 88); g.lineTo(112, 136); g.lineTo(152, 112);
  g.closePath(); g.fill();
  // seats hint
  g.fillStyle = 'rgba(255, 85, 102, 0.25)';
  for (let i = 0; i < 4; i++) {
    g.fillRect(64 + i * 36, 184, 28, 18);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildWorkshop() {
  const accent = WORKSHOP_DEF.accent;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04060c);
  scene.fog = new THREE.FogExp2(0x060a14, 0.014);
  scene.add(new THREE.AmbientLight(0xbfd4ff, 0.7));
  const key = new THREE.DirectionalLight(0xd8ecff, 1.1);
  key.position.set(8, 14, 6);
  scene.add(key);

  // Floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(30, 48),
    new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.85, metalness: 0.15 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Workbench: a glowing platform in the middle where pieces land.
  const bench = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 9, 0.6, 48),
    new THREE.MeshStandardMaterial({ color: 0x111826, roughness: 0.5, metalness: 0.5 })
  );
  bench.position.y = 0.3;
  scene.add(bench);
  const benchRing = new THREE.Mesh(
    new THREE.TorusGeometry(9, 0.12, 12, 72),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.8 })
  );
  benchRing.rotation.x = Math.PI / 2;
  benchRing.position.y = 0.62;
  scene.add(benchRing);

  const dust = makeDust(160, 34, accent, 0.5);
  scene.add(dust.pts);

  // Pieces built in the workbench live here (pieces-only group).
  wsGroup = new THREE.Group();
  scene.add(wsGroup);

  // Return portal to the Nexus, off to the side where the drifter can see it.
  const { group, ring } = makePortal(makeWorkshopTexture(), accent, 'NEXUS', 1.7, 0.14);
  group.position.set(13, 3, 10);
  group.lookAt(0, 3, 16);
  scene.add(group);
  const portals = [{ group, ring, pos: group.position.clone(), target: 'nexus', phase: 0.6, baseY: 3 }];

  return {
    key: WORKSHOP_DEF.key, name: WORKSHOP_DEF.name, root: WORKSHOP_DEF.root,
    scene, portals, echoes: [],
    spawn: new THREE.Vector3(0, 2, 16), spawnYaw: 0, // face the bench (-Z)
    bound: 'realm',
    anim: { dust, benchRing },
    attunedShown: true, // n/a: no echoes here, nothing to attune
    update(dt, t) {
      const { dust, benchRing } = this.anim;
      dust.pts.rotation.y += dt * 0.02;
      benchRing.material.emissiveIntensity = 0.6 + Math.sin(t * 1.6) * 0.25;
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.3;
        pt.ring.rotation.z -= dt * 0.15;
        pt.pos.copy(pt.group.position);
      }
    },
  };
}

/* ---------------- shared piece factory (build 66) ----------------
   The workshop and the stage builder both instantiate saved models
   through this — one geometry per primitive, MeshStandardMaterial so
   the FOH lights play on them. */
function modelPieceMesh(type, colorHex) {
  let geo;
  switch (type) {
    case 'sphere': geo = new THREE.SphereGeometry(1, 24, 18); break;
    case 'cylinder': geo = new THREE.CylinderGeometry(1, 1, 2, 24); break;
    case 'cone': geo = new THREE.ConeGeometry(1, 2, 24); break;
    case 'torus': geo = new THREE.TorusGeometry(1, 0.4, 16, 32); break;
    case 'plane': geo = new THREE.PlaneGeometry(2, 2); break;
    case 'box':
    default: geo = new THREE.BoxGeometry(2, 2, 2); break;
  }
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex || '#7ae0ff'),
    roughness: 0.45, metalness: 0.35,
  });
  return new THREE.Mesh(geo, mat);
}
function modelDisposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh) {
      try { o.geometry.dispose(); } catch (e) {}
      try { o.material.dispose(); } catch (e) {}
    }
  });
  group.clear();
}

/* ---------------- theatre (build 75) ----------------
   Cinema room for watching videos together. Dark space, big glowing
   screen frame on the north wall (the video itself is a DOM overlay —
   YouTube iframes can't be WebGL textures). Seats as simple rows. */
function buildTheatre() {
  const accent = THEATRE_DEF.accent;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050304);
  scene.fog = new THREE.FogExp2(0x080405, 0.014);
  scene.add(new THREE.AmbientLight(0xff8899, 0.35));

  // Floor — dark carpet.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(30, 48),
    new THREE.MeshStandardMaterial({ color: 0x0a0708, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Screen frame on the north wall — big glowing rectangle, exact 16:9 so
  // the projected video layer lands on it pixel-true (build 76).
  const screenW = 28, screenH = 15.75, screenY = 9.5, screenZ = -28.9;
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(screenW + 1.5, screenH + 1.5),
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: accent, emissiveIntensity: 0.35, roughness: 0.4 })
  );
  frame.position.set(0, screenY, screenZ - 0.1);
  scene.add(frame);
  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(screenW, screenH),
    new THREE.MeshBasicMaterial({ color: 0x0a0a0c })
  );
  screenMesh.position.set(0, screenY, screenZ);
  screenMesh.name = 'theatre-screen';
  scene.add(screenMesh);

  // Seat rows — simple dark boxes with a hint of red.
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x1a0d10, roughness: 0.9 });
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 6; i++) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 1.2), seatMat);
      seat.position.set((i - 2.5) * 3.2, 0.8, -8 + row * 4.5);
      scene.add(seat);
      // seat back — a little taller so rows read as a cinema
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 0.5), seatMat);
      back.position.set((i - 2.5) * 3.2, 1.9, -7.5 + row * 4.5);
      scene.add(back);
    }
  }

  // Soft red wash from the screen.
  const wash = new THREE.PointLight(0xff5566, 0.6, 60);
  wash.position.set(0, 9, -24);
  scene.add(wash);

  // Projector booth at the back (build 76) — the beam is what sells it.
  const booth = new THREE.Mesh(
    new THREE.BoxGeometry(3, 2, 2.5),
    new THREE.MeshStandardMaterial({ color: 0x141114, roughness: 0.7 })
  );
  booth.position.set(0, 7.5, 23.5);
  scene.add(booth);
  const lens = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(), color: 0xcfe8ff, transparent: true,
    opacity: 0.9, depthWrite: false, fog: false,
  }));
  lens.scale.set(1.4, 1.4, 1);
  lens.position.set(0, 7.5, 22.1);
  scene.add(lens);

  // Light beam: projector lens -> screen. Narrow at the booth, wide at the
  // screen. Only visible while a video is playing.
  const projPos = new THREE.Vector3(0, 7.5, 22.1);
  const screenPos = new THREE.Vector3(0, screenY, screenZ);
  const beamLen = projPos.distanceTo(screenPos);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 13, beamLen, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x9db8ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      depthWrite: false, fog: false,
    })
  );
  beam.position.copy(projPos).add(screenPos).multiplyScalar(0.5);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), projPos.clone().sub(screenPos).normalize());
  beam.visible = false;
  scene.add(beam);

  // Dust motes drifting in the beam.
  const dustN = 70;
  const dustArr = new Float32Array(dustN * 3);
  const dustSeed = [];
  for (let i = 0; i < dustN; i++) {
    const f = Math.random(); // 0 at projector, 1 at screen
    const cx = projPos.x + (screenPos.x - projPos.x) * f;
    const cy = projPos.y + (screenPos.y - projPos.y) * f;
    const cz = projPos.z + (screenPos.z - projPos.z) * f;
    const r = 0.5 + f * 11;
    dustArr[i * 3] = cx + (Math.random() - 0.5) * 2 * r * 0.6;
    dustArr[i * 3 + 1] = cy + (Math.random() - 0.5) * 2 * r * 0.4;
    dustArr[i * 3 + 2] = cz + (Math.random() - 0.5) * 2;
    dustSeed.push({ sp: 0.2 + Math.random() * 0.6, ph: Math.random() * Math.PI * 2 });
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustArr, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0xbfd4ff, size: 0.12, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  dust.visible = false;
  scene.add(dust);

  // Return portal to the Nexus.
  const { group, ring } = makePortal(makeTheatreTexture(), accent, 'NEXUS', 1.7, 0.14);
  group.position.set(12, 3, 12);
  group.lookAt(0, 3, 0);
  scene.add(group);
  const portals = [{ group, ring, pos: group.position.clone(), target: 'nexus', phase: 0.6, baseY: 3 }];

  return {
    key: THEATRE_DEF.key, name: THEATRE_DEF.name, root: THEATRE_DEF.root,
    scene, portals, echoes: [],
    spawn: new THREE.Vector3(0, 2, 14), spawnYaw: 0, // face the screen (-Z)
    bound: 'realm',
    anim: { wash, screenMesh, beam, lens, dust, dustSeed },
    attunedShown: true,
    update(dt, t) {
      const a = this.anim;
      const playing = theatre.playing && !!theatre.videoId;
      // Screen-light wash: gentle idle breathing, lively flicker while the
      // projector is running — light spilling off the screen.
      a.wash.intensity = playing
        ? 0.75 + Math.sin(t * 9.3) * 0.12 + Math.sin(t * 23.7) * 0.08
        : 0.5 + Math.sin(t * 0.7) * 0.15;
      a.beam.visible = playing;
      a.dust.visible = playing;
      if (playing) {
        a.beam.material.opacity = 0.045 + Math.sin(t * 7.1) * 0.012 + Math.sin(t * 17.3) * 0.008;
        a.lens.material.opacity = 0.75 + Math.sin(t * 11.7) * 0.15;
        const pos = a.dust.geometry.attributes.position;
        for (let i = 0; i < a.dustSeed.length; i++) {
          const s = a.dustSeed[i];
          pos.array[i * 3 + 1] += Math.sin(t * s.sp + s.ph) * dt * 0.35;
          pos.array[i * 3] += Math.cos(t * s.sp * 0.7 + s.ph) * dt * 0.25;
        }
        pos.needsUpdate = true;
      }
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.3;
        pt.ring.rotation.z -= dt * 0.15;
        pt.pos.copy(pt.group.position);
      }
    },
  };
}

/* ---------------- the workbench (build 66) ----------------
   In-browser mini modeler. Pieces are {id, type, mesh}; the saved
   format is JSON-serializable: type + position + spin + size + color. */
const ws = {
  pieces: [], // {id, type, mesh}
  sel: null, // selected piece id
  nextId: 1,
  undoStack: [],
  undoArmed: false,
  open: false,
};
let wsGroup = null; // pieces-only group, set by buildWorkshop()
const WS_MAX_PIECES = 60;

const workshopBtn = document.getElementById('workshop-btn');
const workshopPanel = document.getElementById('workshop-panel');
const workshopCloseBtn = document.getElementById('workshop-close');
const wsAddEl = document.getElementById('ws-add');
const wsPiecesEl = document.getElementById('ws-pieces');
const wsEditEl = document.getElementById('ws-edit');
const wsEditNameEl = document.getElementById('ws-edit-name');
const wsXEl = document.getElementById('ws-x');
const wsYEl = document.getElementById('ws-y');
const wsZEl = document.getElementById('ws-z');
const wsRotEl = document.getElementById('ws-rot');
const wsSizeEl = document.getElementById('ws-size');
const wsColorEl = document.getElementById('ws-color');
const wsUndoEl = document.getElementById('ws-undo');
const wsDeleteEl = document.getElementById('ws-delete');
const wsNameEl = document.getElementById('ws-name');
const wsSaveEl = document.getElementById('ws-save');
const wsModelsEl = document.getElementById('ws-models');

function wsLoadModels() {
  try { return JSON.parse(localStorage.getItem('limbo_models_v1') || '{}') || {}; }
  catch (e) { return {}; }
}
function wsSaveModels(m) {
  try { localStorage.setItem('limbo_models_v1', JSON.stringify(m)); } catch (e) {}
}
function wsPieceSpec(p) {
  const spec = {
    t: p.type,
    p: [+p.mesh.position.x.toFixed(3), +p.mesh.position.y.toFixed(3), +p.mesh.position.z.toFixed(3)],
    ry: +p.mesh.rotation.y.toFixed(3),
    s: +p.mesh.scale.x.toFixed(3),
    c: '#' + p.mesh.material.color.getHexString(),
  };
  // build 68: sculpted pieces carry their clay (detail + displaced verts)
  if (p.sculpt && p.sculpt.v && p.sculpt.detail) { spec.detail = p.sculpt.detail; spec.v = p.sculpt.v; }
  return spec;
}
function wsSerialize() { return ws.pieces.map(wsPieceSpec); }
function wsSanitizeSpec(s) {
  if (!s || typeof s !== 'object') return null;
  const t = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane'].includes(s.t) ? s.t : 'box';
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const p = Array.isArray(s.p) ? s.p : [0, 1.6, 0];
  const out = {
    t,
    p: [num(p[0], 0), num(p[1], 1.6), num(p[2], 0)],
    ry: num(s.ry, 0),
    s: Math.max(0.05, Math.min(8, num(s.s, 1))),
    c: typeof s.c === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.c) ? s.c : '#7ae0ff',
  };
  // build 68: sculpt payload round-trips (validated; corrupt data falls back to the plain primitive)
  if (s.detail && SCULPT_DETAIL[s.detail] && typeof s.v === 'string' && s.v.length > 64 && s.v.length < 4000000) {
    out.detail = s.detail;
    out.v = s.v;
  }
  return out;
}
function wsInstantiate(spec) {
  const s = wsSanitizeSpec(spec);
  if (!s) return null;
  // build 68: sculpted specs rebuild their clay; corrupt data falls back to the plain primitive
  let mesh = (s.v && s.detail) ? sculptMeshFromSpec(s) : null;
  if (!mesh) mesh = modelPieceMesh(s.t, s.c);
  mesh.position.set(s.p[0], s.p[1], s.p[2]);
  mesh.rotation.y = s.ry;
  mesh.scale.setScalar(s.s);
  const piece = { id: ws.nextId++, type: s.t, mesh };
  if (s.v && s.detail) piece.sculpt = { detail: s.detail, v: s.v };
  return piece;
}
/* Rebuild the bench from a serialized list. */
function wsRebuild(list) {
  if (wsGroup) modelDisposeGroup(wsGroup);
  ws.pieces = [];
  ws.sel = null;
  for (const spec of (Array.isArray(list) ? list : [])) {
    const p = wsInstantiate(spec);
    if (p) { ws.pieces.push(p); if (wsGroup) wsGroup.add(p.mesh); }
  }
  wsRenderPieces();
  wsRenderEdit();
}
function wsPushUndo() {
  ws.undoStack.push(JSON.stringify(wsSerialize()));
  if (ws.undoStack.length > 24) ws.undoStack.shift(); // build 68: 24 — sculpted snapshots carry vert data
}
function wsUndo() {
  const snap = ws.undoStack.pop();
  if (snap == null) return false;
  try { wsRebuild(JSON.parse(snap)); } catch (e) { return false; }
  return true;
}
function wsFind(id) { return ws.pieces.find((p) => p.id === id) || null; }

function wsAdd(type) {
  if (!wsGroup) return false;
  if (ws.pieces.length >= WS_MAX_PIECES) {
    addSystemLine('the bench is full — delete something first');
    return false;
  }
  wsPushUndo();
  const p = wsInstantiate({ t: type, p: [0, 1.6, 0], ry: 0, s: 1, c: '#7ae0ff' });
  if (!p) return false;
  ws.pieces.push(p);
  wsGroup.add(p.mesh);
  ws.sel = p.id;
  wsRenderPieces();
  wsRenderEdit();
  return true;
}
function wsSelect(id) {
  ws.sel = wsFind(id) ? id : null;
  wsRenderPieces();
  wsRenderEdit();
}
function wsDelete() {
  const p = wsFind(ws.sel);
  if (!p) return false;
  wsPushUndo();
  if (wsGroup) wsGroup.remove(p.mesh);
  try { p.mesh.geometry.dispose(); p.mesh.material.dispose(); } catch (e) {}
  ws.pieces = ws.pieces.filter((q) => q.id !== p.id);
  ws.sel = null;
  wsRenderPieces();
  wsRenderEdit();
  return true;
}
/* Sliders -> the selected piece, live. */
function wsApplyEdit() {
  const p = wsFind(ws.sel);
  if (!p || !wsXEl) return false;
  p.mesh.position.set(+wsXEl.value, +wsYEl.value, +wsZEl.value);
  p.mesh.rotation.y = (+wsRotEl.value * Math.PI) / 180;
  p.mesh.scale.setScalar(Math.max(0.05, +wsSizeEl.value / 100));
  try { p.mesh.material.color.set(wsColorEl.value); } catch (e) {}
  return true;
}
/* One undo snapshot per slider gesture. */
function wsArmUndo() {
  if (!ws.undoArmed) { wsPushUndo(); ws.undoArmed = true; }
}
function wsSaveModel(name) {
  const nm = String(name != null ? name : (wsNameEl && wsNameEl.value) || '').trim().slice(0, 24) || 'model';
  if (!ws.pieces.length) { addSystemLine('nothing built yet — add a piece first'); return false; }
  const models = wsLoadModels();
  models[nm] = wsSerialize();
  wsSaveModels(models);
  if (wsNameEl) wsNameEl.value = '';
  wsRenderModels();
  stageRenderModels(); // the jam room's stage list sees it immediately
  wsBroadcastModel(nm); // build 69: the room shelf sees it too
  addSystemLine(`model "${nm}" saved — place it from the jam room stage`);
  return true;
}
function wsLoadModel(name) {
  const models = wsLoadModels();
  const list = models[name];
  if (!Array.isArray(list)) return false;
  wsPushUndo();
  wsRebuild(list);
  if (ws.pieces.length) wsSelect(ws.pieces[0].id);
  return true;
}
function wsDeleteModel(name) {
  const models = wsLoadModels();
  if (!(name in models)) return false;
  delete models[name];
  wsSaveModels(models);
  wsRenderModels();
  stageRenderModels();
  wsBroadcastModelDel(name); // build 69: pull it off the room shelf too
  return true;
}
function wsRenderPieces() {
  if (!wsPiecesEl) return;
  wsPiecesEl.innerHTML = '';
  if (!ws.pieces.length) {
    const d = document.createElement('div');
    d.className = 'ws-empty';
    d.textContent = 'nothing built yet — add a piece above';
    wsPiecesEl.appendChild(d);
    return;
  }
  for (const p of ws.pieces) {
    const b = document.createElement('button');
    b.textContent = `${p.type} ${p.id}`;
    b.classList.toggle('sel', p.id === ws.sel);
    b.setAttribute('aria-label', `select ${p.type} ${p.id}`);
    b.addEventListener('click', () => { wsSelect(p.id); b.blur(); });
    wsPiecesEl.appendChild(b);
  }
}
function wsRenderEdit() {
  const p = wsFind(ws.sel);
  if (wsEditEl) wsEditEl.hidden = !p;
  if (!p || !wsXEl) return;
  wsEditNameEl.textContent = `${p.type} ${p.id}`;
  wsXEl.value = p.mesh.position.x.toFixed(2);
  wsYEl.value = p.mesh.position.y.toFixed(2);
  wsZEl.value = p.mesh.position.z.toFixed(2);
  wsRotEl.value = Math.round(((p.mesh.rotation.y * 180) / Math.PI % 360 + 360) % 360);
  wsSizeEl.value = Math.round(p.mesh.scale.x * 100);
  try { wsColorEl.value = '#' + p.mesh.material.color.getHexString(); } catch (e) {}
  if (wsUndoEl) wsUndoEl.classList.toggle('off', !ws.undoStack.length);
}
function wsRenderModels() {
  if (!wsModelsEl) return;
  wsModelsEl.innerHTML = '';
  const models = wsLoadModels();
  const names = Object.keys(models).sort();
  if (!names.length) {
    const d = document.createElement('div');
    d.className = 'ws-empty';
    d.textContent = 'no saved models yet';
    wsModelsEl.appendChild(d);
    return;
  }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'ws-model-row';
    const load = document.createElement('button');
    load.className = 'ws-model-load';
    const count = Array.isArray(models[name]) ? models[name].length : 0;
    load.textContent = `${name} (${count})`;
    load.setAttribute('aria-label', `load model ${name}`);
    load.addEventListener('click', () => { wsLoadModel(name); load.blur(); });
    const del = document.createElement('button');
    del.className = 'ws-model-del';
    del.innerHTML = '&#10005;';
    del.setAttribute('aria-label', `delete model ${name}`);
    del.addEventListener('click', () => { wsDeleteModel(name); del.blur(); });
    row.appendChild(load);
    row.appendChild(del);
    wsModelsEl.appendChild(row);
  }
}
function setWorkshopPanel(open) {
  ws.open = !!open;
  if (workshopPanel) workshopPanel.style.display = ws.open ? '' : 'none';
  if (ws.open) { wsRenderPieces(); wsRenderEdit(); wsRenderModels(); wsShelfRender(); }
}

/* ---------------- shared model shelf (build 69) ----------------
   v1 multiplayer for the model room: a shared-shelf model, NOT live
   stroke-level co-sculpting. Every saved model is broadcast to the room;
   the shelf lists everyone's models with the maker's name. Tapping a
   peer's model loads a COPY into your own workbench (sculpted clay
   included — it round-trips through wsSanitizeSpec). Large models ride
   chunked (data channels cap ~256KB/message; 48KB chunks stay safe). */
const wsShelfEl = document.getElementById('ws-shelf');
const wsRosterEl = document.getElementById('ws-roster');
const wsShelf = new Map(); // `${peerId}::${name}` -> { name, by, specs, peerId }
const MODEL_CHUNK = 48000; // base64 chars per message
const MODEL_MAX_CHUNKS = 64; // ~3MB ceiling per shared model
const wsPendingModels = new Map(); // `${peerId}:${tid}` -> { name, by, parts, n, t }

function wsShelfKey(peerId, name) { return String(peerId) + '::' + String(name); }
function wsMyName() { return (typeof myName === 'string' && myName) || 'drifter'; }

/* Send one of MY models to the room. Small models go direct; large ones
   go as meta + indexed chunks (order-independent reassembly). */
function wsBroadcastModel(name) {
  if (!net.enabled || !net.sendModelShare) return false;
  const models = wsLoadModels();
  const specs = models[name];
  if (!Array.isArray(specs) || !specs.length) return false;
  const by = wsMyName();
  const tid = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  const payload = JSON.stringify({ name, by, specs });
  if (payload.length <= MODEL_CHUNK) {
    try { net.sendModelShare({ tid, name, by, specs }); } catch (e) { return false; }
    return true;
  }
  const parts = [];
  for (let i = 0; i < payload.length; i += MODEL_CHUNK) parts.push(payload.slice(i, i + MODEL_CHUNK));
  if (parts.length > MODEL_MAX_CHUNKS) {
    addSystemLine('model too big to share — try a lower sculpt detail');
    return false;
  }
  try { net.sendModelShare({ tid, name, by, n: parts.length }); } catch (e) { return false; }
  parts.forEach((chunk, i) => { try { net.sendModelChunk({ tid, i, chunk }); } catch (e) {} });
  return true;
}
function wsBroadcastModelDel(name) {
  if (!net.enabled || !net.sendModelDel) return;
  try { net.sendModelDel({ name: String(name).slice(0, 24) }); } catch (e) {}
}
function wsShelfApply(peerId, name, by, specs) {
  if (!Array.isArray(specs) || !specs.length || specs.length > 24) return false;
  const clean = specs.map(wsSanitizeSpec).filter(Boolean);
  if (!clean.length) return false;
  wsShelf.set(wsShelfKey(peerId, name), {
    name: String(name).slice(0, 24),
    by: String(by || 'drifter').slice(0, 16) || 'drifter',
    specs: clean,
    peerId: String(peerId),
  });
  // shelf cap: drop the oldest entries first
  while (wsShelf.size > 60) wsShelf.delete(wsShelf.keys().next().value);
  wsShelfRender();
  return true;
}
function handleModelShare(peerId, d) {
  if (!d) return;
  const tid = String(d.tid || '');
  const name = String(d.name || '').slice(0, 24);
  if (!name || !tid) return;
  // drop stale pending transfers (a minute without all chunks = dead)
  const now = Date.now();
  for (const [k, p] of wsPendingModels) if (now - p.t > 60000) wsPendingModels.delete(k);
  if (typeof d.n === 'number' && d.n > 1 && d.n <= MODEL_MAX_CHUNKS) {
    wsPendingModels.set(String(peerId) + ':' + tid, {
      name, by: String(d.by || 'drifter').slice(0, 16), parts: new Array(Math.floor(d.n)).fill(null),
      n: Math.floor(d.n), t: now,
    });
    return;
  }
  wsShelfApply(peerId, name, d.by, d.specs);
}
function handleModelChunk(peerId, d) {
  if (!d) return;
  const p = wsPendingModels.get(String(peerId) + ':' + String(d.tid || ''));
  if (!p) return;
  const i = Math.floor(+d.i);
  if (!(i >= 0 && i < p.n) || typeof d.chunk !== 'string' || d.chunk.length > MODEL_CHUNK + 64) return;
  p.parts[i] = d.chunk;
  if (p.parts.some((x) => x == null)) return;
  wsPendingModels.delete(String(peerId) + ':' + String(d.tid || ''));
  try {
    const payload = JSON.parse(p.parts.join(''));
    if (payload && String(payload.name || '').slice(0, 24) === p.name) wsShelfApply(peerId, p.name, p.by, payload.specs);
  } catch (e) {}
}
function handleModelDel(peerId, d) {
  if (!d) return;
  const name = String(d.name || '').slice(0, 24);
  if (wsShelf.delete(wsShelfKey(peerId, name))) wsShelfRender();
}
function handleModelReq(peerId, d) {
  if (!net.enabled) return;
  // late joiner asks — answer with each of my models, one message each
  const models = wsLoadModels();
  for (const name of Object.keys(models)) wsBroadcastModel(name);
}
/* Tap a shelf model: it loads as a COPY into my workbench. */
function wsShelfLoadEntry(entry) {
  if (!entry || !Array.isArray(entry.specs)) return false;
  wsPushUndo();
  wsRebuild(entry.specs);
  if (ws.pieces.length) wsSelect(ws.pieces[0].id);
  addSystemLine(`"${entry.name}" by ${entry.by} is on your bench — sculpt away`);
  return true;
}
function wsRosterNames() {
  const out = [];
  for (const pv of peerVisuals.values()) if (pv && pv.name) out.push(pv.name);
  return out;
}
function wsShelfRender() {
  if (wsRosterEl) {
    const names = wsRosterNames();
    wsRosterEl.textContent = names.length
      ? `· ${names.length + 1} here: you, ${names.join(', ')}`
      : (net.enabled ? '· just you here' : '· offline');
  }
  if (!wsShelfEl) return;
  wsShelfEl.innerHTML = '';
  const entries = [...wsShelf.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.length) {
    const d = document.createElement('div');
    d.className = 'ws-empty';
    d.textContent = net.enabled ? 'room shelf is empty — save a model to share it' : 'offline — the shelf needs a connection';
    wsShelfEl.appendChild(d);
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'ws-shelf-row';
    const load = document.createElement('button');
    load.className = 'ws-model-load';
    const nm = document.createElement('span');
    nm.textContent = `${e.name} (${e.specs.length})`;
    const by = document.createElement('span');
    by.className = 'ws-shelf-by';
    by.textContent = 'by ' + e.by;
    load.appendChild(nm);
    load.appendChild(by);
    load.setAttribute('aria-label', `load ${e.name} by ${e.by} into workbench`);
    load.addEventListener('click', () => { wsShelfLoadEntry(e); load.blur(); });
    row.appendChild(load);
    wsShelfEl.appendChild(row);
  }
}

/* ---------------- sculpt mode (build 68) ----------------
   Nomad-style touch sculpting on the selected workbench piece.
   The piece's geometry is swapped for a dense subdivided base; finger
   drags displace verts with dab spacing and a cosine falloff. Sculpting
   edits geometry in the piece's local space — the workbench sliders keep
   owning the piece transform. Saved models carry the displaced verts
   (base64 Float32Array) so they round-trip through the stage builder. */

/* Detail -> per-primitive segment counts. Vert budgets stay phone-sane:
   low ~1.6k, med ~6.3k, high ~18k on the sphere (cap 25k everywhere). */
const SCULPT_DETAIL = {
  low:  { sphere: [48, 32],   box: [10, 10, 10], cylinder: [40, 20],  cone: [40, 20],  torus: [40, 20],  plane: [40, 40] },
  med:  { sphere: [96, 64],   box: [22, 22, 22], cylinder: [80, 40],  cone: [80, 40],  torus: [80, 40],  plane: [80, 80] },
  high: { sphere: [160, 112], box: [34, 34, 34], cylinder: [120, 60], cone: [120, 60], torus: [120, 60], plane: [120, 120] },
};
const SCULPT_BRUSHES = ['grab', 'clay', 'smooth', 'flatten', 'pinch', 'inflate'];

function sculptBaseGeo(type, detail) {
  const lv = SCULPT_DETAIL[detail] || SCULPT_DETAIL.med;
  const d = lv[type] || lv.sphere;
  switch (type) {
    case 'sphere': return new THREE.SphereGeometry(1, d[0], d[1]);
    case 'cylinder': return new THREE.CylinderGeometry(1, 1, 2, d[0], d[1]);
    case 'cone': return new THREE.ConeGeometry(1, 2, d[0], d[1]);
    case 'torus': return new THREE.TorusGeometry(1, 0.4, d[1], d[0]);
    case 'plane': return new THREE.PlaneGeometry(2, 2, d[0], d[1]);
    case 'box':
    default: return new THREE.BoxGeometry(2, 2, 2, d[0], d[1], d[2]);
  }
}

/* Float32Array <-> base64 for the saved-model payload. */
function sculptF32ToB64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function sculptB64ToF32(b64, count) {
  try {
    const bin = atob(b64);
    if (bin.length !== count * 4) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch (e) { return null; }
}
/* Dense geometry rebuilt from saved sculpt data (type + detail + verts). */
function sculptGeoFromData(type, detail, v) {
  try {
    const geo = sculptBaseGeo(type, detail);
    const arr = sculptB64ToF32(v, geo.attributes.position.count * 3);
    if (!arr) { geo.dispose(); return null; }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    return geo;
  } catch (e) { return null; }
}
/* Rebuild a mesh from a sanitized sculpted spec ({t, detail, v, c}). */
function sculptMeshFromSpec(s) {
  const geo = sculptGeoFromData(s.t, s.detail, s.v);
  if (!geo) return null;
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(s.c || '#7ae0ff'), roughness: 0.45, metalness: 0.35,
  });
  return new THREE.Mesh(geo, mat);
}

const sculpt = {
  active: false, pieceId: null, ptype: 'sphere', mesh: null,
  brush: 'clay', size: 0.55, intensity: 0.5,
  sym: true, invert: false, detail: 'med',
  stroke: null, strokeId: null, undo: [], strokeCount: 0,
  orbit: { theta: 0.7, phi: 1.12, radius: 7, target: new THREE.Vector3() },
  orbiting: null, orbitLast: null, pinching: false, pinchDist: 0,
  pointers: new Map(),
  mouseDown: false, mouseRole: null,
  neighbors: null, lastNormalAt: 0,
};
const sculptHud = document.getElementById('sculpt-hud');
const scNameEl = document.getElementById('sc-name');
const scDetailEl = document.getElementById('sc-detail');
const scBrushesEl = document.getElementById('sc-brushes');
const scSizeEl = document.getElementById('sc-size');
const scIntEl = document.getElementById('sc-int');
const scSymEl = document.getElementById('sc-sym');
const scInvertEl = document.getElementById('sc-invert');
const scUndoEl = document.getElementById('sc-undo');
const scDoneEl = document.getElementById('sc-done');
const wsSculptEl = document.getElementById('ws-sculpt');

const _scA = new THREE.Vector3(), _scB = new THREE.Vector3(), _scC = new THREE.Vector3();
const _scQ = new THREE.Quaternion();
const _scD = { x: 0, y: 0, z: 0 }; // scratch displacement, written by sculptDispInto

/* Vertex adjacency from the index — built once per sculpt geometry. */
function sculptBuildNeighbors(geo) {
  const n = geo.attributes.position.count;
  if (!geo.index) return Array.from({ length: n }, () => []);
  const idx = geo.index.array;
  const sets = new Array(n);
  for (let i = 0; i < n; i++) sets[i] = new Set();
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [...sets[i]];
  return out;
}

function sculptLocalRadius() {
  const s = (sculpt.mesh && sculpt.mesh.scale.x) || 1;
  return Math.max(0.04, sculpt.size / Math.max(0.05, s));
}
/* One vert's displacement from one dab — writes into _scD (no allocs).
   g: local-space grab delta (grab brush only). */
function sculptDispInto(brush, cx, cy, cz, nx, ny, nz, px, py, pz, vi, arr, nrm, kClay, kSmooth, inten, g) {
  const D = _scD;
  if (brush === 'clay') { D.x = nx * kClay; D.y = ny * kClay; D.z = nz * kClay; }
  else if (brush === 'inflate') {
    if (nrm) { D.x = nrm[vi] * kClay; D.y = nrm[vi + 1] * kClay; D.z = nrm[vi + 2] * kClay; }
    else { D.x = nx * kClay; D.y = ny * kClay; D.z = nz * kClay; }
  }
  else if (brush === 'flatten') {
    const a = (px - cx) * nx + (py - cy) * ny + (pz - cz) * nz;
    const k = -0.9 * inten * a;
    D.x = nx * k; D.y = ny * k; D.z = nz * k;
  }
  else if (brush === 'pinch') {
    const tx = cx - px, ty = cy - py, tz = cz - pz;
    const a = tx * nx + ty * ny + tz * nz;
    const k = 0.9 * inten;
    D.x = (tx - nx * a) * k; D.y = (ty - ny * a) * k; D.z = (tz - nz * a) * k;
  }
  else if (brush === 'smooth') {
    const nb = sculpt.neighbors[vi / 3];
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < nb.length; j++) { const jx = nb[j] * 3; ax += arr[jx]; ay += arr[jx + 1]; az += arr[jx + 2]; }
    const m = 1 / Math.max(1, nb.length);
    D.x = (ax * m - px) * kSmooth; D.y = (ay * m - py) * kSmooth; D.z = (az * m - pz) * kSmooth;
  }
  else if (brush === 'grab' && g) { D.x = g.x; D.y = g.y; D.z = g.z; }
  else { D.x = 0; D.y = 0; D.z = 0; }
}
/* The heart: apply one dab. c/n in local space; g is the local grab delta.
   Symmetry mirrors the whole dab across local X (second dab at -cx). */
function sculptApplyDab(c, n, g) {
  const mesh = sculpt.mesh;
  if (!mesh) return;
  const posA = mesh.geometry.attributes.position;
  const nrmA = mesh.geometry.attributes.normal;
  const arr = posA.array, nrm = nrmA ? nrmA.array : null;
  const count = posA.count;
  const r = sculptLocalRadius();
  const brush = sculpt.brush;
  let inten = sculpt.intensity;
  if (sculpt.invert && brush !== 'smooth' && brush !== 'grab') inten = -inten;
  const kClay = 0.11 * inten;
  const kSmooth = 0.55 * Math.abs(inten);
  const cx = c.x, cy = c.y, cz = c.z;
  const nx = n.x, ny = n.y, nz = n.z;
  const gM = g ? { x: -g.x, y: g.y, z: g.z } : null;
  for (let i = 0; i < count; i++) {
    const vi = i * 3;
    const px = arr[vi], py = arr[vi + 1], pz = arr[vi + 2];
    let dx = px - cx, dy = py - cy, dz = pz - cz;
    const d1 = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const f1 = d1 < r ? (Math.cos(Math.PI * d1 / r) + 1) * 0.5 : 0;
    let f2 = 0;
    if (sculpt.sym) {
      dx = px + cx; dy = py - cy; dz = pz - cz;
      const d2 = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d2 < r) f2 = (Math.cos(Math.PI * d2 / r) + 1) * 0.5;
    }
    if (f1 === 0 && f2 === 0) continue;
    let ox = 0, oy = 0, oz = 0;
    if (f1 > 0) {
      sculptDispInto(brush, cx, cy, cz, nx, ny, nz, px, py, pz, vi, arr, nrm, kClay, kSmooth, inten, g);
      ox += _scD.x * f1; oy += _scD.y * f1; oz += _scD.z * f1;
    }
    if (f2 > 0) {
      sculptDispInto(brush, -cx, cy, cz, -nx, ny, nz, px, py, pz, vi, arr, nrm, kClay, kSmooth, inten, gM);
      ox += _scD.x * f2; oy += _scD.y * f2; oz += _scD.z * f2;
    }
    arr[vi] = px + ox; arr[vi + 1] = py + oy; arr[vi + 2] = pz + oz;
  }
  posA.needsUpdate = true;
}
function sculptTouchNormals(force) {
  if (!sculpt.mesh) return;
  const now = performance.now();
  if (!force && now - sculpt.lastNormalAt < 90) return;
  sculpt.lastNormalAt = now;
  try {
    sculpt.mesh.geometry.computeVertexNormals();
    sculpt.mesh.geometry.attributes.normal.needsUpdate = true;
  } catch (e) {}
}

/* ---------- strokes ---------- */
function sculptBeginStroke(hit) {
  const mesh = sculpt.mesh;
  if (!mesh || !hit) return false;
  sculptUndoPush();
  const local = mesh.worldToLocal(hit.point.clone());
  const n = hit.face && hit.face.normal ? hit.face.normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const st = { last: local, lastN: n, plane: null, lastPlanePt: null, brush: sculpt.brush };
  if (sculpt.brush === 'grab') {
    camera.getWorldDirection(_scA);
    st.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(_scA.clone(), hit.point);
    st.lastPlanePt = hit.point.clone();
  }
  sculpt.stroke = st;
  sculptApplyDab(local, n, null); // a tap still makes a mark
  sculptTouchNormals(false);
  return true;
}
function sculptStrokeTo(nx, ny) {
  const st = sculpt.stroke;
  if (!st || !sculpt.mesh) return false;
  _raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const hits = _raycaster.intersectObject(sculpt.mesh, false);
  if (!hits.length) return false; // dragged off the clay — the stroke stays alive
  const hit = hits[0];
  const local = sculpt.mesh.worldToLocal(hit.point.clone());
  const n = hit.face && hit.face.normal ? hit.face.normal.clone().normalize() : st.lastN;
  let g = null;
  if (st.brush === 'grab' && st.plane && _raycaster.ray.intersectPlane(st.plane, _scB)) {
    _scC.copy(_scB).sub(st.lastPlanePt);
    st.lastPlanePt.copy(_scB);
    sculpt.mesh.getWorldQuaternion(_scQ).invert();
    g = _scC.applyQuaternion(_scQ).divideScalar(Math.max(0.05, sculpt.mesh.scale.x));
  }
  // dab spacing: walk the segment so fast drags can't skip
  const r = sculptLocalRadius();
  const step = Math.max(0.03, r * 0.3);
  const dist = st.last.distanceTo(local);
  const steps = Math.max(1, Math.min(32, Math.floor(dist / step)));
  const gd = g ? g.clone().multiplyScalar(1 / steps) : null;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    _scA.copy(st.last).lerp(local, t);
    _scB.copy(st.lastN).lerp(n, t).normalize();
    sculptApplyDab(_scA, _scB, gd);
  }
  st.last.copy(local);
  st.lastN.copy(n);
  sculptTouchNormals(false);
  return true;
}
function sculptEndStroke() {
  if (!sculpt.stroke) return;
  sculpt.stroke = null;
  sculpt.strokeCount++;
  sculptTouchNormals(true);
  sculptPersistPiece();
  sculptRenderUndo();
}
function sculptUndoPush() {
  if (!sculpt.mesh) return;
  sculpt.undo.push(sculpt.mesh.geometry.attributes.position.array.slice());
  if (sculpt.undo.length > 12) sculpt.undo.shift();
}
function sculptUndo() {
  if (!sculpt.active || !sculpt.mesh || !sculpt.undo.length) return false;
  const snap = sculpt.undo.pop();
  const posA = sculpt.mesh.geometry.attributes.position;
  if (snap.length !== posA.array.length) return false; // topology changed — can't restore
  posA.array.set(snap);
  posA.needsUpdate = true;
  sculptTouchNormals(true);
  sculptPersistPiece();
  sculptRenderUndo();
  return true;
}
/* The piece remembers its clay: detail + displaced verts live on the piece
   so workbench undo, save/load and the stage builder all round-trip it. */
function sculptPersistPiece() {
  const p = wsFind(sculpt.pieceId);
  if (!p || !sculpt.mesh) return;
  try {
    p.sculpt = { detail: sculpt.detail, v: sculptF32ToB64(sculpt.mesh.geometry.attributes.position.array) };
  } catch (e) { /* quota pressure surfaces at save time */ }
}

/* ---------- session ---------- */
function sculptEnter() {
  if (sculpt.active) return true;
  if (!active || active.key !== WORKSHOP_ROOM_KEY || !wsGroup) return false;
  const p = wsFind(ws.sel);
  if (!p) { addSystemLine('tap a piece first, then hit sculpt'); return false; }
  wsPushUndo();
  const detail = (p.sculpt && SCULPT_DETAIL[p.sculpt.detail]) ? p.sculpt.detail : 'med';
  let geo = (p.sculpt && p.sculpt.v) ? sculptGeoFromData(p.type, detail, p.sculpt.v) : null;
  if (!geo) geo = sculptBaseGeo(p.type, detail);
  try { p.mesh.geometry.dispose(); } catch (e) {}
  p.mesh.geometry = geo;
  sculpt.active = true;
  sculpt.pieceId = p.id;
  sculpt.ptype = p.type;
  sculpt.mesh = p.mesh;
  sculpt.detail = detail;
  sculpt.stroke = null; sculpt.strokeId = null;
  sculpt.undo = []; sculpt.strokeCount = 0;
  sculpt.pointers.clear();
  sculpt.orbiting = null; sculpt.orbitLast = null;
  sculpt.pinching = false; sculpt.pinchDist = 0;
  sculpt.mouseDown = false; sculpt.mouseRole = null;
  sculpt.neighbors = sculptBuildNeighbors(geo);
  sculpt.base = geo.attributes.position.array.slice(); // build 68: displacement baseline
  const wp = new THREE.Vector3();
  p.mesh.getWorldPosition(wp);
  sculpt.orbit.target.copy(wp);
  _scA.copy(camera.position).sub(wp);
  const len = _scA.length() || 7;
  sculpt.orbit.radius = Math.max(3.5, Math.min(18, len));
  sculpt.orbit.theta = Math.atan2(_scA.x, _scA.z);
  sculpt.orbit.phi = Math.max(0.2, Math.min(Math.PI - 0.2,
    Math.acos(Math.max(-1, Math.min(1, _scA.y / len)))));
  chatFocused = true; // keys never fly the wisp mid-sculpt (same guard as paint/jam)
  sculptSetHud(true);
  sculptRenderUI();
  return true;
}
function sculptExit() {
  if (!sculpt.active) return;
  if (sculpt.stroke) sculptEndStroke();
  sculptPersistPiece();
  sculpt.active = false;
  sculpt.pieceId = null; sculpt.mesh = null;
  sculpt.stroke = null; sculpt.strokeId = null;
  sculpt.undo = []; sculpt.neighbors = null;
  sculpt.pointers.clear();
  sculpt.orbiting = null; sculpt.orbitLast = null;
  sculpt.pinching = false; sculpt.mouseDown = false; sculpt.mouseRole = null;
  chatFocused = false;
  sculptSetHud(false);
  wsRenderPieces(); wsRenderEdit();
}
function sculptSetBrush(b) {
  if (!SCULPT_BRUSHES.includes(b)) return false;
  sculpt.brush = b;
  sculptRenderUI();
  return true;
}
function sculptSetDetail(d) {
  if (!sculpt.active || !SCULPT_DETAIL[d] || d === sculpt.detail) return false;
  // a detail change re-subdivides, which resets the clay — the bench undo
  // snapshot below (with the current verts) brings it all back in one tap
  sculptPersistPiece();
  wsPushUndo();
  const old = sculpt.mesh.geometry;
  const geo = sculptBaseGeo(sculpt.ptype, d);
  sculpt.mesh.geometry = geo;
  try { old.dispose(); } catch (e) {}
  sculpt.detail = d;
  sculpt.neighbors = sculptBuildNeighbors(geo);
  sculpt.base = geo.attributes.position.array.slice(); // fresh baseline for the new topology
  sculpt.undo = [];
  sculpt.stroke = null; sculpt.strokeId = null;
  sculptPersistPiece();
  sculptTouchNormals(true);
  sculptRenderUI();
  return true;
}
function sculptSetSym(v) {
  sculpt.sym = v == null ? !sculpt.sym : !!v;
  sculptRenderUI();
  return sculpt.sym;
}
function sculptSetInvert(v) {
  sculpt.invert = v == null ? !sculpt.invert : !!v;
  sculptRenderUI();
  return sculpt.invert;
}

/* ---------- picking ---------- */
function sculptNdcFromClient(cx, cy) {
  return { x: (cx / window.innerWidth) * 2 - 1, y: -(cy / window.innerHeight) * 2 + 1 };
}
function sculptPickNdc(nx, ny) {
  if (!sculpt.active || !sculpt.mesh) return null;
  _raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const hits = _raycaster.intersectObject(sculpt.mesh, false);
  return hits.length ? hits[0] : null;
}

/* ---------- camera: orbit the clay ---------- */
function sculptOrbitBy(dx, dy) {
  const o = sculpt.orbit;
  o.theta -= dx * 0.0085;
  o.phi = Math.max(0.12, Math.min(Math.PI - 0.12, o.phi - dy * 0.0085));
}
function sculptCameraUpdate() {
  const o = sculpt.orbit, t = o.target;
  const sp = Math.sin(o.phi);
  camera.position.set(
    t.x + o.radius * sp * Math.sin(o.theta),
    t.y + o.radius * Math.cos(o.phi),
    t.z + o.radius * sp * Math.cos(o.theta)
  );
  camera.lookAt(t);
}

/* ---------- touch: clay on the model, orbit on the background ---------- */
function sculptTouchStart(e) {
  if (!sculpt.active) return false;
  for (const t of e.changedTouches) {
    if (!sculpt.pointers.has(t.identifier)) {
      sculpt.pointers.set(t.identifier, { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY });
    }
  }
  if (sculpt.pointers.size === 1) {
    const t = e.changedTouches[0];
    const n = sculptNdcFromClient(t.clientX, t.clientY);
    const hit = sculptPickNdc(n.x, n.y);
    if (hit && sculptBeginStroke(hit)) sculpt.strokeId = t.identifier;
    else sculpt.orbiting = t.identifier;
  } else if (sculpt.pointers.size === 2) {
    if (sculpt.stroke) { sculptEndStroke(); sculpt.strokeId = null; }
    sculpt.orbiting = null;
    const pts = [...sculpt.pointers.values()];
    sculpt.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    sculpt.pinching = true;
  }
  return true;
}
function sculptTouchMove(e) {
  if (!sculpt.active) return false;
  for (const t of e.changedTouches) {
    const rec = sculpt.pointers.get(t.identifier);
    if (rec) { rec.x = t.clientX; rec.y = t.clientY; }
  }
  if (sculpt.pinching && sculpt.pointers.size >= 2) {
    const pts = [...sculpt.pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (d > 12 && sculpt.pinchDist > 12) {
      sculpt.orbit.radius = Math.max(2.2, Math.min(26, sculpt.orbit.radius * sculpt.pinchDist / d));
    }
    sculpt.pinchDist = d;
  } else if (sculpt.stroke && sculpt.strokeId != null) {
    const rec = sculpt.pointers.get(sculpt.strokeId);
    if (rec) { const n = sculptNdcFromClient(rec.x, rec.y); sculptStrokeTo(n.x, n.y); }
  } else if (sculpt.orbiting != null) {
    const rec = sculpt.pointers.get(sculpt.orbiting);
    if (rec) {
      sculptOrbitBy(rec.x - rec.lx, rec.y - rec.ly);
      rec.lx = rec.x; rec.ly = rec.y;
    }
  }
  return true;
}
function sculptTouchEnd(e) {
  if (!sculpt.active) return false;
  for (const t of e.changedTouches) sculpt.pointers.delete(t.identifier);
  if (sculpt.stroke && (sculpt.strokeId == null || !sculpt.pointers.has(sculpt.strokeId))) {
    sculptEndStroke(); sculpt.strokeId = null;
  }
  if (sculpt.pinching && sculpt.pointers.size < 2) {
    sculpt.pinching = false;
    const ent = [...sculpt.pointers.entries()][0];
    if (ent) { sculpt.orbiting = ent[0]; ent[1].lx = ent[1].x; ent[1].ly = ent[1].y; }
    else sculpt.orbiting = null;
  }
  if (sculpt.orbiting != null && !sculpt.pointers.has(sculpt.orbiting)) sculpt.orbiting = null;
  return true;
}
/* ---------- mouse (desktop + headless tests) ---------- */
function sculptMouseDown(e) {
  const n = sculptNdcFromClient(e.clientX, e.clientY);
  const hit = sculptPickNdc(n.x, n.y);
  sculpt.mouseDown = true;
  if (hit && sculptBeginStroke(hit)) sculpt.mouseRole = 'stroke';
  else { sculpt.mouseRole = 'orbit'; sculpt.orbitLast = { x: e.clientX, y: e.clientY }; }
}
function sculptMouseMove(e) {
  if (!sculpt.mouseDown) return;
  if (sculpt.mouseRole === 'stroke') {
    const n = sculptNdcFromClient(e.clientX, e.clientY);
    sculptStrokeTo(n.x, n.y);
  } else if (sculpt.orbitLast) {
    sculptOrbitBy(e.clientX - sculpt.orbitLast.x, e.clientY - sculpt.orbitLast.y);
    sculpt.orbitLast = { x: e.clientX, y: e.clientY };
  }
}
function sculptMouseUp() {
  if (sculpt.stroke) sculptEndStroke();
  sculpt.mouseDown = false; sculpt.mouseRole = null; sculpt.orbitLast = null;
}

/* ---------- HUD ---------- */
function sculptSetHud(show) {
  if (sculptHud) sculptHud.style.display = show ? '' : 'none';
  if (workshopPanel) workshopPanel.style.display = show ? 'none' : (ws.open ? '' : 'none');
}
function sculptRenderUI() {
  const p = wsFind(sculpt.pieceId);
  if (scNameEl) scNameEl.textContent = p ? `${p.type} — sculpt` : 'sculpt';
  if (scBrushesEl) scBrushesEl.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('sel', b.dataset.brush === sculpt.brush));
  if (scDetailEl) scDetailEl.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('sel', b.dataset.detail === sculpt.detail));
  if (scSymEl) scSymEl.classList.toggle('on', sculpt.sym);
  if (scInvertEl) scInvertEl.classList.toggle('on', sculpt.invert);
  sculptRenderUndo();
}
function sculptRenderUndo() {
  if (scUndoEl) scUndoEl.classList.toggle('off', !sculpt.undo.length);
}
/* Test seam: per-side displacement stats vs the detail baseline. */
function sculptDispStats() {
  if (!sculpt.active || !sculpt.mesh || !sculpt.base) return null;
  const arr = sculpt.mesh.geometry.attributes.position.array;
  const base = sculpt.base;
  if (arr.length !== base.length) return null;
  let moved = 0, leftMoved = 0, rightMoved = 0;
  for (let i = 0; i < arr.length; i += 3) {
    const dx = arr[i] - base[i], dy = arr[i + 1] - base[i + 1], dz = arr[i + 2] - base[i + 2];
    if (dx * dx + dy * dy + dz * dz > 1e-10) {
      moved++;
      if (base[i] < -0.05) leftMoved++;
      else if (base[i] > 0.05) rightMoved++;
    }
  }
  return { moved, leftMoved, rightMoved };
}
/* Test seam: drag a stroke through NDC space on the real stroke path. */
function sculptChecksum() {
  if (!sculpt.mesh) return 'none';
  const arr = sculpt.mesh.geometry.attributes.position.array;
  let s = 0;
  for (let i = 0; i < arr.length; i += 7) s += arr[i];
  return s.toFixed(3);
}
function sculptNdcStroke(x1, y1, x2, y2, steps) {
  if (!sculpt.active) return { ok: false, why: 'inactive' };
  const hit = sculptPickNdc(x1, y1);
  if (!hit) return { ok: false, why: 'miss' };
  const before = sculptChecksum();
  sculptBeginStroke(hit);
  const n = Math.max(1, Math.min(40, steps | 0 || 10));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    sculptStrokeTo(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
  }
  sculptEndStroke();
  return { ok: true, moved: sculptChecksum() !== before };
}

if (wsSculptEl) wsSculptEl.addEventListener('click', () => { sculptEnter(); wsSculptEl.blur(); });
if (scBrushesEl) scBrushesEl.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => { sculptSetBrush(b.dataset.brush); b.blur(); });
});
if (scDetailEl) scDetailEl.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => { sculptSetDetail(b.dataset.detail); b.blur(); });
});
if (scSizeEl) scSizeEl.addEventListener('input', () => { sculpt.size = Math.max(0.08, (+scSizeEl.value || 55) / 100); });
if (scIntEl) scIntEl.addEventListener('input', () => { sculpt.intensity = Math.max(0.05, Math.min(1, (+scIntEl.value || 50) / 100)); });
if (scSymEl) scSymEl.addEventListener('click', () => { sculptSetSym(); scSymEl.blur(); });
if (scInvertEl) scInvertEl.addEventListener('click', () => { sculptSetInvert(); scInvertEl.blur(); });
if (scUndoEl) scUndoEl.addEventListener('click', () => { sculptUndo(); scUndoEl.blur(); });
if (scDoneEl) scDoneEl.addEventListener('click', () => { sculptExit(); scDoneEl.blur(); });
if (workshopBtn) workshopBtn.addEventListener('click', () => { setWorkshopPanel(!ws.open); workshopBtn.blur(); });
if (workshopCloseBtn) workshopCloseBtn.addEventListener('click', () => setWorkshopPanel(false));
if (wsAddEl) {
  wsAddEl.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => { wsAdd(b.dataset.prim); b.blur(); });
  });
}
if (wsUndoEl) wsUndoEl.addEventListener('click', () => { wsUndo(); wsRenderEdit(); wsUndoEl.blur(); });
if (wsDeleteEl) wsDeleteEl.addEventListener('click', () => { wsDelete(); wsDeleteEl.blur(); });
if (wsSaveEl) wsSaveEl.addEventListener('click', () => { wsSaveModel(); wsSaveEl.blur(); });
for (const el of [wsXEl, wsYEl, wsZEl, wsRotEl, wsSizeEl, wsColorEl]) {
  if (!el) continue;
  el.addEventListener('pointerdown', wsArmUndo);
  el.addEventListener('input', () => { wsApplyEdit(); });
  el.addEventListener('change', () => { ws.undoArmed = false; });
}

/* ---------------- the stage builder (build 66) ----------------
   In the jam UI: saved models (built ONLY in the model room — no
   modeling here) drop onto the sound room stage in front of the DJ
   booth. The layout persists and rides to everyone in the room. */
const stage = {
  items: [], // {id, model, p:[x,y,z], ry, s}
  sel: null,
  nextId: 1,
};
const STAGE_MAX_ITEMS = 24;

const jamStageModelsEl = document.getElementById('jam-stage-models');
const jamStagePlacedEl = document.getElementById('jam-stage-placed');
const jamStageEditEl = document.getElementById('jam-stage-edit');
const jamStageEditNameEl = document.getElementById('jam-stage-edit-name');
const jamStageXEl = document.getElementById('jam-stage-x');
const jamStageYEl = document.getElementById('jam-stage-y');
const jamStageZEl = document.getElementById('jam-stage-z');
const jamStageRotEl = document.getElementById('jam-stage-rot');
const jamStageSizeEl = document.getElementById('jam-stage-size');
const jamStageDeleteEl = document.getElementById('jam-stage-delete');
const jamStageClearEl = document.getElementById('jam-stage-clear');

function stagePersist() {
  try { localStorage.setItem('limbo_stage_v1', JSON.stringify(stage.items)); } catch (e) {}
}
function stageLoad() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('limbo_stage_v1') || '[]'); } catch (e) {}
  stage.items = (Array.isArray(list) ? list : []).map(stageSanitizeItem).filter(Boolean);
  stage.sel = null;
  stage.nextId = stage.items.reduce((m, it) => Math.max(m, it.id || 0), 0) + 1;
}
function stageSanitizeItem(it) {
  if (!it || typeof it !== 'object' || typeof it.model !== 'string') return null;
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const p = Array.isArray(it.p) ? it.p : [0, 0, 0];
  return {
    id: Math.max(1, Math.round(num(it.id, 0)) || 0),
    model: it.model.slice(0, 24),
    p: [num(p[0], 0), num(p[1], 0), num(p[2], 0)],
    ry: num(it.ry, 0),
    s: Math.max(0.05, Math.min(8, num(it.s, 1))),
  };
}
function stageGroup() {
  return worlds && worlds.soundroom && worlds.soundroom.anim
    ? worlds.soundroom.anim.stageGroup : null;
}
/* Rebuild the 3D stage from the layout. */
function stageRebuild() {
  const g = stageGroup();
  if (!g) return;
  modelDisposeGroup(g);
  const models = wsLoadModels();
  for (const it of stage.items) {
    const specs = models[it.model];
    if (!Array.isArray(specs) || !specs.length) continue; // model deleted — skip
    const item = new THREE.Group();
    for (const spec of specs) {
      const s = wsSanitizeSpec(spec);
      if (!s) continue;
      // build 68: sculpted pieces keep their clay on stage
      let mesh = (s.v && s.detail) ? sculptMeshFromSpec(s) : null;
      if (!mesh) mesh = modelPieceMesh(s.t, s.c);
      mesh.position.set(s.p[0], s.p[1], s.p[2]);
      mesh.rotation.y = s.ry;
      mesh.scale.setScalar(s.s);
      item.add(mesh);
    }
    item.position.set(it.p[0], it.p[1], it.p[2]);
    item.rotation.y = it.ry;
    item.scale.setScalar(it.s);
    g.add(item);
  }
}
function stageFind(id) { return stage.items.find((it) => it.id === id) || null; }
function stagePlace(modelName, quiet) {
  if (stage.items.length >= STAGE_MAX_ITEMS) {
    addSystemLine('the stage is full — remove something first');
    return false;
  }
  const models = wsLoadModels();
  if (!models[modelName] || !models[modelName].length) return false;
  const it = {
    id: stage.nextId++, model: modelName,
    p: [0, 0, 0], ry: 0, s: 1,
  };
  stage.items.push(it);
  stage.sel = it.id;
  stagePersist();
  stageRebuild();
  stageRenderPlaced();
  stageRenderEdit();
  if (!quiet) stageBroadcast();
  return true;
}
function stageSelect(id) {
  stage.sel = stageFind(id) ? id : null;
  stageRenderPlaced();
  stageRenderEdit();
}
function stageApplyEdit() {
  const it = stageFind(stage.sel);
  if (!it || !jamStageXEl) return false;
  it.p = [+jamStageXEl.value, +jamStageYEl.value, +jamStageZEl.value];
  it.ry = (+jamStageRotEl.value * Math.PI) / 180;
  it.s = Math.max(0.05, +jamStageSizeEl.value / 100);
  stagePersist();
  stageRebuild();
  return true;
}
function stageDelete(quiet) {
  const it = stageFind(stage.sel);
  if (!it) return false;
  stage.items = stage.items.filter((q) => q.id !== it.id);
  stage.sel = null;
  stagePersist();
  stageRebuild();
  stageRenderPlaced();
  stageRenderEdit();
  if (!quiet) stageBroadcast();
  return true;
}
function stageClear(quiet) {
  if (!stage.items.length) return false;
  stage.items = [];
  stage.sel = null;
  stagePersist();
  stageRebuild();
  stageRenderPlaced();
  stageRenderEdit();
  if (!quiet) stageBroadcast();
  return true;
}
/* The room shares one stage: layout changes ride a room broadcast. */
function stageBroadcast() {
  if (net.enabled && net.sendStageSync && active && active.key === SOUND_ROOM_KEY) {
    try { net.sendStageSync({ layout: stage.items }); } catch (e) {}
  }
}
function handleStageSync(peerId, d) {
  if (!d || !Array.isArray(d.layout)) return;
  stage.items = d.layout.map(stageSanitizeItem).filter(Boolean);
  stage.nextId = stage.items.reduce((m, it) => Math.max(m, it.id || 0), 0) + 1;
  stage.sel = null;
  stagePersist();
  stageRebuild();
  stageRenderPlaced();
  stageRenderEdit();
}
function handleStageReq(peerId, d) {
  if (stage.items.length && net.enabled && net.sendStageSync) {
    try { net.sendStageSync({ layout: stage.items }); } catch (e) {}
  }
}
function stageRenderModels() {
  if (!jamStageModelsEl) return;
  jamStageModelsEl.innerHTML = '';
  const names = Object.keys(wsLoadModels()).sort();
  if (!names.length) {
    const d = document.createElement('div');
    d.className = 'jam-stage-empty';
    d.textContent = 'no saved models — build one in the model room';
    jamStageModelsEl.appendChild(d);
    return;
  }
  for (const name of names) {
    const b = document.createElement('button');
    b.textContent = '+ ' + name;
    b.setAttribute('aria-label', `place ${name} on the stage`);
    b.addEventListener('click', () => { stagePlace(name); b.blur(); });
    jamStageModelsEl.appendChild(b);
  }
}
function stageRenderPlaced() {
  if (!jamStagePlacedEl) return;
  jamStagePlacedEl.innerHTML = '';
  if (!stage.items.length) {
    const d = document.createElement('div');
    d.className = 'jam-stage-empty';
    d.textContent = 'the stage is empty';
    jamStagePlacedEl.appendChild(d);
    return;
  }
  for (const it of stage.items) {
    const b = document.createElement('button');
    b.textContent = it.model;
    b.classList.toggle('sel', it.id === stage.sel);
    b.setAttribute('aria-label', `tweak ${it.model} on the stage`);
    b.addEventListener('click', () => { stageSelect(it.id); b.blur(); });
    jamStagePlacedEl.appendChild(b);
  }
}
function stageRenderEdit() {
  const it = stageFind(stage.sel);
  if (jamStageEditEl) jamStageEditEl.hidden = !it;
  if (!it || !jamStageXEl) return;
  jamStageEditNameEl.textContent = it.model;
  jamStageXEl.value = it.p[0];
  jamStageYEl.value = it.p[1];
  jamStageZEl.value = it.p[2];
  jamStageRotEl.value = Math.round(((it.ry * 180) / Math.PI % 360 + 360) % 360);
  jamStageSizeEl.value = Math.round(it.s * 100);
}
if (jamStageDeleteEl) jamStageDeleteEl.addEventListener('click', () => { stageDelete(); jamStageDeleteEl.blur(); });
if (jamStageClearEl) jamStageClearEl.addEventListener('click', () => { stageClear(); jamStageClearEl.blur(); });
for (const el of [jamStageXEl, jamStageYEl, jamStageZEl, jamStageRotEl, jamStageSizeEl]) {
  if (!el) continue;
  el.addEventListener('input', () => { stageApplyEdit(); });
  el.addEventListener('change', () => { stageBroadcast(); }); // one broadcast per gesture
}
/* Stage + FOH sections live only in the sound room. */
function renderJamStageFoh() {
  const inSound = !!(active && active.key === SOUND_ROOM_KEY);
  for (const id of ['jam-stage-sub', 'jam-stage', 'jam-foh-sub', 'jam-foh']) {
    const el = document.getElementById(id);
    if (el) el.style.display = inSound ? '' : 'none';
  }
  if (inSound) { stageRenderModels(); stageRenderPlaced(); stageRenderEdit(); }
}

/* ---------------- front of house (build 66) ----------------
   Lighting + room FX for the sound room: ambient color/glow, two colored
   spotlights, haze color/thickness, strobe, booth glow. Live on the rig,
   persisted, and riding to everyone in the room. */
const FOH_DEFAULTS = {
  ambColor: '#99aacc', ambInt: 0.5,          // matches the room's original look
  spot1: '#ffc24d', spot2: '#ffc24d', spotInt: 1.2,
  fogColor: '#0a0610', fogDensity: 0.012,
  strobe: false, strobeRate: 8,
  glowInt: 0.58,
  touched: false, // the community wall tints the room until FOH is touched
};
const foh = { ...FOH_DEFAULTS };

const fohAmbColorEl = document.getElementById('foh-amb-color');
const fohAmbIntEl = document.getElementById('foh-amb-int');
const fohSpot1El = document.getElementById('foh-spot1');
const fohSpot2El = document.getElementById('foh-spot2');
const fohSpotIntEl = document.getElementById('foh-spot-int');
const fohFogColorEl = document.getElementById('foh-fog-color');
const fohFogDensityEl = document.getElementById('foh-fog-density');
const fohStrobeEl = document.getElementById('foh-strobe');
const fohStrobeRateEl = document.getElementById('foh-strobe-rate');
const fohGlowEl = document.getElementById('foh-glow');
const fohResetEl = document.getElementById('foh-reset');

function fohPersist() {
  try { localStorage.setItem('limbo_foh_v1', JSON.stringify(foh)); } catch (e) {}
}
function fohRestore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('limbo_foh_v1') || 'null'); } catch (e) {}
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(FOH_DEFAULTS)) {
      if (saved[k] !== undefined) foh[k] = saved[k];
    }
  }
  fohSyncUI();
  soundFohApplyLive();
}
/* Push the foh object into the inputs. */
function fohSyncUI() {
  if (!fohAmbColorEl) return;
  fohAmbColorEl.value = foh.ambColor;
  fohAmbIntEl.value = Math.round(foh.ambInt * 100);
  fohSpot1El.value = foh.spot1;
  fohSpot2El.value = foh.spot2;
  fohSpotIntEl.value = Math.round(foh.spotInt * 100);
  fohFogColorEl.value = foh.fogColor;
  fohFogDensityEl.value = Math.round((foh.fogDensity / 0.04) * 100);
  fohStrobeEl.checked = !!foh.strobe;
  fohStrobeRateEl.value = foh.strobeRate;
  fohGlowEl.value = Math.round(foh.glowInt * 100);
}
/* Read the inputs into the foh object. */
function fohReadUI() {
  if (!fohAmbColorEl) return;
  foh.ambColor = fohAmbColorEl.value;
  foh.ambInt = +fohAmbIntEl.value / 100;
  foh.spot1 = fohSpot1El.value;
  foh.spot2 = fohSpot2El.value;
  foh.spotInt = +fohSpotIntEl.value / 100;
  foh.fogColor = fohFogColorEl.value;
  foh.fogDensity = (+fohFogDensityEl.value / 100) * 0.04;
  foh.strobe = !!fohStrobeEl.checked;
  foh.strobeRate = Math.max(1, Math.min(20, +fohStrobeRateEl.value || 8));
  foh.glowInt = +fohGlowEl.value / 100;
  foh.touched = true;
}
function fohApplyPatch(patch, broadcast) {
  if (patch && typeof patch === 'object') Object.assign(foh, patch);
  foh.touched = true;
  fohSyncUI();
  soundFohApplyLive();
  fohPersist();
  if (broadcast) fohBroadcast();
}
function fohReset() {
  Object.assign(foh, FOH_DEFAULTS, { touched: true });
  fohSyncUI();
  soundFohApplyLive();
  fohPersist();
  fohBroadcast();
}
function fohBroadcast() {
  if (net.enabled && net.sendFohSync && active && active.key === SOUND_ROOM_KEY) {
    try { net.sendFohSync({ foh: { ...foh } }); } catch (e) {}
  }
}
function handleFohSync(peerId, d) {
  if (!d || !d.foh || typeof d.foh !== 'object') return;
  for (const k of Object.keys(FOH_DEFAULTS)) {
    if (d.foh[k] !== undefined) foh[k] = d.foh[k];
  }
  foh.touched = true;
  fohSyncUI();
  soundFohApplyLive();
  fohPersist();
}
function handleFohReq(peerId, d) {
  if (foh.touched && net.enabled && net.sendFohSync) {
    try { net.sendFohSync({ foh: { ...foh } }); } catch (e) {}
  }
}
/* FOH wins over the community-wall tint and the idle light code, but only
   once the drifter has touched the board. */
function soundFohApply(anim, t) {
  const f = anim && anim.foh;
  if (!f || !f.touched) return;
  try {
    anim.amb.color.set(f.ambColor);
    anim.lightA.color.set(f.spot1);
    anim.lightB.color.set(f.spot2);
    const bassPulse = 1 + (anim.bass || 0) * 2.2;
    let dim = 1, ambDim = 1;
    if (f.strobe) {
      const on = Math.sin(t * f.strobeRate * Math.PI * 2) > 0;
      dim = on ? 1 : 0.08;
      ambDim = on ? 1 : 0.25;
    }
    anim.amb.intensity = f.ambInt * ambDim;
    anim.lightA.intensity = f.spotInt * bassPulse * dim;
    anim.lightB.intensity = f.spotInt * bassPulse * dim;
    anim.scene.fog.color.set(f.fogColor);
    anim.scene.fog.density = f.fogDensity + (anim.bass || 0) * 0.008;
    anim.boothGlow.material.opacity = 0.15 + f.glowInt * 0.6;
  } catch (e) {}
}
function soundFohApplyLive() {
  const a = worlds && worlds.soundroom && worlds.soundroom.anim;
  if (a) soundFohApply(a, performance.now() / 1000);
}
function fohUiChanged(broadcast) {
  fohReadUI();
  soundFohApplyLive();
  fohPersist();
  if (broadcast) fohBroadcast();
}
for (const el of [fohAmbColorEl, fohAmbIntEl, fohSpot1El, fohSpot2El, fohSpotIntEl,
                  fohFogColorEl, fohFogDensityEl, fohStrobeEl, fohStrobeRateEl, fohGlowEl]) {
  if (!el) continue;
  el.addEventListener('input', () => fohUiChanged(false));   // live, local
  el.addEventListener('change', () => fohUiChanged(true)); // one broadcast per gesture
}
if (fohResetEl) fohResetEl.addEventListener('click', () => { fohReset(); fohResetEl.blur(); });

/* ================= the endless journey (build 33; open field in 36) =================
   Album-release room: free flight like the Nexus across one big open field
   holding four environment zones (mountain, city, desert, digital as regions
   of a single map, not a corridor). Orbs that bunch up fall into a
   migrating-bird V — the furthest-forward orb along the flock's heading
   is the leader at the apex — and the whole flock slipstreams 1.35x faster.

   Music priority: live jukebox > hosted album (assets/album/) > generative
   ambient. Entering a zone cross-fades the scenery, fog and the ambient
   pad's root — drifting into a new land, never a loading screen. */

const J_SLIPSTREAM = 1.35;    // flock speed multiplier — the whole V surges
const J_CRUISE = 8;           // build 49: a whisper of forward drift — flight is
                              // nexus-style free-fly now; you only go where you steer
const J_MIN_Y = 2.5, J_MAX_Y = 60;
const J_FIELD_R = 560;        // hard edge of the open field (safety clamp)
const J_FIELD_SOFT = 440;     // soft push-back begins here — fog wall, never a hard stop
const J_ZONE_BAND = 25;       // hysteresis half-width around zone borders (no flicker)
const J_ZONE_BLEND = 70;      // build 49: half-width of the dissolve band — the
                              // lands bleed into each other across the borders
/* The field is one 1120x1120 map; each quadrant is a zone.
   x<0,z<0 spires · x>0,z<0 city · x<0,z>0 dunes · x>0,z>0 grid */
const J_ZONES = ['spires', 'city', 'dunes', 'grid'];
const J_ZONE_NAME = {
  spires: 'THE SPIRES',
  city: 'THE SLEEPING CITY',
  dunes: 'THE LONG DUNES',
  grid: 'THE GRID',
};
const J_ZONE_ROOT = { spires: 110.0, city: 98.0, dunes: 123.47, grid: 87.31 }; // ambient pad retunes per zone
const J_ZONE_STYLE = {
  spires: { bg: 0x0d1330, fog: 0x1a2456, fogD: 0.010 },
  city:   { bg: 0x05060f, fog: 0x0a0d1f, fogD: 0.014 },
  dunes:  { bg: 0x201009, fog: 0x33200f, fogD: 0.010 },
  grid:   { bg: 0x020208, fog: 0x0a0618, fogD: 0.013 },
};
// build 49: precomputed colors so the border dissolve can mix the lands
for (const _zk of J_ZONES) {
  const _st = J_ZONE_STYLE[_zk];
  _st._bg = new THREE.Color(_st.bg);
  _st._fog = new THREE.Color(_st.fog);
}
const J_HINT = 'DRAG \u2014 STEER \u00b7 LEFT SIDE \u2014 FLY \u00b7 FLY CLOSE, FLOCK FASTER \u00b7 TAP A RAY TO CALL IT \u00b7 THE GATE AT THE CROSSROADS FLIES YOU HOME';
const J_SPAWN = { x: -60, y: 10, z: 140 }; // dunes, facing the crossroads gate

/* Shared materials — built once when the field is built. */

const _jm = {};
function journeyMats() {
  if (_jm.done) return _jm;
  _jm.terrainMtn = new THREE.MeshLambertMaterial({ color: 0x5a6da8, flatShading: true, emissive: 0x11162e });
  _jm.terrainDst = new THREE.MeshLambertMaterial({ color: 0xc08a4a, flatShading: true, emissive: 0x1a0e04 });
  _jm.peak = new THREE.MeshLambertMaterial({ color: 0x2a3560, flatShading: true, emissive: 0x0a0e22 });
  _jm.cityGround = new THREE.MeshLambertMaterial({ color: 0x07080f });
  _jm.rock = new THREE.MeshLambertMaterial({ color: 0x7a5a38, flatShading: true });
  _jm.digitalGround = new THREE.MeshBasicMaterial({ color: 0x020208 });
  _jm.digitalGrid = new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.32 });
  _jm.floater = new THREE.MeshBasicMaterial({ color: 0xffffff });
  // City windows: one shared emissive texture for every building.
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#05060a'; g.fillRect(0, 0, 64, 64);
  const rnd = mulberry32(99);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    g.fillStyle = rnd() < 0.45 ? '#ffd27a' : '#101320';
    g.globalAlpha = rnd() < 0.45 ? 0.95 : 1;
    g.fillRect(4 + x * 7, 4 + y * 7, 4, 4);
  }
  g.globalAlpha = 1;
  const wtex = new THREE.CanvasTexture(c);
  wtex.colorSpace = THREE.SRGBColorSpace;
  _jm.city = new THREE.MeshLambertMaterial({
    color: 0x11141f, emissive: 0xffffff, emissiveMap: wtex, emissiveIntensity: 0.85,
  });
  _jm.done = true;
  return _jm;
}

let _jdummyObj = null; // lazy Object3D for instanced chunk matrices
function _jDummy() {
  if (!_jdummyObj) _jdummyObj = new THREE.Object3D();
  return _jdummyObj;
}

function journeyDisplace(geo, fn) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setY(i, fn(p.getX(i), p.getZ(i)));
  }
  geo.computeVertexNormals();
  return geo;
}

/* ---------------- the open field (build 36) ----------------
   One 1120x1120 map, built once when the room is entered. The four zones
   share the journeyMats() materials; terrain tapers flat at the quadrant
   borders (natural valley passes between the lands) and at the map edge. */

function sstep01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
/* 0 at the quadrant borders and the map edge, 1 deep inside a zone. */
function fieldTaper(x, z) {
  const axis = sstep01(Math.min(Math.abs(x), Math.abs(z)) / 110);
  const edge = 1 - sstep01((Math.hypot(x, z) - 430) / 160);
  return axis * edge;
}

function buildJourneyField() {
  const M = journeyMats();
  const dummy = _jDummy();
  const group = new THREE.Group();
  const Q = 280; // quadrant half-size: 560x560 per zone, map spans ±560

  // --- THE SPIRES (x<0, z<0): rolling peaks ---
  {
    const cx = -Q, cz = -Q;
    const rnd = mulberry32(1101);
    const g = journeyDisplace(
      new THREE.PlaneGeometry(Q * 2, Q * 2, 44, 44).rotateX(-Math.PI / 2),
      (x, z) => fieldTaper(cx + x, cz + z) * (
        Math.sin(x * 0.045 + 1.3) * Math.cos(z * 0.05 + 2.3) * 16
        + Math.sin(x * 0.11 + 1.1) * Math.sin(z * 0.09 + 0.7) * 7
        + Math.sin(x * 0.23 + 3.7) * 2.5));
    const m = new THREE.Mesh(g, M.terrainMtn);
    m.position.set(cx, 0, cz);
    group.add(m);
    for (let pI = 0; pI < 10; pI++) {
      const peak = new THREE.Mesh(new THREE.ConeGeometry(20 + rnd() * 22, 60 + rnd() * 70, 5), M.peak);
      peak.position.set(
        cx + (rnd() < 0.5 ? -1 : 1) * (90 + rnd() * 160),
        24,
        cz + (rnd() < 0.5 ? -1 : 1) * (90 + rnd() * 160));
      group.add(peak);
    }
  }

  // --- THE SLEEPING CITY (x>0, z<0): towers with lit windows ---
  {
    const cx = Q, cz = -Q;
    const rnd = mulberry32(2202);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(Q * 2, Q * 2).rotateX(-Math.PI / 2), M.cityGround);
    ground.position.set(cx, -0.5, cz);
    group.add(ground);
    const N = 110;
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.city, N);
    let placed = 0, guard = 0;
    while (placed < N && guard++ < 1200) {
      const bx = 40 + rnd() * 480;
      const bz = -(40 + rnd() * 480);
      if (Math.hypot(bx, bz) < 110) continue; // crossroads clearing
      const w = 8 + rnd() * 10, dpt = 8 + rnd() * 10, h = 12 + rnd() * 38;
      dummy.position.set(bx, h / 2 - 0.5, bz);
      dummy.scale.set(w, h, dpt);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  // --- THE LONG DUNES (x<0, z>0): wind-shaped sand ---
  {
    const cx = -Q, cz = Q;
    const rnd = mulberry32(3303);
    const g = journeyDisplace(
      new THREE.PlaneGeometry(Q * 2, Q * 2, 40, 40).rotateX(-Math.PI / 2),
      (x, z) => fieldTaper(cx + x, cz + z) * (
        Math.sin(x * 0.03 + 1.7) * Math.sin(z * 0.028 + 0.4) * 8
        + Math.sin(x * 0.08 + 2.9) * 2.6));
    const m = new THREE.Mesh(g, M.terrainDst);
    m.position.set(cx, 0, cz);
    group.add(m);
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.4), M.rock, 26);
    for (let rI = 0; rI < 26; rI++) {
      const s = 0.8 + rnd() * 3;
      dummy.position.set(-(50 + rnd() * 460), s * 0.4, 50 + rnd() * 460);
      dummy.scale.set(s, s * 0.7, s);
      dummy.rotation.set(rnd() * 3, rnd() * 3, 0);
      dummy.updateMatrix();
      rocks.setMatrixAt(rI, dummy.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    group.add(rocks);
  }

  // --- THE GRID (x>0, z>0): neon lattice on black glass ---
  {
    const cx = Q, cz = Q;
    const rnd = mulberry32(4404);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(Q * 2, Q * 2).rotateX(-Math.PI / 2), M.digitalGround);
    ground.position.set(cx, 0, cz);
    group.add(ground);
    const gridGeo = new THREE.WireframeGeometry(new THREE.PlaneGeometry(Q * 2, Q * 2, 28, 28));
    gridGeo.rotateX(-Math.PI / 2);
    const grid = new THREE.LineSegments(gridGeo, M.digitalGrid);
    grid.position.set(cx, 0.3, cz);
    group.add(grid);
    const N = 34;
    const fl = new THREE.InstancedMesh(new THREE.OctahedronGeometry(2.4), M.floater, N);
    const cols = [new THREE.Color(0x00e5ff), new THREE.Color(0xff4fd8), new THREE.Color(0x7a5cff)];
    for (let fI = 0; fI < N; fI++) {
      dummy.position.set(50 + rnd() * 460, 6 + rnd() * 26, 50 + rnd() * 460);
      dummy.scale.setScalar(0.6 + rnd() * 1.6);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      fl.setMatrixAt(fI, dummy.matrix);
      fl.setColorAt(fI, cols[fI % 3]);
    }
    fl.instanceMatrix.needsUpdate = true;
    if (fl.instanceColor) fl.instanceColor.needsUpdate = true;
    group.add(fl);
    journey.floaters = fl; // gentle bob in updateJourney
  }
  return group;
}

/* ---------------- journey state ---------------- */

const journey = {
  field: null,        // the open field group (built once, persists across visits)
  floaters: null,     // grid-zone octahedra, gently bobbed in updateJourney
  zone: null,         // current zone id (spires|city|dunes|grid)
  beacon: null,       // crossroads gate light beam
  assign: null,       // flock hysteresis, fed back into computeFlocks
  inFlock: false,
  myFlockSize: 1,
  mySlot: null,    // my V-slot target (null when I'm the leader)
  flockT: 0, musicT: 0,
  lastSpeed: 0, // wisp speed (test seam reads the slipstream)
  speedLines: null,
  gate: null,
  stars: null,
  lastJukeId: null,
  hintPrev: '',
  rings: null,        // build 41: fly-through speed rings on 3 circuits
  gems: null,         // build 41: boost gems
  rays: null,         // build 49: manta rays — tap one nearby to call it
  boost: 1,           // build 41: proximity-graded speed multiplier
  ringBoost: 0, gemBoost: 0, // decaying bursts
  lastRing: null,     // circuit combo tracking
  mapT: 0,            // minimap redraw throttle
};
const _jTmpA = new THREE.Vector3();
const _jTmpB = new THREE.Vector3();
const _jBgT = new THREE.Color();
const _jFogT = new THREE.Color();

/* Build 41: audio zoning — the jam can be muted in the endless journey
   (the jukebox + voices stay). Persists; the toggle lives in the journey HUD. */
let journeyJamMuted = false;
try { journeyJamMuted = localStorage.getItem('limbo_journey_jammute') === '1'; } catch (e) {}
function journeyJamMuteSet(m) {
  journeyJamMuted = !!m;
  try { localStorage.setItem('limbo_journey_jammute', journeyJamMuted ? '1' : '0'); } catch (e) {}
  try { mixerApplyGains(); } catch (e) {}
  const b = document.getElementById('journey-jammute');
  if (b) {
    b.textContent = journeyJamMuted ? '🔇 jam muted' : '🎶 jam on';
    b.classList.toggle('off', !journeyJamMuted);
    b.setAttribute('aria-pressed', journeyJamMuted ? 'true' : 'false');
  }
}

/* Which zone is (x, z) in? Quadrants; callers apply the J_ZONE_BAND
   hysteresis so the border never flickers. */
function journeyZoneAt(x, z) {
  if (x < 0) return z < 0 ? 'spires' : 'dunes';
  return z < 0 ? 'city' : 'grid';
}

/* The zone banner: a quiet land-name that fades after a few seconds. */
let zoneBannerT = null;
function showZoneName(zone) {
  if (!zoneNameEl) return;
  zoneNameEl.textContent = J_ZONE_NAME[zone] || '';
  zoneNameEl.classList.add('show');
  if (zoneBannerT) clearTimeout(zoneBannerT);
  zoneBannerT = setTimeout(() => zoneNameEl.classList.remove('show'), 2600);
}

/* ---------------- hosted album (build 33) ----------------
   assets/album/album.json: { title, tracks: [{file, title}] }.
   Files sit next to it: assets/album/01-into-the-drift.mp3 …
   The album loops forever on a fixed epoch, so every client plays the
   same track at the same offset — a shared listening party with no
   leader election. Empty/missing folder -> state 'none', fallbacks cover. */
const ALBUM_EPOCH = Date.UTC(2026, 0, 1);
const album = {
  state: 'idle', // idle|loading|ready|none
  title: '', tracks: [], totalMs: 0, el: null, trackIdx: -1, retryT: 0,
};
function albumProbeDuration(url) {
  return new Promise((resolve, reject) => {
    try {
      const a = new Audio();
      a.preload = 'metadata';
      const to = setTimeout(() => { try { a.src = ''; } catch (e) {} reject(new Error('timeout')); }, 8000);
      a.onloadedmetadata = () => { clearTimeout(to); resolve(a.duration || 0); };
      a.onerror = () => { clearTimeout(to); reject(new Error('bad file')); };
      a.src = url;
    } catch (e) { reject(e); }
  });
}
async function albumEnsure() {
  if (album.state !== 'idle') return;
  album.state = 'loading';
  try {
    const r = await fetch('assets/album/album.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('no album.json');
    const m = await r.json();
    const listed = (m && Array.isArray(m.tracks) ? m.tracks : []).filter((t) => t && t.file).slice(0, 32);
    if (!listed.length) throw new Error('no tracks listed');
    album.title = String(m.title || 'the album');
    const probed = await Promise.all(listed.map(async (t) => {
      const secs = await albumProbeDuration('assets/album/' + t.file).catch(() => 0);
      return { file: String(t.file), title: String(t.title || t.file), durationMs: Math.round(secs * 1000) };
    }));
    album.tracks = probed.filter((t) => t.durationMs > 0);
    if (!album.tracks.length) throw new Error('no playable tracks');
    album.totalMs = album.tracks.reduce((s, t) => s + t.durationMs, 0);
    album.el = new Audio();
    album.el.preload = 'auto';
    album.el.volume = 0.85;
    album.state = 'ready';
  } catch (e) { album.state = 'none'; }
}
/* -> {idx, offsetMs, count} or null. count = absolute track number across loops. */
function albumNow() {
  if (album.state !== 'ready' || !album.totalMs) return null;
  const el = Date.now() - ALBUM_EPOCH;
  const pos = ((el % album.totalMs) + album.totalMs) % album.totalMs;
  const loops = Math.floor(el / album.totalMs);
  let acc = 0;
  for (let i = 0; i < album.tracks.length; i++) {
    const d = album.tracks[i].durationMs;
    if (pos < acc + d) return { idx: i, offsetMs: pos - acc, count: loops * album.tracks.length + i };
    acc += d;
  }
  return { idx: 0, offsetMs: 0, count: loops * album.tracks.length };
}
function albumPause() {
  try { if (album.el && !album.el.paused) album.el.pause(); } catch (e) {}
}
function albumPlayTrack(idx, offsetMs) {
  const tr = album.tracks[idx];
  const el = album.el;
  if (!tr || !el) return;
  const same = !!el.src && el.src.endsWith('/' + tr.file);
  const go = () => {
    try { el.currentTime = Math.max(0, offsetMs / 1000); } catch (e) {}
    try {
      const p = el.play();
      if (p && p.catch) p.catch(() => { album.retryT = 5; }); // iOS gesture block: retry soon
    } catch (e) { album.retryT = 5; }
  };
  if (!same) {
    el.src = 'assets/album/' + tr.file;
    el.oncanplay = () => { el.oncanplay = null; go(); };
    try { el.load(); } catch (e) {}
  } else go();
}

/* Music priority: live jukebox > hosted album > generative ambient. */
function journeyMusicTick() {
  const jukeOn = !!(juke.now && !juke.now.stopped);
  if (jukeOn) {
    albumPause();
    audio.setAuraDucked(true);
    return;
  }
  const an = albumNow();
  if (an && album.el) {
    audio.setAuraDucked(true);
    const el = album.el;
    if (album.trackIdx !== an.idx || el.paused) {
      album.trackIdx = an.idx;
      albumPlayTrack(an.idx, an.offsetMs);
    } else {
      // drift correction: if we're >4s off the wall clock, re-seek
      try {
        const off = el.currentTime * 1000;
        if (Math.abs(off - an.offsetMs) > 4000 && an.offsetMs < album.tracks[an.idx].durationMs - 2000) {
          el.currentTime = an.offsetMs / 1000;
        }
      } catch (e) {}
    }
    if (album.retryT > 0 && el.paused) {
      album.retryT -= 0.5;
      if (album.retryT <= 0) albumPlayTrack(album.trackIdx, (albumNow() || an).offsetMs);
    }
    return;
  }
  albumPause();
  audio.setAuraDucked(false); // generative ambient carries the room
}

/* ---------------- like / follow (build 33) ----------------
   P2P likes for the jukebox track, live counts, no persistence.
   The pill only shows while a jukebox track is playing. */
const jukeLikes = new Map(); // trackId -> Set(names)
let jukeLikedNow = null;     // trackId this client liked
function handleJukeLike(cid, d) {
  if (!d || typeof d.trackId !== 'string' || !d.trackId) return;
  const name = String(d.by || 'drifter').slice(0, 16) || 'drifter';
  let s = jukeLikes.get(d.trackId);
  if (!s) { s = new Set(); jukeLikes.set(d.trackId, s); }
  s.add(name);
  if (juke.now && juke.now.id === d.trackId) renderJukeSocial();
}
function jukeSendLike() {
  if (!juke.now || juke.now.stopped) return;
  const id = juke.now.id;
  if (jukeLikedNow === id) return; // one like per track per drifter
  jukeLikedNow = id;
  handleJukeLike(net.clientId || 'self', { trackId: id, by: myName });
  try { if (net.sendJukeLike) net.sendJukeLike({ trackId: id, by: myName }); } catch (e) {}
}
function renderJukeSocial() {
  if (!jukeSocialPill) return;
  const show = !!(active && active.key === JOURNEY_ROOM_KEY && juke.now && !juke.now.stopped);
  jukeSocialPill.style.display = show ? '' : 'none';
  if (!show) return;
  const id = juke.now.id;
  const n = (jukeLikes.get(id) || new Set()).size;
  if (jukeLikeCount) jukeLikeCount.textContent = String(n);
  if (jukeLikeBtn) {
    const liked = jukeLikedNow === id;
    jukeLikeBtn.classList.toggle('liked', liked);
    const tn = jukeLikeBtn.firstChild;
    if (tn) tn.textContent = liked ? '♥ ' : '♡ ';
  }
}

/* ---------------- journey room world ---------------- */

function makeSpeedLines() {
  const N = 120;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 44;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 30;
    pos[i * 3 + 2] = 12 - Math.random() * 112;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xbfefff, size: 0.4, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pts.visible = false;
  pts.frustumCulled = false;
  return pts;
}

function buildJourneyRoom() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1330);
  scene.fog = new THREE.FogExp2(0x1a2456, 0.010);
  scene.add(new THREE.HemisphereLight(0x9db4ff, 0x11122a, 1.25));
  const sun = new THREE.DirectionalLight(0xfff2dd, 0.9);
  sun.position.set(30, 60, 20);
  scene.add(sun);
  const stars = makeStars(500, 120, 260, 1.8, 0xcfe0ff);
  scene.add(stars);
  // The open field: four zones, one map.
  const field = buildJourneyField();
  scene.add(field);
  journey.field = field;
  // The gate home stands at the crossroads (0,0) under a light beacon —
  // visible from anywhere in the field. Fly through it to return.
  const { group, ring } = makePortal(makeJourneyTexture(), JOURNEY_DEF.accent, 'NEXUS', 2.4, 0.18);
  group.position.set(0, 14, 0);
  scene.add(group);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.5, 4.5, 130, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: JOURNEY_DEF.accent, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
    }));
  beam.position.set(0, 65, 0);
  scene.add(beam);
  journey.beacon = beam;
  const portals = [{ group, ring, pos: group.position.clone(), target: 'nexus', phase: 0, baseY: 0 }];
  const speedLines = makeSpeedLines();
  scene.add(speedLines);
  journey.speedLines = speedLines;
  journey.stars = stars;
  journey.gate = portals[0];
  // build 41: rings + gems, built once with the field
  if (!journey.rings) buildJourneyRings(scene);
  else for (const r of journey.rings) { r.cooldown = 0; r.flash = 0; scene.add(r.mesh); }
  if (!journey.gems) buildJourneyGems(scene);
  else for (const g of journey.gems) scene.add(g.mesh);
  // build 49: manta rays, built once with the field
  if (!journey.rays) buildJourneyRays(scene);
  else for (const r of journey.rays) scene.add(r.group);
  // spawn in the dunes, facing the crossroads gate
  const spawnYaw = Math.atan2(-(0 - J_SPAWN.x), -(0 - J_SPAWN.z));
  return {
    key: JOURNEY_ROOM_KEY, name: JOURNEY_DEF.name, root: JOURNEY_DEF.root,
    scene, portals, echoes: [],
    spawn: new THREE.Vector3(J_SPAWN.x, J_SPAWN.y, J_SPAWN.z), spawnYaw,
    bound: 'journey',
    anim: { stars, speedLines },
    attunedShown: true, // n/a: no echoes here
    update(dt, t) { updateJourney(dt, t); },
  };
}

/* ============ build 41: endless journey fun pass ============
   Rings to fly through (speed + path), boost gems, proximity-graded
   speed (not just a binary fast mode), audio-reactive trails, minimap.
   Additive only — the existing field art is untouched. */

/* A tiny game chime that rides audio.master directly — never the jam bus,
   so it sings even when the journey's jam is muted. */
function journeyBlip(freq, dur, vol) {
  try {
    if (!audio.ctx || audio.ctx.state !== 'running') return;
    const t0 = audio.ctx.currentTime;
    const o = audio.ctx.createOscillator();
    const g = audio.ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.18, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.35));
    o.connect(g); g.connect(audio.master);
    o.start(t0); o.stop(t0 + (dur || 0.35) + 0.05);
  } catch (e) {}
}

const J_RING_R = 6.5;          // fly-through detection radius
const J_RING_CIRCUITS = [
  { cx: -220, cz: -220, r: 130, n: 8, y0: 14, yAmp: 6,  color: 0x7ae0ff },
  { cx: 220,  cz: -220, r: 150, n: 8, y0: 18, yAmp: 8,  color: 0xb388ff },
  { cx: 0,    cz: 0,    r: 300, n: 10, y0: 12, yAmp: 10, color: 0xffd97a },
];
function buildJourneyRings(scene) {
  const rings = [];
  for (let c = 0; c < J_RING_CIRCUITS.length; c++) {
    const circ = J_RING_CIRCUITS[c];
    for (let i = 0; i < circ.n; i++) {
      const a = (i / circ.n) * Math.PI * 2;
      const x = circ.cx + Math.cos(a) * circ.r;
      const z = circ.cz + Math.sin(a) * circ.r;
      const y = circ.y0 + Math.sin(a * 2 + c) * circ.yAmp;
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(J_RING_R, 0.55, 10, 36),
        new THREE.MeshBasicMaterial({
          color: circ.color, transparent: true, opacity: 0.75,
          blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      mesh.position.set(x, y, z);
      // face along the circuit tangent — fly the path, thread the rings
      _jTmpA.set(x - Math.sin(a), y, z + Math.cos(a));
      mesh.lookAt(_jTmpA);
      scene.add(mesh);
      rings.push({
        x, y, z, mesh, circuit: c, idx: i,
        cooldown: 0, flash: 0, baseOp: 0.75,
      });
    }
  }
  journey.rings = rings;
}

const J_GEMS_N = 14;
const J_GEM_COLORS = [0xffd97a, 0x7ae0ff, 0xff8ad1, 0x9dff8a];
function journeyGemSpot() {
  const a = Math.random() * Math.PI * 2;
  const r = 60 + Math.random() * 420;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, y: 8 + Math.random() * 22 };
}
function buildJourneyGems(scene) {
  const gems = [];
  for (let i = 0; i < J_GEMS_N; i++) {
    const s = journeyGemSpot();
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(2.2),
      new THREE.MeshBasicMaterial({
        color: J_GEM_COLORS[i % J_GEM_COLORS.length],
        transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    mesh.position.set(s.x, s.y, s.z);
    scene.add(mesh);
    gems.push({
      x: s.x, y: s.y, z: s.z, mesh,
      active: true, respawn: 0, phase: Math.random() * Math.PI * 2,
    });
  }
  journey.gems = gems;
}

/* ---------------- manta rays (build 49) ----------------
   Seven rays glide the open field on lazy seeded circles — the same
   circles on every phone, so multiplayer shares one sky. Tap a ray when
   you're close and it leaves its circle to follow you; tap it again (or
   tap another ray) to let it go. Never automatic — the call is yours. */
const J_RAYS_N = 7;
const J_RAY_TAP_RANGE = 34; // how close you must be to call a ray
const _raycaster = new THREE.Raycaster();
const _raySlot = new THREE.Vector3();
const _rayRight = new THREE.Vector3();
const _rayUp = new THREE.Vector3(0, 1, 0);

function buildJourneyRays(scene) {
  const rnd = mulberry32(4901);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9db8dd, roughness: 0.55, metalness: 0.15,
    emissive: 0x14263f, emissiveIntensity: 0.5,
    flatShading: true, side: THREE.DoubleSide,
  });

  /* Lofted manta wing — real planform (broad root, swept pointed tip),
     cambered airfoil section: round nose, knife trailing edge. */
  function wingGeometry() {
    const SPAN = 9, CHORD = 10;
    const pos = [], idx = [];
    for (let i = 0; i < SPAN; i++) {
      const s = i / (SPAN - 1);                 // 0 root → 1 tip
      const x = 0.5 + s * 8.0;
      const chord = 3.6 * (1 - s * 0.8) + 0.25; // pointed tip
      const zLE = 1.8 - Math.pow(s, 1.6) * 5.2; // leading edge sweeps back
      const dihedral = s * s * 1.4;             // tips lift a touch
      for (let j = 0; j < CHORD; j++) {
        const c = j / (CHORD - 1);              // 0 leading edge → 1 trailing
        const z = zLE - c * chord;
        // NACA-style half-thickness: round nose, thin tail
        const th = 0.11 * chord * (1.4845 * Math.sqrt(c) - 0.63 * c
          - 1.758 * c * c + 1.4215 * c * c * c - 0.5075 * c * c * c * c);
        const camber = 0.05 * chord * Math.sin(Math.PI * c);
        pos.push(x, camber + th + dihedral, z,
                 x, camber - th + dihedral, z);
      }
    }
    for (let i = 0; i < SPAN - 1; i++) {
      for (let j = 0; j < CHORD - 1; j++) {
        const a = (i * CHORD + j) * 2, b = ((i + 1) * CHORD + j) * 2;
        idx.push(a, a + 2, b, b, a + 2, b + 2);         // upper
        idx.push(a + 1, b + 1, a + 3, b + 1, b + 3, a + 3); // lower
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }
  const wingGeo = wingGeometry();

  // body: long diamond hull
  const bodyGeo = new THREE.SphereGeometry(1, 24, 18);
  bodyGeo.scale(1.5, 0.34, 3.0);
  // whip tail: thin tube with a gentle upward S-curve
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.05, -2.8),
    new THREE.Vector3(0, 0.15, -6.0),
    new THREE.Vector3(0, 0.45, -9.5),
    new THREE.Vector3(0, 0.90, -12.5),
  ]);
  const tailGeo = new THREE.TubeGeometry(tailCurve, 12, 0.07, 6, false);
  // dorsal fin: small swept blade
  const dorsalGeo = new THREE.ConeGeometry(0.32, 1.2, 6);
  dorsalGeo.scale(1, 1, 0.35);
  dorsalGeo.rotateX(-0.35);
  dorsalGeo.translate(0, 0.55, -0.8);
  // cephalic fins: the manta's signature curled "horns" at the head
  const cephGeo = new THREE.ConeGeometry(0.30, 1.9, 8);

  const rays = [];
  for (let i = 0; i < J_RAYS_N; i++) {
    const g = new THREE.Group();
    const wingR = new THREE.Mesh(wingGeo, mat);
    const wingL = new THREE.Mesh(wingGeo, mat);
    wingL.scale.x = -1; // mirrored — same flap sign lifts both tips
    const cephL = new THREE.Mesh(cephGeo, mat);
    cephL.rotation.set(Math.PI / 2 + 0.38, 0, 0.55);
    cephL.position.set(0.95, -0.18, 2.9);
    const cephR = new THREE.Mesh(cephGeo, mat);
    cephR.rotation.set(Math.PI / 2 + 0.38, 0, -0.55);
    cephR.position.set(-0.95, -0.18, 2.9);
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(9, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }));
    g.add(new THREE.Mesh(bodyGeo, mat), wingR, wingL,
      new THREE.Mesh(tailGeo, mat), new THREE.Mesh(dorsalGeo, mat),
      cephL, cephR, hit);
    g.scale.setScalar(1.1 + rnd() * 0.7);
    const ray = {
      group: g, wingR, wingL, hit,
      // flight brain: steered velocity toward a wandering sky target
      vel: new THREE.Vector3((rnd() - 0.5) * 30, (rnd() - 0.5) * 6, (rnd() - 0.5) * 30),
      tgt: new THREE.Vector3(),
      yaw: rnd() * Math.PI * 2,
      cruise: 26 + rnd() * 16,
      flap: rnd() * Math.PI * 2,
      flapSpd: 2,
      rollT: 0, rollCd: 8 + rnd() * 24, rollDir: rnd() < 0.5 ? 1 : -1,
      rndState: rnd,
      following: false,
    };
    hit.userData.ray = ray;
    g.rotation.order = 'YXZ';
    g.position.set((rnd() - 0.5) * 700, 60 + rnd() * 120, (rnd() - 0.5) * 700);
    journeyNewRayTarget(ray);
    scene.add(g);
    rays.push(ray);
  }
  journey.rays = rays;
}

/* A ray's next sky target — wide open field, real altitude. */
function journeyNewRayTarget(ray) {
  const r = ray.rndState || Math.random;
  ray.tgt.set((r() - 0.5) * 620, 55 + r() * 140, (r() - 0.5) * 620);
}

function releaseRay(ray) {
  ray.following = false;
  // resume the wander from right here — pick a fresh target ahead of it
  journeyNewRayTarget(ray);
}

function updateJourneyRays(dt, t) {
  if (!journey.rays) return;
  const k = (s) => 1 - Math.exp(-s * dt);
  for (const ray of journey.rays) {
    const g = ray.group;
    let hx, hy, hz, spd;
    if (ray.following) {
      // a slot off the wisp's shoulder — a damped chase, never glued on
      _rayRight.crossVectors(myFwd, _rayUp).normalize();
      _raySlot.copy(wisp.position).addScaledVector(myFwd, -10)
        .addScaledVector(_rayRight, 5);
      _raySlot.y = Math.max(3.5, wisp.position.y + 3.5);
      g.position.lerp(_raySlot, k(1.7));
      _jTmpA.copy(_raySlot).sub(g.position);
      if (_jTmpA.lengthSq() > 0.01) _jTmpA.normalize();
      else _jTmpA.copy(myFwd);
      hx = _jTmpA.x; hy = _jTmpA.y; hz = _jTmpA.z;
      spd = 30;
    } else {
      // steering brain: chase the sky target, bank into every turn
      _jTmpA.copy(ray.tgt).sub(g.position);
      const dist = _jTmpA.length();
      if (dist < 60) journeyNewRayTarget(ray);
      else _jTmpA.multiplyScalar(1 / dist);
      const cruise = ray.cruise * (ray.rollT > 0 ? 1.25 : 1);
      _jTmpB.copy(_jTmpA).multiplyScalar(cruise);
      ray.vel.lerp(_jTmpB, k(1.5));
      // keep them out of the dirt and under the sky's lid
      if (g.position.y < 25) ray.vel.y += 40 * dt;
      if (g.position.y > 220) ray.vel.y -= 40 * dt;
      g.position.addScaledVector(ray.vel, dt);
      const vlen = ray.vel.length() || 1;
      hx = ray.vel.x / vlen; hy = ray.vel.y / vlen; hz = ray.vel.z / vlen;
      spd = vlen;
    }
    // face the heading: yaw toward it, pitch with the climb, bank the turn
    const wantYaw = Math.atan2(hx, hz);
    let dy = wantYaw - ray.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const turn = Math.max(-1, Math.min(1, dy * 2.4));
    ray.yaw += dy * k(4);
    const wantPitch = Math.max(-0.6, Math.min(0.6, -Math.asin(
      Math.max(-1, Math.min(1, hy))) * 0.9));
    const wantBank = Math.max(-0.65, Math.min(0.65, -turn * 0.6));
    // the flourish: every so often a ray rolls clean through a barrel roll
    ray.rollCd -= dt;
    if (ray.rollCd <= 0 && !ray.following && ray.rollT <= 0) {
      ray.rollT = 1.5; ray.rollCd = 14 + (ray.rndState || Math.random)() * 26;
    }
    let roll = 0;
    if (ray.rollT > 0) {
      ray.rollT -= dt;
      roll = (1 - Math.max(0, ray.rollT) / 1.5) * Math.PI * 2 * ray.rollDir;
    }
    g.rotation.y = ray.yaw;
    g.rotation.x += (wantPitch - g.rotation.x) * k(3);
    g.rotation.z += (wantBank + roll - g.rotation.z) * k(5);
    // wings: beat hard on the climb, hold flat on the dive — gliding birds
    const climbing = hy > 0.08 && !ray.following;
    const wantFlapSpd = ray.following ? 3.4 : climbing ? 6.5 : 1.4;
    ray.flapSpd += (wantFlapSpd - ray.flapSpd) * k(2.5);
    ray.flap += ray.flapSpd * dt;
    const amp = ray.following ? 0.4 : climbing ? 0.5 : 0.1;
    const flap = Math.sin(ray.flap) * amp;
    // wingL is mirrored (scale.x = -1), so the same sign lifts both tips
    ray.wingR.rotation.z = flap;
    ray.wingL.rotation.z = flap;
  }
}

/* Tap a ray: raycast the tap through the hit proxies. Only a ray within
   call range answers — anything farther just asks you to drift closer. */
function journeyTapRay(cx, cy) {
  if (!journey.rays || !journey.rays.length) return;
  if (!active || active.key !== JOURNEY_ROOM_KEY || transitioning) return;
  _raycaster.setFromCamera({
    x: (cx / window.innerWidth) * 2 - 1,
    y: -(cy / window.innerHeight) * 2 + 1,
  }, camera);
  const hits = _raycaster.intersectObjects(journey.rays.map((r) => r.hit), false);
  if (!hits.length) return;
  const ray = hits[0].object.userData.ray;
  if (!ray) return;
  if (ray.group.position.distanceTo(wisp.position) > J_RAY_TAP_RANGE) {
    journeyToast('drift closer to call the ray');
    return;
  }
  if (ray.following) {
    releaseRay(ray);
    journeyToast('the ray drifts on');
  } else {
    const cur = journey.rays.find((r) => r.following);
    if (cur) releaseRay(cur);
    ray.following = true;
    journeyToast('the ray follows you — tap it again to let go');
  }
}

let journeyToastT = null;
function journeyToast(msg) {
  const el = document.getElementById('journey-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (journeyToastT) clearTimeout(journeyToastT);
  journeyToastT = setTimeout(() => el.classList.remove('show'), 2200);
}

/* Ring pass / gem pickup: bursts, chimes, combo on the circuit path. */
function journeyRingPass(ring) {
  ring.cooldown = 3;
  ring.flash = 1;
  const now = performance.now() / 1000;
  let combo = 1;
  if (journey.lastRing &&
      journey.lastRing.circuit === ring.circuit &&
      journey.lastRing.idx === (ring.idx + J_RING_CIRCUITS[ring.circuit].n - 1) % J_RING_CIRCUITS[ring.circuit].n &&
      now - journey.lastRing.t < 12) {
    combo = Math.min(journey.lastRing.combo + 1, 8);
  }
  journey.lastRing = { circuit: ring.circuit, idx: ring.idx, t: now, combo };
  journey.ringBoost = Math.min(1.5, 0.65 + combo * 0.12);
  journeyBlip(520 + combo * 60, 0.4, 0.2);
  setTimeout(() => journeyBlip(780 + combo * 60, 0.3, 0.12), 90);
}
function journeyGemGet(gem) {
  gem.active = false;
  gem.mesh.visible = false;
  gem.respawn = 25 + Math.random() * 15;
  journey.gemBoost = Math.min(1.5, (journey.gemBoost || 0) + 0.8);
  journeyBlip(880, 0.25, 0.16);
  setTimeout(() => journeyBlip(1174, 0.35, 0.14), 80);
}

/* Proximity-graded speed: flock slipstream by slot distance, ring/gem
   nearness, drafting off nearby drifters — plus decaying bursts from
   rings and gems. Never just a binary fast mode. */
function journeyBoostCalc(dt) {
  let boost = 1;
  // flock slipstream: the closer to your V slot, the more you surge
  if (journey.inFlock) {
    if (journey.mySlot) {
      const d = Math.hypot(
        wisp.position.x - journey.mySlot.x,
        wisp.position.y - journey.mySlot.y,
        wisp.position.z - journey.mySlot.z
      );
      const prox = Math.max(0, 1 - d / 30);
      boost += (J_SLIPSTREAM - 1) * (0.35 + 0.65 * prox);
    } else {
      boost += (J_SLIPSTREAM - 1) * 0.5; // leading the V still surges a little
    }
  }
  // ring nearness: threading the path pulls you faster
  let ringNear = Infinity;
  if (journey.rings) {
    for (const r of journey.rings) {
      const d = Math.hypot(wisp.position.x - r.x, wisp.position.y - r.y, wisp.position.z - r.z);
      if (d < ringNear) ringNear = d;
    }
  }
  if (ringNear < 45) boost += 0.35 * (1 - ringNear / 45);
  // gem nearness
  let gemNear = Infinity;
  if (journey.gems) {
    for (const g of journey.gems) {
      if (!g.active) continue;
      const d = Math.hypot(wisp.position.x - g.x, wisp.position.y - g.y, wisp.position.z - g.z);
      if (d < gemNear) gemNear = d;
    }
  }
  if (gemNear < 30) boost += 0.15 * (1 - gemNear / 30);
  // drafting: tuck in close behind another drifter
  let peerNear = Infinity;
  try {
    for (const [, v] of peerPositions) {
      const d = Math.hypot(wisp.position.x - v.x, wisp.position.y - v.y, wisp.position.z - v.z);
      if (d < peerNear) peerNear = d;
    }
  } catch (e) {}
  if (peerNear < 30) boost += 0.25 * (1 - peerNear / 30);
  // build 50: drafting a manta ray — tuck in close and it pulls you along;
  // your called ray tows you a little extra
  let rayNear = Infinity;
  let rayTow = false;
  if (journey.rays) {
    for (const r of journey.rays) {
      const d = Math.hypot(wisp.position.x - r.group.position.x,
        wisp.position.y - r.group.position.y, wisp.position.z - r.group.position.z);
      if (d < rayNear) rayNear = d;
      if (r.following && d < 25) rayTow = true;
    }
  }
  if (rayNear < 40) boost += 0.3 * (1 - rayNear / 40);
  if (rayTow) boost += 0.15;
  // bursts decay
  journey.ringBoost = Math.max(0, (journey.ringBoost || 0) - dt * 0.55);
  journey.gemBoost = Math.max(0, (journey.gemBoost || 0) - dt * 0.8);
  boost *= 1 + journey.ringBoost * 0.9 + journey.gemBoost * 0.5;
  const target = Math.min(2.6, boost);
  // build 49: the surge glides in — speed never step-changes
  journey.boost += (target - journey.boost) * (1 - Math.exp(-2.8 * dt));
  return journey.boost;
}

/* Ring/gem per-frame: pass detection, pickups, respawns, shimmer. */
function journeyUpdatePickups(dt, t) {
  if (!journey.rings || !journey.gems) return;
  const px = wisp.position.x, py = wisp.position.y, pz = wisp.position.z;
  for (const r of journey.rings) {
    if (r.cooldown > 0) r.cooldown -= dt;
    r.flash = Math.max(0, r.flash - dt * 2.2);
    const d = Math.hypot(px - r.x, py - r.y, pz - r.z);
    if (d < J_RING_R + 1 && r.cooldown <= 0) journeyRingPass(r);
    // shimmer: breathe near, flash on pass
    const near = d < 45 ? (1 - d / 45) : 0;
    const s = 1 + near * 0.12 + r.flash * 0.55;
    r.mesh.scale.set(s, s, s);
    r.mesh.material.opacity = Math.min(1, r.baseOp + near * 0.2 + r.flash * 0.25);
    r.mesh.rotation.z += dt * (0.4 + near * 1.6);
  }
  for (const g of journey.gems) {
    if (!g.active) {
      g.respawn -= dt;
      if (g.respawn <= 0) {
        const s = journeyGemSpot();
        g.x = s.x; g.y = s.y; g.z = s.z;
        g.mesh.position.set(s.x, s.y, s.z);
        g.active = true; g.mesh.visible = true;
      }
      continue;
    }
    g.mesh.rotation.y += dt * 1.8;
    g.mesh.position.y = g.y + Math.sin(t * 1.7 + g.phase) * 1.2;
    const d = Math.hypot(px - g.mesh.position.x, py - g.mesh.position.y, pz - g.mesh.position.z);
    if (d < 5.5) journeyGemGet(g);
  }
}

/* Minimap: the field, its four lands, the gate home, rings, gems,
   fellow drifters, and you. ~10Hz redraw. */
let journeyMinimapCtx = null;
function journeyMinimapInit() {
  if (journeyMinimapCtx) return;
  const cv = document.getElementById('journey-minimap');
  if (!cv) return;
  journeyMinimapCtx = cv.getContext('2d');
}
const J_MAP_R = 66; // canvas 132px, field radius 560
function journeyMapXY(x, z) {
  const s = J_MAP_R / 560;
  return [66 + x * s, 66 + z * s];
}
function journeyMinimapDraw() {
  const c = journeyMinimapCtx;
  if (!c) return;
  c.clearRect(0, 0, 132, 132);
  // field + four lands
  c.beginPath(); c.arc(66, 66, J_MAP_R, 0, Math.PI * 2);
  c.fillStyle = 'rgba(20, 26, 54, 0.9)'; c.fill();
  const lands = [
    ['rgba(122, 224, 255, 0.10)', 66 - J_MAP_R, 66 - J_MAP_R], // spires x<0,z<0
    ['rgba(179, 136, 255, 0.10)', 66, 66 - J_MAP_R],           // city  x>0,z<0
    ['rgba(255, 217, 122, 0.10)', 66 - J_MAP_R, 66],           // dunes x<0,z>0
    ['rgba(255, 138, 209, 0.10)', 66, 66],                     // grid  x>0,z>0
  ];
  for (const [col, qx, qy] of lands) { c.fillStyle = col; c.fillRect(qx, qy, J_MAP_R, J_MAP_R); }
  c.beginPath(); c.arc(66, 66, J_MAP_R, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(122, 224, 255, 0.35)'; c.stroke();
  // rings
  if (journey.rings) {
    c.fillStyle = 'rgba(122, 224, 255, 0.5)';
    for (const r of journey.rings) {
      const [mx, my] = journeyMapXY(r.x, r.z);
      c.fillRect(mx - 1, my - 1, 2, 2);
    }
  }
  // gems
  if (journey.gems) {
    for (const g of journey.gems) {
      if (!g.active) continue;
      const [mx, my] = journeyMapXY(g.x, g.z);
      c.fillStyle = '#ffd97a';
      c.beginPath(); c.arc(mx, my, 1.8, 0, Math.PI * 2); c.fill();
    }
  }
  // build 49: manta rays — the called one draws a touch bigger
  if (journey.rays) {
    c.fillStyle = 'rgba(157, 184, 221, 0.85)';
    for (const r of journey.rays) {
      const [mx, my] = journeyMapXY(r.group.position.x, r.group.position.z);
      c.beginPath(); c.arc(mx, my, r.following ? 2.8 : 1.6, 0, Math.PI * 2); c.fill();
    }
  }
  // the gate home at the crossroads
  c.fillStyle = '#ffffff';
  c.beginPath(); c.arc(66, 66, 2.6, 0, Math.PI * 2); c.fill();
  // fellow drifters
  try {
    c.fillStyle = 'rgba(122, 224, 255, 0.9)';
    for (const [, v] of peerPositions) {
      const [mx, my] = journeyMapXY(v.x, v.z);
      c.beginPath(); c.arc(mx, my, 2, 0, Math.PI * 2); c.fill();
    }
  } catch (e) {}
  // you, with a heading tick
  const [sx, sy] = journeyMapXY(wisp.position.x, wisp.position.z);
  c.fillStyle = '#ffffff';
  c.beginPath(); c.arc(sx, sy, 3, 0, Math.PI * 2); c.fill();
  const ha = Math.atan2(myFwd.x, -myFwd.z);
  c.strokeStyle = '#ffffff'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(sx, sy);
  c.lineTo(sx + Math.sin(ha) * 7, sy - Math.cos(ha) * 7); c.stroke();
}

function journeyOnEnter() {
  journey.assign = null;
  journey.inFlock = false;
  journey.myFlockSize = 1;
  journey.mySlot = null;
  journey.zone = null; // forces the zone banner + atmo on the first tick
  journey.lastJukeId = null;
  journey.hintPrev = hintEl ? hintEl.textContent : '';
  if (hintEl) hintEl.textContent = J_HINT;
  albumEnsure(); // hosted album, if Joshua has sent tracks
  if (journey.speedLines) journey.speedLines.visible = false;
  // build 41: fresh speed state on every visit
  journey.boost = 1; journey.ringBoost = 0; journey.gemBoost = 0;
  journey.lastRing = null;
}

function journeyOnLeave() {
  albumPause();
  journey.inFlock = false;
  journey.mySlot = null;
  // build 49: a called ray resumes its wander when you leave
  if (journey.rays) for (const r of journey.rays) if (r.following) releaseRay(r);
  try { wispGlow.scale.set(3.2, 3.2, 1); } catch (e) {}
  try { wispCore.rotation.z = 0; } catch (e) {}
  if (zoneNameEl) zoneNameEl.classList.remove('show');
  if (zoneBannerT) { clearTimeout(zoneBannerT); zoneBannerT = null; }
  if (hintEl && journey.hintPrev) hintEl.textContent = journey.hintPrev;
  if (jukeSocialPill) jukeSocialPill.style.display = 'none';
  if (jukeFollowMenu) jukeFollowMenu.style.display = 'none';
}

/* The per-frame journey update: flocking, zones, gate, music. Flight
   itself is the Nexus free-fly model (updatePlayer runs for this room
   too) — the journey adds the endless cruise drift, the V formation
   and the slipstream surge. */
/* The per-frame journey update: flocking, zones, gate, music.
   Flight itself is the Nexus free-fly model (updatePlayer runs for this
   room too) — the journey adds the endless cruise drift, the V formation
   and the slipstream surge. */
function updateJourney(dt, t) {
  const scene = active.scene;
  // --- flock (10Hz is plenty; positions broadcast at 12Hz) ---
  journey.flockT += dt;
  if (journey.flockT >= 0.1) {
    journey.flockT = 0;
    const selfCid = net.clientId || 'self';
    const members = [{
      cid: selfCid,
      x: wisp.position.x, y: wisp.position.y, z: wisp.position.z,
      fx: myFwd.x, fy: myFwd.y, fz: myFwd.z,
    }];
    for (const [cid, v] of peerPositions) {
      const m = { cid, x: v.x, y: v.y, z: v.z };
      const h = peerHeadings.get(cid);
      if (h) { m.fx = h.x; m.fy = h.y; m.fz = h.z; }
      members.push(m);
    }
    // the flock's forward: mean of the broadcast headings (deterministic —
    // every client runs this on the same inputs)
    const heading = meanHeading(members) || { x: 0, y: 0, z: -1 };
    const r = computeFlocks(members, journey.assign, heading);
    journey.assign = r.assign;
    const mine = r.flocks.find((f) => f.slots.has(selfCid) || f.leaderCid === selfCid) || null;
    journey.inFlock = !!mine;
    journey.myFlockSize = mine ? mine.order.length + 1 : 1;
    journey.mySlot = mine ? mine.slots.get(selfCid) || null : null; // leader: no slot
  }
  // gentle pull into the V slot (damped — never snaps, never oscillates)
  if (journey.mySlot) {
    _jTmpA.set(journey.mySlot.x, journey.mySlot.y, journey.mySlot.z);
    wisp.position.lerp(_jTmpA, 1 - Math.exp(-2.2 * dt));
  }
  journey.lastSpeed = vel.length();
  // --- manta rays (build 49): wander or follow, wings beating ---
  updateJourneyRays(dt, t);
  // --- zones: the lands bleed into each other across the borders.
  // Atmo is a continuous distance-weighted blend of the four quadrant
  // styles, so drifting into a new land is a slow dissolve, never a flip.
  // The banner + the pad's retune still fire once, on the dominant land
  // (hysteresis, so the border never flickers).
  const ZB = J_ZONE_BLEND;
  const wx = Math.max(0, Math.min(1, (wisp.position.x + ZB) / (2 * ZB)));
  const wz = Math.max(0, Math.min(1, (wisp.position.z + ZB) / (2 * ZB)));
  _jBgT.setRGB(0, 0, 0);
  _jFogT.setRGB(0, 0, 0);
  let fogD = 0;
  const mixZone = (w, key) => {
    if (!w) return;
    const st = J_ZONE_STYLE[key];
    _jBgT.r += st._bg.r * w; _jBgT.g += st._bg.g * w; _jBgT.b += st._bg.b * w;
    _jFogT.r += st._fog.r * w; _jFogT.g += st._fog.g * w; _jFogT.b += st._fog.b * w;
    fogD += st.fogD * w;
  };
  mixZone((1 - wx) * (1 - wz), 'spires');
  mixZone(wx * (1 - wz), 'city');
  mixZone((1 - wx) * wz, 'dunes');
  mixZone(wx * wz, 'grid');
  const kk = 1 - Math.exp(-1.5 * dt);
  scene.background.lerp(_jBgT, kk);
  scene.fog.color.lerp(_jFogT, kk);
  const rawZone = journeyZoneAt(wisp.position.x, wisp.position.z);
  if (rawZone !== journey.zone) {
    const inBand = Math.abs(wisp.position.x) < J_ZONE_BAND || Math.abs(wisp.position.z) < J_ZONE_BAND;
    if (!inBand || journey.zone === null) {
      journey.zone = rawZone;
      showZoneName(rawZone);
      audio.setRoot(J_ZONE_ROOT[rawZone] || JOURNEY_DEF.root);
    }
  }
  // the fog wall: the world's edge thickens the air before the soft push-back
  const hd = Math.hypot(wisp.position.x, wisp.position.z);
  const edge = sstep01((hd - J_FIELD_SOFT) / (J_FIELD_R - J_FIELD_SOFT));
  const targetD = fogD + edge * 0.022;
  scene.fog.density += (targetD - scene.fog.density) * kk;
  if (journey.stars) journey.stars.position.set(wisp.position.x, 0, wisp.position.z);
  // --- the gate at the crossroads: ring turn + beacon pulse ---
  if (journey.gate) journey.gate.ring.rotation.z += dt * 0.5;
  if (journey.beacon) journey.beacon.material.opacity = 0.10 + 0.05 * Math.sin(t * 2.2);
  if (journey.floaters) journey.floaters.position.y = Math.sin(t * 0.6) * 1.5;
  // --- slipstream visuals: speed lines + brighter trail ---
  const sl = journey.speedLines;
  // build 41: speed lines follow the graded boost, not just the flock flag
  const boostNow = journeyBoostCalc(dt);
  const slOn = boostNow > 1.12 || journey.inFlock;
  if (sl) {
    sl.visible = slOn;
    sl.position.copy(wisp.position);
    sl.rotation.y = yaw; // local -Z lines up with the heading
    if (sl.visible) {
      const p = sl.geometry.attributes.position;
      const arr = p.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 2] += 90 * dt;
        if (arr[i + 2] > 12) {
          arr[i] = (Math.random() - 0.5) * 44;
          arr[i + 1] = (Math.random() - 0.5) * 30;
          arr[i + 2] = -90 - Math.random() * 20;
        }
      }
      p.needsUpdate = true;
      sl.material.opacity = 0.55 + Math.sin(t * 9) * 0.2;
    }
  }
  try {
    const gs = slOn ? 5.4 : 3.2;
    const s = wispGlow.scale.x + (gs - wispGlow.scale.x) * Math.min(1, dt * 5);
    wispGlow.scale.set(s, s, 1);
  } catch (e) {}
  // --- build 41: rings, gems, minimap ---
  journeyUpdatePickups(dt, t);
  journey.mapT += dt;
  if (journey.mapT >= 0.1) {
    journey.mapT = 0;
    try { journeyMinimapDraw(); } catch (e) {}
  }
  // --- music + social, throttled ---
  journey.musicT += dt;
  if (journey.musicT >= 0.5) {
    journey.musicT = 0;
    journeyMusicTick();
    if (juke.now && !juke.now.stopped && juke.now.id !== journey.lastJukeId) {
      journey.lastJukeId = juke.now.id;
      jukeLikedNow = null; // fresh track, fresh likes
    }
    renderJukeSocial();
  }
}

function buildNexus(textures) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020204);
  scene.fog = new THREE.FogExp2(0x050508, 0.01);
  scene.add(new THREE.AmbientLight(0x8899bb, 0.6));

  const starsFar = makeStars(900, 130, 240, 1.6, 0xbfd4ff);
  const starsNear = makeStars(320, 60, 130, 2.4, 0xffffff);
  const dust = makeDust(220, 45, 0x8fa8ff, 0.5);
  scene.add(starsFar, starsNear, dust.pts);

  const portals = [];
  // The 4 realm portals + the sound room portal (build 12) + the endless
  // journey portal (build 33) + the model room portal (build 66).
  const portalDefs = REALM_DEFS.map((def) => ({
    key: def.key, name: def.name, accent: def.accent, tex: textures[def.key],
  })).concat([{
    key: SOUND_DEF.key, name: SOUND_DEF.name, accent: SOUND_DEF.accent,
    tex: makeSoundTexture(),
  }, {
    key: JOURNEY_DEF.key, name: JOURNEY_DEF.name, accent: JOURNEY_DEF.accent,
    tex: makeJourneyTexture(),
  }, {
    key: WORKSHOP_DEF.key, name: WORKSHOP_DEF.name, accent: WORKSHOP_DEF.accent,
    tex: makeWorkshopTexture(),
  }, {
    key: THEATRE_DEF.key, name: THEATRE_DEF.name, accent: THEATRE_DEF.accent,
    tex: makeTheatreTexture(),
  }]);
  portalDefs.forEach((def, i) => {
    const a = (i / portalDefs.length) * Math.PI * 2;
    const { group, ring } = makePortal(def.tex, def.accent, def.name);
    group.position.set(Math.cos(a) * 16, 2.5, Math.sin(a) * 16);
    group.lookAt(0, 2.5, 0);
    scene.add(group);
    portals.push({ group, ring, pos: group.position.clone(), target: def.key, phase: i * 1.7, baseY: 2.5 });
  });

  return {
    key: 'nexus', name: NEXUS_DEF.name, root: NEXUS_DEF.root,
    scene, portals, echoes: [],
    spawn: new THREE.Vector3(0, 2, 0), spawnYaw: -Math.PI / 2, // face first portal (+X)
    bound: 'nexus',
    anim: { starsFar, starsNear, dust },
    attunedShown: true, // n/a in nexus
    update(dt, t) {
      const { starsFar, starsNear, dust } = this.anim;
      starsFar.rotation.y += dt * 0.004;
      starsNear.rotation.y -= dt * 0.007;
      const p = dust.pts.geometry.attributes.position.array;
      for (let i = 0; i < dust.count; i++) {
        p[i * 3 + 1] = dust.base[i * 3 + 1] + Math.sin(t * 0.25 + dust.phase[i]) * 1.6;
        p[i * 3] = dust.base[i * 3] + Math.cos(t * 0.18 + dust.phase[i]) * 1.2;
      }
      dust.pts.geometry.attributes.position.needsUpdate = true;
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.35;
        pt.ring.rotation.z += dt * 0.18;
        pt.pos.copy(pt.group.position); // keep trigger point in sync
      }
    },
  };
}

function buildRealm(def, texture) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020204);
  scene.fog = new THREE.FogExp2(def.fog, 0.012);
  scene.add(new THREE.AmbientLight(0x99aacc, 0.5));

  // The realm: ONE big flat artwork floating in the dark void.
  // Gently bowed (edges recede a touch) for a hint of immersion —
  // never wrapped; the full frame always faces you.
  const aspect = texture.image.width / texture.image.height;
  const ART_W = 76;
  const ART_H = Math.min(ART_W / aspect, 54);
  const artGeo = new THREE.PlaneGeometry(ART_W, ART_H, 64, 1);
  {
    const p = artGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, -0.0022 * x * x);
    }
    artGeo.computeVertexNormals();
  }
  const art = new THREE.Mesh(artGeo, new THREE.MeshBasicMaterial({ map: texture, fog: true }));
  art.position.set(0, 7, -46);
  scene.add(art);

  // Soft backlit halo so the piece glows against the void.
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(ART_W + 12, ART_H + 12),
    new THREE.MeshBasicMaterial({ map: glowTex, color: def.accent, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  halo.position.set(0, 7, -46.9);
  scene.add(halo);

  const dust = makeDust(200, 60, def.accent, 0.6);
  scene.add(dust.pts);

  // 5 echo orbs at deterministic, reachable positions in front of the art.
  const rnd = mulberry32(def.key.length * 31337 + 11);
  const echoes = [];
  const spawn = new THREE.Vector3(0, 2, 22);
  for (let i = 0; i < ECHOES_PER_REALM; i++) {
    let pos;
    for (let tries = 0; tries < 40; tries++) {
      pos = new THREE.Vector3((rnd() - 0.5) * 56, -2 + rnd() * 22, -34 + rnd() * 44);
      if (pos.distanceTo(spawn) > 9) break;
    }
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true })
    );
    mesh.position.copy(pos);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: def.accent, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.scale.set(3.6, 3.6, 1);
    glow.position.copy(pos);
    scene.add(mesh, glow);
    echoes.push({ mesh, glow, basePos: pos.clone(), phase: rnd() * Math.PI * 2, collected: false, burstT: null });
  }

  // Return portal back to the Nexus, off to one side of the artwork.
  const { group, ring } = makePortal(texture, def.accent, 'RETURN', 1.7, 0.14);
  group.position.set(30, 3, -10);
  group.lookAt(0, 5, -30);
  scene.add(group);
  const portals = [{ group, ring, pos: group.position.clone(), target: 'nexus', phase: 0.6, baseY: 3 }];

  return {
    key: def.key, name: def.name, root: def.root,
    scene, portals, echoes,
    spawn, spawnYaw: 0, // face the artwork (-Z)
    bound: 'realm',
    anim: { dust },
    attunedShown: false,
    update(dt, t) {
      const { dust } = this.anim;
      dust.pts.rotation.y += dt * 0.02;
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.3;
        pt.ring.rotation.z -= dt * 0.15;
        pt.pos.copy(pt.group.position);
      }
      let got = 0;
      for (const e of this.echoes) {
        if (e.collected && e.burstT === null) continue;
        if (e.burstT !== null) {
          // pickup burst: scale up + fade out, then vanish
          e.burstT += dt;
          const s = 1 + e.burstT * 7;
          e.mesh.scale.set(s, s, s);
          e.mesh.material.opacity = Math.max(0, 1 - e.burstT / 0.45);
          e.glow.material.opacity = Math.max(0, 0.8 - e.burstT / 0.45);
          if (e.burstT > 0.45) { e.mesh.visible = false; e.glow.visible = false; e.burstT = null; }
          continue;
        }
        got++;
        e.mesh.position.y = e.basePos.y + Math.sin(t * 1.3 + e.phase) * 0.6;
        e.glow.position.y = e.mesh.position.y;
        e.mesh.rotation.y += dt * 0.8;
        e.glow.material.opacity = 0.6 + Math.sin(t * 2.2 + e.phase) * 0.25;
      }
      // "REALM ATTUNED" once all five are gathered
      if (got === 0 && !this.attunedShown) {
        this.attunedShown = true;
        attunedEl.classList.remove('show');
        void attunedEl.offsetWidth; // restart CSS animation
        attunedEl.classList.add('show');
        onRealmAttuned(this.key, this.name); // unlocks: skin + hat thresholds
      }
    },
  };
}

/* ---------------- loading + boot ---------------- */

const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
const textures = {};
const failedTextures = new Set();
for (const def of REALM_DEFS) {
  // onError only marks the failure — the manager still settles the item,
  // so one bad download can never wedge the loading screen forever.
  const tex = loader.load(
    def.file,
    undefined,
    undefined,
    () => failedTextures.add(def.key)
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  textures[def.key] = tex;
}

// Generative stand-in: buildRealm reads texture.image, which is undefined
// when a download fails — substitute so boot can never throw on it.
function makePlaceholderTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 256, 40, 256, 256, 380);
  grad.addColorStop(0, '#241b4d');
  grad.addColorStop(1, '#04040c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let booted = false;
function finishBoot() {
  if (booted) return;
  booted = true;
  clearTimeout(bootTimeout);
  // Anything that failed (or never settled) becomes a placeholder.
  for (const def of REALM_DEFS) {
    if (!textures[def.key].image) textures[def.key] = makePlaceholderTexture();
  }
  try {
    worlds.nexus = buildNexus(textures);
    for (const def of REALM_DEFS) worlds[def.key] = buildRealm(def, textures[def.key]);
    worlds[SOUND_DEF.key] = buildSoundRoom(textures);
    worlds[JOURNEY_DEF.key] = buildJourneyRoom();
    worlds[WORKSHOP_DEF.key] = buildWorkshop();
    worlds[THEATRE_DEF.key] = buildTheatre();
    try { stageLoad(); stageRebuild(); } catch (e) { /* stage starts empty */ }
    try { fohRestore(); } catch (e) { /* FOH starts at defaults */ }
  } catch (err) {
    // Last resort: say so on screen instead of a dead "loading…" hang.
    loadingEl.firstElementChild.textContent = 'limbo failed to wake — reload to try again';
    console.error('[limbo] world build failed:', err);
    return;
  }

  active = worlds.nexus;
  active.scene.add(wisp, localTrail.group, peerLayer);
  wisp.position.copy(active.spawn);
  yaw = active.spawnYaw;
  clearTrail();
  renderRoomChrome(); // sound-room buttons start hidden (we boot in the Nexus)

  loadingEl.classList.add('done');
  driftBtn.disabled = false;
  driftBtn.textContent = 'click to drift';
  // Build 38: boot net NOW (not on the drift tap) so the server picker has
  // live headcounts before the drifter picks. Idempotent — the drift tap
  // re-boots with the real name on the same promise.
  try {
    net.boot((nameInput.value || '').trim() || myName || 'drifter').then((ok) => {
      if (ok) net.joinLobby(); // shared presence room: who's live, where
      renderServerList();
    });
  } catch (e) { renderServerList(); /* solo drift */ }
  requestAnimationFrame(loop);
}
manager.onProgress = (url, loaded, total) => {
  loadingEl.firstElementChild.textContent = `summoning limbo · ${loaded}/${total}`;
};
manager.onError = (url) => console.warn('[limbo] texture failed:', url);
manager.onLoad = finishBoot;
// Safety net: image loads have no timeout, so a stalled connection could
// leave the manager waiting forever — boot anyway after 30s.
const bootTimeout = setTimeout(finishBoot, 30000);

/* ---------------- input: keys ---------------- */

const keys = {};
window.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (e.code === 'Escape' && settingsOpen) { setSettings(false); return; }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // typing in chat / name field
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (e.code === 'KeyM') {
    setMuted(audio.toggleMute());
  }
  if (e.code === 'KeyT' && started && !chatFocused) {
    e.preventDefault();
    chatInput.focus();
  }
  // (build 77: KeyD used to toggle settings AND strafe right — settings
  // opens from the gear button now, so D is just movement again.)
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

/* ---------------- couch co-op (build 34) ----------------
   Offline LAN multiplayer for the no-internet hangout: one Android
   hotspot is the whole network. Ceremony:
     host:  "host a couch game" -> offer QR on screen
     guest: "join a couch game" -> scans it -> answer QR on screen
     host:  "scan guest's code" -> scans the answer -> linked
   Either transport speaks the same game protocol, so realms, jukebox,
   paint, chat and flocking all work unchanged. Online and couch are
   never bridged — entering couch mode leaves the online rooms. */

let couchScanStop = null; // active camera scan session, if any
function couchStopScan() {
  if (couchScanStop) {
    try { couchScanStop(); } catch (e) { /* ignore */ }
    couchScanStop = null;
  }
}
function couchShowScreen(el) {
  couchStopScan();
  for (const s of [couchHome, couchHostScreen, couchHostScanScreen, couchJoinScreen, couchJoinShowScreen]) {
    if (s) s.style.display = (s === el) ? '' : 'none';
  }
  couchPanel.style.display = 'block';
}
function setNetPillVisible(v) {
  const pill = document.getElementById('net-pill');
  if (pill) pill.style.display = v ? '' : 'none';
}
function couchWaitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let v = false;
      try { v = !!fn(); } catch (e) { /* ignore */ }
      if (v) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function enterCouchMode() {
  if (!couchActive) {
    try { onlineNet.leave(); } catch (e) { /* ignore */ }
    try { onlineNet._leaveLobby(); } catch (e) { /* ignore */ }
    couchActive = true;
    setNetPillVisible(false); // the online pill would lie about couch state
    clearPeerVisuals();
    peerPositions.clear(); peerHeadings.clear();
    await couchNet.boot(myName);
    addSystemLine('couch mode — offline LAN. the internet drifters are out of reach for now.');
  }
  couchNet.join(roomKeyFor(active.key)); // tag the current room for filtering
  updatePeerCount();
  renderCouchSection();
}

async function exitCouchMode() {
  if (!couchActive) return;
  couchStopScan();
  couchPanel.style.display = 'none';
  couchNet.shutdown();
  couchActive = false;
  setNetPillVisible(true);
  clearPeerVisuals();
  peerPositions.clear(); peerHeadings.clear();
  renderCouchSection();
  addSystemLine('back online.');
  try {
    const ok = await onlineNet.boot(myName);
    if (ok) {
      onlineNet.setPresence(myName, active.key);
      onlineNet.joinLobby();
      onlineNet.join(roomKeyFor(active.key));
    }
  } catch (e) { /* best effort — offline here just means solo */ }
  updatePeerCount();
}

function renderCouchRoster() {
  const entries = [...couchNet.roster.entries()];
  couchRosterEl.innerHTML = '';
  if (!entries.length) {
    const d = document.createElement('div');
    d.className = 'couch-empty';
    d.textContent = 'nobody yet — show them your code';
    couchRosterEl.appendChild(d);
    return;
  }
  for (const [, p] of entries) {
    const d = document.createElement('div');
    d.className = 'couch-peer';
    d.textContent = '✦ ' + p.name;
    couchRosterEl.appendChild(d);
  }
}

function renderCouchSection() {
  if (couchActive) {
    couchSetRow.style.display = 'none';
    couchSetStatus.style.display = '';
    couchSetStatus.innerHTML = '';
    const n = couchNet.peerCount();
    const t = document.createElement('div');
    t.textContent = `couch mode · ${couchNet.isHost ? 'hosting' : 'linked'} · ${n} drifter${n === 1 ? '' : 's'}`;
    const b = document.createElement('button');
    b.textContent = 'leave couch mode';
    b.onclick = () => { exitCouchMode(); };
    couchSetStatus.appendChild(t);
    couchSetStatus.appendChild(b);
  } else {
    couchSetRow.style.display = '';
    couchSetStatus.style.display = 'none';
    couchSetStatus.innerHTML = '';
  }
}

// Roster changes (pair/leave) refresh the host screen, settings, HUD.
couchNet.onRosterCb = () => {
  renderCouchRoster();
  renderCouchSection();
  updatePeerCount();
};
// The star died with the host — fall back to whatever net exists.
couchNet.onHostGoneCb = () => {
  addSystemLine('the host drifted away — couch over');
  exitCouchMode();
};

async function couchMintOffer() {
  couchHostStatus.textContent = 'making your code…';
  try {
    const payload = await couchNet.createHostOffer();
    CouchNet.qrToCanvas(couchHostQr, payload, 240);
    couchHostStatus.textContent = 'show this code — guests scan it to join';
  } catch (e) {
    couchHostStatus.textContent = "couldn't make a code: " + ((e && e.message) || e);
  }
  renderCouchRoster();
}

async function couchStartHost() {
  await enterCouchMode();
  couchShowScreen(couchHostScreen);
  // Don't mint over an offer that's already up (reopening the panel).
  if (!couchNet._awaitingAnswer) await couchMintOffer();
  else renderCouchRoster();
}

async function couchHostScan() {
  couchShowScreen(couchHostScanScreen);
  couchHostScanStatus.textContent = 'scanning…';
  try {
    const sess = await CouchNet.startScan(couchHostVideo, (payload) => {
      couchAcceptAnswer(payload);
    });
    couchScanStop = sess.stop;
  } catch (e) {
    couchHostScanStatus.textContent = 'camera blocked — check the browser permission';
  }
}

async function couchAcceptAnswer(payload) {
  const dec = CouchNet.decodePayload(payload);
  if (!dec || dec.kind !== 'A') {
    // Not a guest answer — keep the camera up for another try.
    couchHostScanStatus.textContent = "that's not a guest code — try again";
    couchHostScan();
    return;
  }
  couchHostScanStatus.textContent = 'linking…';
  try {
    await couchNet.acceptGuestAnswer(payload);
  } catch (e) {
    couchShowScreen(couchHostScreen);
    couchHostStatus.textContent = "hmm, that code didn't work — " + ((e && e.message) || e);
    return;
  }
  const before = couchNet.peerCount();
  couchShowScreen(couchHostScreen);
  couchHostStatus.textContent = 'linking…';
  const ok = await couchWaitFor(() => couchNet.peerCount() > before, 20000);
  if (ok) {
    const names = [...couchNet.roster.values()].map((p) => p.name);
    const nm = names[names.length - 1] || 'drifter';
    addSystemLine(`✦ ${nm} joined the couch`);
    couchHostStatus.textContent = `✦ ${nm} joined — fresh code below for the next guest`;
    await couchMintOffer(); // strictly one offer per guest; auto-refresh
  } else {
    couchNet.cancelPendingOffer();
    couchHostStatus.textContent = "the link didn't complete — fresh code below, have them re-scan";
    await couchMintOffer();
  }
  updatePeerCount();
}

async function couchStartJoin() {
  await enterCouchMode();
  couchShowScreen(couchJoinScreen);
  couchJoinManual.style.display = 'none';
  couchJoinCode.value = '';
  couchJoinStatus.textContent = "scanning for the host's code…";
  try {
    const sess = await CouchNet.startScan(couchJoinVideo, (payload) => {
      couchAcceptOffer(payload);
    });
    couchScanStop = sess.stop;
  } catch (e) {
    couchJoinStatus.textContent = 'camera blocked — check the permission, or type the code instead';
    couchJoinManual.style.display = '';
  }
}

async function couchAcceptOffer(payload) {
  const dec = CouchNet.decodePayload(payload);
  if (!dec || dec.kind !== 'O') {
    couchJoinStatus.textContent = "that's not a host code — keep scanning";
    couchStartJoin();
    return;
  }
  couchJoinStatus.textContent = 'linking…';
  let answer;
  try {
    answer = await couchNet.acceptHostOffer(payload);
  } catch (e) {
    couchShowScreen(couchJoinScreen);
    couchJoinStatus.textContent = 'hmm — ' + ((e && e.message) || e);
    return;
  }
  try {
    CouchNet.qrToCanvas(couchJoinQr, answer, 240);
  } catch (e) {
    couchShowScreen(couchJoinScreen);
    couchJoinStatus.textContent = "couldn't draw the code — " + ((e && e.message) || e);
    return;
  }
  couchShowScreen(couchJoinShowScreen);
  couchJoinShowStatus.textContent = 'waiting for the host to scan…';
  const ok = await couchWaitFor(() => couchNet.peerCount() > 0, 45000);
  if (ok) {
    couchJoinShowStatus.textContent = "you're in! ✦";
    addSystemLine('you joined the couch — drift together');
    updatePeerCount();
    setTimeout(() => { couchPanel.style.display = 'none'; }, 1600);
  } else {
    couchJoinShowStatus.textContent = "the host hasn't scanned yet — still waiting…";
  }
}

// --- couch panel wiring ---
couchCloseBtn.addEventListener('click', () => {
  couchStopScan();
  couchPanel.style.display = 'none'; // hosting/linking continues in the background
});
couchHostBtn.addEventListener('click', () => { couchStartHost(); });
couchJoinBtn.addEventListener('click', () => { couchStartJoin(); });
couchHostScanBtn.addEventListener('click', () => {
  if (!couchNet._awaitingAnswer) {
    couchHostStatus.textContent = 'your code is above — guests scan it first';
    return;
  }
  couchHostScan();
});
couchHostScanBack.addEventListener('click', () => { couchShowScreen(couchHostScreen); });
couchHostStop.addEventListener('click', () => { exitCouchMode(); });
couchJoinBack.addEventListener('click', () => { couchShowScreen(couchHome); });
couchJoinCancel.addEventListener('click', () => {
  // Linked already? Just close — the link lives on. Otherwise back out.
  if (couchNet.peerCount() > 0) { couchStopScan(); couchPanel.style.display = 'none'; }
  else couchShowScreen(couchJoinScreen);
});
couchJoinManualBtn.addEventListener('click', () => {
  const open = couchJoinManual.style.display !== 'none';
  couchJoinManual.style.display = open ? 'none' : '';
  if (!open) { couchStopScan(); couchJoinStatus.textContent = "paste the host's code below"; }
});
couchJoinCodeBtn.addEventListener('click', () => {
  const code = (couchJoinCode.value || '').trim();
  if (!code) return;
  couchAcceptOffer(code);
});
// Settings panel entry points (next to the friends list).
setCouchHostBtn.addEventListener('click', () => { setSettings(false); couchStartHost(); });
setCouchJoinBtn.addEventListener('click', () => { setSettings(false); couchStartJoin(); });
renderCouchSection(); // initial paint of the settings row

/* ---------------- chat ----------------
   Room-local text chat. Messages only *display* for peers within
   PROXIMITY_R meters (receiver-side filter on the last-known wisp
   positions, broadcast at 12Hz) — distant chatter arrives as a faint
   hint instead. Own messages always show. */

const PROXIMITY_R = 40; // meters — chat only carries this far
const CHAT_HISTORY_CAP = 100;
const BUBBLE_SECS = 4; // floating bubble lifetime above the sender's wisp

const peerPositions = new Map(); // peerId -> THREE.Vector3 (last wisp broadcast)
const peerHeadings = new Map();  // peerId -> {x,y,z} heading (flock leader votes)
const chatHistory = []; // {name, text, time, sys, self, distant} — this session, capped
let lastDistantHint = 0;

function recordChat(name, text, sys = false, self = false, distant = false) {
  chatHistory.push({ name, text, time: new Date(), sys, self, distant });
  if (chatHistory.length > CHAT_HISTORY_CAP) chatHistory.shift();
}

function renderChatLine(name, text, sys = false) {
  const div = document.createElement('div');
  div.className = 'chat-line' + (sys ? ' sys' : '');
  if (sys) {
    div.textContent = text;
  } else {
    const n = document.createElement('span');
    n.className = 'chat-name';
    n.textContent = name;
    div.appendChild(n);
    div.appendChild(document.createTextNode(' \u00B7 ' + text));
  }
  chatLog.appendChild(div);
  while (chatLog.children.length > CHAT_HISTORY_CAP) chatLog.removeChild(chatLog.firstChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addChatLine(name, text, sys = false, self = false) {
  recordChat(name, text, sys, self, false);
  renderChatLine(name, text, sys);
}

function addSystemLine(text) {
  addChatLine('', text, true);
}

function sendChatLine() {
  const text = chatInput.value.trim().slice(0, 140);
  if (!text) { chatInput.blur(); return; }
  if (net.enabled && net.sendChat) {
    try {
      net.say(text);
    } catch (e) {
      addSystemLine('that one didn\u2019t carry \u2014 your words are still here, try again');
      return; // keep the draft: nothing typed is lost
    }
    addChatLine(myName, text, false, true);
    chatInput.value = '';
    // After sending we dismiss the keyboard on touch devices.
    if (window.matchMedia && matchMedia('(pointer: coarse)').matches) chatInput.blur();
  } else {
    addSystemLine('the void is quiet \u2014 no connection to send with');
    // keep the draft: it can fly once the connection is back
  }
}

/* Floating speech bubble above a peer's wisp, ~4s. Only when on screen. */
function makeChatBubble(text) {
  const shown = String(text).slice(0, 90);
  const maxChars = 24;
  const words = shown.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
    if (lines.length === 3) break;
  }
  if (line.trim() && lines.length < 3) lines.push(line.trim());
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = '300 26px system-ui, -apple-system, sans-serif';
  g.font = font;
  const wMax = Math.max(...lines.map((l) => g.measureText(l).width), 40);
  c.width = Math.ceil(wMax + 44);
  c.height = lines.length * 36 + 40;
  const g2 = c.getContext('2d');
  const r = 16;
  g2.fillStyle = 'rgba(6,10,24,0.88)';
  g2.strokeStyle = 'rgba(159,216,255,0.5)';
  g2.lineWidth = 2;
  g2.beginPath();
  if (g2.roundRect) g2.roundRect(2, 2, c.width - 4, c.height - 4, r);
  else g2.rect(2, 2, c.width - 4, c.height - 4);
  g2.fill();
  g2.stroke();
  g2.font = font;
  g2.fillStyle = 'rgba(235,240,255,0.95)';
  g2.textBaseline = 'top';
  lines.forEach((l, i) => g2.fillText(l, 22, 18 + i * 36));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, fog: false,
  }));
  const s = 0.028;
  sp.scale.set(c.width * s, c.height * s, 1);
  return sp;
}

const _projV = new THREE.Vector3();
function showChatBubble(peerId, text) {
  const pv = peerVisuals.get(peerId);
  if (!pv) return;
  // Only when the sender is actually on screen.
  _projV.copy(pv.group.position);
  _projV.y += 2.9;
  _projV.project(camera);
  if (_projV.z > 1 || Math.abs(_projV.x) > 1 || Math.abs(_projV.y) > 1) return;
  if (pv.bubble) pv.group.remove(pv.bubble.sprite);
  const sprite = makeChatBubble(text);
  sprite.position.y = 2.9;
  pv.group.add(sprite);
  pv.bubble = { sprite, expires: clock.elapsedTime + BUBBLE_SECS };
}

chatInput.addEventListener('focus', () => {
  chatFocused = true;
  for (const k in keys) keys[k] = false; // never fly while typing
});
chatInput.addEventListener('blur', () => { chatFocused = false; });

/* build 40: iOS keyboard covers fixed bottom chrome. The page itself can't
   scroll (overflow hidden), so lift the chat bar by the keyboard height
   while one of its inputs has focus; it settles back on its own. */
(function () {
  const vv = window.visualViewport;
  const chatEl = document.getElementById('chat');
  if (!vv || !chatEl) return;
  vv.addEventListener('resize', () => {
    const inside = chatEl.contains(document.activeElement);
    const kb = window.innerHeight - vv.height - vv.offsetTop;
    chatEl.style.transform = (inside && kb > 80) ? 'translateY(' + (-kb) + 'px)' : '';
  });
})();
chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep game keys out of the window handler
  if (e.key === 'Enter') { lastChatSendAt = Date.now(); sendChatLine(); }
  else if (e.key === 'Escape') chatInput.blur();
});

/* Send button — the touch path. Phone keyboards often dismiss instead of
   firing Enter on a bare input, so without this mobile chat can't send.
   build 42: iOS Safari was silently eating the tap. Tapping the button
   blurs the input, the keyboard starts away, and the keyboard-lift drops
   the whole chat bar ~300px *between* touchstart and touchend — the button
   moves out from under the finger before the click can land. So we send on
   pointerdown (fires first, before any blur or layout shift) and freeze the
   layout with preventDefault. */
let lastChatSendAt = 0;
function chatSendNow(e) {
  if (e) e.preventDefault(); // no blur, no keyboard bounce: the button stays put
  lastChatSendAt = Date.now();
  sendChatLine();
}
chatSend.addEventListener('pointerdown', chatSendNow);
chatSend.addEventListener('click', () => {
  // pointerdown already handled touch taps (its preventDefault suppresses
  // the compat click); this is the mouse/keyboard-activation path only.
  if (Date.now() - lastChatSendAt < 700) return;
  chatSendNow(null);
});

// Toggleable history panel (speech-bubble button).
let chatLogOpen = true;
chatToggle.addEventListener('click', () => {
  chatLogOpen = !chatLogOpen;
  chatLog.classList.toggle('hidden', !chatLogOpen);
  chatToggle.classList.toggle('off', !chatLogOpen);
  if (chatLogOpen) chatLog.scrollTop = chatLog.scrollHeight;
  chatToggle.blur();
});

// Enter in the name field starts the drift.
nameInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !driftBtn.disabled) driftBtn.click();
});

/* ---------------- input: mouse drag-look (no pointer lock) ---------------- */

let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('mousedown', (e) => { if (sculpt.active) return; dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.0032;
  pitch -= (e.clientY - lastY) * 0.0032;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('mouseup', () => { dragging = false; });

/* ---------------- input: touch (left joystick / right look) ---------------- */

const joy = { id: null, ax: 0, ay: 0, x: 0, y: 0 };   // move stick, -1..1
const look = { id: null, lx: 0, ly: 0 };              // look drag
/* build 49: tap-a-ray — a quick still tap (not a drag) on the canvas is a
   tap, routed to the journey's ray caller. Drags keep steering. */
let tapCand = null;
canvas.addEventListener('touchstart', (e) => {
  if (sculptTouchStart(e)) { e.preventDefault(); return; } // build 68: sculpt mode owns the canvas
  for (const t of e.changedTouches) {
    if (!tapCand) tapCand = { id: t.identifier, x: t.clientX, y: t.clientY, at: performance.now() };
    if (t.clientX < window.innerWidth / 2 && joy.id === null) {
      joy.id = t.identifier; joy.ax = t.clientX; joy.ay = t.clientY; joy.x = 0; joy.y = 0;
      joyBase.style.display = 'block';
      joyBase.style.left = t.clientX + 'px';
      joyBase.style.top = t.clientY + 'px';
      joyKnob.style.transform = 'translate(-50%,-50%)';
    } else if (look.id === null) {
      look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY;
    }
  }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  if (sculptTouchMove(e)) { e.preventDefault(); return; } // build 68: sculpt strokes / orbit / pinch
  for (const t of e.changedTouches) {
    if (tapCand && t.identifier === tapCand.id &&
        Math.hypot(t.clientX - tapCand.x, t.clientY - tapCand.y) > 16) tapCand = null; // it's a drag, not a tap
    if (t.identifier === joy.id) {
      joy.x = Math.max(-1, Math.min(1, (t.clientX - joy.ax) / 55));
      joy.y = Math.max(-1, Math.min(1, (t.clientY - joy.ay) / 55));
      joyKnob.style.transform = `translate(calc(-50% + ${joy.x * 32}px), calc(-50% + ${joy.y * 32}px))`;
    } else if (t.identifier === look.id) {
      yaw -= (t.clientX - look.lx) * 0.0042;
      pitch -= (t.clientY - look.ly) * 0.0042;
      pitch = Math.max(-1.45, Math.min(1.45, pitch));
      look.lx = t.clientX; look.ly = t.clientY;
    }
  }
  e.preventDefault();
}, { passive: false });
function endTouch(e) {
  if (sculptTouchEnd(e)) return; // build 68: sculpt mode owns the canvas
  for (const t of e.changedTouches) {
    if (tapCand && e.type === 'touchend' && t.identifier === tapCand.id) {
      const quick = performance.now() - tapCand.at < 350;
      const tc = tapCand;
      tapCand = null;
      if (quick) journeyTapRay(t.clientX, t.clientY);
    } else if (tapCand && t.identifier === tapCand.id) {
      tapCand = null;
    }
    if (t.identifier === joy.id) { joy.id = null; joy.x = 0; joy.y = 0; joyBase.style.display = 'none'; }
    if (t.identifier === look.id) look.id = null;
  }
}
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);
// desktop: same tap-a-ray via the mouse
let mouseTap = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (sculpt.active) { sculptMouseDown(e); return; } // build 68: sculpt mode owns the mouse
  mouseTap = { x: e.clientX, y: e.clientY, at: performance.now() };
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && sculpt.active) sculptMouseMove(e); // build 68
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' && sculpt.active) { sculptMouseUp(); return; } // build 68
  if (e.pointerType === 'mouse' && mouseTap) {
    const quick = performance.now() - mouseTap.at < 400;
    const still = Math.hypot(e.clientX - mouseTap.x, e.clientY - mouseTap.y) < 10;
    mouseTap = null;
    if (quick && still) journeyTapRay(e.clientX, e.clientY);
  }
});

/* ---------------- portal transitions ---------------- */

let transitioning = false;
let lastTransition = -10;

function showTitleCard(name) {
  titleCardEl.textContent = name;
  titleCardEl.classList.add('show');
  setTimeout(() => titleCardEl.classList.remove('show'), 2400);
}

function goTo(key) {
  // Build 38: a friend in Nexus #N advertises the full server room key —
  // land on their server, then portal to the Nexus world itself.
  if (isNexusServerKey(key)) {
    const n = parseInt(String(key).split('-').pop(), 10);
    if (n >= 1 && n <= NEXUS_SERVERS) pickServer(n);
    key = 'nexus';
  }
  if (transitioning || !worlds[key]) return;
  // Leaving the sound room: stop the live relay + the mic automatically.
  if (active && active.key === SOUND_ROOM_KEY && key !== SOUND_ROOM_KEY) { jamMicOff(); }
  // Leaving the journey: park the album, restore the wisp.
  if (active && active.key === JOURNEY_ROOM_KEY && key !== JOURNEY_ROOM_KEY) { journeyOnLeave(); }
  transitioning = true;
  fadeEl.classList.add('on');
  setTimeout(() => {
    active = worlds[key];
    active.scene.add(wisp, localTrail.group, peerLayer); // re-parents from the previous scene
    clearPeerVisuals();                       // old room's drifters stay in the old room
    net.join(roomKeyFor(active.key));         // hop to this location's P2P room
    net.setPresence(myName, presenceKeyFor(active.key)); // lobby heartbeat: we're elsewhere now
    try { mixerApplyGains(); } catch (e) {} // build 41: re-seat the journey jam duck
    updatePeerCount();
    wisp.position.copy(active.spawn);
    vel.set(0, 0, 0);
    yaw = active.spawnYaw;
    pitch = -0.05;
    clearTrail();
    realmNameEl.textContent = active.name;
    audio.setRoot(active.root);
    // Build 46: warm the AudioContext on the way into the sound room, so
    // the first pad tap doesn't pay the iOS resume cost. (The "tap for
    // sound" pill stays the honest fallback if the OS still says no.)
    if (key === SOUND_ROOM_KEY) { try { audioEnsureRunning(); } catch (e) {} }
    // Build 22: the ambient aura ducks out in the sound room (jam,
    // jukebox and metronome all ride the game master and are unaffected).
    audio.setAuraDucked(key === SOUND_ROOM_KEY);
    showTitleCard(active.name);
    renderRoomChrome(); // show/hide each room's buttons for this room
    try { theatreOnRealm(key); } catch (e) {} // build 75: theatre panel only in the theatre
    // Build 33: entering the journey resets the sky and starts the album probe.
    const musicRoom = key === SOUND_ROOM_KEY || key === JOURNEY_ROOM_KEY;
    // Build 41: the jukebox queue is server-wide — entering a music room
    // no longer starts a fresh party. The server channel is live-subscribed,
    // so the queue is already here; ask only if we're somehow empty.
    if (musicRoom && net.enabled && net.sendJukeStateReq && !juke.now && !juke.queue.length) {
      const reqId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      setTimeout(() => {
        if (active && inMusicRoom() && net.sendJukeStateReq && !juke.now && !juke.queue.length) {
          try { net.sendJukeStateReq({ reqId: reqId + '-juke' }); } catch (e) { /* best effort */ }
        }
      }, 2000);
    }
    if (key === JOURNEY_ROOM_KEY) journeyOnEnter();
    if (key === WORKSHOP_ROOM_KEY) setWorkshopPanel(true); // the bench opens itself
    // Build 69: model room late-joiner — clear the shelf and ask the room
    // for everyone's models. Peers already here answer with modelShare.
    if (key === WORKSHOP_ROOM_KEY) {
      wsShelf.clear();
      wsShelfRender();
      setTimeout(() => {
        if (active && active.key === WORKSHOP_ROOM_KEY && net.enabled && net.sendModelReq) {
          try { net.sendModelReq({}); } catch (e) {}
        }
      }, 2000);
    }
    if (key !== WORKSHOP_ROOM_KEY && sculpt.active) sculptExit(); // build 68: don't sculpt the void
    // Community wall (build 18): late joiner asks the room for the current
    // canvas. Delayed so the data channel has a moment to connect; peers
    // with ink answer once per reqId (see handleWallSyncReq).
    if (musicRoom && net.enabled && (net.sendWallSyncReq || net.sendJukeStateReq)) {
      const reqId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      setTimeout(() => {
        if (active && active.key === SOUND_ROOM_KEY) {
          // Build 26: announce my wall's version time; only peers with a
          // NEWER wall answer (wallHello + the ts-gated wallSyncReq below).
          if (net.sendWallHello) { try { net.sendWallHello({ ts: wall.ts }); } catch (e) {} }
          if (net.sendWallSyncReq) {
            try { net.sendWallSyncReq({ reqId, ts: wall.ts }); } catch (e) { /* best effort */ }
          }
          // Build 66: same late-joiner pattern for the stage + FOH lights —
          // peers already in the room answer with the current layout.
          if (net.sendStageReq) { try { net.sendStageReq({}); } catch (e) {} }
          if (net.sendFohReq) { try { net.sendFohReq({}); } catch (e) {} }
        }
        // Jukebox (build 21): same late-joiner pattern — ask the room for
        // the current queue + now-playing so we land in sync mid-track.
        // Build 33: the journey room joins the party the same way.
        if (active && inMusicRoom() && net.sendJukeStateReq) {
          try { net.sendJukeStateReq({ reqId: reqId + '-juke' }); } catch (e) { /* best effort */ }
        }
      }, 2000);
    }
    fadeEl.classList.remove('on');
    lastTransition = clock.elapsedTime;
    setTimeout(() => { transitioning = false; }, 700);
  }, 650);
}

/* ---------------- echoes ---------------- */

let collectedTotal = 0;
function collectEcho(echo) {
  echo.collected = true;
  echo.burstT = 0;
  collectedTotal++;
  echoCountEl.textContent = `ECHOES ${collectedTotal} / ${TOTAL_ECHOES}`;
  audio.chime(collectedTotal);
  // Earnable trail style: 10 total echoes unlocks the Comet trail.
  if (collectedTotal >= 10 && !unlocks.trailStyles.includes('comet')) {
    unlocks.trailStyles.push('comet');
    saveUnlocks();
    showUnlockToast(['10 echoes gathered', 'Comet trail unlocked']);
    addSystemLine('10 echoes gathered — comet trail unlocked');
    renderWispSection();
  }
}

/* ---------------- remote drifters (multiplayer visuals) ---------------- */

const peerCoreGeo = new THREE.SphereGeometry(0.32, 16, 12);

// Floating name tag above a remote wisp.
function makeNameTag(name) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = '300 40px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  try { g.letterSpacing = '10px'; } catch (e) { /* older browsers */ }
  g.fillStyle = 'rgba(235,240,255,0.9)';
  g.shadowColor = 'rgba(150,190,255,0.8)';
  g.shadowBlur = 14;
  g.fillText(name, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sp.scale.set(6.4, 1.6, 1);
  return sp;
}

// Stable per-peer tint so you can tell drifters apart.
function peerColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.65, 0.72);
}

function createPeerVisual(id, name) {
  const color = peerColor(id); // fallback tint for old clients without skins
  const group = new THREE.Group();
  const bob = new THREE.Group();
  const core = new THREE.Mesh(peerCoreGeo, new THREE.MeshBasicMaterial({ color }));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.scale.set(3.4, 3.4, 1);
  const tag = makeNameTag(name);
  tag.position.y = 1.8;
  bob.add(core, glow);
  group.add(bob, tag);
  return { id, group, bob, core, glow, hat: null, tag, target: new THREE.Vector3(), name, skin: null, hatId: null, trailObj: makeTrail(24, 0.9), trailStyle: null, trailColor: null, phase: Math.random() * Math.PI * 2 };
}

// Dress a remote wisp in the peer's equipped skin (unknown id = old client,
// keep the stable per-peer hash tint). Hats ride the existing bob group.
function applyPeerSkin(pv, skinId) {
  const s = SKINS[skinId];
  if (s) {
    pv.core.material.color.setHex(s.core);
    pv.glow.material.color.setHex(s.glow);
  } else {
    const c = peerColor(pv.id);
    pv.core.material.color.copy(c);
    pv.glow.material.color.copy(c);
  }
}
function applyPeerHat(pv, hatId) {
  if (pv.hat) { pv.bob.remove(pv.hat); pv.hat = null; }
  if (hatId && hatId !== 'none' && HATS[hatId]) {
    pv.hat = buildHat(hatId);
    pv.hat.position.y = 0.55;
    pv.bob.add(pv.hat);
  }
}

// Dress a remote wisp's trail in the peer's equipped style + color.
// Unknown/missing style -> ribbon; missing color (old clients) -> the stable
// per-peer hash tint, so every drifter still gets a playful trail.
function applyPeerTrail(pv, styleId, hexStr) {
  const t = pv.trailObj;
  if (!t) return;
  t.setStyle(styleId || 'ribbon');
  let hex = null;
  if (typeof hexStr === 'string' && /^[0-9a-fA-F]{6}$/.test(hexStr)) hex = parseInt(hexStr, 16);
  if (hex === null || Number.isNaN(hex)) hex = peerColor(pv.id).getHex();
  t.setColor(hex);
}

function retagPeer(pv, name) {
  pv.group.remove(pv.tag);
  pv.tag = makeNameTag(name);
  pv.tag.position.y = 1.8;
  pv.group.add(pv.tag);
}

function clearPeerVisuals() {
  for (const pv of peerVisuals.values()) {
    peerLayer.remove(pv.group);
    if (pv.trailObj) peerLayer.remove(pv.trailObj.group);
  }
  peerVisuals.clear();
  peerPositions.clear(); peerHeadings.clear(); // new room, new neighborhood
}

/* "DRIFTERS HERE" with a discovery state: while we're online, alone, and
   still inside the discovery window (~45s from room join) show a soft
   pulsing "finding others" so the wait reads as working, not broken.
   After the window, settle into a calm "just you in this realm". */
const DISCOVERY_WINDOW_MS = 45000;
function updatePeerCount() {
  const n = net.peerCount() + 1;
  let cls = '', suffix = '';
  if (net.couchMode) {
    // Build 34: couch mode has no discovery window — the host's QR is the
    // discovery. Keep the label honest about what's happening.
    if (net.peerCount() === 0) {
      cls = 'searching';
      suffix = net.isHost ? ' \u00B7 show your code to the room' : ' \u00B7 linking\u2026';
    } else {
      suffix = ' \u00B7 couch';
    }
  } else if (net.enabled && net.peerCount() === 0) {
    const elapsed = Date.now() - (net.joinedAt || Date.now());
    if (elapsed < DISCOVERY_WINDOW_MS) { cls = 'searching'; suffix = ' \u00B7 finding others'; }
    else { cls = 'settled'; suffix = ' \u00B7 just you in this realm'; }
  }
  peerCountEl.textContent = `DRIFTERS HERE: ${n}${suffix}`;
  peerCountEl.className = cls;
}
setInterval(updatePeerCount, 1000);

function handleWisp(id, d) {
  if (!d || !Array.isArray(d.p)) return;
  const nm = String(d.n || 'drifter').slice(0, 16) || 'drifter';
  peerPositions.set(id, new THREE.Vector3(d.p[0], d.p[1], d.p[2])); // proximity table
  if (d.f && Array.isArray(d.f) && d.f.length >= 3) peerHeadings.set(id, { x: +d.f[0], y: +d.f[1], z: +d.f[2] }); // flock heading
  let pv = peerVisuals.get(id);
  if (!pv) {
    if (peerVisuals.size >= MAX_REMOTE) return; // render cap; count still tracks
    pv = createPeerVisual(id, nm);
    pv.skin = d.s || null; applyPeerSkin(pv, pv.skin);
    pv.hatId = d.h || null; applyPeerHat(pv, pv.hatId);
    pv.trailStyle = d.t || null; pv.trailColor = d.c || null;
    applyPeerTrail(pv, pv.trailStyle, pv.trailColor);
    pv.target.set(d.p[0], d.p[1], d.p[2]);
    pv.group.position.copy(pv.target); // snap on first sight
    pv.trailObj.clear(pv.group.position); // no streak from the origin
    peerVisuals.set(id, pv);
    peerLayer.add(pv.group);
    peerLayer.add(pv.trailObj.group);
    addSystemLine(`${nm} drifted in`);
    updatePeerCount();
    if (typeof wsShelfRender === 'function') wsShelfRender(); // build 69: room shelf roster
  } else {
    pv.target.set(d.p[0], d.p[1], d.p[2]);
    if (pv.name !== nm) { pv.name = nm; retagPeer(pv, nm); if (typeof wsShelfRender === 'function') wsShelfRender(); }
    const s = d.s || null, h = d.h || null;
    if (pv.skin !== s) { pv.skin = s; applyPeerSkin(pv, s); }
    if (pv.hatId !== h) { pv.hatId = h; applyPeerHat(pv, h); }
    const ts = d.t || null, tc = d.c || null;
    if (pv.trailStyle !== ts || pv.trailColor !== tc) {
      pv.trailStyle = ts; pv.trailColor = tc;
      applyPeerTrail(pv, ts, tc);
    }
  }
}

function handlePeerLeave(id) {
  const pv = peerVisuals.get(id);
  if (pv) {
    addSystemLine(`${pv.name} drifted away`);
    peerLayer.remove(pv.group);
    if (pv.trailObj) peerLayer.remove(pv.trailObj.group);
    peerVisuals.delete(id);
  }
  peerPositions.delete(id);
  peerHeadings.delete(id);
  updatePeerCount();
  // Build 69: the leaver's models leave the room shelf with them.
  try {
    const prefix = String(id) + '::';
    for (const k of [...wsShelf.keys()]) if (k.startsWith(prefix)) wsShelf.delete(k);
    for (const k of [...wsPendingModels.keys()]) if (k.startsWith(prefix)) wsPendingModels.delete(k);
  } catch (e) {}
  if (typeof wsShelfRender === 'function') wsShelfRender();
}

// Wire the net callbacks once; rooms are (re)joined on start + portal hops.
net.onWispCb = handleWisp;
net.onJukeLikeCb = (cid, d) => handleJukeLike(cid, d); // build 33: track likes
net.onPeerLeaveCb = handlePeerLeave;
net.onChatCb = (peerId, d) => {
  if (!d) return;
  const nm = String(d.n || 'drifter').slice(0, 16) || 'drifter';
  const tx = String(d.t || '').slice(0, 140);
  if (!tx) return;
  // Proximity chat: only display peers within earshot. Unknown position
  // (no wisp yet) is treated as near — better than dropping a greeting.
  const pos = peerId ? peerPositions.get(peerId) : null;
  const dist = pos ? wisp.position.distanceTo(pos) : 0;
  if (dist <= PROXIMITY_R) {
    addChatLine(nm, tx);
    if (peerId) showChatBubble(peerId, tx);
  } else {
    recordChat(nm, tx, false, false, true); // kept in history, marked distant
    const now = Date.now();
    if (now - lastDistantHint > 15000) {
      lastDistantHint = now;
      addSystemLine('you sense distant chatter\u2026');
    }
  }
};
net.onQuietCb = () =>
  addSystemLine('the void is quiet here — drift to the Nexus to find other drifters');
net.onPresenceCb = () => { if (settingsOpen) renderFriendsSection(); if (!started) renderServerList(); };
// Jam room (build 13): clock/note/pad events -> local synthesis.
net.onJamClockCb = handleJamClock;
net.onJamNoteCb = handleJamNote;
net.onJamPadCb = handleJamPad;
// Community wall (build 18): paint strokes + late-joiner sync.
net.onWallStrokeCb = handleWallStroke;
net.onWallSyncReqCb = handleWallSyncReq;
net.onWallSyncCb = handleWallSync;
net.onWallHelloCb = handleWallHello; // build 26: last-writer-wins convergence
net.onWallUndoCb = handleWallUndo; // build 26: peer undid a stroke
// Jukebox (build 21): synced queue playback.
net.onJukeAddCb = handleJukeAdd;
net.onJukeRemoveCb = handleJukeRemove;
net.onJukePlayCb = handleJukePlay;
net.onJukeSkipVoteCb = handleJukeSkip; // wire name is legacy; semantics are instant-skip
net.onJukeStateReqCb = handleJukeStateReq;
net.onJukeStateCb = handleJukeState;
net.onJukeHelloCb = handleJukeHello; // build 43: holder election presence
net.onJukeClaimCb = handleJukeClaim; // build 43: "I hold this server's line"
net.onJukeSyncCb = handleJukeSync; // build 43: canonical queue snapshot
net.onJukeClearCb = handleJukeClear; // build 43: anyone may clear the line
// Theatre (build 75): synced video watching.
net.onTheatreAddCb = handleTheatreAdd;
net.onTheatrePlayCb = handleTheatrePlay;
net.onTheatrePauseCb = handleTheatrePause;
net.onTheatreStateReqCb = handleTheatreStateReq;
// Stage builder + front of house (build 66): layout + light rig ride the room.
net.onStageSyncCb = handleStageSync;
net.onStageReqCb = handleStageReq;
net.onFohSyncCb = handleFohSync;
net.onFohReqCb = handleFohReq;
// Model room shared shelf (build 69): everyone's saved models, one room.
net.onModelShareCb = handleModelShare;
net.onModelDelCb = handleModelDel;
net.onModelReqCb = handleModelReq;
net.onModelChunkCb = handleModelChunk;
/* Build 43: the relay is live — start holder election hellos and ask the
   holder for the line if we're empty (the old blind timer fired too early). */
net.onRelayUpCb = () => { jukeStartHellos(); jukeMaybeSync(); };
net.onJukeFileReqCb = handleJukeFileReq; // build 27: phone-file P2P
net.onJukeFileChunkCb = handleJukeFileChunk;
net.onJukeFileHaveCb = handleJukeFileHave;
// Room voice (build 40): live PCM frames over the relay.
net.onVoiceChunkCb = handleVoiceChunk;
net.onVoiceTalkCb = handleVoiceTalk;

/* ---------------- settings panel ----------------
   Gear button opens it; D key is a desktop shortcut to the same panel.
   panel. Holds the net debug readout, sound toggle, and drifter name. */

let settingsOpen = false;
function setSettings(open) {
  settingsOpen = open;
  settingsPanel.classList.toggle('open', open);
  if (open) {
    settingsName.value = myName;
    soundToggle.textContent = audio.muted ? 'OFF' : 'ON';
    renderWispSection();
    renderFriendsSection();
    updateDebugHud();
  }
}
function setMuted(muted) {
  muteEl.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
  soundToggle.textContent = muted ? 'OFF' : 'ON';
  try { localStorage.setItem('limbo_muted', muted ? '1' : ''); } catch (e) { /* ignore */ }
}
gearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setSettings(!settingsOpen);
  gearBtn.blur();
});
settingsClose.addEventListener('click', () => setSettings(false));
soundToggle.addEventListener('click', () => {
  setMuted(audio.toggleMute());
  soundToggle.blur();
});
settingsName.addEventListener('change', () => {
  const raw = settingsName.value.trim().slice(0, 16) || 'drifter';
  myName = raw;
  net.name = raw; // live: future wisp broadcasts + chat carry the new name
  net.setPresence(raw, active ? active.key : 'nexus'); // lobby heartbeat carries the new name too
  try { localStorage.setItem('limbo_name', raw); } catch (e) { /* ignore */ }
  if (nameInput) nameInput.value = raw;
  addSystemLine(`you are now known as ${raw}`);
  settingsName.blur();
});
// Add a drifter to the friends list by name (Enter works too).
friendAddBtn.addEventListener('click', () => {
  if (addFriend(friendAddInput.value)) friendAddInput.value = '';
  friendAddBtn.blur();
});
friendAddInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep game keys out of the window handler
  if (e.key === 'Enter') {
    if (addFriend(friendAddInput.value)) friendAddInput.value = '';
    friendAddInput.blur();
  } else if (e.key === 'Escape') friendAddInput.blur();
});
// Typing a name isn't flying: reuse the chat field's "don't fly" guard.
friendAddInput.addEventListener('focus', () => {
  chatFocused = true;
  for (const k in keys) keys[k] = false;
});
friendAddInput.addEventListener('blur', () => { chatFocused = false; });

/* ---------------- debug readout (lives in the settings panel) ----------------
   Diagnoses multiplayer live on the device: ICE states, candidate types
   (host/srflx/relay — 'relay' means TURN allocation worked), selected
   pair, and trystero's own join-error text. Works with zero peers. */

const debugHud = document.createElement('div');
debugHud.id = 'debug-hud';
settingsDebug.appendChild(debugHud); // styled by #debug-hud in style.css

async function updateDebugHud() {
  if (!settingsOpen) return;
  let s;
  try {
    s = await net.getDebugSnapshot();
  } catch (e) {
    debugHud.textContent = 'debug snapshot failed: ' + e.message;
    return;
  }
  const L = [];
  // Build 34: the snapshot may come from the couch (offline LAN) transport.
  L.push(`LIMBO net debug · build ${s.build} · ${s.couch ? 'COUCH (offline LAN)' : (s.enabled ? 'online' : 'OFFLINE (single-player)')}`);
  if (s.couch) {
    L.push(`couch: ${s.isHost ? 'HOST' : 'guest'} · room: ${s.roomKey}`);
    if (s.roster && s.roster.length) {
      L.push('roster: ' + s.roster.map((r) => r.name).join(', '));
    }
    if (s.log && s.log.length) {
      L.push('couch log:');
      for (const line of s.log.slice(-6)) L.push('  ' + line);
    }
  }
  // (build 30) parallel strategies: torrent + nostr rooms at once, peer sets merged
  if (s.strategies) {
    L.push('paths: ' + s.strategies.map((p) =>
      `${p.name}${p.loaded ? '✓' : '✗'}${p.joined ? ` room(${p.conns})` : ''}`
    ).join(' · ') + ` · room: ${s.roomKey}`);
  }
  L.push(`peers: ${s.peerCount} · turn user: ${s.turnUser} · cid: ${s.clientId || '?'}`);
  if (s.iceRetry) {
    L.push(`ice retry: attempt ${s.iceRetry.attempt} in ${(s.iceRetry.inMs / 1000).toFixed(0)}s`);
  }
  // (a) relay websocket connectivity — open vs shut per pinned relay
  if (s.relays) {
    L.push('relays: ' + s.relays.map((r) => `${r.host}${r.open ? '✓' : '✗'}`).join(' '));
  } else {
    L.push('relays: n/a (torrent strategy)');
  }
  // (b)+(c) discovery & handshake stages per observed peer id
  if (s.hsPeers && s.hsPeers.length) {
    L.push('discovery: ' + s.hsPeers.map((h) =>
      `${h.id}:${h.stage}${h.initiator === true ? '(init)' : ''} sig↓${h.sigIn}↑${h.sigOut}`
    ).join(' · '));
  } else {
    L.push('discovery: no peer announces seen yet');
  }
  // recent nostr wire frames (dir/topic[/peer])
  if (s.frames && s.frames.length) {
    L.push('wire: ' + s.frames.slice(-8).join(' '));
  }
  if (s.peers.length === 0) {
    L.push('no peer connections — signaling found nobody (or room not joined yet)');
  }
  for (const p of s.peers) {
    L.push(`— peer ${p.id}`);
    L.push(`  ice:${p.ice} gather:${p.gathering} conn:${p.conn}`);
    L.push(`  local candidates: ${p.localTypes.length ? p.localTypes.join(',') : '(none yet)'}`);
    L.push(`  selected pair: ${p.selectedType}`);
  }
  if (s.lastJoinError) {
    L.push(`LAST JOIN ERROR [${s.lastJoinError.at}] peer ${s.lastJoinError.peerId}:`);
    L.push(`  ${s.lastJoinError.error}`);
  }
  debugHud.textContent = L.join('\n');
}
setInterval(updateDebugHud, 1000);

/* ---------------- start ---------------- */

let hintTimer = null;
driftBtn.addEventListener('click', () => {
  const raw = (nameInput.value || '').trim().slice(0, 16) || 'drifter';
  myName = raw;
  try { localStorage.setItem('limbo_name', raw); } catch (e) { /* ignore */ }
  audio.init(active ? active.root : NEXUS_DEF.root);
  // iOS Safari may still park the fresh context in 'suspended' — resume()
  // inside THIS gesture is the one call iOS reliably honors.
  try { if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume(); } catch (e) {}
  try { if (localStorage.getItem('limbo_muted')) setMuted(audio.toggleMute()); } catch (e) { /* ignore */ }
  // Build 25: the tap is a user gesture — warm the jukebox provider players
  // now so the first queued track starts fast.
  try { jukePrewarm(); } catch (e) { /* jukebox is best-effort */ }
  overlayEl.classList.add('gone');
  started = true;
  hintTimer = setTimeout(() => hintEl.classList.add('gone'), 15000);
  // Multiplayer: best-effort — the game plays exactly like v1 without it.
  net.boot(myName).then((ok) => {
    if (ok) {
      net.setPresence(myName, presenceKeyFor(active.key));
      net.joinLobby(); // shared presence room: who's live, where
      net.join(roomKeyFor(active.key));
      updatePeerCount();
    } else {
      addSystemLine('the void is quiet tonight — drifting solo');
    }
  });
});

/* ---------------- per-frame ---------------- */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _camWant = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const myFwd = new THREE.Vector3(0, 0, -1); // our heading, broadcast for the flock

function updatePlayer(dt) {
  // Camera-relative flight axes.
  const cp = Math.cos(pitch);
  _fwd.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

  _move.set(0, 0, 0);
  let ix = 0, iz = 0, iy = 0;
  if (!chatFocused) { // never fly while typing in chat
    if (keys.KeyW || keys.ArrowUp) iz += 1;
    if (keys.KeyS || keys.ArrowDown) iz -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.Space || keys.KeyE) iy += 1;
    if (keys.ShiftLeft || keys.ShiftRight || keys.KeyQ) iy -= 1;
  }
  ix += joy.x; iz -= joy.y; // touch joystick (up = forward)

  _move.addScaledVector(_fwd, iz).addScaledVector(_right, ix);
  _move.y += iy * 0.9;
  const isJourney = active.key === JOURNEY_ROOM_KEY;
  // build 41: proximity-graded speed — flock slipstream, ring/gem nearness,
  // drafting off nearby drifters, plus ring/gem bursts. Not a binary fast mode.
  // (updateJourney runs before updatePlayer each frame, so journey.boost is fresh.)
  const boost = (isJourney && journey.boost > 0) ? journey.boost : 1;
  if (_move.lengthSq() > 0) {
    _move.normalize();
    vel.addScaledVector(_move, 26 * boost * dt);
  }
  // Dreamy inertia: exponential damping, then clamp speed.
  vel.multiplyScalar(Math.exp(-2.4 * dt));
  if (isJourney) {
    // the journey never stops drifting — birds on the wing, always forward
    vel.addScaledVector(_fwd, J_CRUISE * boost * dt);
  }
  const sp = vel.length();
  const vmax = 16 * boost;
  if (sp > vmax) vel.multiplyScalar(vmax / sp);

  wisp.position.addScaledVector(vel, dt);

  // Keep the wisp inside its world.
  if (active.bound === 'realm') {
    wisp.position.x = Math.max(-52, Math.min(52, wisp.position.x));
    wisp.position.y = Math.max(-8, Math.min(36, wisp.position.y));
    wisp.position.z = Math.max(-54, Math.min(32, wisp.position.z));
  } else if (active.bound === 'journey') {
    // the open field: soft push-back at the fog wall, hard clamp at the edge
    wisp.position.y = Math.max(J_MIN_Y, Math.min(J_MAX_Y, wisp.position.y));
    const jhx = wisp.position.x, jhz = wisp.position.z;
    const jhd = Math.hypot(jhx, jhz);
    if (jhd > J_FIELD_SOFT) {
      const push = (jhd - J_FIELD_SOFT) * 0.9;
      vel.x -= (jhx / jhd) * push * dt;
      vel.z -= (jhz / jhd) * push * dt;
    }
    if (jhd > J_FIELD_R) {
      const js = J_FIELD_R / jhd;
      wisp.position.x *= js; wisp.position.z *= js;
    }
  } else {
    const hx = wisp.position.x, hz = wisp.position.z;
    const hd = Math.hypot(hx, hz);
    if (hd > NEXUS_BOUND) {
      wisp.position.x = (hx / hd) * NEXUS_BOUND;
      wisp.position.z = (hz / hd) * NEXUS_BOUND;
    }
    wisp.position.y = Math.max(-6, Math.min(30, wisp.position.y));
  }

  // Wisp idle breathing.
  const b = 1 + Math.sin(clock.elapsedTime * 2.1) * 0.07;
  wispCore.scale.set(b, b, b);

  if (sculpt.active) {
    sculptCameraUpdate(); // build 68: orbit the clay — the wisp waits
  } else {
    // Third-person follow camera with soft lag.
    _camWant.copy(wisp.position).addScaledVector(_fwd, -7).add(new THREE.Vector3(0, 2.2, 0));
    camera.position.lerp(_camWant, 1 - Math.exp(-8 * dt));
    _lookAt.copy(wisp.position).addScaledVector(_fwd, 8);
    camera.lookAt(_lookAt);
  }

  pushTrail(dt);
  myFwd.copy(_fwd); // broadcast to the flock in loop()
}

function checkPortals() {
  if (transitioning) return;
  if (clock.elapsedTime - lastTransition < 1.2) return; // settle after arriving
  for (const p of active.portals) {
    if (wisp.position.distanceTo(p.pos) < PORTAL_TRIGGER) {
      goTo(p.target);
      return;
    }
  }
}

function checkEchoes() {
  if (transitioning || active.bound === 'nexus') return;
  for (const e of active.echoes) {
    if (!e.collected && wisp.position.distanceTo(e.mesh.position) < ECHO_TRIGGER) {
      collectEcho(e);
    }
  }
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp huge tabs
  const t = clock.elapsedTime;

  active.update(dt, t);

  // Sound room reactivity (build 12/28): bass energy from the jam bus.
  {
    let target = 0;
    const ra = roomAnalyserGet(false);
    const an = ra && ra.analyser;
    const data = ra && ra.data;
    if (an && data) {
      try {
        an.getByteFrequencyData(data);
        let s = 0, n = 0;
        for (let i = 1; i < 8 && i < data.length; i++) { s += data[i]; n++; }
        target = n ? (s / n / 255) * 1.6 : 0;
      } catch (e) {}
    }
    roomBassSmooth += (Math.min(1, target) - roomBassSmooth) * Math.min(1, dt * 6);
    if (active.key === SOUND_ROOM_KEY && active.setBass) active.setBass(roomBassSmooth);
    // build 41: the wisp's trail breathes with the room's low end
    try { if (localTrail && localTrail.setPulse) localTrail.setPulse(roomBassSmooth); } catch (e) {}
  }

  // Community wall (build 18): push new strokes to the GPU texture.
  if (wall.texDirty && wall.tex) {
    wall.tex.needsUpdate = true;
    wall.texDirty = false;
  }

  // Free flight everywhere — including the journey (its update adds
  // the cruise drift, the V formation and the slipstream).
  updatePlayer(dt);
  checkPortals();  checkEchoes();

  // Multiplayer: broadcast our wisp, ease remote wisps toward their targets.
  if (started) {
    netTimer += dt;
    if (netTimer >= 1 / 12) {
      netTimer = 0;
      net.broadcast(wisp.position, myFwd);
    }
    const k = 1 - Math.exp(-9 * dt);
    for (const pv of peerVisuals.values()) {
      pv.group.position.lerp(pv.target, k);
      pv.bob.position.y = Math.sin(t * 2.2 + pv.phase) * 0.3;      // Floating chat bubbles: rise, fade, vanish after BUBBLE_SECS.
      // Remote trails: short + low-res, skipped beyond 150m for perf.
      const pd = pv.group.position.distanceTo(wisp.position);
      const showTrail = pd < 150;
      pv.trailObj.group.visible = showTrail;
      if (showTrail) pv.trailObj.update(pv.group.position, dt);
      if (pv.bubble) {
        const remain = pv.bubble.expires - t;
        if (remain <= 0) {
          pv.group.remove(pv.bubble.sprite);
          pv.bubble = null;
        } else {
          pv.bubble.sprite.position.y = 2.9 + (1 - remain / BUBBLE_SECS) * 1.2;
          pv.bubble.sprite.material.opacity = Math.min(1, remain / 1.2);
        }
      }
    }
    // Local hat: gentle bob + sway so it feels worn, not glued on.
    if (wispHat) {
      wispHat.position.y = 0.42 + Math.sin(t * 2.2) * 0.05;
      wispHat.rotation.y = Math.sin(t * 0.7) * 0.12;
    }
  }

  renderer.render(active.scene, camera);
  theatreScreenTick(); // build 76: pin the video layer onto the 3D cinema screen
}

/* ---------------- resize ---------------- */

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* Test + diagnostics hook: exposes multiplayer internals so automated
   tests (and future debugging) can drive the chat/proximity paths
   without needing a real second peer. */
window.__limbo = {
  net,
  wisp,
  camera,
  peerVisuals,
  chatHistory: () => chatHistory.slice(),
  myName: () => myName,
  setPeerPos: (id, x, y, z, fx, fy, fz) => {
    peerPositions.set(id, new THREE.Vector3(x, y, z));
    if (fx !== undefined) peerHeadings.set(id, { x: +fx, y: +fy, z: +fz });
  },
  getPeerPos: (id) => peerPositions.get(id),
  handleWisp,
  showChatBubble,
  PROXIMITY_R,
  build: net.build,
  // customization (build 8) + trails (build 9)
  SKINS,
  HATS,
  SKIN_ORDER,
  HAT_ORDER,
  TRAIL_STYLES,
  TRAIL_COLORS,
  TRAIL_STYLE_ORDER,
  TRAIL_COLOR_ORDER,
  unlocks: () => JSON.parse(JSON.stringify(unlocks)),
  equipped: () => ({ ...equipped }),
  grantAttunement: onRealmAttuned,
  applySkin,
  applyHat,
  applyTrail,
  localTrail,
  applyPeerTrail,
  collectEcho,
  renderWispSection,
  // friends + live presence (build 11)
  getFriends: () => friends.slice(),
  addFriend,
  removeFriend,
  renderFriendsSection,
  goTo,
  activeKey: () => (active ? active.key : null),
  journeyGateZ: () => (journey.gate ? +journey.gate.group.position.z.toFixed(1) : null),
  journeySpeed: () => +journey.lastSpeed.toFixed(2),
  journeyZone: () => journey.zone, // open-field zone id (spires|city|dunes|grid)
  /* build 36 test seam: move the gate `d` units along our heading (default 10) */
  journeyDropGate: (d) => {
    if (!journey.gate) return;
    const dd = d || 10;
    journey.gate.group.position.set(
      wisp.position.x + myFwd.x * dd, wisp.position.y + myFwd.y * dd, wisp.position.z + myFwd.z * dd);
    journey.gate.pos.copy(journey.gate.group.position);
  },
  /* build 36 test seam: teleport the wisp (zone/boundary tests) */
  journeyTeleport: (x, y, z) => { wisp.position.set(x, y, z); vel.set(0, 0, 0); },
  setPresence: (n, r) => net.setPresence(n, r),
  presencePayload: () => net._presencePayload(),
  lobbyPeers: () => [...net.lobbyPeers.entries()].map(([id, p]) => ({ id, ...p })),
  lobbyMap: () => net.lobbyPeers, // live map: tests time-travel lastSeen for expiry
  notePresence: (id, d) => net._notePresence(id, d),
  sweepLobby: (now) => net._sweepLobby(now),
  joinLobby: () => net.joinLobby(),
  // servers (build 38)
  selectedServer: () => selectedServer,
  selectServer: (n) => { pickServer(n); },
  renderServerList,
  serverCount,
  // couch co-op (build 34): offline LAN transport + ceremony
  couchNet, // direct handle (bypasses the dispatcher proxy)
  couchActive: () => couchActive,
  onlineNet, // direct handle to the online transport
  enterCouchMode,
  exitCouchMode,
  couchStartHost,
  couchStartJoin,
  couchAcceptOffer, // (payload) -> guest side of the ceremony
  couchAcceptAnswer, // (payload) -> host side of the ceremony
  couchMintOffer,
  couchPeerCount: () => couchNet.peerCount(),
  couchRoster: () => [...couchNet.roster.entries()].map(([cid, p]) => ({ cid, name: p.name })),
  couchSnapshot: () => couchNet.getDebugSnapshot(),
  // sound room (build 12)
  SOUND_DEF,
  // model room (build 66)
  WORKSHOP_DEF,
  // endless journey (build 33)
  JOURNEY_DEF,
  JOURNEY_ROOM_KEY,
  journeyState: () => ({
    key: active ? active.key : null,
    x: +wisp.position.x.toFixed(2),
    y: +wisp.position.y.toFixed(2),
    z: +wisp.position.z.toFixed(2),
    zone: journey.zone,
    zoneName: zoneNameEl ? zoneNameEl.textContent : '',
    bannerShown: !!(zoneNameEl && zoneNameEl.classList.contains('show')),
    gateX: journey.gate ? +journey.gate.group.position.x.toFixed(1) : null,
    inFlock: journey.inFlock,
    flockSize: journey.myFlockSize,
    album: album.state,
    albumTracks: album.tracks.length,
    speedLines: !!(journey.speedLines && journey.speedLines.visible),
    likePill: !!(jukeSocialPill && jukeSocialPill.style.display !== 'none'),
  }),
  /* build 36 test seam: pin the zone (bypasses the hysteresis band) */
  journeyPinZone: (z) => { journey.zone = z; },
  albumState: () => ({ state: album.state, tracks: album.tracks.map((t) => t.title) }),
  jukeLikeCount: (id) => (jukeLikes.get(id) || new Set()).size,
  /* build 75 test seam: theatre state */
  theatreState: () => ({ videoId: theatre.videoId, playing: theatre.playing, position: theatre.position, startedAt: theatre.startedAt, playBlocked: theatre.playBlocked, playerReady: theatre.playerReady, hasPlayer: !!theatre.player }),
  /* build 79 test seams: drive theatre handlers exactly as net._in does (cid, data) */
  theatreRxAdd: (cid, d) => handleTheatreAdd(cid, d),
  theatreRxPlay: (cid, d) => handleTheatrePlay(cid, d),
  theatreRxPause: (cid, d) => handleTheatrePause(cid, d),
  /* build 80 test seam: fake a ready player (headless Chromium cannot build
     a real YT.Player iframe). Lets tests drive the projection + the UI
     toggle path without the network player. */
  theatreForceReady: (videoId) => {
    theatre.videoId = String(videoId || 'testvideoid1');
    theatre.playing = true;
    // the seam simulates a happily-playing player: clear any autoplay-block
    // flag and disarm the play-block watchdog so the UI toggle takes the
    // pause branch instead of the unblock-and-resume branch.
    theatre.playBlocked = false;
    if (theatrePlayWatchTimer) { clearTimeout(theatrePlayWatchTimer); theatrePlayWatchTimer = 0; }
    theatre.position = 0;
    theatre.startedAt = Date.now();
    const cur = { t: 0 };
    theatre.player = {
      getVideoData: () => ({ video_id: theatre.videoId }),
      cueVideoById: () => {},
      seekTo: (s) => { cur.t = s; },
      playVideo: () => {},
      pauseVideo: () => {},
      getCurrentTime: () => cur.t,
      getPlayerState: () => 1,
      setVolume: () => {},
    };
    theatre.playerReady = true;
    theatreRender();
    return { videoId: theatre.videoId, playing: theatre.playing, position: theatre.position };
  },
  theatreScreenLayer: () => document.getElementById('theatre-screen3d'),
  /* build 80 test seam: the screen mesh's four corners in page pixels,
     same math as theatreScreenTick() (read-only). */
  theatreTestCorners: () => {
    const mesh = active && active.key === THEATRE_ROOM_KEY && active.anim ? active.anim.screenMesh : null;
    if (!mesh || !camera) return null;
    mesh.updateWorldMatrix(true, false);
    const hw = 14, hh = 7.875;
    const v = new THREE.Vector3();
    const dst = [];
    for (const [lx, ly] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
      v.set(lx, ly, 0).applyMatrix4(mesh.matrixWorld).project(camera);
      dst.push([(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight]);
    }
    const [tl, tr, br, bl] = dst;
    return { tl, tr, br, bl };
  },
  // build 80 test seam: drive the player-error path without a real YT player
  theatreSimError: (code) => {
    if (code) theatreOnPlayerError(code); else theatreClearPlayerError();
    return document.getElementById('theatre-link').textContent;
  },
  theatreExtractId: (u) => theatreExtractId(u),
  /* build 33 test seam: fake a live jukebox track to drive the like pill */
  jukeFakePlaying: (id) => {
    juke.now = { id: String(id), stopped: false, title: 'test track' };
    juke.nowStartedAt = Date.now();
    journey.lastJukeId = null;
    renderJukeSocial();
  },
  jukeClearFake: () => { juke.now = null; jukeLikedNow = null; renderJukeSocial(); },
  worldKeys: () => Object.keys(worlds),
  nexusPortals: () => (worlds.nexus ? worlds.nexus.portals.map((p) => p.target) : []),
  galleryFiles: () => (worlds.soundroom && worlds.soundroom.gallery ? worlds.soundroom.gallery.slice() : []),
  // build 19: is a named gallery frame ('gallery-realm1' etc.) in the sound room scene?
  galleryFramePresent: (key) => {
    const s = worlds.soundroom && worlds.soundroom.scene;
    return !!(s && s.getObjectByName('gallery-' + key));
  },
  // jam room (build 13)
  // build 27: mic in
  jamMicToggle: () => jamMicToggle(),
  jamMicOff: () => jamMicOff(),
  jamMicToggleMute: () => jamMicToggleMute(),
  jamMicToggleLoop: () => jamMicToggleLoop(),
  jamMicState: () => ({ on: jamMic.on, muted: jamMic.muted, hasStream: !!jamMic.stream, level: jamMicLevel(), loopIn: jamMic.loopIn, loopTapGain: jamMic.loopTap ? jamMic.loopTap.gain.value : null }),
  // room voice (build 40)
  voiceTalkToggle: () => voiceTalkToggle(),
  voiceTxState: () => ({ on: voice.tx.on, starting: voice.tx.starting, seq: voice.tx.seq, hasNode: !!voice.tx.node, lastError: voice.lastError }),
  voiceRxTalk: (d, pid) => handleVoiceTalk(pid || 'test-peer', d),
  voiceRxChunk: (d, pid) => handleVoiceChunk(pid || 'test-peer', d),
  voiceRxState: () => [...voice.rx.entries()].map(([id, r]) => ({ id, name: r.name, queued: r.q.size, ended: r.ended, started: r.started })),
  voiceTalkers: () => voiceTalkers(),
  voiceInGainTarget: () => (voice.inGain ? 'master' : null),
  mixerSet: (s, v) => mixerSet(s, v),
  mixerLevels: () => ({ ...mixer.levels }),
  jukeBadge: () => jukeBadge(),
  jamState: () => ({
    open: jam.open,
    bpm: jam.bpm,
    clockOn: jam.startWall != null,
    by: jam.clockBy,
    manual: jam.manual,
    instrument: jam.instrument,
    synth: { ...jam.synth }, // build 39: the full patch
    scale: jam.scale,
    padsLoaded: jam.pads.map((b) => !!b),
    voices: jamVoicesSpawned,
    queue: jamQueue.length,
    jammers: [...jam.jammers.keys()],
  }),
  jamBeatNow,
  jamQuantize: (q) => {
    const n = jamBeatNow();
    return n == null ? null : quantizeUp(n, q);
  },
  jamSetBpm: (b, o) => jamSetBpm(b, o || {}),
  jamBroadcastClock: () => jamBroadcastClock(),
  jamClockMsg: () => ({ bpm: jam.bpm, startWall: jam.startWall, by: myName }),
  jamTestClock: (bpm, startWallAgoMs) => {
    jam.bpm = bpm;
    jam.startWall = Date.now() - startWallAgoMs;
    renderJamTransport();
  },
  jamNote: (d, pid) => handleJamNote(pid, d),
  jamPad: (d, pid) => handleJamPad(pid, d),
  jamClockIn: (d, pid) => handleJamClock(pid, d),
  jamPlayLocal: (m, v) => jamPlayLocal(m, v),
  jamGrabLoop: () => jamGrabLoop(),
  // aura ducking (build 22): ambient pad fades out in the sound room.
  // gain reads the live AudioParam; lastRamp proves a ramp (not a hard cut).
  auraState: () => ({
    started: audio.started,
    ducked: !!audio._auraDucked,
    gain: audio.aura ? audio.aura.gain.value : null,
    lastRamp: audio._lastAuraRamp,
  }),
  setAuraDucked: (d) => audio.setAuraDucked(d),
  jamTriggerPad: (i) => jamTriggerPad(i),
  jamStopClock: () => jamStopClock(),
  jamDetectTick: () => jamDetectTick(),
  jamEstimateBpm: (o) => estimateBpm(o),
  newOnsetDetector: () => new OnsetDetector(),
  setJamPanel: (o) => setJamPanel(o),
  jamOpen: () => jam.open,
  jamAudioTimeForBeat: (b) => jamAudioTimeForBeat(b),
  // instruments + master bus + metronome (build 20)
  jamInstruments: () => JAM_INST_IDS.slice(),
  jamInstrument: () => jam.instrument,
  jamSelectInstrument: (id) => selectJamInstrument(id),
  jamPlayBass: (m, v) => jamPlayBassLocal(m, v),
  jamHitDrum: (d, v) => jamHitDrumLocal(d, v),
  jamHitChord: (i, v) => jamHitChordLocal(i, v),
  jamLastVoice: () => (jam.lastVoice ? { ...jam.lastVoice } : null),
  jamEnsureChain: () => !!jamEnsureChain(),
  jamChain: () => (jam.chain ? {
    hasConv: !!(jam.chain.conv && jam.chain.conv.buffer),
    hasComp: !!jam.chain.comp,
    delayTime: jam.chain.delay ? jam.chain.delay.delayTime.value : null,
    gains: Object.keys(jam.chain.gains || {}),
  } : null),
  jamSetMetro: (on, vol) => jamSetMetro(on, vol),
  jamMetro: () => ({ ...jam.metro }),
  jamPeerInst: (pid) => jamPeerInst.get(pid) || null,
  // build 39: deeper synth + overdub looper
  jamSynth: () => ({ ...jam.synth }),
  jamSetSynth: (k, v) => { if (k in jam.synth) { jam.synth[k] = v; jamSyncSynthUI(); return true; } return false; },
  jamPreset: (name) => jamApplyPreset(name),
  jamPresets: () => Object.keys(JAM_PRESETS),
  jamScale: () => jam.scale,
  jamSetScale: (s) => {
    if (!JAM_SCALES[s]) return false;
    jam.scale = s;
    document.querySelectorAll('.jam-scale').forEach((x) => x.classList.toggle('sel', x.dataset.scale === s));
    buildJamKeys();
    buildJamLeadChords();
    return true;
  },
  jamKeyCount: () => (jamKeysEl ? jamKeysEl.children.length : 0),
  loopState: () => ({
    state: dub.state,
    dur: dub.dur, hasBuf: !!dub.buf,
    bufLen: dub.buf ? dub.buf.length : 0, sampleRate: audio.ctx ? audio.ctx.sampleRate : 0,
    takeIdx: dub.take ? dub.take.idx : 0,
  }),
  loopMain: () => loopMainButton(),
  loopRecord: () => loopRecord(),
  loopClose: () => loopClose(),
  loopPlay: () => loopPlay(),
  loopStop: () => loopStop(),
  loopClear: () => loopClear(),
  loopRenderUI: () => loopRenderUI(),
  // build 66: workshop / stage / FOH seams
  workshopAdd: (t) => wsAdd(t),
  workshopPieces: () => ws.pieces.map((p) => p.type),
  workshopSave: (n) => wsSaveModel(n),
  workshopModels: () => Object.keys(wsLoadModels()),
  workshopLoad: (n) => wsLoadModel(n),
  workshopState: () => ({ pieces: ws.pieces.length, sel: ws.sel, open: ws.open }),
  workshopDelete: (n) => wsDeleteModel(n),
  // build 69: shared shelf seams
  shelfState: () => [...wsShelf.values()].map((e) => ({ name: e.name, by: e.by, pieces: e.specs.length })),
  shelfRoster: () => wsRosterNames(),
  shelfLoadPeer: (name) => { const e = [...wsShelf.values()].find((x) => x.name === name); return e ? wsShelfLoadEntry(e) : false; },
  shelfPayloadLen: (name) => { const m = wsLoadModels()[name]; return m ? JSON.stringify(m).length : -1; },
  shelfPending: () => wsPendingModels.size,
  netRelay: () => { try { return !!net.relayMode; } catch (e) { return false; } },
  // build 68: sculpt mode seams
  sculptEnter: () => sculptEnter(),
  sculptExit: () => sculptExit(),
  sculptBrush: (b) => sculptSetBrush(b),
  sculptDetail: (d) => sculptSetDetail(d),
  sculptSym: (v) => sculptSetSym(v),
  sculptInvert: (v) => sculptSetInvert(v),
  sculptStroke: (x1, y1, x2, y2, steps) => sculptNdcStroke(x1, y1, x2, y2, steps),
  sculptUndoStroke: () => sculptUndo(),
  sculptDispStats: () => sculptDispStats(),
  sculptState: () => ({
    active: sculpt.active, brush: sculpt.brush, detail: sculpt.detail,
    sym: sculpt.sym, invert: sculpt.invert,
    verts: sculpt.mesh ? sculpt.mesh.geometry.attributes.position.count : 0,
    strokes: sculpt.strokeCount, undoDepth: sculpt.undo.length,
  }),
  stagePlace: (name) => stagePlace(name),
  stageClear: () => stageClear(),
  stageState: () => ({ items: stage.items.length, sel: stage.sel }),
  fohSet: (patch) => fohApplyPatch(patch, true),
  fohReset: () => fohReset(),
  fohState: () => ({ ...foh }),
  soundAnim: () => (worlds && worlds.soundroom && worlds.soundroom.anim) || null,
  wsGroupCount: () => (wsGroup ? wsGroup.children.length : -1),
  // build 39: rhythm sequencer hooks
  seqOn: (on) => seqSetOn(on),
  seqToggle: () => seqSetOn(!seq.on),
  seqState: () => ({ on: seq.on, hits: seq.hits, step: seq.step % 16 }),
  seqHits: () => seq.hits,
  seqStep: (vi, s) => {
    vi = Math.max(0, Math.min(SEQ_VOICES.length - 1, vi | 0));
    s = Math.max(0, Math.min(15, s | 0));
    seq.steps[vi][s] = !seq.steps[vi][s];
    seqRenderSteps();
    return seq.steps[vi][s];
  },
  seqSteps: () => seq.steps.map((r) => r.slice()),
  seqPreset: (name) => seqApplyPreset(name),
  seqSwing: (v) => { seq.swing = Math.max(0, Math.min(0.6, Number(v) || 0)); },
  // build 39: lead chord pads + polyphony diagnostics
  playChord: (degree) => jamPlayChordLocal(jamLeadChordMidis(degree | 0), 0.85),
  leadChordCount: () => (jamLeadChordsEl ? jamLeadChordsEl.children.length : 0),
  leadChordMidis: (degree) => jamLeadChordMidis(degree | 0),
  synthVoices: () => synthVoiceCount(),
  // build 39 diagnostic: peak |sample| of the loop buffer (0 when empty/silent)
  loopBufPeak: () => {
    if (!dub.buf) return 0;
    let peak = 0;
    for (let chI = 0; chI < dub.buf.numberOfChannels; chI++) {
      const d = dub.buf.getChannelData(chI);
      const step = Math.max(1, Math.floor(d.length / 4000));
      for (let i = 0; i < d.length; i += step) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    return Math.round(peak * 1000) / 1000;
  },
  // test helper (build 28): simulate holding the clock without playing a note
  jamSimulateDj: (on) => { if (on) jamEnsureClock(); else jamStopClock(); renderJamTransport(); },
  // test helpers (build 17): drive the sampler's ring buffer deterministically
  // test helper (build 28): inject a MediaStream into the jam bus so the
  // sampler's ring hears a deterministic signal
  jamInjectTestStream: (stream) => {
    const ch = jamEnsureChain();
    if (!ch || !ch.bus || !stream) return false;
    try {
      if (jam.testSrc) { try { jam.testSrc.disconnect(); } catch (e) {} jam.testSrc = null; }
      const src = audio.ctx.createMediaStreamSource(stream);
      src.connect(ch.bus);
      jam.testSrc = src;
      return true;
    } catch (e) { return false; }
  },
  jamTestRecInfo: () => (jam.rec ? {
    w: jam.rec.w, total: jam.rec.total, ringLen: jam.rec.ring.length,
    sr: jam.rec.ctx.sampleRate, lastGrab: jam.lastGrab || null,
  } : null),
  jamTestRecFreeze: (w, total) => {
    const r = jam.rec;
    if (!r) return false;
    r.proc.onaudioprocess = null; // stop the writer; the test owns the ring now
    r.w = w; r.total = total;
    return true;
  },
  jamTestRingSet: (i, v) => {
    const r = jam.rec;
    if (!r) return false;
    r.ring[(((i % r.ring.length) + r.ring.length) % r.ring.length)] = v;
    return true;
  },
  jamTestRingAt: (i) => {
    const r = jam.rec;
    return r ? r.ring[(((i % r.ring.length) + r.ring.length) % r.ring.length)] : null;
  },
  jamTestRingFill: (v) => { if (jam.rec) jam.rec.ring.fill(v); return !!jam.rec; },
  jamTestPadHead: (i, n) => {
    const b = jam.pads[i];
    return b ? Array.from(b.getChannelData(0).slice(0, n || 256)) : null;
  },
  // room sampler (build 24): tab-audio capture of the room mix
  jamRoomSupported,
  jamRoomSample,
  jamRoomTestInfo: () => ({
    sampling: jam.room.sampling,
    requesting: jam.room.requesting,
    supported: jamRoomSupported(),
    last: jam.room.lastCapture ? { ...jam.room.lastCapture } : null,
  }),
  jamTestRoomLen: (s) => { jam.room.lenOverride = s; },
  jamTestPadRms: (i) => {
    const b = jam.pads[i];
    if (!b) return null;
    let sum = 0; const d = b.getChannelData(0);
    for (let k = 0; k < d.length; k++) sum += d[k] * d[k];
    return Math.sqrt(sum / d.length);
  },
  // build 25: which pad the last grab landed in + ring-buffer signal level
  jamLastGrabSlot: () => jam.lastGrabSlot,
  jamTestRingRms: (sec) => {
    const r = jam.rec;
    if (!r) return null;
    try {
      const L = r.ring.length;
      const n = Math.min(L, Math.floor((sec || 4) * r.ctx.sampleRate));
      let s = 0;
      for (let k = 0; k < n; k++) {
        const idx = (((r.w - 1 - k) % L) + L) % L;
        s += r.ring[idx] * r.ring[idx];
      }
      return Math.sqrt(s / n);
    } catch (e) { return null; }
  },
  // community wall (build 18; build 19: planeW/planeH report the
  // in-world size so tests can verify the 2x scale-up)
  wallState: () => {
    const wm = worlds.soundroom && worlds.soundroom.anim && worlds.soundroom.anim.wallMesh;
    const pg = wm && wm.geometry && wm.geometry.parameters;
    return {
      strokes: wall.strokeCount, w: WALL_W, h: WALL_H,
      hasTexture: !!(wall.tex && wall.tex.isCanvasTexture),
      planeInScene: !!wm,
      planeW: pg ? pg.width : null,
      planeH: pg ? pg.height : null,
      paintOpen: paint.open,
    };
  },
  wallTex: () => wall.tex,
  wallPixel: (x, y) => {
    const d = wall.ctx.getImageData(x | 0, y | 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  },
  wallStrokeLocal: (pts, color, size, blend) => {
    // a full local gesture: drawn + logged as one undoable entry (byMe)
    const id = wallNextStrokeId();
    wallDrawSeg(pts, color, size, blend);
    wallLogAppend(id, pts, color, size, true, blend);
    return wall.strokeCount;
  },
  wallSample: () => wallSample(),
  wallAmbColor: () => {
    const a = worlds.soundroom && worlds.soundroom.anim;
    return a && a.amb ? a.amb.color.getHex() : null;
  },
  // deterministic room-reactivity check: sample now, snap the light to target
  wallReactSnap: () => {
    const a = worlds.soundroom && worlds.soundroom.anim;
    if (!a || !a.amb) return null;
    wallReactSample(a);
    a.amb.color.copy(a.wallTarget);
    return a.amb.color.getHex();
  },
  wallOpen: (o) => setPaintOpen(o === undefined ? true : !!o),
  wallPaintVisible: () => !!(paintBtn && paintBtn.style.display !== 'none'),
  wallValid: (d) => wallValidStroke(d),
  wallHandleStroke: (d, pid) => handleWallStroke(pid || 'test-peer', d),
  wallExportPng: () => wallExportPng(),
  wallLoopback: (d) => {
    const ok = wallValidStroke(d);
    if (net.sendWallStroke) { try { net.sendWallStroke(d); } catch (e) {} }
    handleWallStroke('loopback', d);
    return ok;
  },
  wallSnapshot: () => wallSnapshot(),
  wallApplySnapshot: (u) => wallApplySnapshot(u),
  wallHandleSync: (d, pid) => handleWallSync(pid || 'test-peer', d),
  wallSendSyncReq: (id) => { try { return !!(net.sendWallSyncReq && net.sendWallSyncReq({ reqId: id, ts: wall.ts })); } catch (e) { return false; } },
  wallHandleSyncReq: (d, pid) => handleWallSyncReq(pid || 'test-peer', d),
  wallAnswered: () => [...wall.answeredReq],
  // community wall persistence (build 26)
  wallTs: () => wall.ts,
  wallTestSetTs: (t) => { wall.ts = t; return wall.ts; },
  wallSaveSnapshotNow: () => wallSaveSnapshot(),
  wallRestoreSnapshot: () => wallRestoreSnapshot(),
  wallHandleHello: (d, pid) => handleWallHello(pid || 'test-peer', d),
  wallHelloSend: (ts) => { try { return !!(net.sendWallHello && net.sendWallHello({ ts })); } catch (e) { return false; } },
  // community wall undo (build 26)
  wallUndo: () => wallUndoMyLast(),
  wallHandleUndo: (d, pid) => handleWallUndo(pid || 'test-peer', d),
  wallUndoSend: (id) => { try { return !!(net.sendWallUndo && net.sendWallUndo({ id })); } catch (e) { return false; } },
  wallLog: () => wall.log.map((e) => ({ id: e.id, byMe: e.byMe, pts: e.points.length, eraser: e.eraser, blend: !!e.blend })),
  wallTestSetCap: (n) => { wall.logCap = n; return wall.logCap; },
  wallTestSetLastLocal: (t) => { wall.lastLocalStroke = t; return wall.lastLocalStroke; },
  wallPendingSync: () => !!wall.pendingSync,
  // jukebox (build 21)
  jukeState: () => ({
    open: juke.open,
    queue: juke.queue.map((t) => ({ ...t })),
    now: juke.now ? { ...juke.now } : null,
    joinWaiting: juke.joinWaiting,
    volume: juke.volume,
    hasPlayer: !!juke.player,
    playerKind: juke.player ? juke.player.kind : null,
  }),
  jukeOpen: () => setJukePanel(true),
  jukeClose: () => setJukePanel(false),
  jukeIsOpen: () => juke.open,
  jukeBtnVisible: () => !!(jukeBtn && jukeBtn.style.display !== 'none'),
  jukeDetect: (u) => jukeDetectProvider(u),
  jukeAdd: (u, t) => jukeAddTrack(u, t),
  jukeRemove: (id) => jukeRemoveTrack(id),
  jukeHandleAdd: (d, pid) => handleJukeAdd(pid || 'test-peer', d),
  jukeHandleRemove: (d, pid) => handleJukeRemove(pid || 'test-peer', d),
  jukeHandlePlay: (d, pid) => handleJukePlay(pid || 'test-peer', d),
  jukeHandleSkip: (d, pid) => handleJukeSkip(pid || 'test-peer', d),
  jukeHandleState: (d, pid) => handleJukeState(pid || 'test-peer', d),
  jukeHandleStateReq: (d, pid) => handleJukeStateReq(pid || 'test-peer', d),
  jukeAdvance: () => jukeAdvance(),
  jukeSkipNow: () => jukeSkipNow(),
  jukeOffsetFor: (d, nowMs) => jukeOffsetFor(d, nowMs),
  jukeValidPlay: (d) => jukeValidPlay(d),
  jukeResyncTick: () => jukeResyncTick(),
  jukeTrackOver: () => jukeTrackOver(),
  jukeSetFactory: (f) => jukeSetFactory(f),
  jukeSetVolume: (v) => jukeSetVolume(v),
  jukeJoinTap: () => jukeJoinTap(),
  // build 40: mixer + relay seams
  mixerSet: (src, v) => mixerSet(src, v),
  mixerLevels: () => ({ ...mixer.levels }),
  mixerGains: () => {
    const ch = (typeof audio !== 'undefined' && audio.ctx && jam.chain) || null;
    const o = {};
    if (ch && ch.gains) for (const k of Object.keys(ch.gains)) {
      try { o[k] = +ch.gains[k].gain.value.toFixed(4); } catch (e) {}
    }
    return o;
  },
  netIsRelay: () => netIsRelay(),
  netSetRelay: (v) => { try { net.relayMode = !!v; return net.relayMode; } catch (e) { return false; } },
  jukeResolveShortLink: (u) => jukeResolveShortLink(u),
  jukeRemoveGroup: (g) => jukeRemoveGroup(g),
  jukePlayerInfo: () => { // test seam: live read of the real provider player
    if (!juke.player) return null;
    const o = { kind: juke.player.kind };
    try { o.pos = juke.player.pos(); } catch (e) { o.pos = null; }
    try { o.dur = juke.player.dur(); } catch (e) { o.dur = null; }
    try { o.state = juke.player.state ? juke.player.state() : null; } catch (e) {}
    try { o.playingFlag = !!juke.player.playingFlag; } catch (e) {}
    try { if (!o.playingFlag && typeof juke.player.playing === 'function') o.playingFlag = !!juke.player.playing(); } catch (e) {}
    try { o.warm = !!juke.player.warm; } catch (e) {}
    try { if (juke.direct) { o.directMode = juke.direct.mode; o.captureOk = !!juke.direct.captureOk; } } catch (e) {}
    return o;
  },
  // build 25 test seams: invisible players + direct audio
  jukePrewarm: () => jukePrewarm(),
  jukeWarmState: () => ({
    prewarmed: juke.prewarmed,
    yt: !!(juke.warmYt && juke.warmYt.ready),
    sc: !!(juke.player && juke.player.kind === 'soundcloud'), // build 55: per-track, no warm widget
  }),
  jukeDirectRms: () => jukeDirectRms(),
  // build 27: phone-file P2P
  jukeAddPhoneFile: (f) => jukeAddPhoneFile(f),
  jukePhoneState: (fileId) => ({
    stored: !!(juke.phoneFiles[fileId] && juke.phoneFiles[fileId].buf),
    size: juke.phoneFiles[fileId] && juke.phoneFiles[fileId].buf ? juke.phoneFiles[fileId].buf.length : 0,
    fetch: juke.phoneFetch[fileId] ? {
      got: juke.phoneFetch[fileId].got, n: juke.phoneFetch[fileId].n,
      done: !!juke.phoneFetch[fileId].done, server: juke.phoneFetch[fileId].server,
    } : null,
  }),
  jukeHandleFileReq: (d, pid) => handleJukeFileReq(d, pid || 'test-peer'),
  jukeHandleFileChunk: (d, pid) => handleJukeFileChunk(d, pid || 'test-peer'),
  jukeHandleFileHave: (d, pid) => handleJukeFileHave(d, pid || 'test-peer'),
  jukePhoneChunkSize: () => JUKE_PHONE_CHUNK,
  jukeB64: { encode: (u8) => jukeB64encode(u8), decode: (s) => jukeB64decode(s) },
  jukePhoneProgressText: () => { const el = document.getElementById('juke-now-title'); return el ? el.textContent : null; },
  jukeTestPhoneFetch: (d) => jukeRequestPhoneFile(d),
  // phone-first: WebAudio unlock state (must be 'running' after a gesture)
  audioCtxState: () => { try { return audio.ctx ? audio.ctx.state : null; } catch (e) { return null; } },
};
