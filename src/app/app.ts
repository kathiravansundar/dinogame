import { Component, signal } from '@angular/core';
import { CarGame } from './car-game/car-game';
import { EscapeGame } from './escape-game/escape-game';
import { FlightGame } from './flight-game/flight-game';
import { RunnerGame } from './runner-game/runner-game';
import { SliceGame } from './slice-game/slice-game';
import { SpaceGame } from './space-game/space-game';

type GameId = 'runner' | 'escape' | 'car' | 'flight' | 'slice' | 'space';

const GAME_KEY = 'selected-game';

@Component({
  imports: [RunnerGame, EscapeGame, CarGame, FlightGame, SliceGame, SpaceGame],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
  host: {
    '(window:online)': 'online.set(true)',
    '(window:offline)': 'online.set(false)',
  },
})
export class App {
  protected readonly games: { id: GameId; label: string }[] = [
    { id: 'runner', label: '🦖 Dino Runner' },
    { id: 'escape', label: '👶 Baby Escape' },
    { id: 'car', label: '🚗 Road Racer' },
    { id: 'flight', label: '✈️ Sky Patrol' },
    { id: 'slice', label: '🥷 Blade Dojo' },
    { id: 'space', label: '🚀 Space Defender' },
  ];

  /** Tracks the browser's network status. */
  protected readonly online = signal(navigator.onLine);
  /** Lets the user play even while connected (handy for testing). */
  protected readonly playAnyway = signal(false);
  protected readonly selected = signal<GameId>(this.loadSelected());

  protected select(id: GameId, button: HTMLElement): void {
    this.selected.set(id);
    // Drop focus so Space goes to the game instead of re-clicking the menu button.
    button.blur();
    try {
      localStorage.setItem(GAME_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }

  private loadSelected(): GameId {
    try {
      const saved = localStorage.getItem(GAME_KEY);
      return this.games.some((g) => g.id === saved) ? (saved as GameId) : 'runner';
    } catch {
      return 'runner';
    }
  }
}
