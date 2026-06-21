// Dry-lightning sampler.
//
// "Dry" lightning — a strike with NO rain echo beneath it — is the leading
// natural wildfire-ignition source: the bolt isn't quenched on contact. We can
// detect it client-side because RainViewer tiles are CORS-enabled: load the
// latest radar frame into one offscreen Web-Mercator canvas (zoom 3, whole
// world) and read the ALPHA under a strike (transparent = no echo). A strike is
// flagged dry only when there's no echo AND real convective fuel (CAPE) there —
// "no echo AND no CAPE" is more likely a detection artifact than a fire.
//
// HONEST: this is "no rain CORE detected beneath the strike" (radar can miss
// high-based virga, and coverage is patchy over oceans/poles) — an ESTIMATE of
// elevated ignition potential, never a guaranteed fire.

const Z = 3
const N = 1 << Z          // 8 tiles across
const TILE = 256
const SIZE = TILE * N     // 2048px world

export class DryRadar {
  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = SIZE
    this.canvas.height = SIZE
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    this.data = null      // RGBA of the latest radar mosaic
    this.ready = false
  }

  async load() {
    try {
      const r = await fetch('/radar')
      const j = await r.json()
      if (!j.host || !j.past?.length) return false
      const frame = j.past[j.past.length - 1]   // latest observed frame
      this.ctx.clearRect(0, 0, SIZE, SIZE)
      const loads = []
      for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
          loads.push(new Promise((res) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => { try { this.ctx.drawImage(img, x * TILE, y * TILE) } catch {} ; res() }
            img.onerror = () => res()
            img.src = `${j.host}${frame.path}/${TILE}/${Z}/${x}/${y}/2/1_1.png`
          }))
        }
      }
      await Promise.all(loads)
      this.data = this.ctx.getImageData(0, 0, SIZE, SIZE).data
      this.ready = true
      return true
    } catch {
      return false
    }
  }

  // Is there a radar echo (rain) under this point?
  hasEcho(lat, lon) {
    if (!this.data) return true   // unknown → assume wet (don't false-flag dry)
    const x = Math.floor(((lon + 180) / 360) * SIZE)
    const mercY = 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)
    const y = Math.floor(mercY * SIZE)
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return true
    return this.data[(y * SIZE + x) * 4 + 3] > 20   // alpha > 20 ⇒ echo present
  }
}
