// Active-fire overlay (flat map + globe). Regular FIRMS detections are small dim
// orange embers; fires co-located with an active lightning cell ("ignition
// candidates") glow bright amber with a ring. Caller supplies the screen point.

export function drawFire(ctx, x, y, f) {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  if (f.ignition) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, 13)
    g.addColorStop(0, 'rgba(255,235,160,0.95)')
    g.addColorStop(0.4, 'rgba(255,140,40,0.7)')
    g.addColorStop(1, 'rgba(255,80,20,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,205,110,0.85)'; ctx.lineWidth = 1.5; ctx.stroke()
  } else {
    const size = Math.min(7, 2.4 + Math.sqrt(Math.max(0, f.frp)) * 0.7)
    const g = ctx.createRadialGradient(x, y, 0, x, y, size)
    g.addColorStop(0, 'rgba(255,170,70,0.95)')
    g.addColorStop(0.5, 'rgba(255,110,35,0.7)')
    g.addColorStop(1, 'rgba(255,80,20,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
}
