import { AfterViewInit, Component, ElementRef, OnDestroy, signal, viewChild } from '@angular/core';
import { RetroSound, loadHiScore, saveHiScore } from '../shared/retro-sound';

// ---- Tunable settings -------------------------------------------------
const WIDTH = 360;
const HEIGHT = 480;
const SHIP_SPEED_X = 4.5;
const SHIP_SPEED_Y = 3.6;
const SHIP_MIN_Y = HEIGHT * 0.35;
const SHIP_RADIUS = 13; // collision radius
const FIRE_COOLDOWN = 11; // frames between shots
const LIVES = 3;
const INVULNERABLE_FRAMES = 100;
const UFO_POINTS = 10;
const UFO_HP = 2;
const UFO_FIRE_MIN_SCORE = 30; // UFOs start shooting back after this score
const DIFFICULTY_RAMP_FRAMES = 60 * 90; // reaches max difficulty after ~90 s
const HI_SCORE_KEY = 'space-hi-score';

type GameState = 'ready' | 'running' | 'over';
type PlanetKind = 'mars' | 'venus' | 'jupiter' | 'saturn' | 'neptune';

interface Rock {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  angle: number;
  spin: number;
  shape: number[]; // radius multiplier per vertex
  craters: { a: number; d: number; r: number }[]; // polar offsets
}

interface Ufo {
  x: number;
  y: number;
  baseX: number;
  phase: number;
  hp: number;
  flash: number;
  fireIn: number;
}

interface Shot {
  x: number;
  y: number;
  vx: number;
  vy: number;
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
}

interface Star {
  x: number;
  y: number;
  layer: number;
  twinkle: number;
}

interface Planet {
  kind: PlanetKind;
  x: number;
  y: number;
  r: number;
  img: HTMLCanvasElement;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
}

const PLANET_ORDER: PlanetKind[] = ['mars', 'saturn', 'venus', 'jupiter', 'neptune'];
const PLANET_RADIUS: Record<PlanetKind, number> = { mars: 36, venus: 30, jupiter: 56, saturn: 32, neptune: 26 };
const STAR_LAYERS = [
  { count: 70, speed: 0.25, size: 1, alpha: 0.5 },
  { count: 40, speed: 0.6, size: 1.5, alpha: 0.75 },
  { count: 18, speed: 1.2, size: 2, alpha: 1 },
];
const EXPLOSION_COLORS = ['#fff6c2', '#ffd166', '#ff9f1c', '#ff5400', '#c1121f', '#9e9e9e'];

@Component({
  selector: 'app-space-game',
  templateUrl: './space-game.html',
  styleUrl: '../car-game/car-game.scss',
  host: {
    '(window:keydown)': 'onKey($event, true)',
    '(window:keyup)': 'onKey($event, false)',
    '(document:visibilitychange)': 'lastTime = 0',
  },
})
export class SpaceGame implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly soundOn = signal(true);

  private ctx!: CanvasRenderingContext2D;
  private dpr = 1;
  private rafId = 0;
  lastTime = 0;
  private readonly sound = new RetroSound();

  private state: GameState = 'ready';
  private score = 0;
  private hiScore = 0;
  private lives = LIVES;
  private gameOverAt = 0;
  private frame = 0;
  private elapsed = 0;

  // ship
  private shipX = WIDTH / 2;
  private shipY = HEIGHT - 70;
  private bank = 0;
  private invulnerable = 0;
  private fireCooldown = 0;
  private firing = false;
  private readonly keys = { left: false, right: false, up: false, down: false };
  private pointerTarget: { x: number; y: number } | null = null;

  // world
  private rocks: Rock[] = [];
  private ufos: Ufo[] = [];
  private shots: Shot[] = [];
  private enemyShots: Shot[] = [];
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private nextRockIn = 40;
  private nextUfoIn = 90;

  // background
  private stars: Star[] = [];
  private planets: Planet[] = [];
  private planetIndex = 0;
  private nebula!: HTMLCanvasElement;
  private nebulaOffset = 0;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * this.dpr;
    canvas.height = HEIGHT * this.dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(this.dpr, this.dpr);
    this.hiScore = loadHiScore(HI_SCORE_KEY);
    this.initBackground();
    this.rafId = requestAnimationFrame(this.loop);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.sound.close();
  }

  // ---- Input ----------------------------------------------------------
  onKey(e: KeyboardEvent, down: boolean): void {
    const map: Record<string, keyof SpaceGame['keys']> = {
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
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (down && this.state !== 'running') this.startOrRestart();
      else this.firing = down;
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
    this.firing = true; // auto-fire while touching
  }

  protected onPointerMove(e: PointerEvent): void {
    if (this.pointerTarget) this.pointerTarget = this.toCanvas(e);
  }

  protected onPointerUp(): void {
    this.pointerTarget = null;
    this.firing = false;
  }

  protected toggleSound(): void {
    this.soundOn.update((v) => !v);
    this.sound.enabled = this.soundOn();
  }

  private toCanvas(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT - 50, // keep ship visible above the finger
    };
  }

  private startOrRestart(): void {
    if (this.state === 'ready') this.state = 'running';
    else if (this.state === 'over' && performance.now() - this.gameOverAt > 700) this.restart();
  }

  private restart(): void {
    this.state = 'running';
    this.score = 0;
    this.lives = LIVES;
    this.elapsed = 0;
    this.shipX = WIDTH / 2;
    this.shipY = HEIGHT - 70;
    this.invulnerable = 0;
    this.rocks = [];
    this.ufos = [];
    this.shots = [];
    this.enemyShots = [];
    this.popups = [];
    this.nextRockIn = 40;
    this.nextUfoIn = 90;
  }

  // ---- Game loop -------------------------------------------------------
  private loop = (time: number): void => {
    const dt = this.lastTime ? Math.min((time - this.lastTime) / (1000 / 60), 3) : 1;
    this.lastTime = time;
    this.frame += dt;
    this.updateBackground(this.state === 'running' ? dt : dt * 0.4);
    if (this.state === 'running') this.update(dt);
    this.updateEffects(dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private get difficulty(): number {
    return Math.min(1, this.elapsed / DIFFICULTY_RAMP_FRAMES);
  }

  private update(dt: number): void {
    this.elapsed += dt;
    this.moveShip(dt);

    // firing: twin lasers from the wing guns
    this.fireCooldown -= dt;
    if (this.firing && this.fireCooldown <= 0) {
      this.fireCooldown = FIRE_COOLDOWN;
      this.shots.push({ x: this.shipX - 11, y: this.shipY - 4, vx: 0, vy: -9 });
      this.shots.push({ x: this.shipX + 11, y: this.shipY - 4, vx: 0, vy: -9 });
      this.sound.beep(980, 0.04, 'square');
    }

    // spawning
    this.nextRockIn -= dt;
    if (this.nextRockIn <= 0) {
      this.spawnRock();
      this.nextRockIn = 55 - 30 * this.difficulty + Math.random() * 30;
    }
    this.nextUfoIn -= dt;
    if (this.nextUfoIn <= 0) {
      this.spawnUfo();
      this.nextUfoIn = 150 - 60 * this.difficulty + Math.random() * 80;
    }

    // movement
    for (const s of this.shots) s.y += s.vy * dt;
    this.shots = this.shots.filter((s) => s.y > -20);
    for (const s of this.enemyShots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    this.enemyShots = this.enemyShots.filter((s) => s.y < HEIGHT + 10 && s.y > -10 && s.x > -10 && s.x < WIDTH + 10);

    for (const r of this.rocks) {
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.angle += r.spin * dt;
    }
    this.rocks = this.rocks.filter((r) => r.y - r.r < HEIGHT + 10);

    for (const u of this.ufos) {
      u.phase += 0.025 * dt;
      u.y += (0.7 + this.difficulty * 0.5) * dt;
      u.x = u.baseX + Math.sin(u.phase) * 55;
      u.flash = Math.max(0, u.flash - dt);
      if (this.score >= UFO_FIRE_MIN_SCORE) {
        u.fireIn -= dt;
        if (u.fireIn <= 0 && u.y > 20 && u.y < this.shipY - 40) {
          this.ufoFire(u);
          u.fireIn = 110 + Math.random() * 90 - this.difficulty * 40;
        }
      }
    }
    this.ufos = this.ufos.filter((u) => u.y < HEIGHT + 40);

    this.handleCollisions();
  }

  private moveShip(dt: number): void {
    let dx: number;
    let dy: number;
    if (this.pointerTarget) {
      dx = Math.max(-1, Math.min(1, (this.pointerTarget.x - this.shipX) / 20));
      dy = Math.max(-1, Math.min(1, (this.pointerTarget.y - this.shipY) / 20));
    } else {
      dx = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
      dy = (this.keys.down ? 1 : 0) - (this.keys.up ? 1 : 0);
    }
    this.shipX = Math.max(26, Math.min(WIDTH - 26, this.shipX + dx * SHIP_SPEED_X * dt));
    this.shipY = Math.max(SHIP_MIN_Y, Math.min(HEIGHT - 40, this.shipY + dy * SHIP_SPEED_Y * dt));
    this.bank += (dx - this.bank) * 0.2;
    this.invulnerable = Math.max(0, this.invulnerable - dt);
  }

  private spawnRock(): void {
    const r = 12 + Math.random() * 22;
    const vertices = 9 + Math.floor(Math.random() * 4);
    this.rocks.push({
      x: r + Math.random() * (WIDTH - 2 * r),
      y: -r - 10,
      vx: (Math.random() - 0.5) * 0.8,
      vy: 1.4 + Math.random() * 1.2 + this.difficulty * 1.6,
      r,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.03,
      shape: Array.from({ length: vertices }, () => 0.78 + Math.random() * 0.3),
      craters: Array.from({ length: 2 + Math.floor(Math.random() * 3) }, () => ({
        a: Math.random() * Math.PI * 2,
        d: Math.random() * 0.5,
        r: 0.12 + Math.random() * 0.16,
      })),
    });
  }

  private spawnUfo(): void {
    const baseX = 70 + Math.random() * (WIDTH - 140);
    this.ufos.push({ x: baseX, y: -30, baseX, phase: Math.random() * Math.PI * 2, hp: UFO_HP, flash: 0, fireIn: 60 + Math.random() * 60 });
  }

  private ufoFire(u: Ufo): void {
    const dx = this.shipX - u.x;
    const dy = this.shipY - u.y;
    const len = Math.hypot(dx, dy) || 1;
    const speed = 3.2 + this.difficulty;
    this.enemyShots.push({ x: u.x, y: u.y + 10, vx: (dx / len) * speed, vy: (dy / len) * speed });
    this.sound.beep(300, 0.06, 'sawtooth');
  }

  private handleCollisions(): void {
    // player lasers vs UFOs and rocks (rocks are too tough to destroy — they just absorb shots)
    this.shots = this.shots.filter((s) => {
      for (const u of this.ufos) {
        if (Math.abs(s.x - u.x) < 30 && s.y > u.y - 22 && s.y < u.y + 14) {
          u.hp--;
          u.flash = 6;
          if (u.hp <= 0) this.destroyUfo(u);
          else this.sparks(s.x, s.y, 6, '#ffe082');
          return false;
        }
      }
      for (const r of this.rocks) {
        if (Math.hypot(s.x - r.x, s.y - r.y) < r.r * 0.9) {
          this.sparks(s.x, s.y, 4, '#bcaaa4');
          return false;
        }
      }
      return true;
    });
    this.ufos = this.ufos.filter((u) => u.hp > 0);

    if (this.invulnerable > 0) return;
    const sx = this.shipX;
    const sy = this.shipY;
    const hitRock = this.rocks.some((r) => Math.hypot(r.x - sx, r.y - sy) < r.r * 0.85 + SHIP_RADIUS);
    const hitUfo = this.ufos.some((u) => Math.abs(u.x - sx) < 30 + 6 && Math.abs(u.y - sy) < 14 + SHIP_RADIUS);
    const shotIdx = this.enemyShots.findIndex((s) => Math.hypot(s.x - sx, s.y - sy) < SHIP_RADIUS + 3);
    if (shotIdx >= 0) this.enemyShots.splice(shotIdx, 1);
    if (hitRock || hitUfo || shotIdx >= 0) this.loseLife();
  }

  private destroyUfo(u: Ufo): void {
    this.score += UFO_POINTS;
    this.explode(u.x, u.y, 36, 1);
    this.popups.push({ x: u.x, y: u.y, text: `+${UFO_POINTS}`, life: 45 });
    this.sound.beep(180, 0.2, 'sawtooth');
    setTimeout(() => this.sound.beep(90, 0.25, 'sawtooth'), 60);
  }

  private loseLife(): void {
    this.lives--;
    this.explode(this.shipX, this.shipY, 30, 0.8);
    this.sound.beep(110, 0.35, 'sawtooth');
    if (this.lives <= 0) {
      this.explode(this.shipX, this.shipY, 70, 1.6);
      this.state = 'over';
      this.gameOverAt = performance.now();
      this.firing = false;
      this.pointerTarget = null;
      if (this.score > this.hiScore) {
        this.hiScore = this.score;
        saveHiScore(HI_SCORE_KEY, this.hiScore);
      }
    } else {
      this.invulnerable = INVULNERABLE_FRAMES;
    }
  }

  private explode(x: number, y: number, count: number, power: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.5 + Math.random() * 3.5) * power;
      const max = 30 + Math.random() * 30;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: max,
        max,
        size: 1.5 + Math.random() * 3 * power,
        color: EXPLOSION_COLORS[Math.floor(Math.random() * EXPLOSION_COLORS.length)],
      });
    }
  }

  private sparks(x: number, y: number, count: number, color: string): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.particles.push({ x, y, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2, life: 14, max: 14, size: 1.5, color });
    }
  }

  private updateEffects(dt: number): void {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.97;
      p.vy *= 0.97;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const p of this.popups) {
      p.y -= 0.6 * dt;
      p.life -= dt;
    }
    this.popups = this.popups.filter((p) => p.life > 0);
  }

  // ---- Background ------------------------------------------------------
  private initBackground(): void {
    this.stars = [];
    STAR_LAYERS.forEach((layer, i) => {
      for (let n = 0; n < layer.count; n++) {
        this.stars.push({ x: Math.random() * WIDTH, y: Math.random() * HEIGHT, layer: i, twinkle: Math.random() * 10 });
      }
    });
    this.nebula = this.renderNebula();
    this.planets = [this.makePlanet(110, 'mars'), this.makePlanet(-260, 'saturn')];
    this.planetIndex = 2;
  }

  private makePlanet(y: number, kind?: PlanetKind): Planet {
    kind ??= PLANET_ORDER[this.planetIndex++ % PLANET_ORDER.length];
    const r = PLANET_RADIUS[kind];
    const left = Math.random() < 0.5;
    const x = left ? 40 + Math.random() * 80 : WIDTH - 40 - Math.random() * 80;
    return { kind, x, y, r, img: this.renderPlanet(kind, r) };
  }

  private updateBackground(dt: number): void {
    for (const s of this.stars) {
      s.y += STAR_LAYERS[s.layer].speed * dt;
      if (s.y > HEIGHT) {
        s.y -= HEIGHT;
        s.x = Math.random() * WIDTH;
      }
    }
    this.nebulaOffset = (this.nebulaOffset + 0.12 * dt) % HEIGHT;
    for (let i = 0; i < this.planets.length; i++) {
      const p = this.planets[i];
      p.y += 0.18 * dt;
      if (p.y - p.r * 2.2 > HEIGHT) {
        const highest = Math.min(...this.planets.map((q) => q.y));
        this.planets[i] = this.makePlanet(Math.min(-80, highest - 260 - Math.random() * 120));
      }
    }
  }

  private offscreen(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * this.dpr);
    c.height = Math.ceil(h * this.dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(this.dpr, this.dpr);
    return [c, ctx];
  }

  /** Soft coloured gas clouds, tiled vertically so it can scroll forever. */
  private renderNebula(): HTMLCanvasElement {
    const [c, ctx] = this.offscreen(WIDTH, HEIGHT);
    const blobs = [
      { x: 80, y: 120, r: 160, color: '110, 40, 160' },
      { x: 300, y: 330, r: 180, color: '30, 70, 170' },
      { x: 180, y: 430, r: 120, color: '160, 40, 90' },
      { x: 330, y: 60, r: 110, color: '20, 110, 140' },
    ];
    for (const b of blobs) {
      for (const dy of [-HEIGHT, 0, HEIGHT]) {
        const g = ctx.createRadialGradient(b.x, b.y + dy, 0, b.x, b.y + dy, b.r);
        g.addColorStop(0, `rgba(${b.color}, 0.22)`);
        g.addColorStop(1, `rgba(${b.color}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
      }
    }
    return c;
  }

  /** Pre-renders a shaded planet (lit from the top-left) to an offscreen canvas. */
  private renderPlanet(kind: PlanetKind, r: number): HTMLCanvasElement {
    const size = kind === 'saturn' ? r * 4.6 : r * 2.6;
    const [c, ctx] = this.offscreen(size, size);
    ctx.translate(size / 2, size / 2);

    // atmospheric glow
    const glowColor = { mars: '255,120,70', venus: '255,220,150', jupiter: '255,210,160', saturn: '255,225,160', neptune: '110,160,255' }[kind];
    const glow = ctx.createRadialGradient(0, 0, r * 0.9, 0, 0, r * 1.25);
    glow.addColorStop(0, `rgba(${glowColor},0.35)`);
    glow.addColorStop(1, `rgba(${glowColor},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
    ctx.fill();

    if (kind === 'saturn') this.drawRings(ctx, r, 'back');

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    this.paintSurface(ctx, kind, r);
    // terminator shading: light from the top-left, dark limb on the bottom-right
    const shade = ctx.createRadialGradient(-r * 0.45, -r * 0.45, r * 0.05, -r * 0.1, -r * 0.1, r * 1.35);
    shade.addColorStop(0, 'rgba(255,255,255,0.22)');
    shade.addColorStop(0.45, 'rgba(0,0,0,0)');
    shade.addColorStop(0.85, 'rgba(0,0,0,0.6)');
    shade.addColorStop(1, 'rgba(0,0,0,0.9)');
    ctx.fillStyle = shade;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();

    if (kind === 'saturn') this.drawRings(ctx, r, 'front');
    return c;
  }

  private paintSurface(ctx: CanvasRenderingContext2D, kind: PlanetKind, r: number): void {
    const blob = (x: number, y: number, rx: number, ry: number, rot: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(x * r, y * r, rx * r, ry * r, rot, 0, Math.PI * 2);
      ctx.fill();
    };
    switch (kind) {
      case 'mars':
        ctx.fillStyle = '#c1502e';
        ctx.fillRect(-r, -r, r * 2, r * 2);
        blob(-0.3, 0.1, 0.5, 0.18, 0.3, 'rgba(110,40,20,0.55)');
        blob(0.35, -0.2, 0.3, 0.12, -0.4, 'rgba(110,40,20,0.45)');
        blob(0.1, 0.45, 0.45, 0.14, 0.1, 'rgba(90,30,15,0.5)');
        blob(-0.1, -0.35, 0.35, 0.15, 0.2, 'rgba(235,150,100,0.35)');
        blob(0, -0.95, 0.42, 0.14, 0, 'rgba(255,255,255,0.85)'); // polar cap
        break;
      case 'venus':
        ctx.fillStyle = '#e3c27e';
        ctx.fillRect(-r, -r, r * 2, r * 2);
        for (let i = 0; i < 6; i++) {
          blob(-0.6 + i * 0.25, -0.5 + i * 0.2, 0.7, 0.1, 0.35, i % 2 ? 'rgba(255,240,205,0.35)' : 'rgba(170,120,50,0.25)');
        }
        break;
      case 'jupiter': {
        const bands = ['#d9c7a0', '#b5835a', '#ecdcbc', '#a96f43', '#f1e4c8', '#c4925f', '#e0d0ab', '#9d6b46', '#e8d9ba', '#b88a62'];
        const h = (r * 2) / bands.length;
        bands.forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(-r, -r + i * h, r * 2, h + 1);
        });
        blob(0.3, 0.32, 0.22, 0.12, 0, '#b4512e'); // great red spot
        blob(0.3, 0.32, 0.14, 0.07, 0, '#c96a45');
        break;
      }
      case 'saturn': {
        const bands = ['#e8d3a0', '#d9bd85', '#efdcae', '#cfae73', '#ead7a8', '#d6b77d'];
        const h = (r * 2) / bands.length;
        bands.forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(-r, -r + i * h, r * 2, h + 1);
        });
        break;
      }
      case 'neptune':
        ctx.fillStyle = '#3d63d4';
        ctx.fillRect(-r, -r, r * 2, r * 2);
        blob(0, -0.3, 1, 0.08, 0, 'rgba(140,180,255,0.35)');
        blob(0, 0.25, 1, 0.06, 0, 'rgba(20,40,140,0.35)');
        blob(-0.25, 0.1, 0.18, 0.09, 0, 'rgba(15,25,90,0.7)'); // dark spot
        break;
    }
  }

  /** Saturn's rings, split into the half behind the planet and the half in front. */
  private drawRings(ctx: CanvasRenderingContext2D, r: number, half: 'back' | 'front'): void {
    ctx.save();
    ctx.rotate(-0.38);
    const rings = [
      { rx: 1.55, w: 0.18, color: 'rgba(205,180,130,0.75)' },
      { rx: 1.8, w: 0.2, color: 'rgba(225,200,150,0.85)' },
      { rx: 2.05, w: 0.12, color: 'rgba(190,165,120,0.6)' },
    ];
    const [start, end] = half === 'back' ? [Math.PI, Math.PI * 2] : [0, Math.PI];
    for (const ring of rings) {
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = ring.w * r;
      ctx.beginPath();
      ctx.ellipse(0, 0, ring.rx * r, ring.rx * r * 0.28, 0, start, end);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- Drawing ---------------------------------------------------------
  private draw(): void {
    const ctx = this.ctx;

    // deep space
    const space = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    space.addColorStop(0, '#02020a');
    space.addColorStop(1, '#0a0b1f');
    ctx.fillStyle = space;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(this.nebula, 0, this.nebulaOffset - HEIGHT, WIDTH, HEIGHT);
    ctx.drawImage(this.nebula, 0, this.nebulaOffset, WIDTH, HEIGHT);

    // stars with twinkle
    for (const s of this.stars) {
      const layer = STAR_LAYERS[s.layer];
      ctx.globalAlpha = layer.alpha * (0.7 + 0.3 * Math.sin(this.frame / 20 + s.twinkle));
      ctx.fillStyle = s.layer === 2 && s.twinkle > 8 ? '#cfe0ff' : '#ffffff';
      ctx.fillRect(s.x, s.y, layer.size, layer.size);
    }
    ctx.globalAlpha = 1;

    for (const p of this.planets) {
      const w = p.img.width / this.dpr;
      const h = p.img.height / this.dpr;
      ctx.drawImage(p.img, p.x - w / 2, p.y - h / 2, w, h);
    }

    for (const r of this.rocks) this.drawRock(r);
    for (const u of this.ufos) this.drawUfo(u);
    this.drawShots();

    if (this.state !== 'over' && !(this.invulnerable > 0 && Math.floor(this.invulnerable / 5) % 2 === 0)) {
      this.drawShip(this.shipX, this.shipY);
    }

    // explosions (additive glow)
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#9cff8a';
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      ctx.globalAlpha = Math.min(1, p.life / 20);
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    this.drawHud();
  }

  private drawRock(r: Rock): void {
    const ctx = this.ctx;
    const n = r.shape.length;
    // rotate vertices manually so the lighting stays fixed (top-left) while the rock tumbles
    const pt = (a: number, d: number) => [r.x + Math.cos(a + r.angle) * d, r.y + Math.sin(a + r.angle) * d];

    const g = ctx.createRadialGradient(r.x - r.r * 0.4, r.y - r.r * 0.4, r.r * 0.1, r.x, r.y, r.r * 1.1);
    g.addColorStop(0, '#a39383');
    g.addColorStop(0.55, '#655749');
    g.addColorStop(1, '#241d18');
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pt((i / n) * Math.PI * 2, r.r * r.shape[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    for (const c of r.craters) {
      const [cx, cy] = pt(c.a, c.d * r.r);
      const cr = c.r * r.r;
      ctx.fillStyle = 'rgba(25,18,14,0.55)';
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,220,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, Math.PI * 0.1, Math.PI * 0.9); // lit lower rim
      ctx.stroke();
    }
  }

  /** Red-and-white flying saucer with a glass dome and a green alien pilot. */
  private drawUfo(u: Ufo): void {
    const ctx = this.ctx;
    const { x, y } = u;

    // tractor-beam glow under the saucer
    const beam = ctx.createRadialGradient(x, y + 12, 2, x, y + 12, 26);
    beam.addColorStop(0, 'rgba(140,255,200,0.35)');
    beam.addColorStop(1, 'rgba(140,255,200,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.ellipse(x, y + 14, 26, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // alien (drawn first, the glass dome goes over it)
    const head = ctx.createRadialGradient(x - 3, y - 13, 1, x, y - 9, 10);
    head.addColorStop(0, '#b6f58a');
    head.addColorStop(0.6, '#5cbf3a');
    head.addColorStop(1, '#2f7a1e');
    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); // antennae
    ctx.moveTo(x - 3, y - 16);
    ctx.lineTo(x - 6, y - 21);
    ctx.moveTo(x + 3, y - 16);
    ctx.lineTo(x + 6, y - 21);
    ctx.stroke();
    ctx.fillStyle = '#8be05f';
    ctx.beginPath();
    ctx.arc(x - 6, y - 21, 1.6, 0, Math.PI * 2);
    ctx.arc(x + 6, y - 21, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4fa833'; // shoulders
    ctx.beginPath();
    ctx.ellipse(x, y - 1, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = head;
    ctx.beginPath();
    ctx.ellipse(x, y - 9, 7.5, 8.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // big black almond eyes with a glint
    ctx.fillStyle = '#050505';
    ctx.beginPath();
    ctx.ellipse(x - 3.3, y - 9, 3.2, 1.9, 0.5, 0, Math.PI * 2);
    ctx.ellipse(x + 3.3, y - 9, 3.2, 1.9, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x - 4.5, y - 10, 1, 1);
    ctx.fillRect(x + 2.5, y - 10, 1, 1);

    // glass dome
    const glass = ctx.createRadialGradient(x - 5, y - 14, 2, x, y - 6, 18);
    glass.addColorStop(0, 'rgba(255,255,255,0.45)');
    glass.addColorStop(0.5, 'rgba(170,215,255,0.18)');
    glass.addColorStop(1, 'rgba(120,170,230,0.3)');
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.ellipse(x, y - 3, 16, 17, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y - 3, 13, 14, 0, Math.PI * 1.15, Math.PI * 1.45);
    ctx.stroke();

    // red saucer hull
    const hull = ctx.createLinearGradient(0, y - 6, 0, y + 12);
    hull.addColorStop(0, '#ff6f61');
    hull.addColorStop(0.45, '#d32f2f');
    hull.addColorStop(1, '#5e0b0b');
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.ellipse(x, y + 3, 31, 9.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // white rim band
    const rim = ctx.createLinearGradient(0, y - 2, 0, y + 6);
    rim.addColorStop(0, '#ffffff');
    rim.addColorStop(1, '#b0bec5');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.ellipse(x, y + 1.5, 27, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // blinking lights around the rim
    for (let i = -2; i <= 2; i++) {
      const on = (Math.floor(this.frame / 10) + i) % 2 === 0;
      ctx.fillStyle = on ? '#fff59d' : '#ff8a80';
      ctx.beginPath();
      ctx.arc(x + i * 10, y + 2 + Math.abs(i) * -0.4, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // underside
    ctx.fillStyle = '#3d0606';
    ctx.beginPath();
    ctx.ellipse(x, y + 10, 12, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    if (u.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.ellipse(x, y, 32, 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawShots(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.shots) {
      const g = ctx.createLinearGradient(0, s.y - 10, 0, s.y + 4);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,200,80,0.95)');
      g.addColorStop(1, 'rgba(255,120,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(s.x - 1.5, s.y - 10, 3, 14, 1.5);
      ctx.fill();
    }
    for (const s of this.enemyShots) {
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 7);
      g.addColorStop(0, 'rgba(230,255,220,1)');
      g.addColorStop(0.35, 'rgba(90,255,90,0.9)');
      g.addColorStop(1, 'rgba(0,255,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** White-and-black spacecraft (nose up) with an Indian flag decal. */
  private drawShip(x: number, y: number): void {
    const ctx = this.ctx;
    const span = 24 - Math.abs(this.bank) * 5; // wings foreshorten when banking

    // engine flames
    ctx.globalCompositeOperation = 'lighter';
    const flicker = 12 + Math.sin(this.frame * 0.8) * 3 + Math.random() * 3;
    for (const ex of [-5, 5]) {
      const g = ctx.createLinearGradient(0, y + 22, 0, y + 22 + flicker);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.35, 'rgba(130,190,255,0.85)');
      g.addColorStop(1, 'rgba(50,80,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x + ex - 3, y + 22);
      ctx.lineTo(x + ex, y + 22 + flicker);
      ctx.lineTo(x + ex + 3, y + 22);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // black wings with white tips
    const wing = ctx.createLinearGradient(x - span, 0, x + span, 0);
    wing.addColorStop(0, '#0d0d0d');
    wing.addColorStop(0.5, '#3a3d42');
    wing.addColorStop(1, '#0d0d0d');
    ctx.fillStyle = wing;
    ctx.beginPath();
    ctx.moveTo(x - 7, y - 4);
    ctx.lineTo(x - span, y + 12);
    ctx.lineTo(x - span, y + 18);
    ctx.lineTo(x - 7, y + 15);
    ctx.moveTo(x + 7, y - 4);
    ctx.lineTo(x + span, y + 12);
    ctx.lineTo(x + span, y + 18);
    ctx.lineTo(x + 7, y + 15);
    ctx.fill();
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(x - span, y + 11, 2.5, 7); // wing-tip guns
    ctx.fillRect(x + span - 2.5, y + 11, 2.5, 7);

    // tail fins
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(x - 7, y + 12);
    ctx.lineTo(x - 13, y + 24);
    ctx.lineTo(x - 7, y + 22);
    ctx.moveTo(x + 7, y + 12);
    ctx.lineTo(x + 13, y + 24);
    ctx.lineTo(x + 7, y + 22);
    ctx.fill();

    // white metallic fuselage
    const body = ctx.createLinearGradient(x - 8, 0, x + 8, 0);
    body.addColorStop(0, '#8d9399');
    body.addColorStop(0.3, '#ffffff');
    body.addColorStop(0.6, '#e6e8eb');
    body.addColorStop(1, '#6f747a');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x, y - 28);
    ctx.quadraticCurveTo(x + 9, y - 14, x + 8, y + 2);
    ctx.lineTo(x + 8, y + 22);
    ctx.lineTo(x - 8, y + 22);
    ctx.lineTo(x - 8, y + 2);
    ctx.quadraticCurveTo(x - 9, y - 14, x, y - 28);
    ctx.fill();

    // black nose cone + belly stripe
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(x, y - 28);
    ctx.quadraticCurveTo(x + 3.5, y - 24, x + 4.3, y - 20);
    ctx.lineTo(x - 4.3, y - 20);
    ctx.quadraticCurveTo(x - 3.5, y - 24, x, y - 28);
    ctx.fill();
    ctx.fillRect(x - 8, y + 15, 16, 2);

    // cockpit glass
    const glass = ctx.createLinearGradient(x - 3, y - 16, x + 3, y - 4);
    glass.addColorStop(0, '#5a7aa6');
    glass.addColorStop(0.5, '#0b1220');
    glass.addColorStop(1, '#000');
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.ellipse(x, y - 10, 3.6, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.ellipse(x - 1.2, y - 13, 0.9, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Indian flag decal: saffron, white, green with the navy chakra
    const fx = x - 6;
    const fy = y + 2;
    ctx.fillStyle = '#FF9933';
    ctx.fillRect(fx, fy, 12, 3);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(fx, fy + 3, 12, 3);
    ctx.fillStyle = '#138808';
    ctx.fillRect(fx, fy + 6, 12, 3);
    ctx.strokeStyle = '#000080';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(x, fy + 4.5, 1.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(fx, fy, 12, 9);

    // engine nozzles
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(x - 8, y + 19, 6, 4);
    ctx.fillRect(x + 2, y + 19, 6, 4);
  }

  private drawHud(): void {
    const ctx = this.ctx;
    const pad = (n: number) => String(n).padStart(5, '0');
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = '#f2f2f2';
    ctx.textAlign = 'right';
    ctx.fillText(`HI ${pad(this.hiScore)}  ${pad(this.score)}`, WIDTH - 12, 22);

    // lives as small ship icons
    for (let i = 0; i < this.lives; i++) {
      const lx = 16 + i * 18;
      ctx.fillStyle = '#f2f2f2';
      ctx.beginPath();
      ctx.moveTo(lx, 10);
      ctx.lineTo(lx + 6, 24);
      ctx.lineTo(lx - 6, 24);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#FF9933';
      ctx.fillRect(lx - 2, 18, 4, 2);
    }

    if (this.state === 'running') return;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(30, 175, WIDTH - 60, 100, 10);
    ctx.fill();
    ctx.fillStyle = '#f2f2f2';
    ctx.textAlign = 'center';
    if (this.state === 'ready') {
      ctx.font = 'bold 18px "Courier New", monospace';
      ctx.fillText('SPACE DEFENDER', WIDTH / 2, 205);
      ctx.font = 'bold 12px "Courier New", monospace';
      ctx.fillText('arrows / drag to fly · space to fire', WIDTH / 2, 230);
      ctx.fillText('shoot UFOs · dodge the rocks', WIDTH / 2, 248);
      ctx.fillText('press space or tap to launch', WIDTH / 2, 266);
    } else {
      ctx.font = 'bold 20px "Courier New", monospace';
      ctx.fillText('MISSION OVER', WIDTH / 2, 210);
      ctx.font = 'bold 14px "Courier New", monospace';
      ctx.fillText(`UFOs destroyed: ${this.score / UFO_POINTS}`, WIDTH / 2, 236);
      ctx.font = 'bold 12px "Courier New", monospace';
      ctx.fillText('space or tap to fly again', WIDTH / 2, 260);
    }
  }
}
