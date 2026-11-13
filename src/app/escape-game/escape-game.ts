import { AfterViewInit, Component, ElementRef, OnDestroy, signal, viewChild } from '@angular/core';
import { RetroSound, loadHiScore, saveHiScore } from '../shared/retro-sound';

// ---- Tunable settings -------------------------------------------------
const WIDTH = 800;
const HEIGHT = 200;
const GROUND_Y = 170;
const GRAVITY = 0.6;
const FAST_FALL = 1.4;
const JUMP_VELOCITY = -11.5;
const START_SPEED = 6;
const MAX_SPEED = 12;
const ACCELERATION = 0.001;
const PLANE_MIN_SCORE = 150;
const HI_SCORE_KEY = 'escape-hi-score';

const BABY_X = 180;
/** How far mom starts behind the baby, and the most she can fall behind. */
const MOM_START_GAP = 120;
const MOM_MAX_GAP = 140;
/** How much closer mom gets on each trip (3 quick trips = caught). */
const TRIP_PENALTY = 45;
/** How quickly the baby pulls away again while running cleanly (px per frame). */
const ESCAPE_RATE = 0.06;
const INVULNERABLE_FRAMES = 70;

const MOM_LINES = ['Come here!', 'Bath time!', 'Nap time!', 'Gotcha soon!', 'Not so fast!'];

type GameState = 'ready' | 'running' | 'over';
type ObstacleKind = 'blocks' | 'duck' | 'ball' | 'teddy' | 'laundry' | 'plane';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Obstacle extends Rect {
  kind: ObstacleKind;
  variant: number;
}

interface Decor {
  kind: 'window' | 'frame' | 'clock' | 'sofa' | 'lamp' | 'door';
  x: number;
  w: number;
}

@Component({
  selector: 'app-escape-game',
  templateUrl: './escape-game.html',
  styleUrl: '../runner-game/runner-game.scss',
  host: {
    '(window:keydown)': 'onKeyDown($event)',
    '(window:keyup)': 'onKeyUp($event)',
    '(document:visibilitychange)': 'lastTime = 0',
  },
})
export class EscapeGame implements AfterViewInit, OnDestroy {
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

  // baby
  private player = { x: BABY_X, y: GROUND_Y - 44, w: 40, h: 44, vy: 0, jumping: false, ducking: false };
  private downHeld = false;
  private invulnerable = 0;

  // mom
  private momGap = MOM_START_GAP;
  private momLine = '';
  private momLineTimer = 0;

  // world
  private obstacles: Obstacle[] = [];
  private nextObstacleIn = 300;
  private decor: Decor[] = [];
  private floorOffset = 0;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.hiScore = loadHiScore(HI_SCORE_KEY);
    this.initDecor();
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
    if (this.state === 'running' && e.clientY - rect.top > rect.height * 0.66) this.downHeld = true;
    else this.jumpOrStart();
  }

  protected onPointerUp(): void {
    this.downHeld = false;
  }

  protected toggleSound(): void {
    this.soundOn.update((v) => !v);
    this.sound.enabled = this.soundOn();
  }

  private jumpOrStart(): void {
    if (this.state === 'ready') {
      this.state = 'running';
      this.say('Bath time!');
      this.jump();
    } else if (this.state === 'running') {
      this.jump();
    } else if (performance.now() - this.gameOverAt > 600) {
      this.restart();
    }
  }

  private jump(): void {
    const p = this.player;
    if (p.jumping || p.ducking) return;
    p.vy = JUMP_VELOCITY;
    p.jumping = true;
    this.sound.beep(620, 0.07);
  }

  private say(line: string): void {
    this.momLine = line;
    this.momLineTimer = 90;
  }

  // ---- Game loop -------------------------------------------------------
  private loop = (time: number): void => {
    const dt = this.lastTime ? Math.min((time - this.lastTime) / (1000 / 60), 3) : 1;
    this.lastTime = time;
    if (this.state === 'running') this.update(dt);
    else this.frame += dt * 0.5; // keep idle animations ticking
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    this.frame += dt;
    this.speed = Math.min(MAX_SPEED, this.speed + ACCELERATION * dt);
    const prevScore = this.score;
    const move = this.speed * dt;
    this.distance += move;
    this.floorOffset = (this.floorOffset + move) % 60;
    if (Math.floor(this.score / 100) > Math.floor(prevScore / 100)) this.sound.beep(880, 0.1);

    this.updatePlayer(dt);

    for (const o of this.obstacles) o.x -= (o.kind === 'plane' ? this.speed + 1 : this.speed) * dt;
    this.obstacles = this.obstacles.filter((o) => o.x + o.w > -20);
    this.nextObstacleIn -= move;
    if (this.nextObstacleIn <= 0) this.spawnObstacle();

    // house decor scrolls slower for a parallax effect
    for (const d of this.decor) d.x -= move * 0.5;
    const maxX = Math.max(...this.decor.map((d) => d.x + d.w));
    for (const d of this.decor) if (d.x + d.w < 0) Object.assign(d, this.makeDecor(maxX + 40 + Math.random() * 80));

    // mom: falls behind while the baby runs cleanly
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (this.invulnerable === 0) this.momGap = Math.min(MOM_MAX_GAP, this.momGap + ESCAPE_RATE * dt);
    this.momLineTimer = Math.max(0, this.momLineTimer - dt);

    if (this.invulnerable === 0) {
      const hb = this.playerHitbox();
      const hit = this.obstacles.find((o) => this.overlaps(hb, this.obstacleHitbox(o)));
      if (hit) this.trip();
    }
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

  /** The baby bumps into something: stumbles, slows down, and mom closes in. */
  private trip(): void {
    this.momGap -= TRIP_PENALTY;
    this.speed = Math.max(START_SPEED, this.speed * 0.85);
    this.invulnerable = INVULNERABLE_FRAMES;
    if (this.momGap <= 0) {
      this.caught();
      return;
    }
    this.sound.beep(200, 0.15, 'triangle');
    this.say(MOM_LINES[Math.floor(Math.random() * MOM_LINES.length)]);
  }

  private caught(): void {
    this.momGap = 0;
    this.state = 'over';
    this.gameOverAt = performance.now();
    this.say(Math.random() < 0.5 ? 'Bath time!' : 'Nap time!');
    this.sound.beep(300, 0.12, 'triangle');
    setTimeout(() => this.sound.beep(220, 0.25, 'triangle'), 130);
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      saveHiScore(HI_SCORE_KEY, this.hiScore);
    }
  }

  private restart(): void {
    this.state = 'running';
    this.speed = START_SPEED;
    this.distance = 0;
    this.frame = 0;
    this.obstacles = [];
    this.nextObstacleIn = 300;
    this.momGap = MOM_START_GAP;
    this.invulnerable = 0;
    this.say('Bath time!');
    Object.assign(this.player, { y: GROUND_Y - 44, w: 40, h: 44, vy: 0, jumping: false, ducking: false });
  }

  private spawnObstacle(): void {
    const r = Math.random();
    const variant = Math.floor(Math.random() * 3);
    let o: Obstacle;
    if (this.score > PLANE_MIN_SCORE && r < 0.18) {
      const heights = [GROUND_Y - 30, GROUND_Y - 58, GROUND_Y - 90];
      o = { kind: 'plane', variant, x: WIDTH, y: heights[variant] - 18, w: 40, h: 18 };
    } else if (this.score > 50 && r < 0.36) {
      // hangs down to just above a ducking baby's head
      o = { kind: 'laundry', variant, x: WIDTH, y: 80, w: 70, h: 60 };
    } else {
      const kinds: ObstacleKind[] = ['blocks', 'duck', 'ball', 'teddy'];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const size: Record<string, [number, number]> = {
        blocks: variant === 0 ? [18, 36] : variant === 1 ? [36, 18] : [36, 36],
        duck: [24, 22],
        ball: [22, 22],
        teddy: [28, 32],
      };
      const [w, h] = size[kind];
      o = { kind, variant, x: WIDTH, y: GROUND_Y - h, w, h };
    }
    this.obstacles.push(o);
    const minGap = this.speed * 34 + o.w;
    this.nextObstacleIn = o.w + minGap + Math.random() * minGap * 0.9;
  }

  private initDecor(): void {
    this.decor = [];
    let x = 20;
    while (x < WIDTH * 1.5) {
      const d = this.makeDecor(x);
      this.decor.push(d);
      x += d.w + 40 + Math.random() * 80;
    }
  }

  private makeDecor(x: number): Decor {
    const kinds: Decor['kind'][] = ['window', 'frame', 'clock', 'sofa', 'lamp', 'door'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const w = { window: 56, frame: 30, clock: 24, sofa: 96, lamp: 26, door: 44 }[kind];
    return { kind, x, w };
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
    if (o.kind === 'laundry') return { x: o.x + 4, y: o.y + 10, w: o.w - 8, h: o.h - 10 };
    return { x: o.x + 3, y: o.y + 3, w: o.w - 6, h: o.h - 4 };
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

    // house interior
    ctx.fillStyle = faint;
    ctx.strokeStyle = faint;
    for (const d of this.decor) this.drawDecor(d, faint, bg);
    ctx.fillStyle = faint;
    ctx.fillRect(0, GROUND_Y - 8, WIDTH, 2); // skirting board

    // wooden floor
    ctx.fillStyle = ink;
    ctx.fillRect(0, GROUND_Y, WIDTH, 2);
    ctx.fillStyle = faint;
    for (let x = -this.floorOffset; x < WIDTH; x += 60) {
      ctx.fillRect(x, GROUND_Y + 2, 1, 8);
      ctx.fillRect(x + 30, GROUND_Y + 12, 1, 8);
    }
    ctx.fillRect(0, GROUND_Y + 11, WIDTH, 1);

    for (const o of this.obstacles) this.drawObstacle(o, ink, bg);

    this.drawMom(ink, bg, faint);

    // blink while recovering from a trip
    const blink = this.invulnerable > 0 && Math.floor(this.invulnerable / 5) % 2 === 0;
    if (!blink) this.drawBaby(ink, bg);

    this.drawHud(ink, faint);
  }

  private drawDecor(d: Decor, faint: string, bg: string): void {
    const ctx = this.ctx;
    const x = Math.round(d.x);
    ctx.fillStyle = faint;
    switch (d.kind) {
      case 'window':
        ctx.fillRect(x, 30, d.w, 50);
        ctx.fillStyle = bg;
        ctx.fillRect(x + 4, 34, d.w / 2 - 6, 19);
        ctx.fillRect(x + d.w / 2 + 2, 34, d.w / 2 - 6, 19);
        ctx.fillRect(x + 4, 57, d.w / 2 - 6, 19);
        ctx.fillRect(x + d.w / 2 + 2, 57, d.w / 2 - 6, 19);
        ctx.fillStyle = faint;
        ctx.fillRect(x - 6, 26, d.w + 12, 4); // curtain rail
        ctx.fillRect(x - 4, 30, 6, 56); // curtains
        ctx.fillRect(x + d.w - 2, 30, 6, 56);
        break;
      case 'frame':
        ctx.fillRect(x, 50, d.w, 24);
        ctx.fillStyle = bg;
        ctx.fillRect(x + 3, 53, d.w - 6, 18);
        ctx.fillStyle = faint;
        ctx.beginPath(); // little mountain picture
        ctx.moveTo(x + 5, 70);
        ctx.lineTo(x + 13, 59);
        ctx.lineTo(x + 19, 66);
        ctx.lineTo(x + 22, 62);
        ctx.lineTo(x + 26, 70);
        ctx.fill();
        break;
      case 'clock':
        ctx.beginPath();
        ctx.arc(x + 12, 50, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(x + 12, 50, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = faint;
        ctx.fillRect(x + 11, 43, 2, 8);
        ctx.fillRect(x + 11, 49, 6, 2);
        break;
      case 'sofa':
        ctx.beginPath();
        ctx.roundRect(x, GROUND_Y - 44, d.w, 26, 8); // backrest
        ctx.roundRect(x - 6, GROUND_Y - 30, 14, 22, 5); // arms
        ctx.roundRect(x + d.w - 8, GROUND_Y - 30, 14, 22, 5);
        ctx.fill();
        ctx.fillRect(x, GROUND_Y - 22, d.w, 12); // seat
        ctx.fillRect(x + 2, GROUND_Y - 10, 4, 10); // legs
        ctx.fillRect(x + d.w - 6, GROUND_Y - 10, 4, 10);
        break;
      case 'lamp':
        ctx.beginPath();
        ctx.moveTo(x + 4, 104);
        ctx.lineTo(x + 22, 104);
        ctx.lineTo(x + 18, 86);
        ctx.lineTo(x + 8, 86);
        ctx.fill();
        ctx.fillRect(x + 12, 104, 2, GROUND_Y - 112);
        ctx.fillRect(x + 5, GROUND_Y - 10, 16, 3);
        break;
      case 'door':
        ctx.fillRect(x, GROUND_Y - 120, d.w, 112);
        ctx.fillStyle = bg;
        ctx.fillRect(x + 4, GROUND_Y - 116, d.w - 8, 104);
        ctx.fillStyle = faint;
        ctx.fillRect(x + 8, GROUND_Y - 110, d.w - 16, 40);
        ctx.fillRect(x + 8, GROUND_Y - 64, d.w - 16, 46);
        ctx.fillStyle = bg;
        ctx.fillRect(x + 10, GROUND_Y - 108, d.w - 20, 36);
        ctx.fillRect(x + 10, GROUND_Y - 62, d.w - 20, 42);
        ctx.fillStyle = faint;
        ctx.fillRect(x + d.w - 12, GROUND_Y - 66, 4, 4); // knob
        break;
    }
  }

  private drawObstacle(o: Obstacle, ink: string, bg: string): void {
    const ctx = this.ctx;
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    ctx.fillStyle = ink;
    switch (o.kind) {
      case 'blocks': {
        // toy letter blocks: tower, row, or pyramid of three
        const cells =
          o.variant === 0 ? [[0, 0], [0, 1]] : o.variant === 1 ? [[0, 0], [1, 0]] : [[0, 0], [1, 0], [0.5, 1]];
        const letters = 'ABC';
        cells.forEach(([cx, cy], i) => {
          const bx = x + cx * 18;
          const by = GROUND_Y - 18 - cy * 18;
          ctx.fillStyle = ink;
          ctx.fillRect(bx, by, 17, 17);
          ctx.fillStyle = bg;
          ctx.fillRect(bx + 2, by + 2, 13, 13);
          ctx.fillStyle = ink;
          ctx.font = 'bold 11px "Courier New", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(letters[i], bx + 8.5, by + 12.5);
        });
        break;
      }
      case 'duck': // rubber duck facing left
        ctx.beginPath();
        ctx.ellipse(x + 13, y + 15, 11, 7, 0, 0, Math.PI * 2); // body
        ctx.arc(x + 8, y + 7, 6, 0, Math.PI * 2); // head
        ctx.fill();
        ctx.fillRect(x, y + 6, 4, 3); // beak
        ctx.fillRect(x + 20, y + 9, 4, 3); // tail
        ctx.fillStyle = bg;
        ctx.fillRect(x + 6, y + 5, 2, 2); // eye
        ctx.fillRect(x + 11, y + 14, 8, 2); // wing
        break;
      case 'ball': {
        const spin = Math.floor(this.frame / 5) % 2;
        ctx.beginPath();
        ctx.arc(x + 11, y + 11, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = bg;
        if (spin) ctx.fillRect(x + 2, y + 10, 18, 3);
        else ctx.fillRect(x + 10, y + 2, 3, 18);
        ctx.beginPath();
        ctx.arc(x + 11, y + 11, 3, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'teddy':
        ctx.beginPath();
        ctx.arc(x + 14, y + 22, 10, 0, Math.PI * 2); // body
        ctx.arc(x + 14, y + 9, 8, 0, Math.PI * 2); // head
        ctx.arc(x + 7, y + 3, 4, 0, Math.PI * 2); // ears
        ctx.arc(x + 21, y + 3, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(x + 1, y + 18, 6, 5); // arms
        ctx.fillRect(x + 21, y + 18, 6, 5);
        ctx.fillStyle = bg;
        ctx.fillRect(x + 10, y + 7, 2, 2); // eyes
        ctx.fillRect(x + 16, y + 7, 2, 2);
        ctx.fillRect(x + 12, y + 11, 4, 2); // snout
        ctx.beginPath();
        ctx.arc(x + 14, y + 23, 5, 0, Math.PI * 2); // tummy
        ctx.fill();
        break;
      case 'laundry': {
        // washing line with clothes hanging down to head height
        ctx.fillRect(x - 12, y, o.w + 24, 2);
        ctx.fillRect(x - 12, y - 4, 2, 6);
        ctx.fillRect(x + o.w + 10, y - 4, 2, 6);
        const sway = Math.sin(this.frame / 10) * 2;
        // shirt
        ctx.fillRect(x + 2, y + 2, 26, 8);
        ctx.fillRect(x + 6 + sway, y + 10, 18, 40);
        // towel
        ctx.fillRect(x + 34, y + 2, 16, 58 - 4);
        ctx.fillStyle = bg;
        ctx.fillRect(x + 34, y + 40, 16, 2);
        ctx.fillRect(x + 34, y + 45, 16, 2);
        // sock
        ctx.fillStyle = ink;
        ctx.fillRect(x + 56, y + 2, 7, 30);
        ctx.fillRect(x + 56 + sway, y + 30, 13, 7);
        // clothes pegs
        ctx.fillStyle = bg;
        for (const px of [8, 22, 40, 58]) ctx.fillRect(x + px, y - 1, 2, 5);
        break;
      }
      case 'plane': {
        // paper plane gliding left
        ctx.beginPath();
        ctx.moveTo(x, y + 9);
        ctx.lineTo(x + o.w, y);
        ctx.lineTo(x + o.w - 8, y + 10);
        ctx.lineTo(x + o.w, y + o.h);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.moveTo(x + 6, y + 9);
        ctx.lineTo(x + o.w - 8, y + 10);
        ctx.lineTo(x + o.w - 4, y + 14);
        ctx.fill();
        break;
      }
    }
  }

  /** Mom running behind the baby with her arms out and a bath towel. */
  private drawMom(ink: string, bg: string, faint: string): void {
    const ctx = this.ctx;
    const caughtBaby = this.state === 'over';
    // she bobs in from the left edge as she gets closer
    const x = Math.round(BABY_X - 46 - this.momGap);
    const g = GROUND_Y;
    const running = this.state === 'running';
    const step = running ? Math.floor(this.frame / 7) % 2 : 0;
    const bob = running ? step : 0;

    ctx.fillStyle = ink;
    // legs
    ctx.fillRect(x + (step ? 2 : 8), g - 18, 5, 18);
    ctx.fillRect(x + (step ? 12 : 6), g - 18, 5, 18);
    ctx.fillRect(x + (step ? 2 : 8), g - 3, 9, 3); // shoes
    ctx.fillRect(x + (step ? 12 : 6), g - 3, 9, 3);
    // skirt
    ctx.beginPath();
    ctx.moveTo(x + 3, g - 44 - bob);
    ctx.lineTo(x + 17, g - 44 - bob);
    ctx.lineTo(x + 24, g - 16);
    ctx.lineTo(x - 4, g - 16);
    ctx.closePath();
    ctx.fill();
    // torso
    ctx.fillRect(x + 3, g - 62 - bob, 14, 20);
    // head + hair bun
    ctx.beginPath();
    ctx.arc(x + 12, g - 70 - bob, 8, 0, Math.PI * 2);
    ctx.arc(x + 3, g - 76 - bob, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + 2, g - 74 - bob, 8, 10); // hair at the back
    // face
    ctx.fillStyle = bg;
    ctx.fillRect(x + 15, g - 73 - bob, 2, 2); // eye
    ctx.fillRect(x + 14, g - 66 - bob, 4, 1); // mouth

    // arms reaching forward (lower when she has caught the baby)
    ctx.fillStyle = ink;
    const armY = caughtBaby ? g - 46 : g - 58 - bob;
    ctx.fillRect(x + 14, armY, 26, 4);
    ctx.fillRect(x + 14, armY + 6, 22, 4);
    // towel over the arm
    ctx.fillStyle = faint;
    ctx.fillRect(x + 22, armY + 4, 12, 16);
    ctx.fillStyle = ink;
    ctx.fillRect(x + 22, armY + 15, 12, 1);

    // speech bubble
    if (this.momLineTimer > 0 || caughtBaby) {
      ctx.font = 'bold 12px "Courier New", monospace';
      const tw = ctx.measureText(this.momLine).width;
      const bx = Math.max(4, x - 4);
      const by = g - 112;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + 14, 20, 6);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + 8, by + 20);
      ctx.lineTo(x + 14, by + 20);
      ctx.lineTo(x + 10, by + 27);
      ctx.fill();
      ctx.fillStyle = bg;
      ctx.textAlign = 'left';
      ctx.fillText(this.momLine, bx + 7, by + 14);
    }
  }

  private drawBaby(ink: string, bg: string): void {
    const ctx = this.ctx;
    const p = this.player;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const step = this.state === 'running' && !p.jumping ? Math.floor(this.frame / 6) % 2 : 0;
    const caught = this.state === 'over';
    ctx.fillStyle = ink;

    if (p.ducking) {
      this.drawHairTufts(x + 40, y + 1);
      this.circle(x + 44, y + 11, 10);
      ctx.fillRect(x + 4, y + 8, 32, 12);
      ctx.fillRect(x + 1, y + 6, 10, 12);
      ctx.fillRect(x + 30, y + 18, 5, step ? 8 : 6);
      ctx.fillRect(x + 22, y + 18, 5, step ? 6 : 8);
      ctx.fillRect(x + 6, y + 18, 8, step ? 6 : 8);
      ctx.fillStyle = bg;
      this.drawFace(x + 45, y + 8, caught);
      ctx.fillRect(x + 2, y + 13, 9, 1);
      return;
    }

    this.drawHairTufts(x + 18, y);
    this.circle(x + 22, y + 11, 11);
    ctx.fillRect(x + 9, y + 9, 3, 5);
    ctx.fillRect(x + 13, y + 22, 18, 14);
    ctx.fillRect(x + 12, y + 30, 20, 6);
    ctx.fillRect(x + 31, y + (step ? 23 : 25), 6, 4);
    ctx.fillRect(x + 8, y + (step ? 26 : 24), 5, 4);
    ctx.fillRect(x + 14, y + 36, 6, step ? 8 : 6);
    ctx.fillRect(x + 24, y + 36, 6, step ? 6 : 8);
    ctx.fillRect(x + 14, y + (step ? 42 : 40), 8, 2);
    ctx.fillRect(x + 24, y + (step ? 40 : 42), 8, 2);

    ctx.fillStyle = bg;
    this.drawFace(x + 24, y + 8, caught);
    ctx.fillRect(x + 13, y + 30, 18, 1);
  }

  private drawHairTufts(cx: number, top: number): void {
    const ctx = this.ctx;
    ctx.fillRect(cx - 2, top - 4, 2, 5);
    ctx.fillRect(cx - 5, top - 7, 4, 2);
    ctx.fillRect(cx - 6, top - 6, 2, 2);
    ctx.fillRect(cx + 5, top - 5, 2, 6);
    ctx.fillRect(cx + 6, top - 8, 4, 2);
    ctx.fillRect(cx + 9, top - 7, 2, 2);
  }

  /** Happy face while escaping, pouty "O" face when caught. */
  private drawFace(ex: number, ey: number, caught: boolean): void {
    const ctx = this.ctx;
    ctx.fillRect(ex, ey, 2, 3);
    ctx.fillRect(ex + 6, ey, 2, 3);
    if (caught) {
      ctx.fillRect(ex + 3, ey + 6, 3, 3);
    } else {
      ctx.fillRect(ex + 2, ey + 6, 4, 1);
      ctx.fillRect(ex + 1, ey + 5, 1, 1);
      ctx.fillRect(ex + 6, ey + 5, 1, 1);
    }
  }

  private circle(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawHud(ink: string, faint: string): void {
    const ctx = this.ctx;
    const pad = (n: number) => String(n).padStart(5, '0');
    ctx.fillStyle = ink;
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`HI ${pad(this.hiScore)}  ${pad(this.score)}`, WIDTH - 16, 26);

    // escape meter: how far ahead of mom the baby is
    const meterW = 100;
    const mx = WIDTH - 16 - meterW;
    ctx.font = 'bold 11px "Courier New", monospace';
    ctx.fillText('LEAD', mx - 6, 45);
    ctx.fillStyle = faint;
    ctx.fillRect(mx, 36, meterW, 10);
    ctx.fillStyle = ink;
    ctx.fillRect(mx, 36, Math.max(0, (this.momGap / MOM_MAX_GAP) * meterW), 10);

    ctx.textAlign = 'center';
    if (this.state === 'ready') {
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText('PRESS SPACE OR TAP — ESCAPE BATH TIME!', WIDTH / 2, 80);
    } else if (this.state === 'over') {
      ctx.font = 'bold 22px "Courier New", monospace';
      ctx.fillText('C A U G H T !', WIDTH / 2, 70);
      ctx.font = 'bold 14px "Courier New", monospace';
      ctx.fillText('press space or tap to escape again', WIDTH / 2, 96);
    }
  }
}
