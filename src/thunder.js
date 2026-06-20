// Procedural thunder (WebAudio).
//
// When a strike's speed-of-sound ring reaches the "ear", fire() is called with
// the ground distance. Close bolts get a tight, bright CRACK; distant ones get a
// long, low, smeared RUMBLE — low-pass cutoff and envelope length scale with
// distance, so what you HEAR matches what you SEE the ring do. All synthesized
// (filtered noise + a short reverb tail); nothing is sampled, so it never sounds
// canned. A voice cap + cooldown keep a storm overhead from crackling/pinning CPU.

const MAX_DIST = 30000      // matches the ring's audible cap
const MAX_VOICES = 7
const COOLDOWN_S = 0.035

export class Thunder {
  constructor() {
    this.ctx = null
    this.enabled = false
    this.master = null
    this.ir = null
    this.voices = 0
    this.lastFire = -1
  }

  // Must be called from a user gesture (autoplay policy). Idempotent.
  enable() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return false
      this.ctx = new AC()
      // Master chain: gentle compressor → limiter-ish makeup → destination.
      const comp = this.ctx.createDynamicsCompressor()
      comp.threshold.value = -18
      comp.knee.value = 24
      comp.ratio.value = 12
      comp.attack.value = 0.003
      comp.release.value = 0.25
      const out = this.ctx.createGain()
      out.gain.value = 0.9
      comp.connect(out).connect(this.ctx.destination)
      this.master = comp
      this.ir = this._impulse(1.8, 2.2)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    this.enabled = true
    return true
  }

  disable() { this.enabled = false }

  // A decaying-noise impulse response for the rumble's reverb tail.
  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate
    const len = Math.floor(seconds * rate)
    const buf = this.ctx.createBuffer(2, len, rate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
      }
    }
    return buf
  }

  _noise(seconds) {
    const rate = this.ctx.sampleRate
    const len = Math.max(1, Math.floor(seconds * rate))
    const buf = this.ctx.createBuffer(1, len, rate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    return buf
  }

  fire(distM, pol = 0, energy = 0.5) {
    if (!this.enabled || !this.ctx) return
    const t = this.ctx.currentTime
    if (t - this.lastFire < COOLDOWN_S) return
    if (this.voices >= MAX_VOICES) return
    this.lastFire = t

    const ctx = this.ctx
    const frac = Math.min(1, Math.max(0, distM / MAX_DIST))   // 0 near … 1 far
    const dur = 0.32 + frac * 1.7                              // far = longer rumble
    const amp = Math.min(1, energy * (1 / (1 + distM / 2500))) * 0.9

    const src = ctx.createBufferSource()
    src.buffer = this._noise(dur)

    // Tone: near = bright crack (high cutoff), far = deep rumble (low cutoff).
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    const cutoff = 200 + 5200 * Math.pow(1 - frac, 2.2)
    lp.frequency.value = cutoff
    lp.Q.value = 0.7

    // Envelope: quick attack, distance-dependent decay.
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(amp, t + 0.006 + frac * 0.05)
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur)

    src.connect(lp).connect(env)

    // Dry path + a wetter reverb tail the farther (and rumblier) it is.
    const dry = ctx.createGain()
    dry.gain.value = 0.8
    env.connect(dry).connect(this.master)

    const conv = ctx.createConvolver()
    conv.buffer = this.ir
    const wet = ctx.createGain()
    wet.gain.value = 0.25 + frac * 0.5
    env.connect(conv).connect(wet).connect(this.master)

    // Near bolts get a couple of sharp crack transients on top.
    if (frac < 0.12) {
      const cracks = pol > 0 ? 3 : 2
      for (let i = 0; i < cracks; i++) {
        const cs = ctx.createBufferSource()
        cs.buffer = this._noise(0.05)
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 1800
        const cg = ctx.createGain()
        const at = t + i * (0.012 + Math.random() * 0.02)
        cg.gain.setValueAtTime(0, at)
        cg.gain.linearRampToValueAtTime(amp * 0.9, at + 0.002)
        cg.gain.exponentialRampToValueAtTime(0.0008, at + 0.08)
        cs.connect(hp).connect(cg).connect(this.master)
        cs.start(at); cs.stop(at + 0.1)
      }
    }

    this.voices++
    src.start(t)
    src.stop(t + dur + 0.05)
    src.onended = () => { this.voices = Math.max(0, this.voices - 1) }
  }
}
