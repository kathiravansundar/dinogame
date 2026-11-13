import { AfterViewInit, Component, ElementRef, OnDestroy, signal, viewChild } from '@angular/core';
import { RetroSound, loadHiScore, saveHiScore } from '../shared/retro-sound';

// ---- Tunable settings -------------------------------------------------
const WIDTH = 360;
const HEIGHT = 480;
const START_SPEED = 3;
const MAX_SPEED = 9;
const ACCELERATION = 0.0012;
const JET_SPEED_X = 4.5;
const JET_SPEED_Y = 3.2;
const JET_MIN_Y = HEIGHT * 0.4; // jet can't fly above this line
const AIRLINER_MIN_SCORE = 40;
const HI_SCORE_KEY = 'flight-hi-score';

const JET_W = 36;
const JET_H = 44;

type GameState = 'ready' | 'running' | 'over';
type ObstacleKind = 'bird' | 'airliner';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Obstacle {
  kind: ObstacleKind;
  x: number; // centre
  y: number; // top
  vy: number; // extra downward speed relative to scrolling
  phase: number; // animation / sideways drift offset
}

interface Scenery {
  x: number;
  y: number;
  size: number;
  kind: 'cloud' | 'bird';
}

@Component({
  selector: 'app-flight-game',
  templateUrl: './flight-game.html',
  styleUrl: '../car-game/car-game.scss',
  host: {
    '(window:keydown)': 'onKey($event, true)',
    '(window:keyup)': 'onKey($event, false)',
    '(document:visibilitychange)': 'lastTime = 0',
  },
})
export class FlightGame implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly soundOn = signal(true);

  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  lastTime = 0;
  private readonly sound = new RetroSound();

  private state: GameState = 'ready';
  private speed = START_SPEED;
  private distance = 0;
  private hiScore = 0;
  private gameOverAt = 0;
  private frame = 0;

  // jet
  private jetX = WIDTH / 2;
  private jetY = HEIGHT - JET_H - 30;
  private bank = 0;
  private readonly keys = { left: false, right: false, up: false, down: false };
  private pointerTarget: { x: number; y: number } | null = null;

  private obstacles: Obstacle[] = [];
  private nextSpawnIn = 120;
  private scenery: Scenery[] = [];

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.hiScore = loadHiScore(HI_SCORE_KEY);
    this.scenery = Array.from({ length: 7 }, (_, i) => this.makeScenery(i * 70));
    this.rafId = requestAnimationFrame(this.loop);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.sound.close();
  }

  // ---- Input ----------------------------------------------------------
  onKey(e: KeyboardEvent, down: boolean): void {
    const map: Record<string, keyof FlightGame['keys']> = {
      ArrowLeft: 'left',
      KeyA: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      ArrowUp: 'up',
      KeyW: 'up',
      ArrowDown: 'down',
      KeyS: 'down',
    };
    const dir = map[e.code];
    if (dir) {
      e.preventDefault();
      this.keys[dir] = down;
      if (down && this.state === 'ready') this.state = 'running';
    } else if (e.code === 'Space' && down) {
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
    this.pointerTarget = this.toCanvas(e);
  }

  protected onPointerMove(e: PointerEvent): void {
    if (this.pointerTarget) this.pointerTarget = this.toCanvas(e);
  }

  protected onPointerUp(): void {
    this.pointerTarget = null;
  }

  protected toggleSound(): void {
    this.soundOn.update((v) => !v);
    this.sound.enabled = this.soundOn();
  }

  private toCanvas(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      // aim slightly above the finger so the jet isn't hidden under it
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT - 40,
    };
  }

  private startOrRestart(): void {
    if (this.state === 'ready') this.state = 'running';
    else if (this.state === 'over' && performance.now() - this.gameOverAt > 500) this.restart();
  }

  private restart(): void {
    this.state = 'running';
    this.speed = START_SPEED;
    this.distance = 0;
    this.frame = 0;
    this.obstacles = [];
    this.nextSpawnIn = 120;
    this.jetX = WIDTH / 2;
    this.jetY = HEIGHT - JET_H - 30;
    this.bank = 0;
  }

  // ---- Game loop -------------------------------------------------------
  private loop = (time: number): void => {
    const dt = this.lastTime ? Math.min((time - this.lastTime) / (1000 / 60), 3) : 1;
    this.lastTime = time;
    this.frame += dt;
    this.updateScenery(this.state === 'running' ? dt : dt * 0.3);
    if (this.state === 'running') this.update(dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    this.speed = Math.min(MAX_SPEED, this.speed + ACCELERATION * dt);
    const prevScore = this.score;
    this.distance += this.speed * dt;
    if (Math.floor(this.score / 100) > Math.floor(prevScore / 100)) this.sound.beep(880, 0.1);

    this.moveJet(dt);

    for (const o of this.obstacles) {
      o.y += (this.speed + o.vy) * dt;
      if (o.kind === 'bird') o.x += Math.sin((this.frame + o.phase) / 20) * 0.8 * dt; // birds wobble
    }
    this.obstacles = this.obstacles.filter((o) => o.y < HEIGHT + 20);
    this.nextSpawnIn -= this.speed * dt;
    if (this.nextSpawnIn <= 0) this.spawn();

    const jet = this.jetHitboxes();
    const hit = this.obstacles.some((o) =>
      this.obstacleHitboxes(o).some((b) => jet.some((a) => this.overlaps(a, b))),
    );
    if (hit) this.gameOver();
  }

  private moveJet(dt: number): void {
    let dx = 0;
    let dy = 0;
    if (this.pointerTarget) {
      dx = Math.max(-1, Math.min(1, (this.pointerTarget.x - this.jetX) / 20));
      dy = Math.max(-1, Math.min(1, (this.pointerTarget.y - this.jetY) / 20));
    } else {
      dx = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
      dy = (this.keys.down ? 1 : 0) - (this.keys.up ? 1 : 0);
    }
    this.jetX = Math.max(JET_W / 2, Math.min(WIDTH - JET_W / 2, this.jetX + dx * JET_SPEED_X * dt));
    this.jetY = Math.max(JET_MIN_Y, Math.min(HEIGHT - JET_H - 8, this.jetY + dy * JET_SPEED_Y * dt));
    this.bank += (dx - this.bank) * 0.2; // smooth banking for the wing animation
  }

  private spawn(): void {
    const canAirliner = this.score >= AIRLINER_MIN_SCORE;
    const r = Math.random();
    if (canAirliner && r < 0.3) {
      // airliner flying towards us
      this.obstacles.push({ kind: 'airliner', x: 50 + Math.random() * (WIDTH - 100), y: -80, vy: 1.2, phase: 0 });
      this.nextSpawnIn = 180 + Math.random() * 120;
    } else if (r < 0.6) {
      // a small V-shaped flock of birds
      const cx = 40 + Math.random() * (WIDTH - 80);
      const phase = Math.random() * 100;
      for (const [ox, oy] of [[0, 0], [-22, -14], [22, -14]]) {
        this.obstacles.push({ kind: 'bird', x: cx + ox, y: -20 + oy, vy: 0.5, phase });
      }
      this.nextSpawnIn = 120 + Math.random() * 100;
    } else {
      this.obstacles.push({ kind: 'bird', x: 20 + Math.random() * (WIDTH - 40), y: -20, vy: 0.5, phase: Math.random() * 100 });
      this.nextSpawnIn = 70 + Math.random() * 80;
    }
    // Spawn a little more often as speed climbs.
    this.nextSpawnIn *= 0.7 + (MAX_SPEED - this.speed) / (MAX_SPEED * 2);
  }

  private gameOver(): void {
    this.state = 'over';
    this.gameOverAt = performance.now();
    this.pointerTarget = null;
    this.sound.beep(120, 0.35, 'sawtooth');
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      saveHiScore(HI_SCORE_KEY, this.hiScore);
    }
  }

  private get score(): number {
    return Math.floor(this.distance * 0.03);
  }

  // ---- Background ------------------------------------------------------
  private makeScenery(y: number): Scenery {
    const bird = Math.random() < 0.3;
    return {
      kind: bird ? 'bird' : 'cloud',
      x: Math.random() * WIDTH,
      y,
      size: bird ? 1 : 0.6 + Math.random() * 0.8,
    };
  }

  private updateScenery(dt: number): void {
    for (const s of this.scenery) {
      s.y += this.speed * (s.kind === 'cloud' ? 0.45 * s.size : 0.3) * dt; // far things move slower
      if (s.y > HEIGHT + 30) Object.assign(s, this.makeScenery(-40 - Math.random() * 60));
    }
  }

  // ---- Collision helpers ----------------------------------------------
  private jetHitboxes(): Rect[] {
    const x = this.jetX;
    const y = this.jetY;
    return [
      { x: x - 5, y: y + 2, w: 10, h: JET_H - 6 }, // fuselage
      { x: x - 16, y: y + 22, w: 32, h: 8 }, // wings
    ];
  }

  private obstacleHitboxes(o: Obstacle): Rect[] {
    if (o.kind === 'bird') return [{ x: o.x - 8, y: o.y + 2, w: 16, h: 8 }];
    return [
      { x: o.x - 6, y: o.y, w: 12, h: 70 }, // fuselage
      { x: o.x - 38, y: o.y + 26, w: 76, h: 12 }, // main wings
      { x: o.x - 14, y: o.y + 4, w: 28, h: 6 }, // tail
    ];
  }

  private overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---- Drawing ---------------------------------------------------------
  private draw(): void {
    const ctx = this.ctx;
    const css = getComputedStyle(this.canvasRef().nativeElement);
    const ink = css.getPropertyValue('--game-ink').trim() || '#535353';
    const faint = css.getPropertyValue('--game-faint').trim() || '#d4d4d4';
    const bg = css.getPropertyValue('--game-bg').trim() || '#fff';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // background: clouds and far-away birds (harmless)
    ctx.fillStyle = faint;
    for (const s of this.scenery) {
      if (s.kind === 'cloud') this.drawCloud(s.x, s.y, s.size);
      else this.drawBird(s.x, s.y, 0.6);
    }

    ctx.fillStyle = ink;
    for (const o of this.obstacles) {
      if (o.kind === 'bird') this.drawBird(o.x, o.y, 1, o.phase);
      else this.drawAirliner(o.x, o.y, ink, bg);
    }

    this.drawJet(ink, bg);
    this.drawHud(ink, bg);
  }

  private drawCloud(x: number, y: number, s: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x - 30 * s, y, 60 * s, 14 * s, 7 * s);
    ctx.roundRect(x - 16 * s, y - 8 * s, 30 * s, 14 * s, 7 * s);
    ctx.fill();
  }

  /** A simple flapping "V" bird centred on x. */
  private drawBird(x: number, y: number, scale: number, phase = 0): void {
    const ctx = this.ctx;
    const up = Math.floor((this.frame + phase) / 8) % 2 === 0;
    const s = scale;
    const wingY = up ? y : y + 8 * s;
    ctx.fillRect(x - 2 * s, y + 4 * s, 4 * s, 4 * s); // body
    ctx.beginPath();
    ctx.moveTo(x - 2 * s, y + 5 * s);
    ctx.lineTo(x - 11 * s, wingY);
    ctx.lineTo(x - 9 * s, wingY + 3 * s);
    ctx.lineTo(x - 2 * s, y + 8 * s);
    ctx.moveTo(x + 2 * s, y + 5 * s);
    ctx.lineTo(x + 11 * s, wingY);
    ctx.lineTo(x + 9 * s, wingY + 3 * s);
    ctx.lineTo(x + 2 * s, y + 8 * s);
    ctx.fill();
  }

  /** Top-down airliner pointing down (flying towards the player). */
  private drawAirliner(cx: number, y: number, ink: string, bg: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = ink;
    // fuselage
    ctx.beginPath();
    ctx.roundRect(cx - 6, y, 12, 70, 6);
    ctx.fill();
    // tail (at the top, since it's flying down)
    ctx.beginPath();
    ctx.moveTo(cx - 3, y + 4);
    ctx.lineTo(cx - 14, y + 10);
    ctx.lineTo(cx + 14, y + 10);
    ctx.lineTo(cx + 3, y + 4);
    ctx.fill();
    // swept main wings
    ctx.beginPath();
    ctx.moveTo(cx - 5, y + 24);
    ctx.lineTo(cx - 38, y + 34);
    ctx.lineTo(cx - 38, y + 38);
    ctx.lineTo(cx - 5, y + 40);
    ctx.moveTo(cx + 5, y + 24);
    ctx.lineTo(cx + 38, y + 34);
    ctx.lineTo(cx + 38, y + 38);
    ctx.lineTo(cx + 5, y + 40);
    ctx.fill();
    // engines
    ctx.fillRect(cx - 22, y + 34, 5, 9);
    ctx.fillRect(cx + 17, y + 34, 5, 9);
    // windows + cockpit
    ctx.fillStyle = bg;
    for (let wy = y + 14; wy < y + 60; wy += 6) ctx.fillRect(cx - 1, wy, 2, 3);
    ctx.fillRect(cx - 4, y + 62, 8, 3);
  }

  private drawJet(ink: string, bg: string): void {
    const ctx = this.ctx;
    const x = this.jetX;
    const y = this.jetY;
    const span = 18 - Math.abs(this.bank) * 4; // wings look shorter when banking
    const lean = this.bank * 3;
    ctx.fillStyle = ink;

    // exhaust flame (flickers)
    if (this.state !== 'over') {
      const flame = 6 + (Math.floor(this.frame / 3) % 2) * 4;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(x - 3, y + JET_H);
      ctx.lineTo(x, y + JET_H + flame);
      ctx.lineTo(x + 3, y + JET_H);
      ctx.fill();
    }

    // fuselage with pointed nose
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 5, y + 12);
    ctx.lineTo(x + 5, y + JET_H);
    ctx.lineTo(x - 5, y + JET_H);
    ctx.lineTo(x - 5, y + 12);
    ctx.closePath();
    ctx.fill();

    // swept delta wings
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 14);
    ctx.lineTo(x - span, y + 30 + lean);
    ctx.lineTo(x - span, y + 33 + lean);
    ctx.lineTo(x - 4, y + 30);
    ctx.moveTo(x + 4, y + 14);
    ctx.lineTo(x + span, y + 30 - lean);
    ctx.lineTo(x + span, y + 33 - lean);
    ctx.lineTo(x + 4, y + 30);
    ctx.fill();

    // tail fins
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 34);
    ctx.lineTo(x - 11, y + JET_H);
    ctx.lineTo(x - 4, y + JET_H);
    ctx.moveTo(x + 4, y + 34);
    ctx.lineTo(x + 11, y + JET_H);
    ctx.lineTo(x + 4, y + JET_H);
    ctx.fill();

    // cockpit canopy
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x - 2, y + 9, 4, 9, 2);
    ctx.fill();

    if (this.state === 'over') {
      // little smoke puffs
      ctx.fillStyle = ink;
      for (const [ox, oy, r] of [[-10, -6, 4], [8, -10, 5], [0, -18, 3]]) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawHud(ink: string, bg: string): void {
    const ctx = this.ctx;
    const pad = (n: number) => String(n).padStart(5, '0');
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.textAlign = 'right';
    const text = `HI ${pad(this.hiScore)}  ${pad(this.score)}`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = bg;
    ctx.fillRect(WIDTH - tw - 22, 8, tw + 14, 22);
    ctx.fillStyle = ink;
    ctx.fillText(text, WIDTH - 14, 24);

    if (this.state === 'running') return;
    ctx.fillStyle = bg;
    ctx.fillRect(30, 160, WIDTH - 60, 90);
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    if (this.state === 'ready') {
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText('PRESS SPACE OR TAP', WIDTH / 2, 198);
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.fillText('arrows / drag to fly', WIDTH / 2, 224);
    } else {
      ctx.font = 'bold 20px "Courier New", monospace';
      ctx.fillText('M A Y D A Y !', WIDTH / 2, 198);
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.fillText('space or tap to restart', WIDTH / 2, 224);
    }
  }
}
