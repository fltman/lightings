// Multilateration reveal.
//
// Click a strike and this replays how the Blitzortung network *located* it: the
// detector stations that heard the bolt light up (often hundreds of km away),
// a ping races inward from each, and they all converge on the strike point.
//
// HONEST NOTE: the per-station values in sig[] are signal time-of-arrival delays
// (ns), not literal EM travel times from the bolt. We re-time the pings to arrive
// together for legibility — it's an honest dramatization of "all these sensors
// heard this one flash", not a literal propagation simulation.

const TRAVEL_MS = 1200       // pings converge over this long
const LIFE_MS = 3400         // total reveal lifetime

export class Reveal {
  constructor() {
    this.active = null
  }

  start(strike, now) {
    if (!strike || !strike.sig || strike.sig.length < 2) return false
    this.active = {
      lat: strike.lat,
      lon: strike.lon,
      pol: strike.pol,
      mcg: strike.mcg,
      stations: strike.sig,
      born: now,
    }
    return true
  }

  render(ctx, map) {
    const r = this.active
    if (!r) return
    const now = performance.now()
    const age = now - r.born
    if (age >= LIFE_MS) { this.active = null; return }

    const fadeIn = Math.min(1, age / 200)
    const fadeOut = age > LIFE_MS - 800 ? Math.max(0, (LIFE_MS - age) / 800) : 1
    const a = fadeIn * fadeOut
    const prog = Math.min(1, age / TRAVEL_MS)
    const ps = map.project([r.lon, r.lat])

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    for (const st of r.stations) {
      const pst = map.project([st.lo, st.la])
      // line station → strike
      ctx.beginPath()
      ctx.moveTo(pst.x, pst.y)
      ctx.lineTo(ps.x, ps.y)
      ctx.strokeStyle = `rgba(120,190,255,${0.12 * a})`
      ctx.lineWidth = 1
      ctx.stroke()

      // station node
      ctx.beginPath()
      ctx.arc(pst.x, pst.y, 2.4, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(150,210,255,${0.7 * a})`
      ctx.fill()

      // inbound ping (eased), all arriving together at prog = 1
      if (prog < 1) {
        const ease = prog * prog * (3 - 2 * prog)
        const x = pst.x + (ps.x - pst.x) * ease
        const y = pst.y + (ps.y - pst.y) * ease
        ctx.beginPath()
        ctx.arc(x, y, 2.2, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(190,235,255,${0.9 * a})`
        ctx.fill()
      }
    }

    // convergence flash + collapsing focus ring once pings land
    if (prog >= 1) {
      const since = age - TRAVEL_MS
      const f = Math.max(0, 1 - since / 700)
      const fr = 26 * f
      ctx.beginPath()
      ctx.arc(ps.x, ps.y, fr, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * f * a})`
      ctx.lineWidth = 2
      ctx.stroke()
      const g = ctx.createRadialGradient(ps.x, ps.y, 0, ps.x, ps.y, 16)
      g.addColorStop(0, `rgba(255,255,255,${0.9 * f * a})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(ps.x, ps.y, 16, 0, Math.PI * 2)
      ctx.fill()
    }

    // label
    ctx.globalCompositeOperation = 'source-over'
    const mcgTxt = typeof r.mcg === 'number' ? ` · gap ${Math.round(r.mcg)}°` : ''
    const label = `${r.stations.length} stations heard this${mcgTxt}`
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'
    const tw = ctx.measureText(label).width
    ctx.fillStyle = `rgba(8,12,22,${0.7 * a})`
    ctx.fillRect(ps.x + 10, ps.y - 24, tw + 14, 20)
    ctx.fillStyle = `rgba(200,225,255,${a})`
    ctx.fillText(label, ps.x + 17, ps.y - 10)
    ctx.restore()
  }
}
