/* LIMBO — bird-flock V-formation math (build 33, heading-aware in 36).
 *
 * Pure functions, zero dependencies (no THREE), so node can unit-test them.
 * "Forward" is the flock's shared heading (a unit {x,y,z} vector): the
 * leader is the orb furthest along it, and the V falls back behind the
 * leader against it. Build 33 flew a fixed -Z rail; build 36 flies free,
 * so the heading comes from the members' broadcast forward vectors
 * (default (0,0,-1) keeps the old behavior and the old tests green).
 * All clients run the same math on the same broadcast positions+headings,
 * so every client assigns the same leader and the same V slots — the
 * formation is deterministic.
 */

export const FLOCK_R = 14;        // join radius: orbs this close flock
export const FLOCK_R_LEAVE = 19;  // leave radius (hysteresis: no flicker at the edge)
export const SLOT_DX = 4.5;       // lateral spacing per V rank
export const SLOT_DZ = 5.5;       // back spacing per V rank
export const SLOT_DY = 0.8;       // slight rise per V rank

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function dot3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function len3(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
function norm3(a) {
  if (!a) return null;
  const l = len3(a);
  return l < 1e-9 ? null : { x: a.x / l, y: a.y / l, z: a.z / l };
}
function cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
/* Mean heading of the members that reported one (members carry
 * fx/fy/fz from their wisp broadcast). Null when nobody reported —
 * callers fall back to (0,0,-1). Deterministic: same inputs, same mean. */
export function meanHeading(members) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const m of members) {
    if (typeof m.fx !== 'number' || typeof m.fy !== 'number' || typeof m.fz !== 'number') continue;
    x += m.fx; y += m.fy; z += m.fz; n++;
  }
  if (!n) return null;
  return norm3({ x: x / n, y: y / n, z: z / n });
}

/* Cluster members into flocks (transitive: A near B near C = one flock).
 * members: [{cid, x, y, z}] — cid is the per-session client UUID.
 * prevAssign: optional Map(cid -> flockKey) from the last tick; pairs that
 *   were flocked together stay together out to FLOCK_R_LEAVE (hysteresis).
 * Returns [{ key, members: [member...] }] with members sorted by cid.
 */
export function clusterOrbs(members, prevAssign) {
  const sorted = members.slice().sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const n = sorted.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  };
  const prevKey = (m) => (prevAssign ? prevAssign.get(m.cid) : undefined);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist3(sorted[i], sorted[j]);
      if (d <= FLOCK_R) { union(i, j); continue; }
      // Hysteresis: previously flocked pair holds together a little longer.
      if (d <= FLOCK_R_LEAVE) {
        const ki = prevKey(sorted[i]), kj = prevKey(sorted[j]);
        if (ki !== undefined && ki === kj) union(i, j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(sorted[i]);
  }
  let ki = 0;
  return [...groups.values()].map((members) => ({ key: 'f' + (ki++), members }));
}

/* Assign V slots inside one cluster.
 * Leader = furthest forward along the heading — the apex of the V, like
 * migrating birds. Everyone else, in cid order, takes alternating
 * left/right slots falling back and outward by rank: rank 1 = just behind
 * the leader, rank 2 wider... Slots sit behind the leader against the
 * heading, offset along the heading's horizontal perpendicular.
 * Returns { leader, slots: Map(cid -> {x, y, z}), order: [cids in slot order] }.
 */
const _UP = { x: 0, y: 1, z: 0 };
export function assignVSlots(clusterMembers, heading) {
  const h = norm3(heading) || { x: 0, y: 0, z: -1 };
  // horizontal perpendicular to the heading (the V spreads sideways, not up)
  let side = cross3(h, _UP);
  if (len3(side) < 1e-4) side = { x: 1, y: 0, z: 0 }; // heading straight up/down
  side = norm3(side);
  const members = clusterMembers.slice();
  let leader = members[0];
  let best = dot3(leader, h);
  for (const m of members) {
    const d = dot3(m, h);
    if (d > best) { best = d; leader = m; }
  }
  const rest = members.filter((m) => m !== leader).sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const slots = new Map();
  const order = [];
  rest.forEach((m, i) => {
    const rank = Math.floor(i / 2) + 1;
    const s = i % 2 === 0 ? -1 : 1; // left, right, left, right…
    slots.set(m.cid, {
      x: leader.x - h.x * rank * SLOT_DZ + side.x * s * rank * SLOT_DX,
      y: leader.y - h.y * rank * SLOT_DZ + rank * SLOT_DY,
      z: leader.z - h.z * rank * SLOT_DZ + side.z * s * rank * SLOT_DX,
    });
    order.push(m.cid);
  });
  return { leader, slots, order };
}

/* Full pass: cluster, then slot every multi-orb cluster.
 * `heading` (optional unit vector) is the flock's forward; members'
 * fx/fy/fz feed meanHeading() when the caller wants it derived.
 * Returns { flocks: [{key, leaderCid, slots: Map, order}], solo: [cids],
 *           assign: Map(cid -> flockKey) } — assign feeds the next tick's
 * hysteresis so the formation never jitters at the radius edge.
 */
export function computeFlocks(members, prevAssign, heading) {
  const clusters = clusterOrbs(members, prevAssign);
  const h = norm3(heading) || { x: 0, y: 0, z: -1 };
  const flocks = [];
  const solo = [];
  const assign = new Map();
  for (const c of clusters) {
    if (c.members.length < 2) {
      solo.push(c.members[0].cid);
      continue;
    }
    const { leader, slots, order } = assignVSlots(c.members, h);
    for (const m of c.members) assign.set(m.cid, c.key);
    flocks.push({ key: c.key, leaderCid: leader.cid, slots, order });
  }
  return { flocks, solo, assign };
}
