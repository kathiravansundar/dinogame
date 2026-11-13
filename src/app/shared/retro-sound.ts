/** Tiny Web Audio beeper shared by the games. Fails silently if audio is unavailable. */
export class RetroSound {
  enabled = true;
  private audio?: AudioContext;

  beep(freq: number, duration: number, type: OscillatorType = 'square'): void {
    if (!this.enabled) return;
    try {
      this.audio ??= new AudioContext();
      const now = this.audio.currentTime;
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
      osc.stop(now + duration);
    } catch {
      /* audio not available */
    }
  }

  close(): void {
    this.audio?.close().catch(() => {});
    this.audio = undefined;
  }
}

/** Reads a stored high score; returns 0 if storage is unavailable. */
export function loadHiScore(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

export function saveHiScore(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}
