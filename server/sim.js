// Simulation mode — drifting storm cells that emit clustered lightning strikes.
// Used as an offline / fallback source so the map is alive even without the
// live Blitzortung feed. Shape of an emitted strike matches the live relay:
//   { lat, lon, time (ms epoch), pol, region, mode }

const R = () => Math.random()

// A storm cell: a moving centre with an intensity and a spatial spread.
function makeCell() {
  // Bias cells toward mid-latitudes where real storms cluster, but keep global.
  const lat = (R() * 2 - 1) * 60
  const lon = (R() * 2 - 1) * 175
  return {
    lat,
    lon,
    spread: 0.4 + R() * 1.6,        // degrees
    intensity: 0.2 + R() * 1.0,     // relative strike weight
    // slow drift, degrees per second
    vlat: (R() * 2 - 1) * 0.004,
    vlon: (R() * 2 - 1) * 0.01,
    life: 40 + R() * 160,           // seconds until the cell dissipates
    age: 0,
  }
}

// Box–Muller gaussian for natural clustering around a cell centre.
function gauss() {
  let u = 0, v = 0
  while (u === 0) u = R()
  while (v === 0) v = R()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// Synthetic detector stations around a strike, so the sig[]-based features
// (confidence halo, the click-to-reveal multilateration) work in sim/demo mode.
// Returns { sig:[{la,lo,t}], mcg } in the same trimmed shape the live feed uses.
function genStations(lat, lon) {
  const n = 5 + Math.floor(R() * 10)            // 5–14 stations
  const bearings = []
  const sig = []
  for (let i = 0; i < n; i++) {
    const brg = R() * 360
    bearings.push(brg)
    const d = 60000 + R() * 900000              // 60–960 km away
    const b = (brg * Math.PI) / 180
    const dLat = (d / 111320) * Math.cos(b)
    const dLon = (d / 111320) * Math.sin(b) / Math.cos((lat * Math.PI) / 180)
    sig.push({
      la: Math.max(-85, Math.min(85, lat + dLat)),
      lo: ((lon + dLon + 540) % 360) - 180,
      t: Math.round(d * 3.336),                 // fake time-of-arrival delay (ns)
    })
  }
  // Max circular gap between station bearings → coverage quality.
  bearings.sort((a, b) => a - b)
  let mcg = 0
  for (let i = 0; i < bearings.length; i++) {
    const gap = i === 0
      ? bearings[0] + 360 - bearings[bearings.length - 1]
      : bearings[i] - bearings[i - 1]
    if (gap > mcg) mcg = gap
  }
  return { sig, mcg: Math.round(mcg) }
}

export function startSim(onStrike, opts = {}) {
  const targetRate = opts.rate ?? 14       // strikes per second across the globe
  const maxCells = opts.cells ?? 7
  let cells = Array.from({ length: maxCells }, makeCell)

  const tickMs = 100
  let last = Date.now()

  const timer = setInterval(() => {
    const now = Date.now()
    const dt = (now - last) / 1000
    last = now

    // Age, drift and recycle cells.
    cells = cells.map((c) => {
      c.age += dt
      c.lat += c.vlat * dt * 50
      c.lon += c.vlon * dt * 50
      if (c.lon > 180) c.lon -= 360
      if (c.lon < -180) c.lon += 360
      c.lat = Math.max(-85, Math.min(85, c.lat))
      return c
    }).filter((c) => c.age < c.life)
    while (cells.length < maxCells) cells.push(makeCell())

    // Poisson-ish: expected strikes this tick.
    const expected = targetRate * (tickMs / 1000)
    let n = Math.floor(expected)
    if (R() < expected - n) n++

    const totalIntensity = cells.reduce((s, c) => s + c.intensity, 0)
    for (let i = 0; i < n; i++) {
      // Pick a cell weighted by intensity.
      let pick = R() * totalIntensity
      let cell = cells[0]
      for (const c of cells) { pick -= c.intensity; if (pick <= 0) { cell = c; break } }

      const lat = cell.lat + gauss() * cell.spread * 0.5
      const lon = cell.lon + gauss() * cell.spread * 0.5
      const pol = R() < 0.85 ? -1 : 1   // most cloud-to-ground strikes are negative
      const sLat = Math.max(-85, Math.min(85, lat))
      const sLon = ((lon + 540) % 360) - 180
      const { sig, mcg } = genStations(sLat, sLon)
      onStrike({
        lat: sLat,
        lon: sLon,
        time: now,
        pol,
        region: 0,
        // Relative intensity: skewed low, with occasional strong (often positive) bolts.
        e: Math.max(0.15, Math.min(1, (pol > 0 ? 0.55 : 0.25) + Math.abs(gauss()) * 0.25)),
        mcg,
        sig,
        mode: 'sim',
      })
    }
  }, tickMs)

  return () => clearInterval(timer)
}
