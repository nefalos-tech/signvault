import type { EventsPort, RunEvent } from '@signvault/shared';

const KEEP = 1000;

export class MemoryEvents implements EventsPort {
  private events: RunEvent[] = [];
  private listeners = new Set<(e: RunEvent) => void>();
  private nextId = 1;

  emit(e: Omit<RunEvent, 'id' | 'ts'>): RunEvent {
    const event: RunEvent = { ...e, id: String(this.nextId++), ts: Date.now() };
    this.events.push(event);
    if (this.events.length > KEEP) this.events.splice(0, this.events.length - KEEP);
    for (const fn of this.listeners) fn(event);
    return event;
  }

  recent(n: number): RunEvent[] {
    return n > 0 ? this.events.slice(-n) : [];
  }

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
