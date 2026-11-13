import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { RetroSound } from '../shared/retro-sound';

// ---- Tunable settings -------------------------------------------------
const WIDTH = 800;
const HEIGHT = 200;
const GROUND_Y = 170;
const GRAVITY = 0.6;
const FAST_FALL = 1.4;
const JUMP_VELOCITY = -11.5;
const START_SPEED = 6;
const MAX_SPEED = 13;
const ACCELERATION = 0.0012;
const DRONE_MIN_SCORE = 200;
const HI_SCORE_KEY = 'runner-hi-score';

type GameState = 'ready' | 'running' | 'over';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Obstacle extends Rect {
  kind: 'cactus' | 'drone';
  count: number; // cacti in a cluster
}

interface Cloud {
  x: number;
  y: number;
}

@Component({
  selector: 'app-runner-game',
  templateUrl: './runner-game.html',
  styleUrl: './runner-game.scss',
  host: {
    '(window:keydown)': 'onKeyDown($event)',
    '(window:keyup)': 'onKeyUp($event)',
    '(document:visibilitychange)': 'onVisibilityChange()',
  },
})
export class RunnerGame implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly soundOn = signal(true);

  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = 0;
  private readonly sound = new RetroSound();

  // game state
  private state: GameState = 'ready';
  private speed = START_SPEED;
  private distance = 0;
  private hiScore = 0;
  private gameOverAt = 0;
  private frame = 0;

  // player
  private player = { x: 50, y: GROUND_Y - 44, w: 40, h: 44, vy: 0, jumping: false, ducking: false };
  private downHeld = false;

  // world
  private obstacles: Obstacle[] = [];
  private nextObstacleIn = 300;
  private clouds: Cloud[] = [];
  private groundDots: { x: number; y: number; w: number }[] = [];

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);

    try {
      this.hiScore = Number(localStorage.getItem(HI_SCORE_KEY)) || 0;
    } catch {
      this.hiScore = 0;
    }

    this.initWorld();
    this.rafId = requestAnimationFrame(this.loop);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.sound.close();
  }

  // ---- Input ----------------------------------------------------------
  onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      this.jumpOrStart();
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      this.downHeld = true;
    }
  }

  onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'ArrowDown') this.downHeld = false;
  }

  protected onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    // Holding the bottom third of the canvas ducks; anywhere else jumps.
    if (this.state === 'running' && e.clientY - rect.top > rect.height * 0.66) {
      this.downHeld = true;
    } else {
      this.jumpOrStart();
    }
  }

  protected onPointerUp(): void {
    this.downHeld = false;
  }

  protected toggleSound(): void {
    this.soundOn.update((v) => !v);
  }

  onVisibilityChange(): void {
    // Avoid a huge time jump when coming back to the tab.
    this.lastTime = 0;
  }

  private jumpOrStart(): void {
    if (this.state === 'ready') {
      this.state = 'running';
      this.jump();
    } else if (this.state === 'running') {
      this.jump();
    } else if (this.state === 'over' && performance.now() - this.gameOverAt > 500) {
      this.restart();
    }
  }

  private jump(): void {
    const p = this.player;
    if (p.jumping || p.ducking) return;
    p.vy = JUMP_VELOCITY;
    p.jumping = true;
    this.beep(520, 0.08);
  }

  // ---- Game loop -------------------------------------------------------
  private loop = (time: number): void => {
    const dt = this.lastTime ? Math.min((time - this.lastTime) / (1000 / 60), 3) : 1;
    this.lastTime = time;
    if (this.state === 'running') this.update(dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    this.frame += dt;
    this.speed = Math.min(MAX_SPEED, this.speed + ACCELERATION * dt);
    const prevScore = this.score;
    this.distance += this.speed * dt;
    if (Math.floor(this.score / 100) > Math.floor(prevScore / 100)) this.beep(880, 0.1);

    this.updatePlayer(dt);

    // obstacles
    for (const o of this.obstacles) o.x -= (o.kind === 'drone' ? this.speed + 0.8 : this.speed) * dt;
    this.obstacles = this.obstacles.filter((o) => o.x + o.w > -10);
    this.nextObstacleIn -= this.speed * dt;
    if (this.nextObstacleIn <= 0) this.spawnObstacle();

    // scenery
    for (const c of this.clouds) {
      c.x -= 0.4 * dt;
      if (c.x < -60) {
        c.x = WIDTH + Math.random() * 200;
        c.y = 20 + Math.random() * 60;
      }
    }
    for (const d of this.groundDots) {
      d.x -= this.speed * dt;
      if (d.x < 0) d.x += WIDTH;
    }

    // collisions
    const hb = this.playerHitbox();
    if (this.obstacles.some((o) => this.overlaps(hb, this.obstacleHitbox(o)))) this.gameOver();
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    if (p.jumping) {
      p.vy += (this.downHeld ? GRAVITY + FAST_FALL : GRAVITY) * dt;
      p.y += p.vy * dt;
      if (p.y >= GROUND_Y - p.h) {
        p.y = GROUND_Y - p.h;
        p.vy = 0;
        p.jumping = false;
      }
    }
    const shouldDuck = this.downHeld && !p.jumping;
    if (shouldDuck !== p.ducking) {
      p.ducking = shouldDuck;
      p.w = shouldDuck ? 54 : 40;
      p.h = shouldDuck ? 26 : 44;
      p.y = GROUND_Y - p.h;
    }
  }

  private spawnObstacle(): void {
    let o: Obstacle;
    if (this.score > DRONE_MIN_SCORE && Math.random() < 0.3) {
      const heights = [GROUND_Y - 30, GROUND_Y - 58, GROUND_Y - 90];
      o = { kind: 'drone', count: 1, x: WIDTH, y: heights[Math.floor(Math.random() * 3)] - 24, w: 42, h: 24 };
    } else {
      const tall = Math.random() < 0.4;
      const maxCount = this.speed > 9 ? 3 : 2;
      const count = 1 + Math.floor(Math.random() * maxCount);
      const unitW = tall ? 24 : 17;
      const h = tall ? 48 : 34;
      o = { kind: 'cactus', count, x: WIDTH, y: GROUND_Y - h, w: unitW * count, h };
    }
    this.obstacles.push(o);
    const minGap = this.speed * 32 + o.w;
    this.nextObstacleIn = o.w + minGap + Math.random() * minGap * 0.9;
  }

  private gameOver(): void {
    this.state = 'over';
    this.gameOverAt = performance.now();
    this.beep(160, 0.25, 'sawtooth');
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      try {
        localStorage.setItem(HI_SCORE_KEY, String(this.hiScore));
      } catch {
        /* storage unavailable — keep in memory only */
      }
    }
  }

  private restart(): void {
    this.state = 'running';
    this.speed = START_SPEED;
    this.distance = 0;
    this.frame = 0;
    this.obstacles = [];
    this.nextObstacleIn = 300;
    Object.assign(this.player, { y: GROUND_Y - 44, w: 40, h: 44, vy: 0, jumping: false, ducking: false });
  }

  private initWorld(): void {
    this.clouds = Array.from({ length: 3 }, (_, i) => ({ x: 150 + i * 260, y: 20 + Math.random() * 60 }));
    this.groundDots = Array.from({ length: 40 }, () => ({
      x: Math.random() * WIDTH,
      y: GROUND_Y + 4 + Math.random() * 14,
      w: 1 + Math.floor(Math.random() * 4),
    }));
  }

  private get score(): number {
    return Math.floor(this.distance * 0.025);
  }

  // ---- Collision helpers ----------------------------------------------
  private playerHitbox(): Rect {
    const p = this.player;
    return { x: p.x + 6, y: p.y + 4, w: p.w - 12, h: p.h - 6 };
  }

  private obstacleHitbox(o: Obstacle): Rect {
    return o.kind === 'drone'
      ? { x: o.x + 4, y: o.y + 6, w: o.w - 8, h: o.h - 8 }
      : { x: o.x + 3, y: o.y + 6, w: o.w - 6, h: o.h - 6 };
  }

  private overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---- Drawing ---------------------------------------------------------
  private draw(): void {
    const ctx = this.ctx;
    const css = getComputedStyle(this.canvasRef().nativeElement);
    const ink = css.getPropertyValue('--game-ink').trim() || '#535353';
    const faint = css.getPropertyValue('--game-faint').trim() || '#c8c8c8';
    const bg = css.getPropertyValue('--game-bg').trim() || '#fff';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // clouds
    ctx.fillStyle = faint;
    for (const c of this.clouds) this.drawCloud(c.x, c.y);

    // ground
    ctx.fillStyle = ink;
    ctx.fillRect(0, GROUND_Y, WIDTH, 2);
    for (const d of this.groundDots) ctx.fillRect(d.x, d.y, d.w, 1);

    for (const o of this.obstacles) o.kind === 'drone' ? this.drawDrone(o, ink) : this.drawCacti(o, ink);
    this.drawPlayer(ink, bg);
    this.drawHud(ink);
  }

  private drawCloud(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillRect(x + 10, y, 26, 6);
    ctx.fillRect(x, y + 6, 46, 6);
  }

  private drawPlayer(ink: string, bg: string): void {
    const ctx = this.ctx;
    const p = this.player;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const step = this.state === 'running' && !p.jumping ? Math.floor(this.frame / 6) % 2 : 0;
    const dead = this.state === 'over';
    ctx.fillStyle = ink;

    if (p.ducking) {
      // Low, stretched-out dino: head forward, tail straight back.
      this.drawPlates(x + 10, y + 7, 4);
      this.roundRect(x + 4, y + 6, 36, 14, 6); // body
      this.roundRect(x + 36, y + 2, 18, 14, 5); // head
      this.triangle(x, y + 12, x + 8, y + 8, x + 8, y + 16); // tail
      ctx.fillRect(x + 12, y + 20, 6, step ? 6 : 4); // legs
      ctx.fillRect(x + 28, y + 20, 6, step ? 4 : 6);
      ctx.fillStyle = bg;
      this.drawEye(x + 46, y + 5, dead, ink);
      ctx.fillRect(x + 46, y + 12, 6, 1); // mouth
      return;
    }

    // Standing / running dino
    this.drawPlates(x + 9, y + 15, 3);
    this.roundRect(x + 20, y, 20, 16, 6); // head
    this.roundRect(x + 6, y + 13, 26, 24, 9); // round body
    this.triangle(x, y + 30, x + 9, y + 20, x + 10, y + 32); // tail
    ctx.fillRect(x + 31, y + 22, 5, 3); // little arm
    ctx.fillRect(x + 11, y + 36, 6, step ? 8 : 6); // legs
    ctx.fillRect(x + 22, y + 36, 6, step ? 6 : 8);
    ctx.fillRect(x + 11, y + (step ? 42 : 40), 8, 2); // feet
    ctx.fillRect(x + 22, y + (step ? 40 : 42), 8, 2);

    ctx.fillStyle = bg;
    this.drawEye(x + 30, y + 4, dead, ink);
    ctx.fillRect(x + 31, y + 12, 7, 1); // mouth
    ctx.fillRect(x + 13, y + 24, 2, 2); // belly spots
    ctx.fillRect(x + 19, y + 28, 2, 2);
  }

  /** Row of small triangular back plates along the dino's spine. */
  private drawPlates(x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const px = x + i * 7;
      this.triangle(px, y + 2, px + 3, y - 4, px + 6, y + 2);
    }
  }

  /** Round eye with a pupil, or an "x" when the game is over. (x, y) = top-left. */
  private drawEye(x: number, y: number, dead: boolean, ink: string): void {
    const ctx = this.ctx;
    if (dead) {
      ctx.fillRect(x, y, 1, 1);
      ctx.fillRect(x + 2, y, 1, 1);
      ctx.fillRect(x + 1, y + 1, 1, 1);
      ctx.fillRect(x, y + 2, 1, 1);
      ctx.fillRect(x + 2, y + 2, 1, 1);
      return;
    }
    const white = ctx.fillStyle;
    ctx.fillRect(x, y, 4, 4);
    ctx.fillStyle = ink;
    ctx.fillRect(x + 2, y + 1, 2, 2); // pupil looks forward
    ctx.fillStyle = white;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  private triangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    ctx.fill();
  }

  /** Draws a cluster of pixel-style cacti (trunk + two arms each). */
  private drawCacti(o: Obstacle, ink: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = ink;
    const unit = o.w / o.count;
    for (let i = 0; i < o.count; i++) {
      const left = Math.round(o.x + i * unit);
      const h = o.h - (i % 2) * 6; // vary heights inside a cluster
      const top = GROUND_Y - h;
      const trunkW = Math.max(6, Math.round(unit * 0.36));
      const armW = Math.max(3, Math.round(trunkW * 0.55));
      const tx = left + Math.round((unit - trunkW) / 2);

      // trunk with a rounded top
      ctx.fillRect(tx + 1, top, trunkW - 2, 2);
      ctx.fillRect(tx, top + 2, trunkW, h - 2);

      // left arm: elbow lower, points up
      const lElbow = top + Math.round(h * (i % 2 ? 0.55 : 0.5));
      const lLen = Math.round(h * 0.28);
      ctx.fillRect(left + 1, lElbow - lLen, armW, lLen + armW);
      ctx.fillRect(left + 1, lElbow, tx - left - 1, armW);

      // right arm: elbow higher, points up
      const rElbow = top + Math.round(h * (i % 2 ? 0.35 : 0.4));
      const rLen = Math.round(h * 0.22);
      const rx = left + unit - 1 - armW;
      ctx.fillRect(rx, rElbow - rLen, armW, rLen + armW);
      ctx.fillRect(tx + trunkW, rElbow, rx - tx - trunkW, armW);
    }
  }

  private drawDrone(o: Obstacle, ink: string): void {
    const ctx = this.ctx;
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    const spin = Math.floor(this.frame / 4) % 2;
    ctx.fillStyle = ink;
    ctx.fillRect(x + 10, y + 10, 22, 10); // body
    ctx.fillRect(x + 4, y + 6, 34, 2); // arms
    ctx.fillRect(x + 6, y + 2, 2, 6); // rotor masts
    ctx.fillRect(x + 34, y + 2, 2, 6);
    // rotors
    ctx.fillRect(x + (spin ? 0 : 3), y, spin ? 14 : 8, 2);
    ctx.fillRect(x + (spin ? 28 : 31), y, spin ? 14 : 8, 2);
    ctx.fillRect(x + 18, y + 20, 6, 4); // camera
  }

  private drawHud(ink: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = ink;
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.textAlign = 'right';
    const pad = (n: number) => String(n).padStart(5, '0');
    const flashing = this.state === 'running' && this.score >= 100 && this.score % 100 < 15 && Math.floor(this.frame / 8) % 2;
    ctx.fillText(`HI ${pad(this.hiScore)}  ${flashing ? '' : pad(this.score)}`, WIDTH - 16, 26);

    ctx.textAlign = 'center';
    if (this.state === 'ready') {
      ctx.fillText('PRESS SPACE OR TAP TO START', WIDTH / 2, 90);
    } else if (this.state === 'over') {
      ctx.font = 'bold 22px "Courier New", monospace';
      ctx.fillText('G A M E   O V E R', WIDTH / 2, 70);
      ctx.font = 'bold 14px "Courier New", monospace';
      ctx.fillText('press space or tap to restart', WIDTH / 2, 100);
    }
  }

  // ---- Sound -----------------------------------------------------------
  private beep(freq: number, duration: number, type: OscillatorType = 'square'): void {
    this.sound.enabled = this.soundOn();
    this.sound.beep(freq, duration, type);
  }
}
