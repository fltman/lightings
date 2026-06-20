// Aircraft overlay (flat map). Each plane is a small triangle oriented by its
// real ADS-B true_track, with a short trail. Planes the relay flagged as turning
// AWAY from the cell glow amber — observed curvature near convection, never a
// claimed reroute.

export function drawPlanes(ctx, planes, map, viewW, viewH) {
  ctx.save()
  for (const pl of planes) {
    const p = map.project([pl.lon, pl.lat])
    if (p.x < -30 || p.x > viewW + 30 || p.y < -30 || p.y > viewH + 30) continue

    // trail
    if (pl.trail && pl.trail.length > 1) {
      ctx.beginPath()
      for (let i = 0; i < pl.trail.length; i++) {
        const tp = map.project([pl.trail[i][1], pl.trail[i][0]])
        if (i === 0) ctx.moveTo(tp.x, tp.y); else ctx.lineTo(tp.x, tp.y)
      }
      ctx.strokeStyle = pl.dev ? 'rgba(255,180,90,0.5)' : 'rgba(200,220,255,0.3)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // triangle oriented by track (deg clockwise from north)
    const a = (pl.track * Math.PI) / 180
    const dx = Math.sin(a), dy = -Math.cos(a)
    const px = -dy, py = dx           // perpendicular
    const s = pl.dev ? 7 : 5
    ctx.beginPath()
    ctx.moveTo(p.x + dx * s, p.y + dy * s)
    ctx.lineTo(p.x - dx * s * 0.6 + px * s * 0.6, p.y - dy * s * 0.6 + py * s * 0.6)
    ctx.lineTo(p.x - dx * s * 0.6 - px * s * 0.6, p.y - dy * s * 0.6 - py * s * 0.6)
    ctx.closePath()
    ctx.fillStyle = pl.dev ? 'rgba(255,190,100,0.95)' : 'rgba(210,225,255,0.85)'
    ctx.fill()
    if (pl.dev) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,180,90,0.6)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
  ctx.restore()
}
