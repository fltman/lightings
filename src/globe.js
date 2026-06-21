// Globe mode — a rotating 3D Earth.
//
// An alternative view, fully isolated from the flat MapLibre map: a d3-geo
// orthographic projection drawn on its own canvas. The planet auto-spins (drag
// to turn it, wheel to zoom), continents and a graticule are drawn, the real
// day/night terminator curves across the sphere, and the same live strikes play
// on it — flashes, energy-scaled glow, lingering embers, and the speed-of-sound
// rings (which become visible as you zoom into a storm, exactly like the flat
// map). Back-hemisphere points are culled automatically by the projection.

import { geoOrthographic, geoPath, geoGraticule10, geoCircle } from 'd3-geo'
import { feature } from 'topojson-client'
import landTopo from 'world-atlas/land-110m.json'
import { subsolar } from './nightside.js'
import { drawQuake } from './quakes.js'
import { drawFire } from './firesview.js'

const land = feature(landTopo, landTopo.objects.land)
const graticule = geoGraticule10()

const SOUND_SPEED = 343
const MAX_RING_M = 30000
const EARTH_R_M = 6371000
const M_PER_DEG = 111320
const FLASH_MS = 480
const EMBER_LIFE_MS = 40000

const NEG = [143, 208, 255]
const POS = [255, 210, 122]

export class Globe {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.proj = geoOrthographic().clipAngle(90).precision(0.4)
    this.path = geoPath(this.proj, this.ctx)
    this.circle = geoCircle()

    this.active = false
    this.night = true
    this.fx = null            // StrikeFx, set by main
    this.quakes = []          // set by main each frame
    this.fires = []           // set by main each frame

    this.rotLon = 0
    this.rotLat = -12         // slight northern tilt
    this.zoom = 1
    this.spinSpeed = 5        // deg/s
    this.dragging = false
    this.resumeAt = 0
    this.lastT = null
    this.w = 0; this.h = 0; this.dpr = 1

    this._bindEvents()
  }

  setActive(on) {
    this.active = on
    this.canvas.style.display = on ? 'block' : 'none'
    if (on) { this.lastT = null }
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr
    this.canvas.width = w * dpr
    this.canvas.height = h * dpr
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
  }

  get scale() { return Math.min(this.w, this.h) * 0.46 * this.zoom }

  // Geographic point under the front of the globe (for the thunder "ear").
  centerPoint() { return { lat: this.rotLat * -1, lon: this.rotLon * -1 } }

  _bindEvents() {
    const c = this.canvas
    let lx = 0, ly = 0
    c.addEventListener('pointerdown', (e) => {
      if (!this.active) return
      this.dragging = true; lx = e.clientX; ly = e.clientY
      c.setPointerCapture(e.pointerId)
    })
    c.addEventListener('pointermove', (e) => {
      if (!this.active || !this.dragging) return
      const k = 0.3 / Math.sqrt(this.zoom)
      this.rotLon += (e.clientX - lx) * k
      this.rotLat = Math.max(-85, Math.min(85, this.rotLat - (e.clientY - ly) * k))
      lx = e.clientX; ly = e.clientY
    })
    const end = () => { if (this.dragging) { this.dragging = false; this.resumeAt = performance.now() + 2500 } }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
    c.addEventListener('wheel', (e) => {
      if (!this.active) return
      e.preventDefault()
      this.zoom = Math.max(0.6, Math.min(8, this.zoom * (1 - e.deltaY * 0.001)))
    }, { passive: false })
  }

  render(now, date) {
    const ctx = this.ctx
    const dt = this.lastT == null ? 0 : Math.min(0.1, (now - this.lastT) / 1000)
    this.lastT = now
    if (!this.dragging && now > this.resumeAt) {
      this.rotLon = (this.rotLon + this.spinSpeed * dt) % 360
    }

    this.proj.rotate([this.rotLon, this.rotLat]).scale(this.scale).translate([this.w / 2, this.h / 2])
    const cx = this.w / 2, cy = this.h / 2, R = this.scale

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)

    // Atmosphere halo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.16)
    halo.addColorStop(0, 'rgba(70,130,230,0.0)')
    halo.addColorStop(0.5, 'rgba(70,130,230,0.18)')
    halo.addColorStop(1, 'rgba(70,130,230,0)')
    ctx.fillStyle = halo
    ctx.fillRect(0, 0, this.w, this.h)

    // Ocean sphere
    ctx.beginPath(); this.path({ type: 'Sphere' })
    const ocean = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R)
    ocean.addColorStop(0, '#0d1a30')
    ocean.addColorStop(1, '#050a16')
    ctx.fillStyle = ocean
    ctx.fill()

    // Graticule
    ctx.beginPath(); this.path(graticule)
    ctx.strokeStyle = 'rgba(120,160,220,0.08)'
    ctx.lineWidth = 0.6
    ctx.stroke()

    // Land
    ctx.beginPath(); this.path(land)
    ctx.fillStyle = '#11203a'
    ctx.fill()
    ctx.strokeStyle = 'rgba(120,190,255,0.25)'
    ctx.lineWidth = 0.5
    ctx.stroke()

    // Night hemisphere + terminator
    if (this.night) {
      const { dec, lon } = subsolar(date)
      const anti = [lon + 180, -dec]
      ctx.beginPath(); this.path(this.circle.center(anti).radius(90)())
      ctx.fillStyle = 'rgba(2,4,12,0.5)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,170,90,0.18)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Strikes
    this._strikes(now)

    // Earthquakes (far-side culled)
    if (this.quakes.length) {
      const toR = Math.PI / 180
      const clat = -this.rotLat * toR, clon = -this.rotLon
      const sinC = Math.sin(clat), cosC = Math.cos(clat)
      for (const q of this.quakes) {
        const cosd = sinC * Math.sin(q.lat * toR) + cosC * Math.cos(q.lat * toR) * Math.cos((q.lon - clon) * toR)
        if (cosd <= 0) continue
        const p = this.proj([q.lon, q.lat])
        if (p) drawQuake(ctx, p[0], p[1], q, now - (q._seen || 0))
      }
    }

    // Fires (far-side culled)
    if (this.fires.length) {
      const toR = Math.PI / 180
      const clat = -this.rotLat * toR, clon = -this.rotLon
      const sinC = Math.sin(clat), cosC = Math.cos(clat)
      for (const f of this.fires) {
        const cosd = sinC * Math.sin(f.lat * toR) + cosC * Math.cos(f.lat * toR) * Math.cos((f.lon - clon) * toR)
        if (cosd <= 0) continue
        const p = this.proj([f.lon, f.lat])
        if (p) drawFire(ctx, p[0], p[1], f)
      }
    }

    // Crisp limb
    ctx.beginPath(); this.path({ type: 'Sphere' })
    ctx.strokeStyle = 'rgba(140,190,255,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  _strikes(now) {
    const ctx = this.ctx
    const fx = this.fx
    if (!fx) return
    const maxLife = Math.max(EMBER_LIFE_MS, (MAX_RING_M / SOUND_SPEED) * 1000)
    const ringPxK = this.scale / EARTH_R_M    // ringMeters → screen px (small-angle)

    // Centre point facing the camera; used to cull the far hemisphere. (The
    // orthographic POINT projection ignores clipAngle — only geoPath clips — so
    // without this, back-side strikes project onto the front and "show through".)
    const toR = Math.PI / 180
    const clat = -this.rotLat * toR
    const clon = -this.rotLon
    const sinC = Math.sin(clat), cosC = Math.cos(clat)

    ctx.globalCompositeOperation = 'lighter'
    for (const s of fx.strikes) {
      const age = now - s.born
      if (age > maxLife) continue
      const ringMeters = SOUND_SPEED * (age / 1000)
      fx.maybeThunder(s, ringMeters)

      // Cosine of angular distance from the globe centre; ≤ 0 ⇒ far side.
      // Uses the strike's cached sin/cos(lat) so we don't recompute trig per frame.
      const cosd = sinC * s._sin + cosC * s._cos * Math.cos((s.lon - clon) * toR)
      if (cosd <= 0) continue

      const p = this.proj([s.lon, s.lat])
      if (!p) continue
      const rgb = s.pol > 0 ? POS : NEG
      const e = s.e
      const limb = Math.min(1, cosd * 6)   // fade in over the last ~10° to the edge

      // ember
      const emberA = Math.max(0, 1 - age / EMBER_LIFE_MS) * limb
      if (emberA > 0) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 1.3 + 1.5 * e, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.4 + 0.5 * e) * emberA})`
        ctx.fill()
      }

      // speed-of-sound ring (only when big enough to see)
      const ringPx = ringMeters * ringPxK
      if (ringMeters < MAX_RING_M && ringPx > 1.5) {
        const ringA = Math.pow(1 - ringMeters / MAX_RING_M, 1.4) * (0.4 + 0.45 * e) * limb
        ctx.beginPath(); this.path(this.circle.center([s.lon, s.lat]).radius(ringMeters / M_PER_DEG)())
        ctx.strokeStyle = `rgba(${Math.min(255, rgb[0] + 50)},${rgb[1]},${rgb[2]},${ringA})`
        ctx.lineWidth = 1.2
        ctx.stroke()
      }

      // flash
      if (age < FLASH_MS) {
        const f = 1 - age / FLASH_MS
        const fa = f * limb
        const glowR = (6 + 20 * f) * (0.8 + 0.6 * e)
        const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], glowR)
        g.addColorStop(0, `rgba(255,255,255,${0.95 * fa})`)
        g.addColorStop(0.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.8 * fa})`)
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(p[0], p[1], glowR, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(p[0], p[1], (1.4 + 2 * f) * (0.8 + 0.5 * e), 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${fa})`; ctx.fill()
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }
}
