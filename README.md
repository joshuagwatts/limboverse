# LIMBO — a portal universe (prototype)

A playable browser prototype of the LIMBO portal-universe game concept:
you are a **wisp** drifting through a dark Nexus hub. Four portal rings —
each showing a real Holowatts artwork — lead into four **realms**, where the
artwork hangs as one giant flat piece floating in the void. Gather the 5
echo orbs in each realm (20 total). When a realm's echoes are all collected,
it becomes *attuned*.

Drift with others: **serverless P2P multiplayer** (WebRTC via Trystero —
no server, no backend, no accounts) plus **room-local proximity text
chat**. Each location (Nexus + 4 realms + the sound room) is its own room; you see and chat
with whoever is drifting in the same place as you.

Attuning a realm (all 5 echoes) unlocks **wisp customization**: each realm
grants its own wisp skin, and attunement milestones grant hats (party hat,
top hat, crown) and trail styles/colors (ribbon, comet, ghost). Pick your
look in the settings panel — other drifters see your skin, hat, and trail
too. All cosmetics are earned by playing; nothing is paid.

The settings panel also has a **PRINTS** section: each realm's artwork is a
real giclée print in the shop, one tap away.

The **FRIENDS** section keeps a local friends list and shows who's live:
every client heartbeats into a shared lobby room, so you can see which
realm a friend is drifting in and hop straight to them.

The Nexus has a 5th portal — the **SOUND ROOM**, a social listening space
with the four realm artworks hanging as a gallery. Everyone in the room
plays the **jam** together — synth notes, pads, jukebox tracks, sampler
loops, mic — and every client hears the same mix built locally from the
same broadcast notes, so nothing confuses anyone. The room's lights pulse
with the bass. The generative ambient aura ducks out while you're in the
sound room (it fades back in when you leave) — the room is for jam,
jukebox and wall, not the background pad.

The sound room is also a **JAM ROOM**: four instruments on glowing tabs —
**LEAD** (the pocket synth: one chromatic octave, waveform + filter
controls), **BASS** (sub synth, one octave down, punchy), **DRUMS** (a fully
synthesized kit: kick, snare, clap, closed/open hats, shaker), and **PAD**
(four chord pads: i–VI–III–VII in A minor, wide detuned saws with a slow
bloom). Every player picks an instrument; the pick rides every note event
so each client renders the *sender's* voice, and each player's wisp glow
takes their instrument's color. A **personal metronome** (accented on beat
1, volume slider, local-only — nobody else hears it) keeps you on the grid.
The jam master bus runs every instrument through a generated-impulse
convolution reverb and a tempo-synced dotted-eighth delay into a safety
limiter, so the room gets bigger as more players join without ever
clipping. The 4-pad **sampler** grabs loops from the DJ's stream snapped to
the beat grid — post-effects, so grabs capture what the room hears — and
**auto-BPM detection** listens to the music. The DJ is the shared beat
clock — note and pad events are tiny messages and every client synthesizes
the sound locally on the grid, so the jam feels tight despite network
latency. Beat dots pulse with the clock, pads swell on the beat, and the
friends list shows who's jamming (with their instrument color).

The sound room also has a **COMMUNITY WALL**: a monumental 32×16 shared paint
canvas on the north wall (the old gallery piece there was removed to make
room). Hit **🎨 paint** to go fullscreen and draw —
strokes appear live for everyone in the room, and late joiners get the
current canvas synced automatically. The room drinks the wall's colors:
ambient light tints toward the painting's average hue (never near-black)
and the booth glow pulses with paint energy. There's no wipe button —
the only way paint leaves the wall is the **eraser** in paint mode
(background-colored strokes over the same live path); otherwise the wall
persists. The wall lives for the session — refresh and it starts blank again.

Everything is static files — no build step, no backend, no audio files
(all sound is synthesized live with WebAudio).

## Building together

The repo is public — clone it and run it locally, same as above. There is no
build step: edit the files, refresh the browser, done.

**Deploying:** GitHub Pages serves the `main` branch, so pushing to `main`
deploys automatically (takes ~1 minute; watch the Actions tab go green).
**Every deploy must bump the version** or phones will keep running the cached
old copy: `BUILD` in `js/net.js`, `js/game.js?v=N` in `index.html`, and
`./net.js?v=N` in `js/game.js` (keep all three `N`s in sync — currently 10).
`audio.js` only needs a bump when it actually changes.

One rule: talk before pushing to `main` — there's an automated builder on
Joshua's side that works from its own copy and uploads through the GitHub web
UI, so coordinate to avoid stepping on each other's deploys.

## Run it locally

```bash
cd ~/workspace/limbo
python3 -m http.server 8000
# open http://localhost:8000
```

(A plain `file://` open won't work — ES modules + the Three.js CDN import
require http.)

## Deploy to GitHub Pages

Already live at `https://joshuagwatts.github.io/limbo/` — Pages is set to
**Deploy from a branch**, `main` / `/ (root)`. Push to `main` and it
redeploys in about a minute. Remember the version bump (see above).

Notes:
- All paths are relative, so it works identically locally and on Pages.
- Three.js r160 loads from the unpkg CDN, Trystero loads from the esm.sh
  CDN — the page needs internet access.

## Multiplayer + chat (how it works)

- **No server.** Multiplayer runs on [Trystero](https://github.com/dmotz/trystero):
  peers find each other through public BitTorrent trackers, then talk
  directly over WebRTC. Works from static hosting.
- **NAT traversal (why 2-player works on phones).** Trystero core ships
  STUN-only ICE, which fails behind symmetric NAT (mobile carriers / CGNAT).
  `net.js` adds TURN via the OpenRelay **static-auth** scheme (standard
  coturn TURN REST API — the same one Nextcloud Talk / Jitsi use):
  credentials are derived client-side with WebCrypto HMAC-SHA1 from the
  shared secret, valid 24h, refreshed automatically on long sessions.
  `rtcConfig` *replaces* Trystero's default iceServers, so the config also
  carries its own STUN entries:
  `stun:stun.cloudflare.com:3478` + `stun:stun.l.google.com:19302`,
  then `turn:staticauth.openrelay.metered.ca:80`/`:443` and
  `turns:staticauth.openrelay.metered.ca:443`. (The old fixed
  `openrelayproject`/`openrelayproject` password is stale — never used.)
- **Signaling fallback.** If no peer appears within 15s of joining a room,
  the client leaves and rejoins the *same* room key via Trystero's `nostr`
  strategy (`https://esm.sh/@trystero-p2p/nostr@0.25.4` — version-pinned, like
  the torrent strategy, so a silent esm.sh "latest" drift can't break the
  import shape). Both clients run identical logic, so they converge on
  whichever strategy works. One fallback only.
- **One room per location:** `limbo-nexus`, `limbo-realm-1` … `limbo-realm-4`
  (all under the app id `limbo_by_holowatts`). Portal hops leave the old
  room and join the new one, so you only ever see/speak to drifters who are
  *where you are*.
- Your wisp position + name broadcasts ~12Hz; remote wisps render as glowing
  spheres with floating name tags (capped at 15), eased for smoothness.
- **Chat:** tap the chat box (or press **T**) to type, **Enter** to send,
  **Esc** to close. Messages are room-local, 140 chars, and **proximity-based**:
  you only hear drifters within ~40m of you — a message from farther away
  shows as a faint "you sense distant chatter…" hint. The speech-bubble
  button opens the session's chat history; incoming messages also float as
  bubbles above the sender's wisp for a few seconds. Peer join/leave shows
  as quiet system lines ("nova drifted in"). Alone in a realm
  room for 20s and you'll get one gentle nudge: "the void is quiet here —
  drift to the Nexus to find other drifters".
- **Graceful:** if the CDN or WebRTC is unreachable, the game plays exactly
  like the single-player prototype — no errors, no blocking.
- **Debug readout** lives in the settings panel (gear button, or **D** on
  desktop). Live overlay showing the build stamp (so you can confirm a phone
  is running the latest deploy and not a cached copy), signaling strategy, room key, peer count, and — for
  each peer connection — ICE state, gathering state, local candidate types
  (`host`/`srflx`/`relay`), the selected pair type, and trystero's own
  join-error text. `relay` in local candidates = TURN allocation worked;
  host+srflx only = TURN is dead. Updates every second while open.
- **Cache-busting.** `index.html` loads `js/game.js?v=N` and game.js imports
  `./net.js?v=N` — bump `N` (and `BUILD` in `net.js`) on every deploy,
  because mobile browsers aggressively cache the old bundle and a stale
  copy looks exactly like "multiplayer still broken".

## Controls

| Input | Action |
|---|---|
| WASD / arrow keys | fly (camera-relative) |
| Mouse drag | look around (no pointer-lock, works in iframes) |
| Space / E | rise |
| Shift / Q | sink |
| T | chat with drifters in your realm (Enter sends, Esc closes) |
| M | mute / unmute |
| Touch | left-half virtual joystick = fly, right-half drag = look; tap chat box to type |

Fly into a portal ring to travel. Fly into a glowing echo orb to collect it.

## What's in the box

- `index.html` — page + HUD overlays + Three.js importmap (pinned r160)
- `css/style.css` — dark minimal UI, wide-tracked typography
- `js/game.js` — scenes, wisp flight, portals, echoes, transitions, multiplayer rendering, chat
- `js/net.js` — serverless P2P layer (Trystero WebRTC rooms, graceful offline fallback)
- `js/audio.js` — generative ambient pad (retuned per realm) + echo chimes
- `assets/realm1.jpg` … `realm4.jpg` — the four realm artworks (downscaled ≤2048px)
  - realm1 **PRISM DEEP** — *Colorful Worlds*
  - realm2 **MIRROR TIDE** — *Rainbow Deathstar*
  - realm3 **CHROME VEIL** — *BubbleFairy*
  - realm4 **STILL POINT** — *Mind Body n Soul*

## Prototype scope (what was kept simple)

- Echo progress persists for the session only (in-memory).
- 4 realms instead of 59 — the builder functions take any artwork, so scaling
  up is mostly a content pass.
- Third-person follow camera with dreamy inertia rather than full 6-DOF sim.
- Touch controls are functional but basic; desktop is the primary target.
- No VR mode, no persistence backend — those are phase 2+.

## Jukebox (builds 21–25) — synchronized playback, not audio relay

The sound room has a jukebox: anyone can queue a track link, and everyone
hears the same track at the same moment. The honest architecture: we do
**not** relay Spotify/SoundCloud audio between users (DRM, ToS, no API for
it). Instead every client plays the same track at the same wall-clock
offset through an embedded player on their own device — same song, same
moment, ~1s sync. Good enough for hanging out.

- **Supported providers:** YouTube (embedded IFrame player, seek-synced),
  SoundCloud (embedded widget, seek-synced), and **direct audio links**
  (build 25): paste an `.mp3`/`.ogg`/`.wav`/`.m4a`/`.aac`/`.opus`/`.flac`
  URL and it plays through the game's **own WebAudio chain** — reverb and
  delay sends, limiter, master volume, aura-ducking, all of it. The
  sampler's "grab loop" captures it natively, no tab-capture needed.
  Extensionless links (signed URLs, redirects) get one HEAD request at
  queue time to sniff the content-type. Anything else (Spotify, Bandcamp,
  …) gets the **external path**: the room counts down together
  ("press play in your app in 5…") and everyone presses play manually,
  plus an "open in my app ↗" button per track.
- **Invisible players (build 25):** the YouTube/SoundCloud players live in
  1px holders pinned off-screen (`position:fixed; left:-9999px`, zero
  opacity, no pointer events) — never `display:none`, which throttles some
  players, and never inside the panel, so closing the panel can't tear them
  down. Nothing about them can intercept touches or overlap the game.
- **Warm persistent players (build 25):** one YouTube player and one
  SoundCloud widget are built once, inside the start-tap gesture (so
  autoplay is allowed), and reused for every track via `cueVideoById` /
  `widget.load()` — no per-track iframe churn, no reload flash. First play
  after queueing starts inside your tap.
- **Playback watchdog (build 25):** if a track shows no progress ~6s after
  it should be playing, the client tries one recovery (re-cue / reload at
  the room offset); if that fails too, the room gets the honest error
  instead of silence. Autoplay blocks still surface the pulsing "tap to
  join the music" button — one tap and you're in.
- **Direct-audio paths (build 25):** a CORS-open host → fetch +
  `decodeAudioData` into a buffer source on the jam bus (sample-accurate,
  seekable, the premium path). A host **without** CORS headers → the
  element just plays: audible and synced, but outside the chain, and the
  room is told plainly ("that host blocks audio capture — it'll play, but
  the sampler can't grab it"). `captureStream()` is **not** a fallback for
  cross-origin media — Chromium throws `SecurityError: Cannot capture from
  element with cross-origin data`, probed live. No fake capture is ever
  claimed.
- **SoundCloud API (build 25 research):** app registration is open again
  (soundcloud.com/you/apps) with ~15,000 play-stream requests/day per
  `client_id`. Native SC playback through api-v2 stream URLs is possible in
  a future build once an app is registered and a client_id is provided —
  keyless stream-URL scraping is not a shippable foundation.
- **Link shapes that work (build 23):** full `soundcloud.com/artist/track`
  URLs **and** mobile share links (`on.soundcloud.com/xxx` — the kind the
  SoundCloud app's Share button gives you; the game resolves it to the
  canonical track through SoundCloud's oEmbed), `m.soundcloud.com` links, and links with tracking
  query params (`?si=…`). If a short link won't resolve, the game hands it
  to the widget anyway — SoundCloud usually resolves it server-side.
- **Playlists (build 23):** paste a SoundCloud set (`…/sets/…`) or a YouTube
  URL with `list=` and the game pulls the whole track list (keyless — via
  the widget's `getSounds()` / the IFrame API's `getPlaylist()`) and queues
  every track as its own item, grouped under a "🎶 playlist • N tracks"
  header. Skip still works per track; the ✕ on the header pulls the whole
  remaining set. Real track titles resolve (SoundCloud oEmbed / noembed).
- **When a link won't play:** the panel says so — "couldn't load that link
  — is it public?" (private/deleted/region-blocked tracks), and the queuer's
  client moves the room on to the next track instead of stalling in silence.
  If SoundCloud's player script itself won't load: "soundcloud isn't
  loading — check your connection". If the browser blocks autoplay, a
  pulsing "tap to join the music" button appears — one tap and you're in.
- **Queue:** FIFO; anyone can queue, only the queuer can remove their track.
  Anyone can skip — one tap advances the track immediately, no votes.
  Late joiners get the full queue + now-playing and land
  mid-track via offset math. A 20s resync nudge re-seeks anyone who drifted
  >2.5s. The first link pasted into an empty queue starts playing
  immediately, inside your tap.
- **Advance duty:** whoever queued the finished track broadcasts the next
  `jukePlay`. Watchdog: if a track has been over >8s with no advance, any
  peer may advance — first broadcast wins (earliest `startedAt` wins ties).
- **Phone vs desktop (build 25, verified on a phone-class browser —
  390×844, touch, mobile UA, every interaction a real tap):** everything
  above works on phones. WebAudio unlocks to `running` from the start tap;
  a tap-queued mp3 from a CORS-open host plays on the WebAudio chain
  (rms ≈ 0.12, same as desktop) with the friendly filename title and no
  "tap to join" prompt on the gesture path; a no-CORS host plays audibly
  through the plain-element fallback with the honest "that host blocks
  audio capture" hint; hidden YT/SC players start from taps (`warm=true`)
  and a 140-point touch sweep found zero iframe touch interception. The
  jam "grab loop" captures a direct-audio track **natively on phones**
  (`getDisplayMedia` undefined — no tab-capture API involved). The one
  desktop-only feature in the whole room is the "🎙 sample the room"
  button (build 24, tab-audio capture needs desktop Chrome/Edge) — and the
  button says so itself on phones. No pretending.

## Room sampler (build 24) — sample the room mix

The sampler's "🎙 sample the room" button records the whole room mix
(jukebox + jam + the live mix) straight into the next pad — same grab length as
"grab loop" (2 bars on the clock, 4s free-time), same pad slot behavior.

The honest part: YouTube/SoundCloud tracks play through iframes, and
**no page API can touch iframe audio** (no WebAudio node, no
`captureStream` — nothing). So the game uses the only browser-native path
that exists: **tab-audio capture** (`getDisplayMedia`), which asks you to
pick the LIMBO tab. That API exists on **desktop Chrome/Edge only** —
mobile browsers don't offer any site a tab-audio track, so **on phones the
button just says so**: "Room sampling needs Chrome or Edge on desktop —
phones can't capture the embedded player's audio." No fake functionality.
(Build 25 note: **direct audio links** — mp3 etc. from CORS-open hosts —
ride the game's own WebAudio chain, so the sampler's "grab loop" captures
those natively with no tab capture at all. `captureStream()` was probed as
a bridge for no-CORS hosts and rejected: Chromium throws SecurityError on
cross-origin media without CORS.)

We also probed (build 24) whether a public SoundCloud track's direct
stream URL could be resolved keylessly so the page could fetch the audio
itself: no — the stream URLs 401 without a `client_id`, and the only
client_ids floating around are undocumented ones scraped from SoundCloud's
own player bundles. Not a shippable foundation, so tab-audio capture of
**embedded** (YouTube/SoundCloud iframe) playback stays impossible on
phones via page APIs — the "🎙 sample the room" button stays
**desktop-only** and says so on phones. But **direct audio links**
(build 25: mp3 etc. from CORS-open hosts) ride the game's own WebAudio
chain, so the jam pads' **"grab loop" captures them natively on phones**
— verified on a phone-class browser (390×844, touch) with
`getDisplayMedia` entirely undefined: ring hears the track, grab lands on
a pad with real signal. That's the phone's sampling answer: paste an mp3
link, sample it straight into a pad.

Safety: the captured stream is recorded with `MediaRecorder` and **never
connected to the WebAudio graph at all** — it cannot feed back into your
speakers. The share is released the instant the take lands.
- **Autoplay:** browsers block unmuted autoplay without a gesture. Queueing
  or skipping (your tap) starts playback directly; on receiving a remote
  play the client attempts it and, if blocked, pulses a "tap to join the
  music" button.
- **Limits:** no seeking UI (skip + re-add covers it), no Spotify direct
  playback (needs Premium + an OAuth app — use the external path), no
  persistence across sessions. YouTube/SoundCloud iframe audio can't route
  through the game's WebAudio chain, so the volume slider drives each
  provider player's own volume API — but **direct audio links** (mp3 etc.)
  ride the full chain natively, volume slider and all.

## Community wall (builds 18, 26) — the wall remembers

The sound room's monumental paint wall now persists. After strokes land
(debounced ~2s) and on pagehide/tab-hidden, a downscaled JPEG snapshot plus
a timestamp is saved to `localStorage` under the key `limbo-wall-v1`. On
boot the snapshot is redrawn onto the wall canvas before first render — so
a refresh or a game update brings back the last mural. The key is never
renamed, and same-origin `localStorage` survives deploys, which is what
makes updates safe. Any storage failure (private mode, quota) is silent:
the wall just doesn't persist, never a crash, never a toast.

When drifters meet in the sound room they exchange `wallHello {ts}` —
each client's wall version time. Only a peer whose wall is NEWER answers,
with the existing `wallSync` JPEG flow, so the room converges on the
latest mural (last-writer-wins). Live strokes stay the truth while anyone
is painting; the snapshot is the backstop. An incoming `wallSync` never
stomps active painting: if your own brush landed in the last ~3s the mural
is stashed and merged once you're quiet, and the merge keeps your strokes
on top of the peer's mural instead of replacing them.

Undo (paint overlay, next to the eraser): every stroke carries an id, and
each client keeps an undoable stroke log under a flattened base canvas.
Undo pops your most recent stroke, replays the rest, re-snapshots, and
broadcasts `wallUndo {id}` so peers drop it from their logs and replay
too. Eraser strokes undo like any other. The log caps at 500 strokes —
past that the mural bakes into the base (pixels kept, undo history
dropped). The log itself doesn't survive a reload, only the flattened
snapshot does, so undo history starts fresh after a refresh.

- **Honest line:** true permanent-for-everyone persistence would need a
  tiny server holding the canonical mural. This is the serverless version:
  your wall remembers across your refreshes and updates, and rooms
  converge on the newest mural when drifters meet — but if nobody who saw
  a mural ever comes back, that mural is gone with them.

## Build 27 — the decks are gone (jukebox + jam consolidate)

The DJ decks are removed. Everything they did now lives in the two places
it always belonged:

- **Play a song from your phone → jukebox.** The jukebox gets a 📱 button:
  pick an audio file on your phone and it's queued for the room. No file
  host, no expiring links, no CORS roulette — the file travels **peer to
  peer over the existing Trystero data channel** (48KB base64 chunks, 8 per
  request, receiver-pinned to whoever is serving). The queue carries
  metadata only (`fileId`/`fileName`); anyone holding the bytes advertises
  them, so late joiners can pull from any holder. The now-playing line and
  queue rows badge it honestly: "📱 from {name}'s phone".
- **Why P2P and not a free upload host:** ten keyless hosts were probed
  with real browser traffic (catbox, tmpfiles, gofile, pixeldrain, uguu,
  0x0.st, qu.ax, transfer.sh, filebin…). None offers both browser-upload
  CORS *and* file-fetch CORS — uploads either get blocked at the POST or
  the returned file can't be fetched/decoded by the page. So the file never
  leaves the room's devices.
- **The uploader's answer to "can't a phone song work like the jukebox
  stream sync?":** yes — better. The uploader plays their file instantly
  from memory (blob URL → fetch → `decodeAudioData`) on the **full
  WebAudio chain** — FX sends, limiter, aura ducking — and receivers play
  the reassembled bytes the same way, landing at the room's wall-clock
  offset when they arrive late. Phone tracks are first-class citizens, and
  the sampler's "grab loop" captures them natively.
- **Honest edges:** 50MB cap per file (memory + chunk sanity), audio types
  only. Fetch has a 20s no-chunk watchdog — if nobody serves the file the
  room gets "that track is gone" and moves on, never silence. If the
  uploader leaves mid-track, whoever still holds the bytes keeps serving.
- **Microphone → jam.** The jam panel gets a 🎙 mic button: your voice
  joins the jam like any instrument (mic → jam bus → reverb/delay/limiter),
  with `echoCancellation` + `noiseSuppression` on, a mute toggle, a live
  level meter, and a "headphones on" note. Denial is an honest toast, never
  a crash; the mic stops when you toggle off or leave the sound room. The
  mic never touches the "sample the room" tab-capture path (that API only
  sees the tab's rendered output — no software feedback loop exists).
- **Instant skip:** anyone can skip — one tap advances the track
  immediately, no votes, no thresholds. A skip arriving for a track the
  room already moved past is ignored, not a crash.

## Build 28 — the broadcast button is gone

Joshua's call: the 🔴 go-live button was confusing (it looked like the
synth notes weren't shared until you tapped it, but they were always live
— the button only relayed the full mix), so it's gone entirely.

- **No broadcast, no relay, no DJ slot.** `goLive`/`stopLive`, the DJ claim
  protocol, the `MediaStreamDestination` tap, remote-track listening, and
  the "jukebox pauses while someone's live" rule are all removed from
  `game.js` and `net.js`.
- **What everyone hears now:** the jam mix is assembled locally on every
  client from the same broadcast notes, pads, jukebox offsets, sampler
  grabs, and mic input — no one person's feed, nothing to turn on. It
  can't be confusing because there's nothing to misunderstand.
- **The clock is leaderless:** the 15s clock heartbeat rides on whoever
  played a note most recently (freshest-wins), so the groove survives
  without a DJ holding the decks.
- The sampler records the jam bus post-limiter, and the sound room's light
  pulse reads bass from the same bus — both unchanged, both DJ-free.

## Build 28 — wall: blend brush + PNG backup

- **Blend brush.** A 🌀 blend button sits next to the eraser on the wall
  panel. Dragging it smudges the paint already on the canvas — a real
  finger-paint: each dab samples the average color under the brush, mixes
  it into what the brush is carrying, and stamps a soft dab of the mix.
  Not a translucent overlay; the colors genuinely blend. Blend strokes ride
  the existing wall-stroke protocol (`b: 1` in the stroke data) so peers
  render the same smudge, undo pops them like any stroke, and the
  500-stroke bake cap treats them as ordinary pixels.
- **Save wall.** A 💾 save button in the wall panel header downloads the
  whole mural as a timestamped PNG (`limbo-wall-<date>.png`) straight to
  the device — a manual backup on top of the existing localStorage
  persistence, which is untouched.

## Build 29 — paint overlay redo (phone-first)

Joshua's verdict on build 28's paint screen: "The paint ui is weird" —
on his phone the canvas was a tiny strip, the palette ran down the left
edge, buttons floated over the game world, and the room UI bled through
behind the overlay (style.css had no cache-bust, so his phone was likely
also showing stale CSS — fixed with `css/style.css?v=29`).

- **Full-screen opaque paint surface.** `#paint-overlay` is now solid
  `#05060d` — the 3D scene and room UI never show through. The canvas
  fills all space between the header and the toolbars
  (`object-fit: contain` letterboxes the 2:1 wall canvas without
  distortion; pointer mapping already uses `getBoundingClientRect`, so
  no game.js changes were needed).
- **Palette is a horizontal scrollable row** of 44px swatches under the
  canvas (moved out of the toolbar into its own `#paint-palette` row —
  all element ids and the JS population logic are unchanged).
- **One bottom toolbar:** erase, blend, undo, S/M/L — all ≥44px tall,
  fits 390px wide without overlap or scroll.
- The "it paints live for everyone in the sound room" hint stays,
  small, at the bottom inside the overlay.

## Build 30 — iPhone Safari hardening + Android↔iPhone cross-device
- Viewport: `viewport-fit=cover` added; `#paint-overlay` and `#start-overlay`
  use `height: 100dvh` with `100vh` fallback (iOS Safari's 100vh reaches under
  the toolbar); paint header/toolbars respect `env(safe-area-inset-*)` notches.
- Touch: global `-webkit-tap-highlight-color: transparent` on buttons;
  `touch-action: manipulation` on buttons, `touch-action: none` on the paint
  canvas (no scroll / pull-to-refresh while drawing). Paint strokes already
  use Pointer Events with pointer capture — no mouse-only paths.
- Audio unlock: the drift tap now calls `AudioContext.resume()` inside the
  gesture (the one call iOS honors); jam pad/note local triggers call
  `audioEnsureRunning()` (they're gestures, so resume succeeds); best-effort
  resume on `visibilitychange`.
- New floating "🔇 tap for sound" pill (`#sound-pill`): iOS Safari rejects
  programmatic `<audio>` playback with NotAllowedError when there's been no
  recent gesture (e.g. a track starting on a remote peer's iPhone). The
  media-element path now detects the rejection INSTANTLY and raises the pill
  instead of waiting ~12s for the autoplay watchdog (which stays as backup);
  the WebAudio path shows the pill if the context is still suspended after a
  resume attempt. Tapping the pill resumes audio and starts the current track
  at the room's wall-clock offset. Complements the in-panel "tap to join the
  music" button — the pill is visible even with the jukebox closed.
- "📱 play from my phone": file-input + `arrayBuffer()` + `decodeAudioData`
  path verified — no iOS-only breakage, no new APIs beyond build 27.
- Cross-device wall: stroke protocol is plain JSON (`{id, n, c, s, b, pts}`,
  normalized coords) — nothing platform-specific in serialization; Trystero
  WebRTC data channels work on iOS 14.1+. Real two-phone proof (Android +
  iPhone in the same room, drawing + hearing the same jukebox track) still
  needs humans with real phones.

### Build 30b — P2P: parallel signaling + phone-visible status pill
Real-world failure: Joshua (Android Chrome) + his homie (iPhone Safari) in
the sound room at the same time got NO connection — no wisp, no name tags.
Auditing the old 15s torrent→nostr once-only fallback against the actual
Trystero 0.25.4 module sources found three fatal races:
1. **Staggered-join deadlock** — A joins at t=0, falls back to nostr at t=15s;
   B joins torrent at t=60s. One-shot fallback means they never share a
   strategy again; both sit alone forever.
2. **Mid-handshake kill** — the timer fired on `peers.size===0` even with a
   handshake in progress (`onPeerJoin` only fires after the data channel
   connects; ICE on mobile can take 10–30s). Leaving the room mid-handshake
   destroyed connections that would have succeeded.
3. **ICE-failure silence** — discovery working but ICE failing only recorded
   `lastJoinError` for the keyboard debug HUD; nothing retried, nothing told
   the user. Trystero only retries on passive re-announce (60s nostr /
   120s torrent).
Fix: **both strategies now run in parallel** on the same room key
(`js/net.js` `_joinAll()`); peer sets merge by per-session `cid` injected
into every payload, so callbacks see one human even when both of their
connections are up. Broadcasts go out on both rooms; an 8s dedup filter
drops the second delivery of each logical message (chat/jam notes/queue
ops arrive exactly once). Targeted sends (file chunks) resolve the cid to
a single connection and go out once. `onJoinError` with zero peers now
schedules a visible retry — leave + rejoin both rooms for fresh
RTCPeerConnections and immediate re-announce, backoff 10s→60s — instead of
silence. iOS Safari + torrent: no iOS-specific breakage found in the 0.25.4
strategy source (plain WSS JSON trackers + WebRTC data channels, both fine
on iOS) and no documented issue, so no strategy reorder — with parallel
rooms whichever path works wins anyway.
New **net status pill** (`#net-pill`, touch devices only, `pointer-events:
none`, created/updated by `net.js`): `○ offline` (modules failed to load),
`○ net ready`, `○ finding others…`, `○ connecting…` (peer announced /
handshaking), `○ couldn't connect · retrying…` (ICE failed, retry
scheduled), `● N here`. Updates on join/leave/error/handshake + 2s poll —
the next human test reports the pill text instead of "no connection".
Debug HUD (settings panel) now shows per-strategy load/join/connection
counts, ICE retry countdown, and cid.

## Build 31 — stuck-"connecting…" watchdog + ?debug=net
Real two-phone build-30 test (Android Chrome + iPhone Safari, sound room):
the pill said `○ connecting…` forever — discovery worked (peer announced
via signaling) but the WebRTC data channel never opened, and Trystero fired
neither `onPeerJoin` nor `onJoinError`, so nothing ever retried. Fix: a
**handshake watchdog** on the 2s tick — if the pill is in "connecting…"
with zero fully-joined peers for >20s (`WATCHDOG_MS`), it's treated as a
failure: pill flips to `○ couldn't connect · retrying…` and the client
takes the same leave+rejoin ICE-retry path (backoff preserved). Re-arms
automatically — never sits silent. (Both phones were almost certainly on
cellular symmetric NAT, so the TURN relay path in `buildIceServers` is the
suspect; TURN allocate from the VM sandbox was inconclusive — the egress
proxy mangles non-HTTP traffic — so TURN is UNVERIFIED, not proven-dead.)
New **`?debug=net` on-screen net log** (build 31): when the URL carries
`?debug=net`, a small toggleable monospace panel (tap header to collapse,
z-index above the paint overlay) renders timestamped net events — strategy
module load ok/fail, rooms joined per strategy, peer announced per strategy
+ initiator flag, nostr announce/signal frames, ICE connection state
transitions per peer connection, local ICE candidate TYPES once gathering
completes (`relay` present = TURN alive; host+srflx only = TURN dead),
join errors, ICE retry countdowns, watchdog triggers. Zero UI change
without the param. The 2s tick now runs on every platform (pill stays
touch-only) so the watchdog protects desktop too.

## Build 32 — paint touch-offset fix
Joshua's paint test: "the line appears away from my finger". Cause:
`#paint-canvas` was `width:100%; height:100%` with `object-fit: contain`
letterboxing the 2:1 (1024×512) wall buffer inside a tall element box, but
`paintUvFromEvent` in `js/game.js` maps touches with
`getBoundingClientRect()` — the ELEMENT box, not the letterboxed content
box — so vertical touches mapped to the wrong v. Fix is CSS-only:
`#paint-canvas` is now `width:100%; aspect-ratio: 2 / 1; height:auto;`
(no more `object-fit`), so the element box IS the content box and the rect
math is exact; `#paint-wrap` changed `align-items: stretch` →
`center` so the canvas centers vertically in the leftover space. game.js
input math untouched (already correct), WALL_W/WALL_H unchanged.

## Build 33 — the endless journey (album-release room)
Joshua's vision: "endless navigating. Your orb can just fly through an
infinite mountain, city, desert, and digital realm scape while listening to
the songs I upload to you for my album release!" Plus: orbs that travel
close together go faster, "like a set of birds flocking together", the
jukebox works over there, and a like/follow option.

**The room.** A 5th Nexus portal (bird-V portal art) opens `limbo-realm-6`,
the ENDLESS JOURNEY. Your orb auto-flies an endless -Z route at 14 u/s;
drag anywhere to steer (no look-drag in this room), arrow keys work too.
Four procedural biomes cycle mountain -> city -> desert -> digital, 4
chunks (160u) each, recycled ahead/behind with dense fog hiding the pop-in.
Everything is instanced/low-poly; materials are shared and chunk
geometries disposed on recycle. A NEXUS gate is world-anchored ~350u ahead
(drifting toward your line, never receding) — fly through the ring to come
home; miss it and the next gate is laid 600u further on.

**Flocking.** Every 0.1s the room runs deterministic flock math
(`js/flock.js`, pure + unit-tested): orbs within 14u cluster transitively,
the furthest-forward orb is the leader at the V apex, everyone else gets a
V slot alternating left/right and widening by rank, and positions lerp
toward slots (damped, never snaps). The whole V slipstreams at 1.35x
(18.9 u/s) with speed lines + a brighter trail while flocked. Hysteresis:
join at 14u, leave at 19u.

**Music priority: jukebox > album > generative.** The jukebox plays in the
journey room exactly like the sound room (48KB chunks, queue, anyone can
skip, wall-clock sync, per-room party). Next: the hosted album —
`assets/album/album.json` (`{title, tracks:[{file,title}]}`) with numbered
mp3s next to it; the album loops forever on a fixed epoch (2026-01-01 UTC)
so every drifter hears the same track at the same offset with no leader
election. Ship no `album.json` and the room silently falls back to the
generative ambient — the room works fully today with an empty folder.
Biome shifts land on track changes (album or jukebox) and every 1400u of
leader distance, all derived from the wall clock so every client renders
the same world.

**Like / follow.** While a jukebox track plays in the journey room, a pill
offers ♡ Like (P2P live count, one per drifter per track, no persistence)
and follow (menu linking Joshua's SoundCloud
https://soundcloud.com/joshua-watts-4 and
https://www.instagram.com/holowatts_music).

**Perf notes / cut corners.** Chunk terrain is 20x10-22x12 segments;
biome art is deliberately simple (cones, instanced boxes/octahedrons,
wireframe grid) to hold 60fps on phones. No per-frame allocations in the
hot loop except the flock tick's small arrays at 10Hz. The album probe
fetches `album.json` with `cache: no-store`; durations are probed once via
metadata preload (8s timeout each). iOS may block `Audio.play()` without a
gesture — the player retries every 5s until it starts.

## Build 34 — couch co-op (offline LAN multiplayer)

Joshua's scenario: Thanksgiving, bad internet, everybody's phones charged,
everyone hanging out in the same room. "How can we get it local? ... not
through the house's wifi ... not through the phone's data. So like what's
another way we can connect everything?"

**The answer: one phone becomes the network.** An Android hotspot is a
network even with no data — the phones just talk to each other over the
radio. One Android hosts the hotspot (iPhones can JOIN a hotspot fine but
can't HOST one — Apple gates Personal Hotspot on cellular, so the UI says
"host from an Android"). Everyone joins that WiFi, opens LIMBO, and links
up with QR codes. No STUN/TURN (it's a LAN — host candidates are enough),
no signaling server, no room keys, no accounts.

**Offline-first PWA.** After ONE online visit, a service worker (`sw.js`,
cache `limbo-v34`) has the whole game — pages, scripts, CSS, realm art,
the vendored QR libs, even three.js from the CDN — so LIMBO boots with the
network fully blocked. `manifest.webmanifest` makes it installable
(fullscreen, `#020204` theme). Without this, a data-less hotspot couldn't
even load the page.

**The ceremony (js/couch.js).** Host taps Settings → COUCH CO-OP → host:
an SDP offer (host candidates only, SDP stripped of extmap/msid/ssrc to
fit) is encoded as `LIMBO1:O:<base64url>` and drawn as a QR with the
vendored `qrcode-generator`. Guest taps join, scans it with the camera
(vendored `jsQR`), mints an answer (`LIMBO1:A:…`), shows their QR; the host
scans it and the WebRTC data channel opens. ~10–15s per guest. The host's
offer auto-refreshes after each pairing (strictly one offer per guest —
WebRTC-correct). A "type code instead" fallback exists on the join screen.

**The transport speaks the same game protocol.** `CouchNet` mirrors the
`LimboNet` interface (same callbacks, same `send*` names, same
`{cid, …data}` payloads); game.js talks to whichever transport is active
through a dispatcher proxy, so realms, jukebox (including play-from-phone
file chunks), paint wall, chat, jam and flocking all work unchanged.
Online and couch are never bridged — entering couch mode leaves the online
rooms and lobby; leaving restores them.

**Topology: star.** Guests connect only to the host; the host relays
broadcasts to the other guests and routes targeted messages (file chunks)
by cid, and announces roster join/leave so every phone's drifter count is
right. Online mode has one room per realm; couch mode has one LAN room for
everybody, so every broadcast carries the sender's current room and the
transport drops room-scoped actions from drifters in other realms.

**Known limits.** iPhone hosts are impossible (Apple). The game must be
opened once online before the offline night. A guest who joins mid-party
syncs the wall/jukebox state on their next room hop (same late-joiner
pattern as online). Keep the game in the foreground.

## Build 35 — cache-bust hotfix (journey camera, round 2)
Same-night follow-up to the build-34 journey-camera hotfix. The hotfix shipped
with the same `?v=34` URLs, so phones that had already loaded build 34 kept
serving the pre-hotfix `game.js` from HTTP cache — and worse, from the build-34
service worker's cache-first `limbo-v34` cache, which the unchanged `sw.js`
would have kept serving indefinitely. Build 35 bumps every version stamp
(`?v=35`, SW cache `limbo-v35`); the new service worker uses skipWaiting +
clients.claim and deletes old `limbo-v*` caches on activate, so one online
visit flushes the stale bytes. No gameplay changes — the journey room already
works solo (verified 9/9 on the live site with a clean cache: fly, steer,
biomes, zero errors).

## Build 36 — the open-field journey (Nexus-style free flight)

Joshua's directive: *"I wanted the flying to be more like nexus. Maybe
make a big open field map for us with those environments."* So the endless
auto-forward rail is gone — the journey room now flies exactly like the
Nexus (drag to steer, left side is the fly stick, the wisp keeps the same
dreamy inertia), with one addition: the journey never stops drifting, a
gentle cruise along your heading, like birds on the wing.

**One big open field, four lands.** The recycling corridor is retired. The
room is a single 1120×1120 map split into quadrants, and the four
environments are regions of it: **THE SPIRES** (mountain peaks, northwest),
**THE SLEEPING CITY** (tower blocks with lit windows, northeast),
**THE LONG DUNES** (wind-shaped sand, southwest), **THE GRID** (neon lattice
on black glass, southeast). Terrain tapers flat at the borders, so crossing
between lands feels like drifting through a valley pass.

**The world cross-fades around you.** Flying into a new land lerps the sky,
fog color and fog density to that land's palette, retunes the ambient pad's
root note (ducked while the jukebox or hosted album is playing), and a quiet
banner names the land — plain words, his voice: THE SPIRES, THE SLEEPING
CITY, THE LONG DUNES, THE GRID. A hysteresis band at the borders keeps the
banner from flickering.

**The edge is a fog wall, not a wall.** Past 440u the air thickens and a
soft push-back turns you home; a hard clamp at 560u is the safety net. You
spawn in the dunes facing the crossroads, where the **gate home** stands
under a light beacon visible from anywhere in the field — fly through it to
return to the Nexus.

**Flocking survived the redesign** (build 33/34 mechanics, heading-aware
now): the V formation's leader is the orb furthest along the flock's mean
heading — every client computes this from the same broadcast headings, so
all screens agree — and flying in formation still multiplies speed 1.35×
(slipstream), with speed lines and a brighter trail. The jukebox, hosted
album, and like/follow pill are all still in the room. Solo and multiplayer
both work.
