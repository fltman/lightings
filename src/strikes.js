// Strike FX engine.
//
// Each lightning strike spawns three layered effects, all drawn on a single
// canvas that overlays the map:
//   1. FLASH  — an instant white-hot bloom at the strike point (fast fade).
//   2. RING   — an expanding circle: the THUNDER wavefront. It grows outward at
//                the real speed of sound (343 m/s) and fades as it reaches the
//                ~30 km thunder stays audible. Because it moves at true sound
//                speed, the moment the ring sweeps over a place on the map is the
//                moment that strike's thunder would be heard there (~3 s / km).
//   3. EMBER  — a small dot that lingers for ~40 s so storm density builds up.
//
// Strokes are scaled by a RELATIVE intensity `e` (from detection geometry), so
// monster bolts flash fatter and brighter than flickers. When a ring reaches the
// configured "ear" point, the engine calls onThunder() so audio can fire in sync.
//
// Geometry is recomputed every frame from the live map state, so rings stay
// pinned to their real-world location while you pan and zoom. The canvas is
// cleared by the caller (so other layers can draw beneath the additive strikes).

const SOUND_SPEED = 343          // m/s, real speed of sound in air
const MAX_RING_M = 30000         // thunder is ~inaudible past ~25-30 km
const FLASH_MS = 480
const EMBER_LIFE_MS = 40000
const MAX_ACTIVE = 4000          // hard cap; oldest culled beyond this

const NEG = [143, 208, 255]      // cyan-white  (negative cloud-to-ground)
const POS = [255, 210, 122]      // warm        (positive)
const DRY = [255, 95, 45]        // ember-red   (dry lightning — no rain, fire risk)

// Web-mercator ground resolution: metres per CSS pixel at a latitude + zoom.
function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
}

function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, toR = Math.PI / 180
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR
  const la1 = aLat * toR, la2 = bLat * toR
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export class StrikeFx {
  constructor() {
    this.strikes = []
    this._id = 0
    // Thunder hook: when a ring reaches `ear`, onThunder(distM, pol, energy) fires.
    this.ear = null            // { lat, lon } geographic listening point
    this.soundOn = false
    this.onThunder = null
    this.showHalo = true       // GDOP confidence ellipse during the flash
  }

  // Rings always travel at the true speed of sound, so this is how long one
  // takes to reach MAX_RING_M (~87 s for 30 km).
  get ringLifeMs() {
    return (MAX_RING_M / SOUND_SPEED) * 1000
  }

  add(strike, born, opts = {}) {
    const toR = Math.PI / 180
    this.strikes.push({
      sid: strike.id,                    // server id, for the reveal round-trip
      lat: strike.lat,
      lon: strike.lon,
      pol: strike.pol || 0,
      e: typeof strike.e === 'number' ? strike.e : 0.4,
      gd: strike.gd || null,             // precomputed confidence-ellipse {a, e}
      dry: !!strike.dry,                 // dry lightning (no rain echo + fuel)
      mcg: strike.mcg ?? null,
      time: strike.time || Date.now(),   // epoch ms
      born,                              // performance.now() timeline
      fired: !!opts.silent,              // seeded strikes never play thunder
      _sin: Math.sin(strike.lat * toR),  // cached for the globe far-side cull
      _cos: Math.cos(strike.lat * toR),
    })
    if (this.strikes.length > MAX_ACTIVE) {
      this.strikes.splice(0, this.strikes.length - MAX_ACTIVE)
    }
  }

  // Suppress thunder for everything currently active (used when sound is enabled
  // mid-storm, so we don't fire a barrage of past strikes at once).
  markAllFired() {
    for (const s of this.strikes) s.fired = true
  }

  // Fire thunder if this strike's ring (current radius `ringMeters`) has just
  // reached the ear. Shared by the flat-map and globe render paths.
  maybeThunder(s, ringMeters) {
    if (!this.soundOn || !this.ear || !this.onThunder || s.fired) return
    const d = haversineM(s.lat, s.lon, this.ear.lat, this.ear.lon)
    if (d < MAX_RING_M && ringMeters >= d) {
      s.fired = true
      this.onThunder(d, s.pol, s.e)
    }
  }

  // Drop expired strikes. Render does this implicitly; globe mode (which doesn't
  // call render) calls this each frame to keep the buffer bounded.
  cull(now) {
    const maxLife = Math.max(EMBER_LIFE_MS, this.ringLifeMs)
    this.strikes = this.strikes.filter((s) => now - s.born <= maxLife)
  }

  // Nearest strike to a screen point that still carries station data (for the
  // multilateration reveal). Searches newest-first.
  pick(map, x, y, maxPx = 22) {
    let best = null, bestD = maxPx * maxPx
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i]
      if (!s.gd) continue                 // only multilaterated strikes are revealable
      const p = map.project([s.lon, s.lat])
      const dx = p.x - x, dy = p.y - y
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = s }
    }
    return best
  }

  render(ctx, map, now, viewW, viewH) {
    const zoom = map.getZoom()
    const ringLife = this.ringLifeMs
    const maxLife = Math.max(EMBER_LIFE_MS, ringLife)
    const keep = []

    for (const s of this.strikes) {
      const age = now - s.born
      if (age > maxLife) continue
      keep.push(s)

      const ringMeters = SOUND_SPEED * (age / 1000)
      this.maybeThunder(s, ringMeters)   // ring reaches the ear → boom

      const p = map.project([s.lon, s.lat])
      const mpp = metersPerPixel(s.lat, zoom)
      const ringR = ringMeters / mpp

      // Cheap viewport cull (account for current ring radius + glow).
      const margin = ringR + 24
      if (p.x < -margin || p.x > viewW + margin || p.y < -margin || p.y > viewH + margin) {
        continue
      }

      const rgb = s.dry ? DRY : (s.pol > 0 ? POS : NEG)
      const e = s.e

      // ---- EMBER: lingering dot ------------------------------------
      const emberA = Math.max(0, 1 - age / EMBER_LIFE_MS)
      if (emberA > 0) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.4 + 1.6 * e, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.4 + 0.5 * e) * emberA})`
        ctx.fill()
      }

      // ---- RING: expanding thunder wavefront -----------------------
      if (ringMeters < MAX_RING_M && ringR > 1) {
        const ringA = Math.pow(1 - ringMeters / MAX_RING_M, 1.4) * (0.4 + 0.45 * e)
        ctx.globalCompositeOperation = 'lighter'
        ctx.beginPath()
        ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${ringA * 0.4})`
        ctx.lineWidth = 4
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${Math.min(255, rgb[0] + 60)},${Math.min(255, rgb[1] + 30)},${rgb[2]},${ringA})`
        ctx.lineWidth = 1.4
        ctx.stroke()
      }

      // ---- FLASH: hot bloom at the strike point --------------------
      if (age < FLASH_MS) {
        const f = 1 - age / FLASH_MS
        const glowR = (7 + 26 * f) * (0.8 + 0.6 * e)
        ctx.globalCompositeOperation = 'lighter'
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR)
        g.addColorStop(0, `rgba(255,255,255,${0.95 * f})`)
        g.addColorStop(0.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.8 * f})`)
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2)
        ctx.fill()
        // hot core
        ctx.beginPath()
        ctx.arc(p.x, p.y, (1.6 + 2.2 * f) * (0.8 + 0.5 * e), 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${f})`
        ctx.fill()
        // rare high-energy positive strokes get a gold halo
        if (e > 0.8 && s.pol > 0) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, glowR * 1.4, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(255,200,90,${0.5 * f})`
          ctx.lineWidth = 2
          ctx.stroke()
        }
        // confidence halo: a precomputed error-ellipse (shape only, never metres)
        // — round = well-surrounded, smeared = stations one-sided.
        if (this.showHalo && s.gd) {
          ctx.beginPath()
          ctx.ellipse(p.x, p.y, 13 * (1 + s.gd.e * 1.1), 13 * (1 - s.gd.e * 0.6), -s.gd.a, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.38 * f})`
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }
    }

    ctx.globalCompositeOperation = 'source-over'
    this.strikes = keep
  }

  get activeCount() { return this.strikes.length }
}

export { haversineM, metersPerPixel }
