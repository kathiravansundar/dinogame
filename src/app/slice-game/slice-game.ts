import { AfterViewInit, Component, ElementRef, OnDestroy, signal, viewChild } from '@angular/core';
import { RetroSound, loadHiScore, saveHiScore } from '../shared/retro-sound';

// ---- Tunable settings -------------------------------------------------
const WIDTH = 360;
const HEIGHT = 480;
const GRAVITY = 0.18; // for sliced halves and juice
const FLOAT_GRAVITY = 0.02; // whole fruit drift down slowly from the top
const MAX_FALL_SPEED = 3.5;
const ROUND_SECONDS = 60;
const MIN_SLICE_SPEED = 4; // px per pointer move needed to count as a slice
const TRAIL_LIFE = 10; // frames a blade trail point stays visible
const HI_SCORE_KEY = 'slice-hi-score';

type GameState = 'ready' | 'running' | 'over';
type FruitKind = 'apple' | 'orange' | 'melon' | 'lemon';

interface Fruit {
  kind: FruitKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  angle: number;
  spin: number;
}

interface Half extends Fruit {
  side: 1 | -1;
  life: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

interface Bamboo {
  layer: 0 | 1 | 2; // 0 = far (faded), 2 = near (solid black)
  x: number;
  w: number;
  seg: number; // distance between nodes
  phase: number;
  leafNodes: number[];
}

// Silhouette palette — this game is always dark, regardless of light/dark mode.
const SILHOUETTE = '#000000';
const GLINT = '#e8e8e8'; // ninja eye slit
const TEXT = '#f2f2f2';

interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
}

const FRUITS: Record<FruitKind, { r: number; skin: string; flesh: string }> = {
  apple: { r: 18, skin: '#e53935', flesh: '#fff3d6' },
  orange: { r: 18, skin: '#fb8c00', flesh: '#ffc56b' },
  melon: { r: 26, skin: '#2e7d32', flesh: '#ef5350' },
  lemon: { r: 15, skin: '#fdd835', flesh: '#fff59d' },
};
const KINDS = Object.keys(FRUITS) as FruitKind[];

@Component({
  selector: 'app-slice-game',
  templateUrl: './slice-game.html',
  styleUrl: '../car-game/car-game.scss',
  host: {
    '(window:keydown)': 'onKeyDown($event)',
    '(document:visibilitychange)': 'lastTime = 0',
  },
})
export class SliceGame implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly soundOn = signal(true);

  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  lastTime = 0;
  private readonly sound = new RetroSound();

  private state: GameState = 'ready';
  private score = 0;
  private hiScore = 0;
  private timeLeft = ROUND_SECONDS;
  private gameOverAt = 0;
  private frame = 0;

  private fruits: Fruit[] = [];
  private halves: Half[] = [];
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private nextWaveIn = 40;

  // blade
  private swiping = false;
  private trail: { x: number; y: number; life: number }[] = [];
  private swipeCombo = 0;

  // ninja
  private ninjaX = WIDTH / 2;
  private ninjaTargetX = WIDTH / 2;
  private slashTimer = 0;
  private slashDir: 1 | -1 = 1;

  // background
  private bamboo: Bamboo[] = [];
  private leaves: { x: number; y: number; phase: number }[] = [];

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.hiScore = loadHiScore(HI_SCORE_KEY);
    this.createForest();
    this.rafId = requestAnimationFrame(this.loop);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.sound.close();
  }

  // ---- Input ----------------------------------------------------------
  onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      e.preventDefault();
      this.startOrRestart();
    }
  }

  protected onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    if (this.state !== 'running') {
      this.startOrRestart();
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.swiping = true;
    this.swipeCombo = 0;
    const p = this.toCanvas(e);
    this.trail = [{ ...p, life: TRAIL_LIFE }];
  }

  protected onPointerMove(e: PointerEvent): void {
    if (!this.swiping || this.state !== 'running') return;
    const p = this.toCanvas(e);
    const prev = this.trail[this.trail.length - 1];
    this.trail.push({ ...p, life: TRAIL_LIFE });
    this.ninjaTargetX = p.x;
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) >= MIN_SLICE_SPEED) this.sliceAlong(prev, p);
  }

  protected onPointerUp(): void {
    if (this.swipeCombo >= 3) {
      const bonus = this.swipeCombo;
      this.score += bonus;
      const last = this.trail[this.trail.length - 1];
      this.popups.push({ x: last?.x ?? WIDTH / 2, y: last?.y ?? HEIGHT / 2, text: `COMBO x${bonus}!`, life: 50 });
      this.sound.beep(1040, 0.15);
    }
    this.swiping = false;
    this.swipeCombo = 0;
  }

  protected toggleSound(): void {
    this.soundOn.update((v) => !v);
    this.sound.enabled = this.soundOn();
  }

  private toCanvas(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
    };
  }

  private startOrRestart(): void {
    if (this.state === 'ready') this.state = 'running';
    else if (this.state === 'over' && performance.now() - this.gameOverAt > 800) this.restart();
  }

  private restart(): void {
    this.state = 'running';
    this.score = 0;
    this.timeLeft = ROUND_SECONDS;
    this.fruits = [];
    this.halves = [];
    this.particles = [];
    this.popups = [];
    this.nextWaveIn = 40;
  }

  // ---- Slicing ---------------------------------------------------------
  private sliceAlong(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const cutAngle = Math.atan2(b.y - a.y, b.x - a.x);
    const remaining: Fruit[] = [];
    for (const f of this.fruits) {
      if (this.distToSegment(f.x, f.y, a, b) <= f.r) this.slice(f, cutAngle);
      else remaining.push(f);
    }
    this.fruits = remaining;
  }

  private slice(f: Fruit, cutAngle: number): void {
    this.score++;
    this.swipeCombo++;
    this.slashTimer = 12;
    this.slashDir = Math.cos(cutAngle) >= 0 ? 1 : -1;
    this.sound.beep(600 + this.swipeCombo * 80, 0.06, 'triangle');

    // two halves fly apart, perpendicular to the cut
    const nx = -Math.sin(cutAngle);
    const ny = Math.cos(cutAngle);
    for (const side of [1, -1] as const) {
      this.halves.push({
        ...f,
        angle: cutAngle,
        vx: f.vx + nx * side * 1.6,
        vy: Math.min(f.vy, 0) + ny * side * 1.6 - 1,
        spin: side * 0.06,
        side,
        life: 120,
      });
    }
    // juice splash
    const color = FRUITS[f.kind].flesh;
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * 3;
      this.particles.push({ x: f.x, y: f.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 25 + Math.random() * 15, color });
    }
  }

  private distToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  // ---- Game loop -------------------------------------------------------
  private loop = (time: number): void => {
    const dtMs = this.lastTime ? Math.min(time - this.lastTime, 50) : 16.7;
    const dt = dtMs / (1000 / 60);
    this.lastTime = time;
    this.frame += dt;
    if (this.state === 'running') this.update(dt, dtMs);
    this.updateEffects(dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number, dtMs: number): void {
    this.timeLeft -= dtMs / 1000;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.endRound();
      return;
    }

    this.nextWaveIn -= dt;
    if (this.nextWaveIn <= 0) this.spawnWave();

    for (const f of this.fruits) {
      // gentle fall with a side-to-side sway, like floating down
      f.vy = Math.min(f.vy + FLOAT_GRAVITY * dt, MAX_FALL_SPEED);
      f.x += (f.vx + Math.sin((f.y + f.r * 10) / 40) * 0.5) * dt;
      f.x = Math.max(f.r, Math.min(WIDTH - f.r, f.x));
      f.y += f.vy * dt;
      f.angle += f.spin * dt;
    }
    // missed fruit simply falls away — no penalty
    this.fruits = this.fruits.filter((f) => f.y < HEIGHT + 40);

    this.ninjaX += (this.ninjaTargetX - this.ninjaX) * Math.min(1, 0.15 * dt);
  }

  private updateEffects(dt: number): void {
    for (const h of this.halves) {
      h.vy += GRAVITY * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.angle += h.spin * dt;
      h.life -= dt;
    }
    this.halves = this.halves.filter((h) => h.life > 0 && h.y < HEIGHT + 40);
    for (const p of this.particles) {
      p.vy += GRAVITY * 0.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const p of this.popups) {
      p.y -= 0.5 * dt;
      p.life -= dt;
    }
    this.popups = this.popups.filter((p) => p.life > 0);
    for (const t of this.trail) t.life -= dt;
    this.trail = this.trail.filter((t) => t.life > 0);
    this.slashTimer = Math.max(0, this.slashTimer - dt);
  }

  /** Drops a group of 1–4 fruits that float down from the top; bigger groups later in the round. */
  private spawnWave(): void {
    const progress = 1 - this.timeLeft / ROUND_SECONDS;
    const count = 1 + Math.floor(Math.random() * (2 + progress * 2.5));
    for (let i = 0; i < count; i++) {
      const kind = KINDS[Math.floor(Math.random() * KINDS.length)];
      const x = 40 + Math.random() * (WIDTH - 80);
      this.fruits.push({
        kind,
        x,
        y: -30 - i * 28, // stagger a group so it arrives as a little cluster
        vx: (Math.random() - 0.5) * 0.6,
        vy: 0.8 + Math.random() * 0.8 + progress * 0.8,
        r: FRUITS[kind].r,
        angle: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.06,
      });
    }
    this.sound.beep(220, 0.05, 'triangle');
    this.nextWaveIn = 55 + Math.random() * 45 - progress * 25;
  }

  private endRound(): void {
    this.state = 'over';
    this.gameOverAt = performance.now();
    this.swiping = false;
    this.fruits = [];
    this.sound.beep(330, 0.3, 'triangle');
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      saveHiScore(HI_SCORE_KEY, this.hiScore);
    }
  }

  // ---- Drawing ---------------------------------------------------------
  private draw(): void {
    const ctx = this.ctx;
    this.drawForest();

    for (const p of this.particles) {
      ctx.globalAlpha = Math.min(1, p.life / 20);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    for (const h of this.halves) this.drawHalf(h);
    for (const f of this.fruits) this.drawFruit(f);

    // near bamboo stands in front of the fruit for depth
    for (const s of this.bamboo) if (s.layer === 2) this.drawStalk(s);

    this.drawNinja(SILHOUETTE, GLINT);
    this.drawTrail(TEXT);

    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    ctx.font = 'bold 15px "Courier New", monospace';
    for (const p of this.popups) {
      ctx.globalAlpha = Math.min(1, p.life / 20);
      ctx.fillText(p.text, Math.max(60, Math.min(WIDTH - 60, p.x)), p.y);
    }
    ctx.globalAlpha = 1;

    this.drawHud(TEXT, 'rgba(0, 0, 0, 0.75)');
  }

  // ---- Bamboo forest -----------------------------------------------------
  private createForest(): void {
    const stalk = (layer: 0 | 1 | 2, x: number, w: number): Bamboo => ({
      layer,
      x,
      w,
      seg: 34 + Math.random() * 30,
      phase: Math.random() * Math.PI * 2,
      leafNodes: [1, 2, 3, 5].filter(() => Math.random() < 0.6),
    });
    const far = Array.from({ length: 14 }, (_, i) => stalk(0, i * 27 + Math.random() * 14, 4 + Math.random() * 2));
    const mid = Array.from({ length: 7 }, (_, i) => stalk(1, 10 + i * 55 + Math.random() * 20, 7 + Math.random() * 3));
    // near stalks hug the edges so they frame the play area without hiding fruit
    const near = [stalk(2, 8, 15), stalk(2, 26, 10), stalk(2, WIDTH - 14, 16), stalk(2, WIDTH - 34, 10)];
    this.bamboo = [...far, ...mid, ...near];
    this.leaves = Array.from({ length: 6 }, () => ({
      x: Math.random() * WIDTH,
      y: Math.random() * HEIGHT,
      phase: Math.random() * 10,
    }));
  }

  private drawForest(): void {
    const ctx = this.ctx;
    // misty night sky: black at the top, glowing haze near the floor
    const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    sky.addColorStop(0, '#050505');
    sky.addColorStop(0.5, '#1b1b1b');
    sky.addColorStop(0.82, '#4d4d4d');
    sky.addColorStop(1, '#262626');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // pale moon
    ctx.fillStyle = 'rgba(225, 220, 205, 0.85)';
    ctx.beginPath();
    ctx.arc(WIDTH * 0.68, 110, 46, 0, Math.PI * 2);
    ctx.fill();

    for (const s of this.bamboo) if (s.layer < 2) this.drawStalk(s);

    // drifting bamboo leaves
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    for (const l of this.leaves) {
      l.y += 0.4;
      l.x += Math.sin(this.frame / 30 + l.phase) * 0.4;
      if (l.y > HEIGHT) Object.assign(l, { y: -10, x: Math.random() * WIDTH });
      this.drawLeaf(l.x, l.y, Math.sin(this.frame / 25 + l.phase) * 0.8, 9);
    }

    // forest floor with grass tufts
    ctx.fillStyle = SILHOUETTE;
    ctx.fillRect(0, HEIGHT - 40, WIDTH, 40);
    for (let x = 4; x < WIDTH; x += 13) {
      const h = 4 + ((x * 7) % 6);
      ctx.beginPath();
      ctx.moveTo(x - 3, HEIGHT - 40);
      ctx.lineTo(x, HEIGHT - 40 - h);
      ctx.lineTo(x + 3, HEIGHT - 40);
      ctx.fill();
    }
  }

  /** A bamboo stalk silhouette: swaying trunk, ringed nodes and leaf sprays. */
  private drawStalk(s: Bamboo): void {
    const ctx = this.ctx;
    const floor = HEIGHT - 40;
    const sway = Math.sin(this.frame / 90 + s.phase) * (2 + s.layer * 1.5);
    const xAt = (y: number) => s.x + sway * (1 - y / floor); // base fixed, top sways
    ctx.fillStyle = ['rgba(0,0,0,0.4)', 'rgba(0,0,0,0.75)', SILHOUETTE][s.layer];

    ctx.beginPath();
    ctx.moveTo(xAt(-10) - s.w / 2, -10);
    ctx.lineTo(xAt(-10) + s.w / 2, -10);
    ctx.lineTo(s.x + s.w / 2, floor);
    ctx.lineTo(s.x - s.w / 2, floor);
    ctx.fill();

    let node = 0;
    for (let y = floor - s.seg; y > -10; y -= s.seg, node++) {
      const nx = xAt(y);
      ctx.fillRect(nx - s.w / 2 - 1.5, y - 1.5, s.w + 3, 3); // node ring
      if (s.leafNodes.includes(node)) {
        const side = node % 2 ? 1 : -1;
        for (let i = 0; i < 3; i++) {
          this.drawLeaf(nx + side * (s.w / 2 + 8 + i * 3), y + 4 + i * 5, side * (0.35 + i * 0.25), 10 + s.layer * 3);
        }
      }
    }
  }

  /** A slim pointed bamboo leaf centred at (x, y). */
  private drawLeaf(x: number, y: number, angle: number, len: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(x, y, len, len * 0.22, angle, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFruit(f: Fruit): void {
    const ctx = this.ctx;
    const def = FRUITS[f.kind];
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.angle);
    ctx.fillStyle = def.skin;
    ctx.beginPath();
    if (f.kind === 'lemon') ctx.ellipse(0, 0, f.r * 1.25, f.r, 0, 0, Math.PI * 2);
    else ctx.arc(0, 0, f.r, 0, Math.PI * 2);
    ctx.fill();

    if (f.kind === 'melon') {
      ctx.strokeStyle = '#1b5e20';
      ctx.lineWidth = 3;
      for (const s of [-0.5, 0, 0.5]) {
        ctx.beginPath();
        ctx.ellipse(0, 0, f.r * Math.abs(s) + 2, f.r, 0, -Math.PI / 2, Math.PI / 2, s < 0);
        ctx.stroke();
      }
    } else if (f.kind === 'apple') {
      ctx.fillStyle = '#6d4c41';
      ctx.fillRect(-1, -f.r - 5, 3, 7); // stem
      ctx.fillStyle = '#66bb6a';
      ctx.beginPath();
      ctx.ellipse(6, -f.r - 2, 6, 3, -0.4, 0, Math.PI * 2); // leaf
      ctx.fill();
    } else if (f.kind === 'orange') {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (const [dx, dy] of [[-6, -5], [5, -8], [7, 4], [-4, 7], [0, 0]]) ctx.fillRect(dx, dy, 2, 2);
    } else {
      ctx.fillStyle = '#f9a825';
      ctx.fillRect(f.r * 1.2, -1, 4, 2); // lemon tips
      ctx.fillRect(-f.r * 1.2 - 4, -1, 4, 2);
    }
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.arc(-f.r * 0.35, -f.r * 0.35, f.r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawHalf(h: Half): void {
    const ctx = this.ctx;
    const def = FRUITS[h.kind];
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(h.angle);
    ctx.globalAlpha = Math.min(1, h.life / 30);
    const start = h.side === 1 ? 0 : Math.PI;
    ctx.fillStyle = def.skin;
    ctx.beginPath();
    ctx.arc(0, 0, h.r, start, start + Math.PI);
    ctx.fill();
    ctx.fillStyle = def.flesh;
    ctx.beginPath();
    ctx.arc(0, 0, h.r - 3, start, start + Math.PI);
    ctx.fill();
    if (h.kind === 'melon') {
      ctx.fillStyle = '#212121';
      for (const sx of [-10, -3, 4, 11]) ctx.fillRect(sx, h.side * 8 - 1, 2, 3);
    }
    ctx.restore();
  }

  private drawTrail(ink: string): void {
    if (this.trail.length < 2) return;
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const life = b.life / TRAIL_LIFE;
      ctx.strokeStyle = ink;
      ctx.globalAlpha = life;
      ctx.lineWidth = 1 + life * 5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Ninja on the dojo floor; swings the katana when a fruit is sliced. */
  private drawNinja(ink: string, bg: string): void {
    const ctx = this.ctx;
    const x = Math.round(this.ninjaX);
    const feet = HEIGHT - 40;
    const slashing = this.slashTimer > 0;
    const dir = this.slashDir;

    ctx.fillStyle = ink;
    // legs (wide stance while slashing)
    const stance = slashing ? 9 : 5;
    ctx.fillRect(x - stance - 3, feet - 14, 5, 14);
    ctx.fillRect(x + stance - 2, feet - 14, 5, 14);
    // body
    ctx.fillRect(x - 8, feet - 34, 16, 22);
    // belt
    ctx.fillStyle = '#c62828';
    ctx.fillRect(x - 8, feet - 18, 16, 3);
    // head
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(x, feet - 43, 10, 0, Math.PI * 2);
    ctx.fill();
    // headband + flowing tails
    const wave = Math.sin(this.frame / 6) * 3;
    ctx.fillStyle = '#c62828';
    ctx.fillRect(x - 10, feet - 49, 20, 4);
    ctx.fillRect(x - 10 * dir - (dir > 0 ? 10 : 0), feet - 48 + wave, 10, 3);
    ctx.fillRect(x - 10 * dir - (dir > 0 ? 16 : -6), feet - 44 - wave, 10, 3);
    // eye slit
    ctx.fillStyle = bg;
    ctx.fillRect(x - 6 + dir * 2, feet - 44, 12, 3);
    ctx.fillStyle = ink;
    ctx.fillRect(x - 3 + dir * 3, feet - 44, 2, 3);
    ctx.fillRect(x + 2 + dir * 3, feet - 44, 2, 3);

    // arm + kunai (held up, slashes forward when a fruit is cut)
    ctx.save();
    ctx.translate(x + dir * 8, feet - 30);
    const swing = slashing ? (1 - this.slashTimer / 12) * 2.4 - 1.8 : -1.3;
    ctx.rotate(dir > 0 ? swing : Math.PI - swing);
    ctx.fillStyle = ink;
    ctx.fillRect(0, -2, 10, 4); // arm
    this.drawKunai(10, 0, ink);
    ctx.restore();
  }

  /** Kunai pointing along +x from (x, y): ring pommel, wrapped grip, diamond blade. */
  private drawKunai(x: number, y: number, ink: string): void {
    const ctx = this.ctx;
    // ring pommel
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 2, y, 3, 0, Math.PI * 2);
    ctx.stroke();
    // wrapped grip
    ctx.fillStyle = '#c62828';
    ctx.fillRect(x + 5, y - 2, 9, 4);
    ctx.fillStyle = ink;
    for (const gx of [7, 10, 13]) ctx.fillRect(x + gx, y - 2, 1, 4);
    // diamond-shaped steel blade
    ctx.fillStyle = '#b0bec5';
    ctx.beginPath();
    ctx.moveTo(x + 14, y);
    ctx.lineTo(x + 19, y - 5);
    ctx.lineTo(x + 30, y);
    ctx.lineTo(x + 19, y + 5);
    ctx.closePath();
    ctx.fill();
    // centre ridge
    ctx.fillStyle = '#78909c';
    ctx.fillRect(x + 15, y - 0.5, 14, 1);
  }

  private drawHud(ink: string, bg: string): void {
    const ctx = this.ctx;
    const pad = (n: number) => String(n).padStart(4, '0');
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.fillText(`⏱ ${Math.ceil(this.timeLeft)}s`, 14, 24);
    ctx.textAlign = 'right';
    ctx.fillText(`HI ${pad(this.hiScore)}  ${pad(this.score)}`, WIDTH - 14, 24);

    if (this.state === 'running') return;
    ctx.fillStyle = bg;
    ctx.fillRect(30, 180, WIDTH - 60, 100);
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    if (this.state === 'ready') {
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText('TAP OR PRESS SPACE', WIDTH / 2, 218);
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.fillText('drag to slice falling fruit', WIDTH / 2, 244);
    } else {
      ctx.font = 'bold 20px "Courier New", monospace';
      ctx.fillText('T I M E   U P', WIDTH / 2, 212);
      ctx.font = 'bold 14px "Courier New", monospace';
      ctx.fillText(`You sliced ${this.score} points`, WIDTH / 2, 238);
      ctx.font = 'bold 12px "Courier New", monospace';
      ctx.fillText('tap or space to play again', WIDTH / 2, 262);
    }
  }
}
