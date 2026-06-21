// Storm-cell tracker. Turns the strike firehose into persistent, named, moving
// cells — the keystone the AI layer stands on. Pure deterministic stats (no LLM):
// gridded clustering each tick, greedy nearest-centroid association for stable
// IDs, EWMA velocity for drift, and a fast/slow rate ratio for rising/falling.
//
// HONESTY: a cluster is a "lightning cluster", never a meteorological storm type
// (no supercell/squall/MCS — that needs radar we don't have). The drift arrow is
// "where the activity is heading", a count trend, not a severity forecast.

const WINDOW_MS = 25 * 60 * 1000   // strike history kept for tracking
const MAX_STRIKES = 50000          // hard count cap (the firehose can be unbounded)
const TICK_MS = 5000
const BIN_DEG = 0.7                // ~70 km grid for clustering
const MIN_PTS = 5                  // min strikes to form a cell
const MAX_JOIN_KM = 90             // association gate between ticks
const PROMOTE_TICKS = 2            // must persist this many ticks before naming
const DEATH_TICKS = 3              // ticks unmatched before a cell dies

const strikes = []                 // { lat, lon, time }
let cells = []                     // tracked cells
let nextId = 1

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = Math.PI / 180
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR
  const la1 = aLat * toR, la2 = bLat * toR
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function ingest(s) {
  if (typeof s.lat === 'number' && typeof s.lon === 'number') {
    strikes.push({ lat: s.lat, lon: s.lon, time: s.time || Date.now() })
    // Guard against an extreme firehose between 5 s ticks.
    if (strikes.length > MAX_STRIKES + 20000) strikes.splice(0, strikes.length - MAX_STRIKES)
  }
}

// Grid clustering: bucket strikes into ~BIN_DEG bins, flood-fill 8-connected
// occupied bins into components, keep components with >= MIN_PTS strikes.
function clusterRecent(now) {
  const bins = new Map()
  for (const s of strikes) {
    const by = Math.round(s.lat / BIN_DEG)
    const bx = Math.round(s.lon / BIN_DEG)
    const key = `${bx},${by}`
    let b = bins.get(key)
    if (!b) { b = { bx, by, pts: [] }; bins.set(key, b) }
    b.pts.push(s)
  }
  const seen = new Set()
  const clusters = []
  for (const [key, b] of bins) {
    if (seen.has(key)) continue
    const stack = [b]
    seen.add(key)
    const members = []
    while (stack.length) {
      const cur = stack.pop()
      members.push(cur)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue
          const nk = `${cur.bx + dx},${cur.by + dy}`
          if (bins.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(bins.get(nk)) }
        }
      }
    }
    const pts = members.flatMap((m) => m.pts)
    if (pts.length < MIN_PTS) continue
    let slat = 0, slon = 0
    for (const p of pts) { slat += p.lat; slon += p.lon }
    const lat = slat / pts.length, lon = slon / pts.length
    let maxR = 0
    for (const p of pts) { const d = haversineKm(lat, lon, p.lat, p.lon); if (d > maxR) maxR = d }
    const recentCount = pts.filter((p) => p.time >= now - 60000).length
    clusters.push({ lat, lon, count: pts.length, rate: recentCount, spreadKm: maxR })
  }
  return clusters
}

function step(now) {
  const clusters = clusterRecent(now)
  const used = new Set()

  // Associate existing cells to nearest cluster within the gate.
  for (const cell of cells) {
    let best = -1, bestD = MAX_JOIN_KM
    for (let i = 0; i < clusters.length; i++) {
      if (used.has(i)) continue
      const d = haversineKm(cell.lat, cell.lon, clusters[i].lat, clusters[i].lon)
      if (d < bestD) { bestD = d; best = i }
    }
    if (best >= 0) {
      used.add(best)
      const c = clusters[best]
      const dt = Math.max(1, (now - cell.tLast) / 1000)
      // EWMA velocity (deg/s).
      const vlat = (c.lat - cell.lat) / dt, vlon = (c.lon - cell.lon) / dt
      cell.vlat = cell.vlat * 0.6 + vlat * 0.4
      cell.vlon = cell.vlon * 0.6 + vlon * 0.4
      cell.lat = c.lat; cell.lon = c.lon
      cell.count = c.count; cell.spreadKm = c.spreadKm
      cell.rateSlow = cell.rateSlow * 0.8 + c.rate * 0.2
      cell.rateFast = cell.rateFast * 0.5 + c.rate * 0.5
      cell.rate = c.rate
      cell.tLast = now
      cell.misses = 0
      cell.ticks++
      cell.trail.push([c.lat, c.lon])
      if (cell.trail.length > 30) cell.trail.shift()
    } else {
      cell.misses++
    }
  }

  // Spawn candidates for unmatched clusters.
  for (let i = 0; i < clusters.length; i++) {
    if (used.has(i)) continue
    const c = clusters[i]
    cells.push({
      id: nextId++, lat: c.lat, lon: c.lon, vlat: 0, vlon: 0,
      count: c.count, rate: c.rate, rateFast: c.rate, rateSlow: c.rate,
      spreadKm: c.spreadKm, ticks: 1, misses: 0, tLast: now, trail: [[c.lat, c.lon]],
    })
  }

  // Reap dead cells.
  cells = cells.filter((c) => c.misses <= DEATH_TICKS)

  return cells
    .filter((c) => c.ticks >= PROMOTE_TICKS && c.misses === 0)
    .map((c) => {
      const ratio = c.rateFast / Math.max(0.5, c.rateSlow)
      const state = ratio > 1.35 ? 'rising' : ratio < 0.7 ? 'falling' : 'steady'
      return {
        id: c.id, lat: c.lat, lon: c.lon, vlat: c.vlat, vlon: c.vlon,
        count: c.count, rate: c.rate, spreadKm: Math.round(c.spreadKm),
        state, trail: c.trail.slice(-16),
      }
    })
}

export function startCells(onTick, { log = console.log } = {}) {
  const timer = setInterval(() => {
    const now = Date.now()
    const cut = now - WINDOW_MS
    while (strikes.length && strikes[0].time < cut) strikes.shift()
    if (strikes.length > MAX_STRIKES) strikes.splice(0, strikes.length - MAX_STRIKES)
    try { onTick(step(now)) } catch (e) { log(`[cells] ${e.message}`) }
  }, TICK_MS)
  return () => clearInterval(timer)
}
