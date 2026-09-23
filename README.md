# LIMBOVERSE

A collaborative metaverse. Anyone can add, edit, and become a contributor.

Limboverse started as LIMBO — a portal universe you fly through in your browser — and grew into something bigger: a world that builds itself, versions itself, and protects itself from destruction.

**The verse versions itself.** Every 5 minutes, the world auto-saves its creative state — the wall mural, the lighting, the shared models — as a version. If anything gets griefed, cleared, or destroyed, any drifter can open Settings → Verse History and roll it back. The restore re-broadcasts to the room, healing the shared world.

**The repo versions itself too.** Every change is a git version on a protected `main` branch. Nothing lands without a pull request. The history is the safety net.

## Play it

**https://joshuagwatts.github.io/limboverse/** (deploying)

Fly a wisp through the Nexus into art-realms. Drift with others — serverless P2P multiplayer, no account, no server.

## Create with us

This is a collaborative metaverse. There are two ways to contribute:

**1. In the world** — Just show up and create. Paint the wall. Sculpt a model and share it. Queue a track. The verse saves your work as versions automatically.

**2. In the code** — Fork the repo, dial in your changes, open a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## What lives here

- `index.html` — the page
- `js/game.js` — the world (13k lines, one big beautiful file)
- `js/verse.js` — the self-versioning snapshot system
- `js/net.js` — P2P multiplayer (Trystero, no server)
- `js/jam.js` — the music engine
- `js/audio.js`, `js/couch.js`, `js/flock.js` — supporting systems

## The vision

A metaverse that anyone can add to, edit, and become a contributor to — and that protects itself from destruction by versioning everything. The world saves itself. The code saves itself. Creators just create.
