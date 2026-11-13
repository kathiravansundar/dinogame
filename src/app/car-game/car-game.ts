import { AfterViewInit, Component, ElementRef, OnDestroy, signal, viewChild } from '@angular/core';
import { RetroSound, loadHiScore, saveHiScore } from '../shared/retro-sound';

// ---- Tunable settings -------------------------------------------------
const WIDTH = 360;
const HEIGHT = 480;
const ROAD_LEFT = 60;
const ROAD_RIGHT = 300;
const LANES = 3;
const LANE_W = (ROAD_RIGHT - ROAD_LEFT) / LANES;
const START_SPEED = 5;
const MAX_SPEED = 13;
const ACCELERATION = 0.0015;
const STEER_SPEED = 0.25; // 0..1, how quickly the car slides into the target lane
const HI_SCORE_KEY = 'car-hi-score';

const CAR_W = 36;
const CAR_H = 70;
const TEX_H = 256; // height of the pre-rendered road/grass textures

type GameState = 'ready' | 'running' | 'over';
type ObstacleKind = 'barrier' | 'cones' | 'car' | 'suv' | 'truck';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Obstacle extends Rect {
  kind: ObstacleKind;
  color: string;
}

interface Roadside {
  kind: 'tree' | 'bush' | 'lamp';
  side: -1 | 1;
  x: number;
  y: number;
  r: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  smoke: boolean;
}

const OBSTACLE_SIZE: Record<ObstacleKind, [number, number]> = {
  barrier: [72, 24],
  cones: [62, 18],
  car: [32, 60],
  suv: [35, 66],
  truck: [42, 124],
};
const CAR_COLORS = ['#c62828', '#eeeeee', '#263238', '#9ea7ad', '#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a'];
const TRUCK_COLORS = ['#d32f2f', '#1e88e5', '#fafafa', '#ff8f00', '#37474f'];

const laneCenter = (lane: number) => ROAD_LEFT + LANE_W * (lane + 0.5);

/** Mixes a hex colour towards black (amount < 0) or white (amount > 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const mix = (c: number) => Math.round(c + (target - c) * t);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

@Component({
  selector: 'app-car-game',
  templateUrl: './car-game.html',
  styleUrl: './car-game.scss',
  host: {
    '(window:keydown)': 'onKeyDown($event)',
    '(document:visibilitychange)': 'lastTime = 0',
  },
})
export class CarGame implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly soundOn = signal(true);

  private ctx!: CanvasRenderingContext2D;
  private dpr = 1;
  private rafId = 0;
  lastTime = 0;
  private readonly sound = new RetroSound();

  private state: GameState = 'ready';
  private speed = START_SPEED;
  private distance = 0;
  private hiScore = 0;
  private gameOverAt = 0;
  private roadOffset = 0;
  private frame = 0;
  private shake = 0;

  private lane = 1;
  private carX = laneCenter(1);
  private readonly carY = HEIGHT - CAR_H - 20;
  private tilt = 0;

  private obstacles: Obstacle[] = [];
  private nextRowIn = 200;
  private roadside: Roadside[] = [];
  private particles: Particle[] = [];

  private asphalt!: HTMLCanvasElement;
  private grass!: HTMLCanvasElement;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * this.dpr;
    canvas.height = HEIGHT * this.dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(this.dpr, this.dpr);
    this.hiScore = loadHiScore(HI_SCORE_KEY);
    this.asphalt = this.renderAsphalt();
    this.grass = this.renderGrass();
    this.initRoadside();
    this.rafId = requestAnimationFrame(this.loop);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.sound.close();
  }

  // ---- Input ----------------------------------------------------------
  onKeyDown(e: KeyboardEvent): void {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        e.preventDefault();
        this.steer(-1);
        break;
      case 'ArrowRight':
      case 'KeyD':
        e.preventDefault();
        this.steer(1);
        break;
      case 'Space':
      case 'ArrowUp':
        e.preventDefault();
        this.startOrRestart();
        break;
    }
  }

  protected onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    if (this.state !== 'running') {
      this.startOrRestart();
      return;
    }
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    this.steer(e.clientX - rect.left < rect.width / 2 ? -1 : 1);
  }

  protected toggleSound(): void {
    this.soundOn.update((v) => !v);
    this.sound.enabled = this.soundOn();
  }

  private steer(dir: -1 | 1): void {
    if (this.state === 'ready') this.state = 'running';
    if (this.state !== 'running') return;
    const next = Math.max(0, Math.min(LANES - 1, this.lane + dir));
    if (next !== this.lane) {
      this.lane = next;
      this.sound.beep(440, 0.05);
    }
  }

  private startOrRestart(): void {
    if (this.state === 'ready') this.state = 'running';
    else if (this.state === 'over' && performance.now() - this.gameOverAt > 600) this.restart();
  }

  private restart(): void {
    this.state = 'running';
    this.speed = START_SPEED;
    this.distance = 0;
    this.obstacles = [];
    this.particles = [];
    this.nextRowIn = 200;
    this.lane = 1;
    this.carX = laneCenter(1);
    this.tilt = 0;
  }

  // ---- Game loop -------------------------------------------------------
  private loop = (time: number): void => {
    const dt = this.lastTime ? Math.min((time - this.lastTime) / (1000 / 60), 3) : 1;
    this.lastTime = time;
    this.frame += dt;
    if (this.state === 'running') this.update(dt);
    else if (this.state === 'ready') this.scroll(1.5 * dt); // idle cruise behind the start screen
    this.updateParticles(dt);
    this.shake = Math.max(0, this.shake - dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private scroll(move: number): void {
    this.roadOffset = (this.roadOffset + move) % TEX_H;
    for (const r of this.roadside) r.y += move;
    this.recycleRoadside();
  }

  private update(dt: number): void {
    this.speed = Math.min(MAX_SPEED, this.speed + ACCELERATION * dt);
    const prevScore = this.score;
    const move = this.speed * dt;
    this.distance += move;
    this.scroll(move);
    if (Math.floor(this.score / 100) > Math.floor(prevScore / 100)) this.sound.beep(880, 0.1);

    // steering: slide towards the target lane, tilt while moving
    const target = laneCenter(this.lane);
    const dx = (target - this.carX) * Math.min(1, STEER_SPEED * dt);
    this.carX += dx;
    this.tilt = Math.max(-0.22, Math.min(0.22, dx * 0.05));

    for (const o of this.obstacles) o.y += move;
    this.obstacles = this.obstacles.filter((o) => o.y < HEIGHT + 10);
    this.nextRowIn -= move;
    if (this.nextRowIn <= 0) this.spawnRow();

    // exhaust puffs
    if (Math.random() < 0.3) this.puff(this.carX + (Math.random() < 0.5 ? -6 : 6), this.carY + CAR_H, 'rgba(200,200,200,0.35)', true, 0.3);

    const hb = { x: this.carX - CAR_W / 2 + 5, y: this.carY + 5, w: CAR_W - 10, h: CAR_H - 10 };
    const hit = this.obstacles.find((o) => this.overlaps(hb, this.obstacleHitbox(o)));
    if (hit) this.crash(hit);
  }

  /** Spawns one row of obstacles, always leaving at least one lane open. */
  private spawnRow(): void {
    const blocked = this.speed > 8 && Math.random() < 0.45 ? 2 : 1;
    const lanes = [0, 1, 2].sort(() => Math.random() - 0.5).slice(0, blocked);
    let tallest = 0;
    for (const lane of lanes) {
      const r = Math.random();
      const kind: ObstacleKind = r < 0.28 ? 'barrier' : r < 0.45 ? 'cones' : r < 0.7 ? 'car' : r < 0.85 ? 'suv' : 'truck';
      const [w, h] = OBSTACLE_SIZE[kind];
      const palette = kind === 'truck' ? TRUCK_COLORS : CAR_COLORS;
      const color = palette[Math.floor(Math.random() * palette.length)];
      this.obstacles.push({ kind, color, x: laneCenter(lane) - w / 2, y: -h, w, h });
      tallest = Math.max(tallest, h);
    }
    // Gap grows with speed so there's always time to change lanes.
    const minGap = 150 + this.speed * 12;
    this.nextRowIn = tallest + minGap + Math.random() * 140;
  }

  private crash(o: Obstacle): void {
    this.state = 'over';
    this.gameOverAt = performance.now();
    this.shake = 18;
    this.sound.beep(140, 0.3, 'sawtooth');
    const cx = (this.carX + o.x + o.w / 2) / 2;
    const cy = Math.max(this.carY, o.y + o.h - 10);
    for (let i = 0; i < 26; i++) this.puff(cx, cy, ['#ffd54f', '#ff9800', '#fff3e0'][i % 3], false, 3.5);
    for (let i = 0; i < 18; i++) this.puff(cx, cy, 'rgba(70,70,70,0.6)', true, 1.2);
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      saveHiScore(HI_SCORE_KEY, this.hiScore);
    }
  }

  private puff(x: number, y: number, color: string, smoke: boolean, power: number): void {
    const a = Math.random() * Math.PI * 2;
    const s = Math.random() * power;
    const max = smoke ? 40 + Math.random() * 30 : 18 + Math.random() * 14;
    this.particles.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s + (smoke ? 0.6 : 0),
      life: max,
      max,
      size: smoke ? 3 + Math.random() * 3 : 1.5 + Math.random() * 1.5,
      color,
      smoke,
    });
  }

  private updateParticles(dt: number): void {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.95;
      p.vy *= 0.95;
      if (p.smoke) p.size += 0.08 * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private get score(): number {
    return Math.floor(this.distance * 0.02);
  }

  private obstacleHitbox(o: Obstacle): Rect {
    const inset = o.kind === 'cones' ? 4 : 3;
    return { x: o.x + inset, y: o.y + inset, w: o.w - inset * 2, h: o.h - inset * 2 };
  }

  private overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---- Scenery ---------------------------------------------------------
  private offscreen(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * this.dpr);
    c.height = Math.ceil(h * this.dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(this.dpr, this.dpr);
    return [c, ctx];
  }

  /** Asphalt with grain, darker tyre tracks and a few repair patches. */
  private renderAsphalt(): HTMLCanvasElement {
    const w = ROAD_RIGHT - ROAD_LEFT;
    const [c, ctx] = this.offscreen(w, TEX_H);
    ctx.fillStyle = '#3c3f44';
    ctx.fillRect(0, 0, w, TEX_H);
    for (let i = 0; i < 1600; i++) {
      const v = Math.random() < 0.5 ? 0 : 255;
      ctx.fillStyle = `rgba(${v},${v},${v},${0.04 + Math.random() * 0.08})`;
      ctx.fillRect(Math.random() * w, Math.random() * TEX_H, 1 + Math.random(), 1 + Math.random());
    }
    // worn tyre tracks in each lane
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let lane = 0; lane < LANES; lane++) {
      const cx = LANE_W * (lane + 0.5);
      ctx.fillRect(cx - 14, 0, 8, TEX_H);
      ctx.fillRect(cx + 6, 0, 8, TEX_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(w * 0.55, 60, 30, 22); // patch
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(w * 0.12, 180, 24, 30);
    return c;
  }

  private renderGrass(): HTMLCanvasElement {
    const [c, ctx] = this.offscreen(WIDTH, TEX_H);
    ctx.fillStyle = '#4f7d2e';
    ctx.fillRect(0, 0, WIDTH, TEX_H);
    for (let i = 0; i < 2200; i++) {
      const light = Math.random() < 0.5;
      ctx.fillStyle = light ? `rgba(150,200,90,${0.15 + Math.random() * 0.2})` : `rgba(30,60,15,${0.15 + Math.random() * 0.25})`;
      ctx.fillRect(Math.random() * WIDTH, Math.random() * TEX_H, 1, 2 + Math.random() * 2);
    }
    return c;
  }

  private initRoadside(): void {
    this.roadside = [];
    for (const side of [-1, 1] as const) {
      for (let y = -40; y < HEIGHT + 40; y += 50 + Math.random() * 40) this.roadside.push(this.makeTree(side, y));
    }
    for (let y = -40; y < HEIGHT; y += 240) {
      this.roadside.push({ kind: 'lamp', side: -1, x: ROAD_LEFT - 10, y, r: 0 });
      this.roadside.push({ kind: 'lamp', side: 1, x: ROAD_RIGHT + 10, y: y + 120, r: 0 });
    }
  }

  private makeTree(side: -1 | 1, y: number): Roadside {
    const bush = Math.random() < 0.35;
    const r = bush ? 6 + Math.random() * 4 : 12 + Math.random() * 8;
    const x = side < 0 ? 6 + Math.random() * (ROAD_LEFT - 26) : ROAD_RIGHT + 20 + Math.random() * (WIDTH - ROAD_RIGHT - 26);
    return { kind: bush ? 'bush' : 'tree', side, x, y, r };
  }

  private recycleRoadside(): void {
    for (let i = 0; i < this.roadside.length; i++) {
      const r = this.roadside[i];
      if (r.y - 30 < HEIGHT) continue;
      const sameKind = this.roadside.filter((q) => q.kind === 'lamp' ? r.kind === 'lamp' : r.kind !== 'lamp' && q.side === r.side);
      const top = Math.min(...sameKind.map((q) => q.y));
      this.roadside[i] =
        r.kind === 'lamp' ? { ...r, y: top - 120 } : this.makeTree(r.side, top - 50 - Math.random() * 40);
    }
  }

  // ---- Drawing ---------------------------------------------------------
  private draw(): void {
    const ctx = this.ctx;
    ctx.save();
    if (this.shake > 0) ctx.translate((Math.random() - 0.5) * this.shake * 0.6, (Math.random() - 0.5) * this.shake * 0.6);

    this.drawTiled(this.grass, 0, WIDTH);
    // gravel verges
    ctx.fillStyle = '#8b8373';
    ctx.fillRect(ROAD_LEFT - 14, -10, 14, HEIGHT + 20);
    ctx.fillRect(ROAD_RIGHT, -10, 14, HEIGHT + 20);
    this.drawTiled(this.asphalt, ROAD_LEFT, ROAD_RIGHT - ROAD_LEFT);
    this.drawMarkings();
    this.drawGuardRails();

    for (const r of this.roadside) if (r.kind !== 'lamp') this.drawTree(r);

    for (const o of this.obstacles) this.drawObstacle(o);

    ctx.save();
    ctx.translate(this.carX, this.carY + CAR_H / 2);
    ctx.rotate(this.tilt);
    this.drawHypercar(0, -CAR_H / 2);
    ctx.restore();

    // street lamps overhang the road, so they're drawn above the traffic
    for (const r of this.roadside) if (r.kind === 'lamp') this.drawLamp(r);

    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    this.drawHud();
  }

  private drawTiled(img: HTMLCanvasElement, x: number, w: number): void {
    const off = this.roadOffset % TEX_H;
    for (let y = off - TEX_H; y < HEIGHT; y += TEX_H) this.ctx.drawImage(img, x, y, w, TEX_H);
  }

  private drawMarkings(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(ROAD_LEFT + 5, 0, 3, HEIGHT); // solid edge lines
    ctx.fillRect(ROAD_RIGHT - 8, 0, 3, HEIGHT);
    for (let lane = 1; lane < LANES; lane++) {
      const x = ROAD_LEFT + LANE_W * lane - 1.5;
      for (let y = (this.roadOffset % 52) - 52; y < HEIGHT; y += 52) ctx.fillRect(x, y, 3, 26);
    }
  }

  private drawGuardRails(): void {
    const ctx = this.ctx;
    for (const x of [ROAD_LEFT - 7, ROAD_RIGHT + 3]) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + 2, 0, 4, HEIGHT); // shadow
      const g = ctx.createLinearGradient(x, 0, x + 4, 0);
      g.addColorStop(0, '#8e989f');
      g.addColorStop(0.5, '#eef2f4');
      g.addColorStop(1, '#7b858c');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 4, HEIGHT);
      ctx.fillStyle = '#4b5359';
      for (let y = (this.roadOffset % 36) - 36; y < HEIGHT; y += 36) ctx.fillRect(x - 1, y, 6, 4); // posts
    }
  }

  private drawTree(r: Roadside): void {
    const ctx = this.ctx;
    // shadow cast to the bottom-right
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(r.x + r.r * 0.35, r.y + r.r * 0.4, r.r, r.r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    // layered canopy
    const blobs = r.kind === 'tree' ? [[0, 0, 1], [-0.45, -0.25, 0.6], [0.4, -0.35, 0.55], [0.1, 0.4, 0.6]] : [[0, 0, 1]];
    for (const [dx, dy, s] of blobs) {
      const cx = r.x + dx * r.r;
      const cy = r.y + dy * r.r;
      const rad = r.r * s;
      const g = ctx.createRadialGradient(cx - rad * 0.35, cy - rad * 0.35, rad * 0.1, cx, cy, rad);
      g.addColorStop(0, r.kind === 'tree' ? '#7fb24a' : '#8bbf55');
      g.addColorStop(0.7, r.kind === 'tree' ? '#3f7a24' : '#4f8a2e');
      g.addColorStop(1, '#1f4512');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawLamp(r: Roadside): void {
    const ctx = this.ctx;
    const armEnd = r.x - r.side * 26; // arm reaches over the road
    // pole base
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(Math.min(r.x, armEnd) + 3, r.y + 4, 26, 3); // arm shadow
    ctx.fillStyle = '#5f676d';
    ctx.beginPath();
    ctx.arc(r.x, r.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#80898f';
    ctx.fillRect(Math.min(r.x, armEnd), r.y - 1.5, 26, 3);
    // lamp head
    ctx.fillStyle = '#3d4449';
    ctx.beginPath();
    ctx.roundRect(armEnd - 5, r.y - 3.5, 10, 7, 3);
    ctx.fill();
    ctx.fillStyle = '#fff8d6';
    ctx.fillRect(armEnd - 3, r.y - 1.5, 6, 3);
  }

  private drawObstacle(o: Obstacle): void {
    const cx = o.x + o.w / 2;
    switch (o.kind) {
      case 'barrier':
        return this.drawBarrier(o);
      case 'cones':
        return this.drawCones(o);
      case 'truck':
        return this.drawTruck(cx, o.y, o.w, o.h, o.color);
      default:
        return this.drawSedan(cx, o.y, o.w, o.h, o.color, o.kind === 'suv');
    }
  }

  /** Black-and-yellow striped road barricade with flashing amber lamps. */
  private drawBarrier(o: Obstacle): void {
    const ctx = this.ctx;
    const { x, y, w } = o;
    const boardY = y + 4;
    const boardH = 13;
    // shadow + metal feet
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 4, boardY + 6, w, boardH + 2);
    ctx.fillStyle = '#6d757b';
    ctx.fillRect(x + 6, boardY + boardH - 2, 6, 9);
    ctx.fillRect(x + w - 12, boardY + boardH - 2, 6, 9);
    // striped board
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, boardY, w, boardH, 2);
    ctx.clip();
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(x, boardY, w, boardH);
    ctx.fillStyle = '#141414';
    for (let sx = x - boardH; sx < x + w + boardH; sx += 14) {
      ctx.beginPath();
      ctx.moveTo(sx, boardY + boardH);
      ctx.lineTo(sx + 7, boardY + boardH);
      ctx.lineTo(sx + 7 + boardH, boardY);
      ctx.lineTo(sx + boardH, boardY);
      ctx.fill();
    }
    // glossy reflective sheen
    const sheen = ctx.createLinearGradient(0, boardY, 0, boardY + boardH);
    sheen.addColorStop(0, 'rgba(255,255,255,0.35)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = sheen;
    ctx.fillRect(x, boardY, w, boardH);
    ctx.restore();
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, boardY + 0.5, w - 1, boardH - 1);
    // flashing amber warning lamps
    const on = Math.floor(this.frame / 15) % 2 === 0;
    for (const lx of [x + 6, x + w - 6]) {
      if (on) {
        const glow = this.ctx.createRadialGradient(lx, y + 2, 0, lx, y + 2, 12);
        glow.addColorStop(0, 'rgba(255,200,0,0.7)');
        glow.addColorStop(1, 'rgba(255,160,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(lx, y + 2, 12, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = on ? '#ffd740' : '#9a6b00';
      ctx.beginPath();
      ctx.arc(lx, y + 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Three traffic cones (seen from above) spread across a lane. */
  private drawCones(o: Obstacle): void {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const cx = o.x + 11 + i * 20;
      const cy = o.y + 9;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(cx + 3, cy + 4, 9, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e1e1e';
      ctx.beginPath();
      ctx.roundRect(cx - 8, cy - 8, 16, 16, 3); // rubber base
      ctx.fill();
      const g = ctx.createRadialGradient(cx - 2, cy - 2, 0.5, cx, cy, 7);
      g.addColorStop(0, '#ffab70');
      g.addColorStop(0.6, '#ff6d00');
      g.addColorStop(1, '#b83c00');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f5f5f5';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2); // reflective band
      ctx.stroke();
      ctx.fillStyle = '#ff9e40';
      ctx.beginPath();
      ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private withShadow(draw: () => void, blur = 8): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 5;
    draw();
    ctx.restore();
  }

  private bodyGradient(cx: number, w: number, color: string): CanvasGradient {
    const g = this.ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    g.addColorStop(0, shade(color, -0.55));
    g.addColorStop(0.18, shade(color, -0.1));
    g.addColorStop(0.45, shade(color, 0.3));
    g.addColorStop(0.6, color);
    g.addColorStop(0.85, shade(color, -0.2));
    g.addColorStop(1, shade(color, -0.6));
    return g;
  }

  private drawWheels(cx: number, halfW: number, ys: number[], len: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#111';
    for (const wy of ys) {
      ctx.beginPath();
      ctx.roundRect(cx - halfW - 2.5, wy, 5, len, 2);
      ctx.roundRect(cx + halfW - 2.5, wy, 5, len, 2);
      ctx.fill();
    }
  }

  /** Everyday traffic: sedan or SUV, nose up, seen from above. */
  private drawSedan(cx: number, top: number, w: number, h: number, color: string, suv: boolean): void {
    const ctx = this.ctx;
    const x = cx - w / 2;
    this.drawWheels(cx, w / 2 - 1, [top + h * 0.13, top + h * 0.7], h * 0.17);
    this.withShadow(() => {
      ctx.fillStyle = this.bodyGradient(cx, w, color);
      ctx.beginPath();
      ctx.roundRect(x, top, w, h, suv ? [8, 8, 6, 6] : [11, 11, 8, 8]);
      ctx.fill();
    });

    // hood crease
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 6, top + 4);
    ctx.lineTo(cx - 5, top + h * 0.24);
    ctx.moveTo(cx + 6, top + 4);
    ctx.lineTo(cx + 5, top + h * 0.24);
    ctx.stroke();

    // glass: windshield, roof, rear window
    const glass = (y1: number, y2: number, inset1: number, inset2: number) => {
      const g = ctx.createLinearGradient(x, y1, x + w, y2);
      g.addColorStop(0, '#1b2733');
      g.addColorStop(0.45, '#5d7487');
      g.addColorStop(0.55, '#26394a');
      g.addColorStop(1, '#101820');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x + inset1, y1);
      ctx.lineTo(x + w - inset1, y1);
      ctx.lineTo(x + w - inset2, y2);
      ctx.lineTo(x + inset2, y2);
      ctx.closePath();
      ctx.fill();
    };
    const ws = top + h * (suv ? 0.2 : 0.26);
    const roofTop = top + h * (suv ? 0.33 : 0.4);
    const roofBottom = top + h * (suv ? 0.82 : 0.7);
    glass(ws, roofTop, 6, 3);
    ctx.fillStyle = shade(color, suv ? -0.15 : 0.08);
    ctx.beginPath();
    ctx.roundRect(x + 3, roofTop, w - 6, roofBottom - roofTop, 3);
    ctx.fill();
    if (suv) {
      ctx.fillStyle = 'rgba(30,30,30,0.6)'; // roof rails
      ctx.fillRect(x + 5, roofTop + 3, 2, roofBottom - roofTop - 6);
      ctx.fillRect(x + w - 7, roofTop + 3, 2, roofBottom - roofTop - 6);
    }
    glass(roofBottom, top + h * (suv ? 0.92 : 0.82), 3, 6);

    // mirrors
    ctx.fillStyle = shade(color, -0.2);
    ctx.beginPath();
    ctx.ellipse(x - 1.5, ws + 2, 3, 2, 0, 0, Math.PI * 2);
    ctx.ellipse(x + w + 1.5, ws + 2, 3, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // lights
    ctx.fillStyle = '#fffbe6';
    ctx.fillRect(x + 3, top + 2, 7, 3);
    ctx.fillRect(x + w - 10, top + 2, 7, 3);
    ctx.fillStyle = '#d50000';
    ctx.fillRect(x + 3, top + h - 4, 8, 3);
    ctx.fillRect(x + w - 11, top + h - 4, 8, 3);
  }

  /** Lorry with a cab and a long box trailer, seen from above. */
  private drawTruck(cx: number, top: number, w: number, h: number, color: string): void {
    const ctx = this.ctx;
    const x = cx - w / 2;
    this.drawWheels(cx, w / 2 - 1, [top + 8, top + 40, top + 54, top + h - 30, top + h - 16], 11);

    this.withShadow(() => {
      // trailer box
      const t = ctx.createLinearGradient(x, 0, x + w, 0);
      t.addColorStop(0, '#9aa3a8');
      t.addColorStop(0.35, '#f4f6f7');
      t.addColorStop(0.7, '#dfe3e5');
      t.addColorStop(1, '#8a9398');
      ctx.fillStyle = t;
      ctx.fillRect(x, top + 32, w, h - 32);
      // cab
      ctx.fillStyle = this.bodyGradient(cx, w - 4, color);
      ctx.beginPath();
      ctx.roundRect(x + 2, top, w - 4, 29, [7, 7, 3, 3]);
      ctx.fill();
    }, 10);

    // trailer roof ribs + coloured stripe
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (let ry = top + 38; ry < top + h - 4; ry += 7) ctx.fillRect(x + 2, ry, w - 4, 1.5);
    ctx.fillStyle = color;
    ctx.fillRect(x, top + 32, 3, h - 32);
    ctx.fillRect(x + w - 3, top + 32, 3, h - 32);
    // coupling
    ctx.fillStyle = '#222';
    ctx.fillRect(cx - 6, top + 28, 12, 5);
    // cab windshield, roof light bar, mirrors
    const g = ctx.createLinearGradient(x, top + 3, x + w, top + 10);
    g.addColorStop(0, '#1b2733');
    g.addColorStop(0.5, '#6a8296');
    g.addColorStop(1, '#101820');
    ctx.fillStyle = g;
    ctx.fillRect(x + 5, top + 4, w - 10, 7);
    ctx.fillStyle = '#ffb300';
    for (let i = 0; i < 5; i++) ctx.fillRect(x + 9 + i * 5.5, top + 14, 3, 2);
    ctx.fillStyle = '#222';
    ctx.fillRect(x - 4, top + 8, 4, 6);
    ctx.fillRect(x + w, top + 8, 4, 6);
    // tail lights
    ctx.fillStyle = '#d50000';
    ctx.fillRect(x + 2, top + h - 3, 7, 3);
    ctx.fillRect(x + w - 9, top + h - 3, 7, 3);
  }

  /**
   * The player's yellow Italian mid-engine supercar (seen from above): long low nose,
   * body-colour roof with black glass, engine-cover window, side intakes, quad round tail lights.
   */
  private drawHypercar(cx: number, t: number): void {
    const ctx = this.ctx;
    const hw = CAR_W / 2;
    const yellow = '#f6c200';

    // tyres peeking out under the fenders
    this.drawWheels(cx, hw - 2, [t + 10, t + 47], 13);

    const outline = () => {
      ctx.beginPath();
      for (const s of [1, -1]) {
        ctx.moveTo(cx, t);
        ctx.bezierCurveTo(cx + s * 11, t, cx + s * 14, t + 2, cx + s * 15, t + 8);
        ctx.bezierCurveTo(cx + s * hw, t + 13, cx + s * hw, t + 21, cx + s * (hw - 2.5), t + 27);
        ctx.lineTo(cx + s * (hw - 3), t + 36);
        ctx.bezierCurveTo(cx + s * (hw + 0.5), t + 44, cx + s * (hw + 0.5), t + 57, cx + s * (hw - 0.5), t + 63);
        ctx.bezierCurveTo(cx + s * (hw - 1.5), t + 68.5, cx + s * 11, t + CAR_H, cx, t + CAR_H);
      }
    };

    this.withShadow(() => {
      ctx.fillStyle = this.bodyGradient(cx, CAR_W, yellow);
      outline();
      ctx.fill();
    }, 10);

    // clear-coat gloss: soft highlight down the hood and over the rear haunches
    const gloss = ctx.createLinearGradient(cx - 7, 0, cx + 7, 0);
    gloss.addColorStop(0, 'rgba(255,255,255,0)');
    gloss.addColorStop(0.5, 'rgba(255,255,240,0.45)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.fillRect(cx - 7, t + 3, 14, 15);
    ctx.fillStyle = 'rgba(255,255,230,0.25)';
    ctx.beginPath();
    ctx.ellipse(cx - hw + 5, t + 52, 2, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + hw - 5, t + 52, 2, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // body lines along the hood
    ctx.strokeStyle = 'rgba(120,85,0,0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx - 8, t + 4);
    ctx.quadraticCurveTo(cx - 10, t + 12, cx - 9, t + 20);
    ctx.moveTo(cx + 8, t + 4);
    ctx.quadraticCurveTo(cx + 10, t + 12, cx + 9, t + 20);
    ctx.stroke();

    // front splitter / grille and hood vents
    ctx.fillStyle = '#121212';
    ctx.beginPath();
    ctx.roundRect(cx - 8, t + 0.8, 16, 3, 1.5);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(cx - 7, t + 12, 4, 5, 1.5);
    ctx.roundRect(cx + 3, t + 12, 4, 5, 1.5);
    ctx.fill();

    // windshield (black glass with a reflection streak)
    const glass = (x1: number, y1: number, x2: number, y2: number) => {
      const g = ctx.createLinearGradient(x1, y1, x2, y2);
      g.addColorStop(0, '#05080d');
      g.addColorStop(0.42, '#2a3a4f');
      g.addColorStop(0.5, '#93abc6');
      g.addColorStop(0.58, '#2a3a4f');
      g.addColorStop(1, '#040609');
      return g;
    };
    ctx.fillStyle = glass(cx - 10, t + 20, cx + 10, t + 31);
    ctx.beginPath();
    ctx.moveTo(cx - 10, t + 31);
    ctx.quadraticCurveTo(cx - 9, t + 22, cx, t + 20.5);
    ctx.quadraticCurveTo(cx + 9, t + 22, cx + 10, t + 31);
    ctx.closePath();
    ctx.fill();

    // side windows framing a body-colour roof
    ctx.fillStyle = '#07090c';
    ctx.beginPath();
    ctx.moveTo(cx - 10, t + 31);
    ctx.quadraticCurveTo(cx - 11.5, t + 36, cx - 9.5, t + 42);
    ctx.lineTo(cx - 7.5, t + 41);
    ctx.lineTo(cx - 8, t + 31);
    ctx.moveTo(cx + 10, t + 31);
    ctx.quadraticCurveTo(cx + 11.5, t + 36, cx + 9.5, t + 42);
    ctx.lineTo(cx + 7.5, t + 41);
    ctx.lineTo(cx + 8, t + 31);
    ctx.fill();
    ctx.fillStyle = this.bodyGradient(cx, 16, yellow);
    ctx.beginPath();
    ctx.roundRect(cx - 8, t + 31, 16, 10.5, [1, 1, 3, 3]);
    ctx.fill();

    // engine-cover glass with louvres (mid-engine look)
    ctx.fillStyle = glass(cx - 8, t + 43, cx + 8, t + 55);
    ctx.beginPath();
    ctx.moveTo(cx - 8, t + 43);
    ctx.lineTo(cx + 8, t + 43);
    ctx.lineTo(cx + 6, t + 56);
    ctx.lineTo(cx - 6, t + 56);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(150,160,170,0.35)';
    for (let i = 0; i < 5; i++) ctx.fillRect(cx - 6.5 + i * 0.4, t + 45 + i * 2.2, 13 - i * 0.8, 0.8);

    // black side air intakes on the rear fenders
    ctx.fillStyle = '#0b0b0b';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * (hw - 3.5), t + 37);
      ctx.quadraticCurveTo(cx + s * (hw - 1), t + 42, cx + s * (hw - 2), t + 47);
      ctx.lineTo(cx + s * (hw - 5), t + 45);
      ctx.closePath();
      ctx.fill();
    }

    // mirrors in body colour
    ctx.fillStyle = shade(yellow, -0.15);
    ctx.beginPath();
    ctx.ellipse(cx - hw - 1, t + 24, 3, 2, -0.3, 0, Math.PI * 2);
    ctx.ellipse(cx + hw + 1, t + 24, 3, 2, 0.3, 0, Math.PI * 2);
    ctx.fill();

    // rear diffuser with twin exhaust tips
    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath();
    ctx.roundRect(cx - 10, t + 64, 20, 4.5, 1.5);
    ctx.fill();
    ctx.fillStyle = '#9ea4a8';
    ctx.beginPath();
    ctx.arc(cx - 3, t + 67, 1.3, 0, Math.PI * 2);
    ctx.arc(cx + 3, t + 67, 1.3, 0, Math.PI * 2);
    ctx.fill();

    // swept headlights, quad round tail lights (glowing)
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(220,235,255,0.95)';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * 9, t + 4);
      ctx.lineTo(cx + s * 14, t + 7);
      ctx.lineTo(cx + s * 13.5, t + 8.5);
      ctx.lineTo(cx + s * 9, t + 5.6);
      ctx.fill();
    }
    const beam = ctx.createLinearGradient(0, t + 6, 0, t - 40);
    beam.addColorStop(0, 'rgba(255,255,230,0.22)');
    beam.addColorStop(1, 'rgba(255,255,230,0)');
    ctx.fillStyle = beam;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * 11 - 3, t + 5);
      ctx.lineTo(cx + s * 11 - 9, t - 40);
      ctx.lineTo(cx + s * 11 + 9, t - 40);
      ctx.lineTo(cx + s * 11 + 3, t + 5);
      ctx.fill();
    }
    for (const tx of [-11.5, -7, 7, 11.5]) {
      const g = ctx.createRadialGradient(cx + tx, t + 66.5, 0, cx + tx, t + 66.5, 4);
      g.addColorStop(0, 'rgba(255,120,120,1)');
      g.addColorStop(0.4, 'rgba(230,20,20,0.9)');
      g.addColorStop(1, 'rgba(200,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx + tx, t + 66.5, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawHud(): void {
    const ctx = this.ctx;
    const pad = (n: number) => String(n).padStart(5, '0');
    const panel = (x: number, w: number) => {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(x, 8, w, 24, 6);
      ctx.fill();
    };
    ctx.font = 'bold 13px "Courier New", monospace';

    const text = `HI ${pad(this.hiScore)}  ${pad(this.score)}`;
    const tw = ctx.measureText(text).width;
    panel(WIDTH - tw - 22, tw + 14);
    ctx.fillStyle = '#f2f2f2';
    ctx.textAlign = 'right';
    ctx.fillText(text, WIDTH - 15, 24);

    const kmh = `${Math.round(80 + this.speed * 15)} km/h`;
    panel(8, ctx.measureText(kmh).width + 14);
    ctx.fillStyle = '#ffd54f';
    ctx.textAlign = 'left';
    ctx.fillText(kmh, 15, 24);

    if (this.state === 'running') return;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.beginPath();
    ctx.roundRect(ROAD_LEFT - 10, 180, ROAD_RIGHT - ROAD_LEFT + 20, 90, 10);
    ctx.fill();
    ctx.fillStyle = '#f2f2f2';
    ctx.textAlign = 'center';
    if (this.state === 'ready') {
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText('PRESS SPACE OR TAP', WIDTH / 2, 216);
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.fillText('← → to change lanes', WIDTH / 2, 242);
    } else {
      ctx.font = 'bold 20px "Courier New", monospace';
      ctx.fillText('C R A S H !', WIDTH / 2, 216);
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.fillText('space or tap to restart', WIDTH / 2, 242);
    }
  }
}
