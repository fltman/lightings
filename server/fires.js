// Active-fire layer (NASA FIRMS, VIIRS NRT). Polled per client viewport.
//
// FIRMS returns ALL thermal detections (huge — much of it agricultural burning),
// so we cap the payload and, per the data-fusion plan, flag fires sitting on an
// active lightning CELL as "possible lightning ignition" candidates (always kept).
// Honest: co-location with active lightning, NOT a verified causal ignition.

const CAP = 600

let fires = []
let pokeFn = null
export function getFires() { return fires }
export function pokeFires() { if (pokeFn) pokeFn() }

function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = Math.PI / 180
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function parseCsv(text) {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []
  const head = lines[0].split(',')
  const iLat = head.indexOf('latitude'), iLon = head.indexOf('longitude')
  const iDate = head.indexOf('acq_date'), iTime = head.indexOf('acq_time')
  const iFrp = head.indexOf('frp'), iConf = head.indexOf('confidence')
  const out = []
  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(',')
    const lat = +c[iLat], lon = +c[iLon]
    if (!isFinite(lat) || !isFinite(lon)) continue
    const hhmm = String(c[iTime] || '0').padStart(4, '0')
    const [y, m, d] = (c[iDate] || '').split('-').map(Number)
    const time = y ? Date.UTC(y, m - 1, d, +hhmm.slice(0, 2), +hhmm.slice(2)) : Date.now()
    out.push({ lat, lon, frp: +c[iFrp] || 0, conf: c[iConf] || 'n', time })
  }
  return out
}

export function startFires(getBoxes, getCells, { log = console.log } = {}) {
  const KEY = process.env.FIRMS_MAP_KEY
  if (!KEY) { log('[fires] no FIRMS_MAP_KEY — fires disabled'); return () => {} }

  async function poll() {
    const boxes = getBoxes()
    if (!boxes.length) { fires = []; return }
    const cells = getCells()
    try {
      let all = []
      for (const b of boxes) {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/VIIRS_SNPP_NRT/${b.w},${b.s},${b.e},${b.n}/1`
        const r = await fetch(url)
        if (!r.ok) throw new Error(`FIRMS ${r.status}`)
        all = all.concat(parseCsv(await r.text()))
      }
      // Flag ignition candidates: a fire within 15 km of an active lightning cell.
      for (const f of all) {
        f.ignition = cells.some((c) => distKm(f.lat, f.lon, c.lat, c.lon) <= 15)
      }
      // Keep all ignition candidates + the strongest others, up to the cap.
      all.sort((a, b) => (b.ignition - a.ignition) || (b.frp - a.frp))
      fires = all.slice(0, CAP)
      const ign = fires.filter((f) => f.ignition).length
      log(`[fires] ${all.length} detections, ${fires.length} shown, ${ign} near lightning`)
    } catch (e) {
      log(`[fires] ${e.message}`)
    }
  }

  pokeFn = poll
  poll()
  const t = setInterval(poll, 15 * 60000)   // FIRMS NRT latency is hours; poll gently
  return () => clearInterval(t)
}
