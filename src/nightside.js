// Night Side — the real day/night terminator.
//
// Computes the subsolar point from the wall clock, draws the terminator as a
// screen-space hemisphere, and fills the night side with a translucent dark wash
// on the FX canvas BEFORE the additive strikes are drawn — so flashes, rings and
// embers on the dark hemisphere naturally bloom brighter while the day side reads
// as faint sparks. No external data: pure astronomy from Date.now().
//
// Accuracy is "visually right" (a few degrees; equation-of-time ignored), which
// is plenty for the effect. Best near the solstices; roughest at the equinoxes.

const RAD = Math.PI / 180

// Approximate subsolar point (where the sun is overhead) for a given Date.
export function subsolar(date) {
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 0)
  const dayOfYear = Math.floor((date.getTime() - yearStart) / 86400000)
  let dec = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10)) // solar declination °
  if (Math.abs(dec) < 0.5) dec = dec < 0 ? -0.5 : 0.5                  // avoid tan() blow-up
  const lon = -15 * (utcH - 12)                                       // subsolar longitude °
  return { dec, lon }
}

export class NightSide {
  constructor() {
    this.enabled = true
  }

  setEnabled(on) { this.enabled = on }

  render(ctx, map, w, h, date) {
    if (!this.enabled) return

    // The terminator only moves with the map view or (slowly) with the clock, so
    // recompute the projected point array only on view change or ~1 s drift —
    // not the ~180 map.project() calls every single 60fps frame.
    const now = date.getTime()
    const c = map.getCenter()
    const vk = `${c.lng.toFixed(2)},${c.lat.toFixed(2)},${map.getZoom().toFixed(2)},${w}x${h}`
    if (!this._pts || vk !== this._vk || now - (this._t || 0) > 1000) {
      const { dec, lon: subLon } = subsolar(date)
      const tanDec = Math.tan(dec * RAD)
      const pts = []
      for (let i = 0; i <= 180; i++) {
        const lon = c.lng - 180 + (i * 360) / 180
        const latT = Math.atan(-Math.cos((lon - subLon) * RAD) / tanDec) / RAD
        pts.push(map.project([lon, Math.max(-85, Math.min(85, latT))]))
      }
      this._pts = pts
      // Night is the hemisphere away from the sun: sun north (dec>0) → dark south.
      this._edgeY = dec > 0 ? h + 10 : -10
      this._vk = vk
      this._t = now
    }
    const pts = this._pts
    const edgeY = this._edgeY

    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.lineTo(pts[pts.length - 1].x, edgeY)
    ctx.lineTo(pts[0].x, edgeY)
    ctx.closePath()
    ctx.fillStyle = 'rgba(2, 4, 14, 0.5)'
    ctx.fill()

    // Thin amber dusk line along the terminator.
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.strokeStyle = 'rgba(255, 170, 90, 0.22)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }
}
