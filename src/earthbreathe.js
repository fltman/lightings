// Earth Breathe — the planet as a generative ambient instrument.
//
// Every strike, anywhere, becomes a soft pitched tick: pitch by LATITUDE (low at
// the poles, high at the equator), quantized to a PENTATONIC scale so it never
// turns to mush, timbre by polarity. Underneath, a slow drone PAD swells with
// global strike activity. Voice-limited and gentle — built to actually sound
// good on a busy night, not a wall of clicks.

// 3 octaves of a C pentatonic scale (low → high).
const SEMI = [0, 2, 4, 7, 9]
const SCALE = []
for (let oct = 0; oct < 3; oct++) for (const s of SEMI) SCALE.push(65.41 * Math.pow(2, (oct * 12 + s) / 12))

const MAX_VOICES = 10
const COOLDOWN = 0.05   // s between ticks (throttles the firehose)

export class EarthBreathe {
  constructor() {
    this.ctx = null
    this.enabled = false
    this.master = null
    this.reverb = null
    this.padGain = null
    this.padFilter = null
    this.voices = 0
    this.last = -1
  }

  enable() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return false
      const ctx = new AC()
      this.ctx = ctx
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -16; comp.ratio.value = 8; comp.attack.value = 0.004; comp.release.value = 0.25
      const out = ctx.createGain(); out.gain.value = 0.7
      comp.connect(out).connect(ctx.destination)
      this.master = comp

      // a long soft reverb tail
      const conv = ctx.createConvolver()
      conv.buffer = this._impulse(3.2, 2.5)
      const wet = ctx.createGain(); wet.gain.value = 0.5
      conv.connect(wet).connect(this.master)
      this.reverb = conv

      // drone pad: detuned low oscillators through a slow lowpass
      const pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 300; pf.Q.value = 4
      const pg = ctx.createGain(); pg.gain.value = 0.0001
      pf.connect(pg).connect(this.master)
      pg.connect(this.reverb)
      for (const [f, det] of [[65.41, -6], [98.0, 4], [130.8, -10]]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det
        o.connect(pf); o.start()
      }
      this.padGain = pg; this.padFilter = pf
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    this.enabled = true
    return true
  }

  disable() {
    this.enabled = false
    if (this.padGain) this.padGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.5)
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate
    const len = Math.floor(seconds * rate)
    const buf = this.ctx.createBuffer(2, len, rate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
    }
    return buf
  }

  // Modulate the pad with global activity (strikes/min).
  setActivity(perMin) {
    if (!this.enabled || !this.padGain) return
    const t = this.ctx.currentTime
    const a = Math.min(1, perMin / 300)
    this.padGain.gain.setTargetAtTime(0.0001 + a * 0.06, t, 2)
    this.padFilter.frequency.setTargetAtTime(220 + a * 700, t, 2)
  }

  // A strike → one quantized tick.
  tick(lat, pol) {
    if (!this.enabled || !this.ctx) return
    const t = this.ctx.currentTime
    if (t - this.last < COOLDOWN || this.voices >= MAX_VOICES) return
    this.last = t

    const idx = Math.max(0, Math.min(SCALE.length - 1, Math.round((1 - Math.abs(lat) / 90) * (SCALE.length - 1))))
    const freq = SCALE[idx]
    const osc = this.ctx.createOscillator()
    osc.type = pol > 0 ? 'triangle' : 'sine'
    osc.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.09, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.45)
    osc.connect(g)
    g.connect(this.master)
    g.connect(this.reverb)
    this.voices++
    osc.start(t)
    osc.stop(t + 0.5)
    osc.onended = () => { this.voices = Math.max(0, this.voices - 1) }
  }
}
