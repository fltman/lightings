// Storm-cell overlay (flat map). Draws each tracked cell as: a faint trail, a
// centroid ring, a ~15-min drift arrow inside a widening uncertainty cone, and a
// chip with its neutral ID, strikes/min and a rising/steady/falling marker.
//
// Neutral nouns only — "Cell C12", never a storm-type label; the arrow is "where
// the activity is drifting", a projection, not a promised path.

const HORIZON_S = 15 * 60          // 15-minute drift projection
const STATE = {
  rising: { c: '255,150,90', mark: '▲' },
  falling: { c: '120,170,255', mark: '▼' },
  steady: { c: '185,205,235', mark: '■' },
}

export function drawCells(ctx, cells, map, viewW, viewH) {
  ctx.save()
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'
  for (const c of cells) {
    const p = map.project([c.lon, c.lat])
    if (p.x < -60 || p.x > viewW + 60 || p.y < -60 || p.y > viewH + 60) continue
    const st = STATE[c.state] || STATE.steady

    // trail
    if (c.trail && c.trail.length > 1) {
      ctx.beginPath()
      for (let i = 0; i < c.trail.length; i++) {
        const tp = map.project([c.trail[i][1], c.trail[i][0]])
        if (i === 0) ctx.moveTo(tp.x, tp.y); else ctx.lineTo(tp.x, tp.y)
      }
      ctx.strokeStyle = `rgba(${st.c},0.25)`
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // drift arrow + widening cone toward the projected position
    const fp = map.project([c.lon + c.vlon * HORIZON_S, c.lat + c.vlat * HORIZON_S])
    const dx = fp.x - p.x, dy = fp.y - p.y
    const len = Math.hypot(dx, dy)
    if (len > 6) {
      const ang = Math.atan2(dy, dx)
      const half = 0.42                       // cone half-angle (uncertainty)
      const cone = len * 1.15
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(p.x + Math.cos(ang - half) * cone, p.y + Math.sin(ang - half) * cone)
      ctx.lineTo(p.x + Math.cos(ang + half) * cone, p.y + Math.sin(ang + half) * cone)
      ctx.closePath()
      ctx.fillStyle = `rgba(${st.c},0.10)`
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(p.x, p.y); ctx.lineTo(fp.x, fp.y)
      ctx.strokeStyle = `rgba(${st.c},0.7)`
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // centroid
    ctx.beginPath()
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${st.c},0.9)`
    ctx.lineWidth = 1.5
    ctx.stroke()

    // chip
    const label = `C${c.id} · ${c.rate}/min ${st.mark}`
    const tw = ctx.measureText(label).width
    ctx.fillStyle = 'rgba(8,12,22,0.72)'
    ctx.fillRect(p.x + 9, p.y - 18, tw + 12, 17)
    ctx.fillStyle = `rgba(${st.c},1)`
    ctx.fillText(label, p.x + 15, p.y - 6)
  }
  ctx.restore()
}
