# Contributing to Limboverse

Limboverse is a collaborative metaverse. Anyone can add, edit, and become a contributor. Here's how.

## The workflow: fork, dial it in, merge

We use the **fork + pull request** workflow. It lets you dial things in on your own copy before proposing them to the verse.

1. **Fork** this repo (top-right Fork button). You now have your own copy.
2. **Clone** your fork to your machine.
3. **Create a branch** for your change: `git checkout -b my-cool-thing`
4. **Dial it in.** Make your changes, test them. Take your time — it's your fork.
5. **Push** to your fork: `git push origin my-cool-thing`
6. **Open a pull request** from your branch to `joshuagwatts/limboverse` `main`. Describe what you built and why.
7. A maintainer reviews it. When it's good, it merges — and you're a contributor.

No commit access needed. No permission to ask for. Fork and go.

## What to work on

- **New realms** — portal destinations with their own art, mood, and music
- **World objects** — sculptures, installations, interactive things
- **The verse itself** — improvements to the snapshot/versioning system (`js/verse.js`)
- **Music & sound** — the jam engine (`js/jam.js`), new instruments, new kits
- **Multiplayer** — P2P systems (`js/net.js`), new shared experiences
- **Polish** — UI, performance, accessibility, bug fixes

Check the Issues tab for ideas, or bring your own.

## Ground rules

- **The verse protects itself.** Don't break the snapshot system. If your change touches world state, make sure versions still save and restore.
- **`main` is protected.** Nothing merges without a pull request and review. The git history is the safety net — keep it clean.
- **Cache-busting.** Every build runs `python3 tools/bump_build.py <N>` before committing. It rewrites every `?v=` so phones never serve stale files. Never skip this.
- **Verify with acorn**, not `node --check`. (`node --check` misses real syntax errors in this codebase.)
- **UI gets out of the way.** The interface never crowds the play surface. Rooms should feel like real rooms.
- **Test on real devices** when you touch multiplayer, audio, or the theatre. The VM can't do WebRTC or YouTube iframes.

## Code layout

- `index.html` — the page, all panels and UI
- `js/game.js` — the world. Yes, it's 13k lines. It's organized by system with banner comments — search for the banner.
- `js/verse.js` — the self-versioning snapshot system (wall, FOH, models)
- `js/net.js` — Trystero P2P multiplayer
- `js/jam.js` — music engine (synths, drums, sequencer)
- `js/audio.js` — WebAudio engine
- `js/couch.js` — offline LAN co-op
- `js/flock.js` — flocking motion

## Questions?

Open an issue. Or just fork and start building — the verse wants what you're making.
