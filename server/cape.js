// CAPE (Convective Available Potential Energy) — the "fuel" that drives the
// updrafts that electrify storms. Polled from Open-Meteo (free, no key, global)
// on a coarse grid and cached. CAPE evolves ~hourly, so a 30-min refresh is
// plenty; we batch many locations per request (Open-Meteo returns an array),
// which keeps it to ~tens of calls per refresh — far under the free limits.

let cape = { time: 0, cells: [], hiFrac: 0 }
const HI = 1000   // J/kg — a meaningful "loaded" threshold

export function getCape() { return cape }

export function startCape({ log = console.log } = {}) {
  // Coarse global grid. Open-Meteo's free tier weights each LOCATION as a call
  // (~600/min, 10000/day), so keep the point count modest and refresh slowly —
  // CAPE evolves ~hourly anyway. 10° grid ≈ 468 pts; 90-min refresh ≈ 7.5k/day.
  const pts = []
  for (let la = -60; la <= 60; la += 10) {
    for (let lo = -180; lo < 180; lo += 10) pts.push([la, lo])
  }

  async function poll() {
    try {
      const idx = new Date().getUTCHours()   // hourly series starts 00:00 UTC (timezone=GMT)
      const cells = []
      for (let i = 0; i < pts.length; i += 100) {
        const chunk = pts.slice(i, i + 100)
        const latStr = chunk.map((p) => p[0]).join(',')
        const lonStr = chunk.map((p) => p[1]).join(',')
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latStr}&longitude=${lonStr}&hourly=cape&forecast_days=1&timezone=GMT`
        const r = await fetch(url)
        const j = await r.json()
        const arr = Array.isArray(j) ? j : [j]
        for (let k = 0; k < arr.length && k < chunk.length; k++) {
          const series = arr[k]?.hourly?.cape
          const v = series ? series[Math.min(idx, series.length - 1)] : null
          if (typeof v === 'number') cells.push({ lat: chunk[k][0], lon: chunk[k][1], cape: v })
        }
      }
      if (cells.length) {
        const hi = cells.filter((c) => c.cape >= HI).length
        cape = { time: Date.now(), cells, hiFrac: hi / cells.length }
        log(`[cape] ${cells.length} cells, ${(cape.hiFrac * 100) | 0}% loaded`)
      }
    } catch (e) {
      log(`[cape] ${e.message}`)
    }
  }
  poll()
  const t = setInterval(poll, 90 * 60000)
  return () => clearInterval(t)
}
