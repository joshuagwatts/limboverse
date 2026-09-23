/* LIMBO — couch co-op transport (build 34): offline LAN multiplayer.
 *
 * Thanksgiving mode: no internet, no house wifi, no phone data. One
 * Android phone turns on its hotspot (a hotspot is a network even with no
 * data — the phones just talk to each other over the radio). Every phone
 * opens LIMBO (already cached by the service worker, so it boots with
 * zero bars) and links up with QR codes:
 *
 *   host:  "host a couch game" -> shows an offer QR
 *   guest: "join a couch game" -> scans it -> shows an answer QR
 *   host:  scans the answer QR -> data channel opens -> they're in
 *
 * No STUN/TURN (it's a LAN — host candidates are enough), no signaling
 * server, no room keys. iPhones can JOIN but never HOST (Apple gates the
 * hotspot on cellular) — the UI says so.
 *
 * TOPOLOGY — star: every guest connects directly to the host, and the host
 * RELAYS broadcasts (wisps, chat, jam, wall, jukebox) to the other guests,
 * plus routes targeted messages (file chunks) by cid. Guests never talk
 * to each other directly.
 *
 * INTERFACE — deliberately mirrors LimboNet (js/net.js): same callback
 * properties (onWispCb, onChatCb, ...), same send* names, same
 * broadcast()/say()/peerCount()/join()/leave() shapes, same payload
 * convention ({cid, ...data}). game.js talks to whichever transport is
 * active through a dispatcher proxy, so realms, jukebox, paint, chat and
 * flocking all work unchanged over either transport.
 *
 * One real difference: online mode has one Trystero room per realm; couch
 * mode has ONE lan room for everybody. Room separation is done in the
 * transport: every broadcast carries the sender's current roomKey (`r`),
 * and incoming room-scoped actions are dropped when `d.r` isn't our
 * current room. Peer join/leave are transport-level and always delivered.
 *
 * Build 48: reads the module's own ?v= cache-bust — always the running build.
 */

const BUILD = (() => {
  try {
    const m = String(import.meta.url || '').match(/[?&]v=(\d+)/);
    return m ? m[1] : '?';
  } catch (e) { return '?'; }
})();
const MAX_NAME = 16;
const QR_PREFIX = 'LIMBO1:';
const DC_LABEL = 'limbo-couch';
/* How long we wait for ICE gathering before encoding the QR anyway. On a
   LAN with no STUN this is nearly instant (host candidates only). */
const GATHER_TIMEOUT_MS = 6000;

/* Room-scoped actions: dropped on receive unless the sender was in our
   current room. Targeted actions (file chunks) ride the star addressed by
   cid and are never room-filtered. */
const ROOM_SCOPED = new Set([
  'wisp', 'chat',
  'jamClock', 'jamNote', 'jamPad',
  'wallStroke', 'wallSyncReq', 'wallSync', 'wallHello', 'wallUndo',
  'jukeAdd', 'jukeRemove', 'jukePlay', 'jukeSkipVote',
  'jukeStateReq', 'jukeState', 'jukeFileHave', 'jukeLike',
  'stageSync', 'stageReq', 'fohSync', 'fohReq', // build 66: stage + front of house
  'modelShare', 'modelDel', 'modelReq', 'modelChunk', // build 69: model-room shelf
]);
const TARGETED = new Set(['jukeFileReq', 'jukeFileChunk']);
/* Internal control actions, never room-filtered, never reach game.js. */
const INTERNAL = new Set(['hello', 'peerJoin', 'peerLeave', 'peerRoster']);

function makeClientId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* ignore */ }
  return 'couch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* Strip SDP lines that cost QR bytes and buy nothing on a LAN datachannel:
   extmap, msid, ssrc groups, trickle option. Candidates stay — with no
   trickle the answerer needs them all up front. */
function stripSdp(sdp) {
  const kept = String(sdp)
    .split('\r\n')
    .filter((l) => {
      const t = l.trim();
      return (
        t &&
        !t.startsWith('a=extmap') &&
        !t.startsWith('a=msid-semantic') &&
        !t.startsWith('a=ssrc-group') &&
        !t.startsWith('a=ssrc:') &&
        !t.startsWith('a=ice-options:')
      );
    });
  // SDP parsers want the trailing CRLF — keep it (2 bytes, not worth the fight).
  return kept.join('\r\n') + '\r\n';
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(b64) {
  let s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* 'LIMBO1:O:<b64>' (offer) or 'LIMBO1:A:<b64>' (answer). The prefix lets
   the scanner ignore every random QR in the room. */
function encodePayload(kind, sdp) {
  return QR_PREFIX + kind + ':' + b64urlEncode(sdp);
}

function decodePayload(text) {
  try {
    const t = String(text || '').trim();
    if (!t.startsWith(QR_PREFIX)) return null;
    const kind = t.charAt(QR_PREFIX.length);
    if (kind !== 'O' && kind !== 'A') return null;
    if (t.charAt(QR_PREFIX.length + 1) !== ':') return null;
    const sdp = b64urlDecode(t.slice(QR_PREFIX.length + 2));
    if (!sdp || sdp.indexOf('v=0') !== 0) return null;
    return { kind, sdp };
  } catch (e) {
    return null;
  }
}

function r1(v) {
  return Math.round(v * 10) / 10;
}

export class CouchNet {
  constructor() {
    this.build = BUILD;
    this.couchMode = true; // lets game.js branch (peer-count text, etc.)
    this.enabled = false; // true once hosting or linked to a host
    this.isHost = false;
    this.clientId = makeClientId();
    this.name = 'drifter';
    this.roomKey = null; // current realm room (drives room-scoped filtering)
    this.joinedAt = 0;
    /* Direct data-channel peers: cid -> {pc, dc, name}. Host: every guest.
       Guest: just the host. */
    this.peers = new Map();
    /* Everyone we know about (for peerCount + the debug HUD). Host: same
       as peers. Guest: host + everyone the host announces. */
    this.roster = new Map(); // cid -> {name}
    this.cosmetics = null;
    // --- callbacks: same names as LimboNet ---
    this.onWispCb = null;
    this.onChatCb = null;
    this.onPeerLeaveCb = null;
    this.onQuietCb = null;
    this.onJamClockCb = null;
    this.onJamNoteCb = null;
    this.onJamPadCb = null;
    this.onWallStrokeCb = null;
    this.onWallSyncReqCb = null;
    this.onWallSyncCb = null;
    this.onWallHelloCb = null;
    this.onWallUndoCb = null;
    this.onJukeAddCb = null;
    this.onJukeRemoveCb = null;
    this.onJukePlayCb = null;
    this.onJukeSkipVoteCb = null;
    this.onJukeFileReqCb = null;
    this.onJukeFileChunkCb = null;
    this.onJukeFileHaveCb = null;
    this.onJukeStateReqCb = null;
    this.onJukeStateCb = null;
    this.onJukeLikeCb = null;
    this.onPresenceCb = null; // never fires in couch mode (no lobby)
    // --- ceremony state ---
    this._pending = []; // host: [{pc, dc}] awaiting their hello
    this._awaitingAnswer = null; // host: the pc whose answer we're scanning for
    this._guestPc = null; // guest: our single pc to the host
    this._hostCid = null; // guest: the host's cid once known
    this.onRosterCb = null; // () — roster changed (game.js re-renders)
    this._log = [];
  }

  cleanName(n) {
    return String(n || 'drifter').trim().slice(0, MAX_NAME) || 'drifter';
  }

  _note(msg) {
    try {
      const t = new Date().toLocaleTimeString('en-GB');
      this._log.push(`${t} ${msg}`);
      if (this._log.length > 120) this._log.shift();
    } catch (e) { /* never break networking */ }
  }

  /* Best-effort boot: WebRTC is native, nothing to load. Always true —
     the failure mode this guards against (no WebRTC at all) doesn't
     exist on any phone browser that runs the game. */
  async boot(name) {
    this.name = this.cleanName(name);
    this.clientId = makeClientId();
    this.enabled = false;
    this._note(`boot as ${this.name} (${String(this.clientId).slice(0, 8)})`);
    return true;
  }

  /* ---------------- QR ceremony ---------------- */

  /* Host: mint a fresh offer per guest. Throws if a previous offer is
     still awaiting its answer — the UI pairs strictly sequentially. */
  async createHostOffer() {
    if (this._awaitingAnswer) throw new Error('an offer is already awaiting its answer');
    this.isHost = true;
    this.enabled = true;
    const pc = new RTCPeerConnection({ iceServers: [] }); // LAN: host candidates only
    const dc = pc.createDataChannel(DC_LABEL);
    this._wireHostChannel(pc, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitGathering(pc);
    const payload = encodePayload('O', stripSdp(pc.localDescription.sdp));
    this._pending.push({ pc, dc });
    this._awaitingAnswer = pc;
    this._note(`host offer minted (${payload.length} chars)`);
    return payload;
  }

  /* Guest: scanned the host's offer -> mint our answer. */
  async acceptHostOffer(payload) {
    const dec = decodePayload(payload);
    if (!dec || dec.kind !== 'O') throw new Error('that code is not a host offer');
    this.isHost = false;
    this.enabled = true;
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.ondatachannel = (ev) => this._wireGuestChannel(pc, ev.channel);
    await pc.setRemoteDescription({ type: 'offer', sdp: dec.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitGathering(pc);
    this._guestPc = pc;
    const out = encodePayload('A', stripSdp(pc.localDescription.sdp));
    this._note(`guest answer minted (${out.length} chars)`);
    return out;
  }

  /* Host: scanned the guest's answer -> the channel opens. */
  async acceptGuestAnswer(payload) {
    const dec = decodePayload(payload);
    if (!dec || dec.kind !== 'A') throw new Error("that code is not a guest's answer");
    const pc = this._awaitingAnswer;
    if (!pc) throw new Error('no offer is awaiting an answer right now');
    await pc.setRemoteDescription({ type: 'answer', sdp: dec.sdp });
    this._awaitingAnswer = null;
    this._note('guest answer accepted — channel opening');
    return true;
  }

  /* Host is done showing the current offer (guest walked away, etc). */
  cancelPendingOffer() {
    const pc = this._awaitingAnswer;
    this._awaitingAnswer = null;
    if (pc) {
      this._pending = this._pending.filter((p) => p.pc !== pc);
      try { pc.close(); } catch (e) { /* ignore */ }
      this._note('pending offer cancelled');
    }
  }

  _waitGathering(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => {
        pc.removeEventListener('icecandidate', onCand);
        pc.removeEventListener('icegatheringstatechange', onState);
        clearTimeout(timer);
        resolve();
      };
      const onCand = (ev) => { if (!ev.candidate) done(); };
      const onState = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      pc.addEventListener('icecandidate', onCand);
      pc.addEventListener('icegatheringstatechange', onState);
    });
  }

  /* ---------------- data channel plumbing ---------------- */

  _sendRaw(dc, obj) {
    try {
      if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
    } catch (e) { /* best effort */ }
  }

  _wireHostChannel(pc, dc) {
    dc.onopen = () => {
      this._note('host: guest channel open — sending hello');
      this._sendRaw(dc, { a: 'hello', d: { cid: this.clientId, name: this.name } });
    };
    dc.onmessage = (ev) => this._onMessage(dc, ev.data);
    const gone = () => this._dropPeerByDc(dc);
    dc.onclose = gone;
    dc.onerror = () => { /* onclose follows */ };
    try {
      pc.onconnectionstatechange = () => {
        this._note(`host pc state: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') gone();
      };
    } catch (e) { /* ignore */ }
  }

  _wireGuestChannel(pc, dc) {
    dc.onopen = () => {
      this._note('guest: host channel open — sending hello');
      this._sendRaw(dc, { a: 'hello', d: { cid: this.clientId, name: this.name } });
    };
    dc.onmessage = (ev) => this._onMessage(dc, ev.data);
    const gone = () => {
      // The host is gone — the whole star is gone.
      this._note('guest: host channel closed');
      this.shutdown();
      if (this.onHostGoneCb) { try { this.onHostGoneCb(); } catch (e) { /* ignore */ } }
    };
    dc.onclose = gone;
    dc.onerror = () => { /* onclose follows */ };
    try {
      pc.onconnectionstatechange = () => {
        this._note(`guest pc state: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') gone();
      };
    } catch (e) { /* ignore */ }
  }

  /* Claim a pending host channel for the hello's cid (pairing is strictly
     sequential, so the oldest pending entry is always the right one). */
  _claimPending(cid, name) {
    const pend = this._pending.shift();
    if (!pend) return null;
    this.peers.set(cid, { pc: pend.pc, dc: pend.dc, name });
    this.roster.set(cid, { name });
    return this.peers.get(cid);
  }

  _onMessage(dc, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.a !== 'string') return;
    const d = msg.d || {};
    const fromCid = typeof d.cid === 'string' && d.cid ? d.cid : null;

    // --- internal control plane ---
    if (msg.a === 'hello') {
      if (!fromCid || fromCid === this.clientId) return;
      const nm = this.cleanName(d.name);
      if (this.isHost) {
        const rec = this._claimPending(fromCid, nm);
        if (!rec) return; // stray hello — ignore
        this._note(`guest paired: ${nm} (${fromCid.slice(0, 8)})`);
        // Tell the newcomer who's already here, then announce them.
        this._sendRaw(rec.dc, {
          a: 'peerRoster',
          d: { cid: this.clientId, peers: [...this.roster.entries()]
            .filter(([id]) => id !== fromCid)
            .map(([id, p]) => ({ cid: id, name: p.name })) },
        });
        this._relayAll({ a: 'peerJoin', d: { cid: this.clientId, peer: { cid: fromCid, name: nm } } }, fromCid);
        this._rosterChanged();
      } else {
        this._hostCid = fromCid;
        this.peers.set(fromCid, { pc: this._guestPc, dc, name: nm });
        this.roster.set(fromCid, { name: nm });
        this._note(`linked to host ${nm} (${fromCid.slice(0, 8)})`);
        this._rosterChanged();
      }
      return;
    }
    if (msg.a === 'peerRoster') {
      // Host -> newcomer: everyone already here.
      if (this.isHost || !Array.isArray(d.peers)) return;
      for (const p of d.peers) {
        if (p && p.cid && p.cid !== this.clientId) this.roster.set(p.cid, { name: this.cleanName(p.name) });
      }
      this._rosterChanged();
      return;
    }
    if (msg.a === 'peerJoin') {
      // Host -> guests: someone new arrived.
      if (this.isHost || !d.peer || !d.peer.cid) return;
      if (d.peer.cid === this.clientId) return;
      this.roster.set(d.peer.cid, { name: this.cleanName(d.peer.name) });
      this._note(`roster +${this.cleanName(d.peer.name)}`);
      this._rosterChanged();
      return;
    }
    if (msg.a === 'peerLeave') {
      // d.gone is the leaver's cid (d.cid is always the sender — the host).
      if (this.isHost || !d.gone) return;
      this._forgetRoster(d.gone);
      return;
    }

    // --- the star: host relays everything guest-originated ---
    if (this.isHost && fromCid) {
      if (TARGETED.has(msg.a) && msg.to && msg.to !== this.clientId) {
        const target = this.peers.get(msg.to);
        if (target) this._sendRaw(target.dc, msg);
        return; // routed, not for us
      }
      if (!TARGETED.has(msg.a)) {
        // Broadcast: deliver locally only if it's for our room, then relay
        // to every OTHER guest — each guest applies its own room filter.
        if (!ROOM_SCOPED.has(msg.a) || d.r === this.roomKey) this._deliver(msg.a, fromCid, d);
        this._relayAll(msg, fromCid);
        return;
      }
    }

    // Targeted at someone else (shouldn't happen for guests) — drop.
    if (TARGETED.has(msg.a) && msg.to && msg.to !== this.clientId) return;
    // Room-scoped actions from a drifter in another realm — drop.
    if (ROOM_SCOPED.has(msg.a) && d.r !== this.roomKey) return;
    this._deliver(msg.a, fromCid, d);
  }

  _deliver(action, fromCid, d) {
    const cbProp = {
      wisp: 'onWispCb', chat: 'onChatCb',
      jamClock: 'onJamClockCb', jamNote: 'onJamNoteCb', jamPad: 'onJamPadCb',
      wallStroke: 'onWallStrokeCb', wallSyncReq: 'onWallSyncReqCb',
      wallSync: 'onWallSyncCb', wallHello: 'onWallHelloCb', wallUndo: 'onWallUndoCb',
      jukeAdd: 'onJukeAddCb', jukeRemove: 'onJukeRemoveCb', jukePlay: 'onJukePlayCb',
      jukeSkipVote: 'onJukeSkipVoteCb', jukeFileReq: 'onJukeFileReqCb',
      jukeFileChunk: 'onJukeFileChunkCb', jukeFileHave: 'onJukeFileHaveCb',
      jukeStateReq: 'onJukeStateReqCb', jukeState: 'onJukeStateCb',
      jukeLike: 'onJukeLikeCb',
      stageSync: 'onStageSyncCb', stageReq: 'onStageReqCb',
      fohSync: 'onFohSyncCb', fohReq: 'onFohReqCb',
      modelShare: 'onModelShareCb', modelDel: 'onModelDelCb',
      modelReq: 'onModelReqCb', modelChunk: 'onModelChunkCb', // build 69
    }[action];
    if (!cbProp) return;
    const cb = this[cbProp];
    if (cb) {
      try { cb(fromCid || 'unknown', d); } catch (e) { /* game callbacks must never break networking */ }
    }
  }

  _relayAll(msg, exceptCid) {
    for (const [cid, p] of this.peers) {
      if (cid === exceptCid) continue;
      this._sendRaw(p.dc, msg);
    }
  }

  _dropPeerByDc(dc) {
    for (const [cid, p] of this.peers) {
      if (p.dc === dc) {
        this._dropPeer(cid);
        break;
      }
    }
  }

  _dropPeer(cid) {
    const p = this.peers.get(cid);
    if (!p) { this._forgetRoster(cid); return; }
    try { p.dc.close(); } catch (e) { /* ignore */ }
    try { p.pc.close(); } catch (e) { /* ignore */ }
    this.peers.delete(cid);
    this._note(`peer dropped: ${p.name} (${String(cid).slice(0, 8)})`);
    // d.gone carries the leaver — d.cid is reserved for the sender (us).
    if (this.isHost) this._relayAll({ a: 'peerLeave', d: { cid: this.clientId, gone: cid } }, cid);
    this._forgetRoster(cid);
  }

  _forgetRoster(cid) {
    if (this.roster.delete(cid)) {
      if (this.onPeerLeaveCb) {
        try { this.onPeerLeaveCb(cid); } catch (e) { /* ignore */ }
      }
      this._rosterChanged();
    }
  }

  _rosterChanged() {
    if (this.onRosterCb) { try { this.onRosterCb(); } catch (e) { /* ignore */ } }
  }

  /* ---------------- LimboNet-shaped sends ---------------- */

  _withMeta(data) {
    let out;
    try { out = Object.assign({ cid: this.clientId, r: this.roomKey }, data); }
    catch (e) { out = { cid: this.clientId, r: this.roomKey }; }
    return out;
  }

  _bcast(action, data) {
    if (!this.enabled) return;
    const msg = { a: action, d: this._withMeta(data) };
    for (const [, p] of this.peers) this._sendRaw(p.dc, msg);
    // The host also delivers to itself (game.js expects local echo paths
    // to behave like online mode — actually no: online _bcast does NOT
    // echo locally either. Keep parity: no local echo.)
  }

  _sendTo(action, data, target) {
    if (!this.enabled || target == null) return;
    const t = String(target);
    if (t === this.clientId) return;
    const msg = { a: action, to: t, d: this._withMeta(data) };
    if (this.isHost) {
      const p = this.peers.get(t);
      if (p) this._sendRaw(p.dc, msg);
    } else {
      // Guests route through the host (the star).
      const h = this._hostCid && this.peers.get(this._hostCid);
      if (h) this._sendRaw(h.dc, msg);
    }
  }

  sendWisp(d) { this._bcast('wisp', d); }
  sendChat(d) { this._bcast('chat', d); }
  sendJamClock(d) { this._bcast('jamClock', d); }
  sendJamNote(d) { this._bcast('jamNote', d); }
  sendJamPad(d) { this._bcast('jamPad', d); }
  sendWallStroke(d) { this._bcast('wallStroke', d); }
  sendWallSyncReq(d) { this._bcast('wallSyncReq', d); }
  sendWallSync(d) { this._bcast('wallSync', d); }
  sendWallHello(d) { this._bcast('wallHello', d); }
  sendWallUndo(d) { this._bcast('wallUndo', d); }
  sendJukeAdd(d) { this._bcast('jukeAdd', d); }
  sendJukeRemove(d) { this._bcast('jukeRemove', d); }
  sendJukePlay(d) { this._bcast('jukePlay', d); }
  sendJukeSkipVote(d) { this._bcast('jukeSkipVote', d); }
  sendJukeFileHave(d) { this._bcast('jukeFileHave', d); }
  sendJukeStateReq(d) { this._bcast('jukeStateReq', d); }
  sendJukeState(d) { this._bcast('jukeState', d); }
  sendJukeLike(d) { this._bcast('jukeLike', d); }
  sendStageSync(d) { this._bcast('stageSync', d); } // build 66
  sendStageReq(d) { this._bcast('stageReq', d); } // build 66
  sendFohSync(d) { this._bcast('fohSync', d); } // build 66
  sendFohReq(d) { this._bcast('fohReq', d); } // build 66
  sendModelShare(d) { this._bcast('modelShare', d); } // build 69
  sendModelDel(d) { this._bcast('modelDel', d); } // build 69
  sendModelReq(d) { this._bcast('modelReq', d); } // build 69
  sendModelChunk(d) { this._bcast('modelChunk', d); } // build 69
  sendJukeFileReq(d, target) { this._sendTo('jukeFileReq', d, target); }
  sendJukeFileChunk(d, target) { this._sendTo('jukeFileChunk', d, target); }

  broadcast(pos, fwd) {
    if (!this.enabled) return;
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
      const wisp = { p: [r1(pos.x), r1(pos.y), r1(pos.z)], n: this.name, s, h, t, c };
      if (fwd && typeof fwd.x === 'number') wisp.f = [r1(fwd.x), r1(fwd.y), r1(fwd.z)];
      this.sendWisp(wisp);
    } catch (e) { /* ignore */ }
  }

  say(text) {
    if (!this.enabled) return;
    try { this.sendChat({ n: this.name, t: String(text).slice(0, 140) }); }
    catch (e) { /* ignore */ }
  }

  /* ---------------- room lifecycle (LimboNet-shaped) ---------------- */

  /* Realm hop: only retags the room filter. Peers are transport-level and
     survive hops — leave() never disconnects. */
  join(roomKey) {
    this.roomKey = roomKey;
    this.joinedAt = Date.now();
    // Fresh arrivals announce themselves to the new room's party the same
    // way online mode does (wall + juke late-joiner sync is driven by
    // game.js on goTo — nothing needed here).
  }

  leave() {
    this.roomKey = null;
  }

  /* Full teardown: leaving couch mode entirely. */
  shutdown() {
    this.cancelPendingOffer();
    for (const [cid] of [...this.peers.keys()]) {
      const p = this.peers.get(cid);
      try { p.dc.close(); } catch (e) { /* ignore */ }
      try { p.pc.close(); } catch (e) { /* ignore */ }
    }
    this.peers.clear();
    this._pending = [];
    this._awaitingAnswer = null;
    if (this._guestPc) { try { this._guestPc.close(); } catch (e) { /* ignore */ } this._guestPc = null; }
    this._hostCid = null;
    this.roster.clear();
    this.enabled = false;
    this.isHost = false;
    this.roomKey = null;
    this._rosterChanged();
    this._note('shutdown');
  }

  peerCount() {
    return this.roster.size;
  }

  /* Presence / lobby: none in couch mode (never bridged with online). */
  setPresence() { /* no-op */ }
  joinLobby() { /* no-op */ }
  get lobbyPeers() { return CouchNet._emptyLobby || (CouchNet._emptyLobby = new Map()); }
  _presencePayload() { return { n: this.name, r: this.roomKey || 'nexus', t: Date.now() }; }
  _notePresence() { /* no-op */ }
  _sweepLobby() { /* no-op */ }

  /* ---------------- QR helpers (used by the game UI) ---------------- */

  /* Render a payload to a <canvas> as a crisp QR. window.qrcode comes
     from the vendored qrcode-generator (loaded via classic script tag so
     it works offline). typeNumber 0 = auto-size; 'L' keeps the code as
     small (and scannable) as possible on a phone screen. */
  static qrToCanvas(canvas, text, px = 260) {
    if (!window.qrcode) throw new Error('QR library not loaded');
    const qr = window.qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2; // quiet-zone modules
    const scale = Math.max(1, Math.floor(px / (n + quiet * 2)));
    const size = (n + quiet * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = px + 'px';
    canvas.style.height = px + 'px';
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return { modules: n, size };
  }

  /* Camera scan loop. Resolves {stop} once the camera is live; calls
     onPayload once with the first LIMBO1: payload seen, then stops
     itself. window.jsQR is the vendored scanner. */
  static async startScan(videoEl, onPayload) {
    if (!window.jsQR) throw new Error('QR scanner library not loaded');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', '');
    await videoEl.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    let alive = true;
    let raf = 0;
    const stop = () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      try { videoEl.srcObject = null; } catch (e) { /* ignore */ }
    };
    const tick = () => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      try {
        const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
        if (!vw || !vh) return;
        const w = Math.min(640, vw), h = Math.round((vh / vw) * w);
        if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
        g.drawImage(videoEl, 0, 0, w, h);
        const img = g.getImageData(0, 0, w, h);
        const found = window.jsQR(img.data, w, h);
        if (found && found.data && String(found.data).startsWith(QR_PREFIX)) {
          const payload = String(found.data);
          stop();
          onPayload(payload);
        }
      } catch (e) { /* keep scanning */ }
    };
    tick();
    return { stop };
  }

  static decodePayload(text) {
    return decodePayload(text);
  }

  /* ---------------- diagnostics ---------------- */

  async getDebugSnapshot() {
    const peers = [];
    const all = new Map();
    for (const [cid, p] of this.peers) all.set(cid, p);
    for (const [cid, p] of all) {
      const info = {
        id: `couch:${String(cid).slice(0, 8)}`,
        ice: '?', gathering: '?', conn: '?', localTypes: [], selectedType: 'none',
      };
      try {
        info.ice = p.pc.iceConnectionState || '?';
        info.gathering = p.pc.iceGatheringState || '?';
        info.conn = p.pc.connectionState || '?';
        const stats = await p.pc.getStats();
        const types = new Set();
        stats.forEach((s) => {
          if (s.type === 'local-candidate' && s.candidateType) types.add(s.candidateType);
        });
        info.localTypes = [...types].sort();
      } catch (e) { info.ice = 'stats-err'; }
      peers.push(info);
    }
    return {
      build: this.build,
      enabled: this.enabled,
      couch: true,
      isHost: this.isHost,
      roomKey: this.roomKey || '(none)',
      peerCount: this.peerCount(),
      peers,
      roster: [...this.roster.entries()].map(([cid, p]) => ({ cid: String(cid).slice(0, 8), name: p.name })),
      turnUser: 'n/a (LAN — no TURN)',
      clientId: this.clientId ? String(this.clientId).slice(0, 8) : '(none)',
      lastJoinError: null,
      iceRetry: null,
      log: this._log.slice(-12),
    };
  }
}
