// Cell Avoidance — live aircraft (OpenSky, free/anonymous).
//
// OpenSky's anonymous tier is rate-limited, so we only poll while a client has
// the Flights layer on, and only the box(es) that client supplies — its current
// viewport when zoomed in (clamped so the area stays cheap), or the busiest
// storm cells when zoomed out. Every plane in the box is shown; one is flagged
// "deviating" only when its ADS-B true_track is turning AWAY from a nearby cell —
// honest observed curvature near convection, never a claimed reroute.

let planes = []
let pokeFn = null
export function getPlanes() { return planes }
export function pokeAircraft() { if (pokeFn) pokeFn() }

function angDiff(a, b) {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
function bearing(aLat, aLon, bLat, bLon) {
  const toR = Math.PI / 180
  const y = Math.sin((bLon - aLon) * toR) * Math.cos(bLat * toR)
  const x = Math.cos(aLat * toR) * Math.sin(bLat * toR) -
    Math.sin(aLat * toR) * Math.cos(bLat * toR) * Math.cos((bLon - aLon) * toR)
  return (Math.atan2(y, x) / toR + 360) % 360
}
function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = Math.PI / 180
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// getBoxes() -> [{s,w,n,e}] to poll (empty = nobody watching). getCells() -> cells.
export function startAircraft(getBoxes, getCells, { log = console.log } = {}) {
  const trails = new Map()   // icao -> [{lat,lon,track,t}]

  async function fetchBox(box) {
    const url = `https://opensky-network.org/api/states/all?lamin=${box.s}&lomin=${box.w}&lamax=${box.n}&lomax=${box.e}`
    const r = await fetch(url, { headers: { 'User-Agent': 'lightings-map' } })
    if (!r.ok) throw new Error(`OpenSky ${r.status}`)
    return (await r.json()).states || []
  }

  function nearestCell(cells, lat, lon) {
    let best = null, bestD = 250   // only consider cells within 250 km
    for (const c of cells) {
      const d = distKm(lat, lon, c.lat, c.lon)
      if (d < bestD) { bestD = d; best = c }
    }
    return best
  }

  async function poll() {
    const boxes = getBoxes()
    if (!boxes.length) { planes = []; return }
    const cells = getCells()
    try {
      const now = Date.now()
      const out = []
      const seen = new Set()
      for (const box of boxes) {
        const states = await fetchBox(box)
        for (const st of states) {
          const icao = st[0], lon = st[5], lat = st[6], onGround = st[8], track = st[10]
          if (onGround || typeof lat !== 'number' || typeof lon !== 'number' || typeof track !== 'number') continue
          if (seen.has(icao)) continue
          seen.add(icao)
          const tr = trails.get(icao) || []
          tr.push({ lat, lon, track, t: now })
          while (tr.length > 6) tr.shift()
          trails.set(icao, tr)
          // Turning away from the nearest cell?
          let dev = false
          const cell = nearestCell(cells, lat, lon)
          if (cell && tr.length >= 3) {
            const old = tr[0], cur = tr[tr.length - 1]
            const turned = angDiff(old.track, cur.track) > 12
            const brg = bearing(cur.lat, cur.lon, cell.lat, cell.lon)
            const away = angDiff(cur.track, brg) > angDiff(old.track, brg) + 5
            dev = turned && away
          }
          out.push({ icao, lat, lon, track, dev, trail: tr.map((q) => [q.lat, q.lon]) })
        }
      }
      for (const [icao, tr] of trails) if (now - tr[tr.length - 1].t > 5 * 60000) trails.delete(icao)
      planes = out
    } catch (e) {
      log(`[aircraft] ${e.message}`)   // rate-limited / offline → keep last, degrade quietly
    }
  }

  pokeFn = poll
  poll()
  const t = setInterval(poll, 60000)
  return () => clearInterval(t)
}
