// Thunder ETA + 30/30 guardian.
//
// Drop a pin (your location). For every strike we compute when its thunder
// reaches the pin — at the real speed of sound — and surface the soonest one as
// a live countdown. We also apply the US NWS "30/30" lightning-safety rule: a
// strike within ~10 km (flash-to-bang < 30 s) means TAKE COVER, and we only flip
// back to ALL CLEAR once 30 minutes pass with no nearby strike.
//
// All timing is from epoch `strike.time` vs Date.now() (NOT the FX engine's
// performance.now() "born" clock), so countdowns are physically correct.

import { haversineM } from './strikes.js'

const SOUND_SPEED = 343
const MAX_RING_M = 30000
const DANGER_M = 10300          // ~30 s flash-to-bang
const ALL_CLEAR_MS = 30 * 60 * 1000

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const compass = (b) => COMPASS[Math.round(b / 45) % 8]

export class Guardian {
  constructor(badgeEl) {
    this.badge = badgeEl
    this.pin = null              // { lat, lon }
    this.allClearAt = 0          // epoch ms
    this.soonestEta = null       // seconds until next thunder at the pin
    this.nearestKm = null
    this.cells = []              // tracked storm cells (for the approach nowcast)
    this.approach = null         // { minutes, brg, dist } or null
  }

  setPin(lat, lon) {
    this.pin = { lat, lon }
    this.allClearAt = 0
    if (this.badge) this.badge.hidden = false
  }

  clear() {
    this.pin = null
    if (this.badge) this.badge.hidden = true
  }

  // Short-horizon nowcast: which tracked cell, by its own motion, is heading for
  // the pin — time to closest approach + the compass bearing it's coming from.
  // Honest: only coherent, non-trivial cells; null when nothing's heading your way.
  _computeApproach() {
    if (!this.pin || !this.cells.length) { this.approach = null; return }
    const toR = Math.PI / 180
    const cosLat = Math.cos(this.pin.lat * toR)
    let best = null
    for (const c of this.cells) {
      if (c.rate < 6) continue
      const ex = (this.pin.lon - c.lon) * 111 * cosLat   // pin − cell (km, E/N)
      const ny = (this.pin.lat - c.lat) * 111
      const vx = c.vlon * 111 * cosLat                   // cell velocity (km/s)
      const vy = c.vlat * 111
      const vv = vx * vx + vy * vy
      if (vv < 1e-10) continue
      const tca = -(ex * vx + ny * vy) / vv              // seconds to closest approach
      if (tca <= 0 || tca > 3600) continue
      const minDist = Math.hypot(ex + vx * tca, ny + vy * tca)
      if (minDist > (c.spreadKm || 40) + 40) continue    // won't actually reach you
      const brg = (Math.atan2(-ex, -ny) / toR + 360) % 360
      if (!best || tca < best.tca) best = { tca, minDist, brg, id: c.id }
    }
    this.approach = best ? { minutes: best.tca / 60, brg: best.brg, id: best.id } : null
  }

  // Recompute safety state + soonest thunder ETA. Call a few times a second.
  update(strikes) {
    this._computeApproach()
    if (!this.pin) return
    const now = Date.now()
    let dangerTime = 0
    let soonest = Infinity
    let nearest = Infinity

    for (const s of strikes) {
      const dist = haversineM(s.lat, s.lon, this.pin.lat, this.pin.lon)
      if (dist < nearest) nearest = dist
      if (dist <= DANGER_M && s.time > dangerTime) dangerTime = s.time
      if (dist < MAX_RING_M) {
        const eta = dist / SOUND_SPEED - (now - s.time) / 1000  // seconds until ring reaches pin
        if (eta > 0.05 && eta < soonest) soonest = eta
      }
    }

    if (dangerTime) this.allClearAt = Math.max(this.allClearAt, dangerTime + ALL_CLEAR_MS)
    this.soonestEta = soonest === Infinity ? null : soonest
    this.nearestKm = nearest === Infinity ? null : nearest / 1000

    // Nowcast line (storm cell heading toward the pin).
    let approachHtml = ''
    if (this.approach) {
      const m = this.approach.minutes
      const mTxt = m < 1 ? '<1' : Math.round(m)
      approachHtml = `<span class="approach">⛈ storm heading your way · ~${mTxt} min from the ${compass(this.approach.brg)}</span>`
    }

    // Badge
    if (this.badge) {
      if (now < this.allClearAt) {
        const left = this.allClearAt - now
        const mm = Math.floor(left / 60000)
        const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
        this.badge.className = 'guardian cover'
        this.badge.innerHTML = `<strong>⚠ TAKE COVER</strong><span>nearby lightning · all-clear in ${mm}:${ss}</span>${approachHtml}`
      } else {
        const near = this.nearestKm == null ? '—' : `${this.nearestKm.toFixed(0)} km`
        this.badge.className = 'guardian clear'
        this.badge.innerHTML = `<strong>✓ ALL CLEAR</strong><span>nearest strike ${near}</span>${approachHtml}`
      }
    }
  }

  render(ctx, map) {
    if (!this.pin) return
    const p = map.project([this.pin.lon, this.pin.lat])

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(p.x - 9, p.y); ctx.lineTo(p.x - 3, p.y)
    ctx.moveTo(p.x + 3, p.y); ctx.lineTo(p.x + 9, p.y)
    ctx.moveTo(p.x, p.y - 9); ctx.lineTo(p.x, p.y - 3)
    ctx.moveTo(p.x, p.y + 3); ctx.lineTo(p.x, p.y + 9)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(180,220,255,0.9)'
    ctx.stroke()

    // soonest thunder ETA
    if (this.soonestEta != null) {
      ctx.globalCompositeOperation = 'source-over'
      const txt = `thunder in ${this.soonestEta < 10 ? this.soonestEta.toFixed(1) : Math.round(this.soonestEta)} s`
      ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'
      const tw = ctx.measureText(txt).width
      ctx.fillStyle = 'rgba(8,12,22,0.7)'
      ctx.fillRect(p.x + 10, p.y - 9, tw + 12, 18)
      ctx.fillStyle = 'rgba(220,235,255,0.95)'
      ctx.fillText(txt, p.x + 16, p.y + 4)
    }
    ctx.restore()
  }
}
