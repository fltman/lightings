// Earthquake rendering — hollow rings sized by magnitude, coloured by depth, a
// deliberate slow counterpoint to lightning's fast flashes. Newly-arrived quakes
// bloom once then settle into embers. Drawn on whichever canvas is active (flat
// FX overlay or the globe), so the draw is projection-agnostic: the caller
// supplies the screen point (or culls the far side of the globe).
//
// Honest framing: lightning and earthquakes are independent planetary clocks
// shown side by side — never implied to be causally linked.

// Depth colour: shallow = warm/red, intermediate = amber, deep = blue.
function depthColor(d) {
  if (d == null) return [255, 180, 120]
  if (d < 70) return [255, 120, 90]
  if (d < 300) return [255, 200, 90]
  return [120, 170, 255]
}

// bloomAge = ms since the client first saw this quake (NOT since it occurred).
export function drawQuake(ctx, x, y, q, bloomAge) {
  const mag = q.mag || 0
  if (mag < 1) return
  const [r, g, b] = depthColor(q.depth)
  const baseR = 3 + mag * 3.5

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'

  // Steady ember ring.
  ctx.beginPath()
  ctx.arc(x, y, baseR, 0, Math.PI * 2)
  ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, 1.6, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(${r},${g},${b},0.9)`
  ctx.fill()

  // One-time bloom for the first ~5 s after arrival.
  const BLOOM = 5000
  if (bloomAge >= 0 && bloomAge < BLOOM) {
    const f = 1 - bloomAge / BLOOM
    ctx.beginPath()
    ctx.arc(x, y, baseR + (1 - f) * (baseR + 30), 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.6 * f})`
    ctx.lineWidth = 2
    ctx.stroke()
  }
  ctx.restore()
}
