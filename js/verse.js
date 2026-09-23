/* ============================================================
   LIMBOVERSE — the verse versions itself.

   The metaverse auto-saves its shared creative state as versioned
   snapshots: the wall mural, the FOH lighting, and my shared models.
   If the verse is ever griefed, cleared, or destroyed, any drifter
   can open the verse history and roll it back — the restore
   re-broadcasts to the room, healing the shared world.

   Snapshots live in localStorage (per-device). The repo's git history
   is the other half of the protection: every code change is a version
   on a protected main branch.

   v1 scope: wall + foh + my models. Jukebox/theatre queues are
   ephemeral by design (they're "what's playing now", not "the verse").
   ============================================================ */

export const VERSE_KEY = 'limboverse-snaps-v1';
export const VERSE_MAX = 12;          // rolling history depth
export const VERSE_INTERVAL_MS = 5 * 60 * 1000; // auto-snapshot every 5 min

/* Load the snapshot list (newest first). */
export function verseLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(VERSE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}

/* Persist the list, capped at VERSE_MAX. */
function verseSave(list) {
  try {
    localStorage.setItem(VERSE_KEY, JSON.stringify(list.slice(0, VERSE_MAX)));
  } catch (e) {
    /* Storage full: drop oldest until it fits. */
    try {
      let l = list.slice(0, VERSE_MAX);
      while (l.length > 1) {
        l = l.slice(0, -1);
        try { localStorage.setItem(VERSE_KEY, JSON.stringify(l)); break; }
        catch (e2) {}
      }
    } catch (e3) {}
  }
}

/* A fingerprint of the snapshottable state, for change detection. */
function verseFingerprint(state) {
  const w = (state.wallStrokes || []).length;
  const m = Object.keys(state.models || {}).length;
  const f = JSON.stringify(state.foh || {});
  // Include a hash of stroke ids so new strokes trigger a snapshot.
  const ids = (state.wallStrokes || []).map(s => s.id).join(',');
  let h = 0;
  const str = w + '|' + m + '|' + f + '|' + ids;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

/* Capture a snapshot. Returns the snapshot, or null if nothing changed
   since the last one (so the auto-timer doesn't spam identical versions).
   `state` = { wallStrokes, wallBase (dataURL or null), foh, models, by } */
export function verseCapture(state) {
  const snaps = verseLoad();
  const fp = verseFingerprint(state);
  if (snaps.length && snaps[0].fp === fp) return null; // unchanged

  const snap = {
    v: 1,
    ts: Date.now(),
    by: String((state.by || 'drifter')).slice(0, 16),
    fp,
    wallStrokes: state.wallStrokes || [],
    wallBase: state.wallBase || null, // JPEG dataURL of the flattened base
    foh: state.foh ? { ...state.foh } : {},
    models: state.models || {},       // my shared models {name: specs}
  };
  snaps.unshift(snap);
  verseSave(snaps);
  return snap;
}

/* Human-readable age: "just now", "5m ago", "2h ago", "3d ago". */
export function verseAge(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

/* One-line summary of what's in a snapshot. */
export function verseSummary(snap) {
  const parts = [];
  const strokes = (snap.wallStrokes || []).length;
  if (strokes) parts.push(strokes + ' strokes');
  else if (snap.wallBase) parts.push('mural');
  const models = Object.keys(snap.models || {}).length;
  if (models) parts.push(models + ' model' + (models > 1 ? 's' : ''));
  if (snap.foh && Object.keys(snap.foh).length) parts.push('lighting');
  return parts.length ? parts.join(' · ') : 'empty verse';
}
