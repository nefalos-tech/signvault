import { useCallback, useEffect, useState } from 'react';
import type { AppState, RunEvent } from '@signvault/shared';
import baselineRun from '../fixtures/baseline-run.json';
import signvaultRun from '../fixtures/signvault-run.json';
import { replayLength, visibleEvents } from './player';

export const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

const FIXTURES = [baselineRun as RunEvent[], signvaultRun as RunEvent[]];
const REPLAY_MS = replayLength(FIXTURES);
const TICK_MS = 250;
const POLL_MS = 2000;

export interface RunEvents {
  events: RunEvent[];
  /** Mock: play the recorded runs again from the start. Live: nothing, the server starts runs. */
  replay: () => void;
  /** Hide every event so far. Used by Reset. */
  clear: () => void;
}

/** Mock mode plays the fixtures side by side. Otherwise it reads the SSE stream at /api/events. */
export function useRunEvents(): RunEvents {
  return MOCK ? useFixtureReplay() : useEventStream();
}

function useFixtureReplay(): RunEvents {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => setStartedAt(Date.now()), []);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(() => {
      tick();
      if (Date.now() - startedAt > REPLAY_MS) clearInterval(timer);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);

  const events = startedAt === null ? [] : visibleEvents(FIXTURES, now - startedAt);
  const replay = useCallback(() => setStartedAt(Date.now()), []);
  const clear = useCallback(() => setStartedAt(null), []);
  return { events, replay, clear };
}

function useEventStream(): RunEvents {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [clearedAt, setClearedAt] = useState(0);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as RunEvent;
      // The server replays the last 200 on every (re)connect, so drop the ones we already hold.
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
    };
    return () => source.close();
  }, []);

  const replay = useCallback(() => {}, []);
  const clear = useCallback(() => setClearedAt(Date.now()), []);
  return { events: events.filter((e) => e.ts >= clearedAt), replay, clear };
}

export type Remote<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'error'; message: string; last?: T };

/** Polls /api/state every 2 seconds. Keeps the last good state when a poll fails. */
export function useAppState(): Remote<AppState> & { refresh: () => void } {
  const [state, setState] = useState<Remote<AppState>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (MOCK) return;
    let alive = true;
    const poll = () =>
      getJson<AppState>('/api/state')
        .then((value) => alive && setState({ kind: 'ready', value }))
        .catch((err) => alive && setState((prev) => ({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          last: prev.kind === 'ready' ? prev.value : prev.kind === 'error' ? prev.last : undefined,
        })));
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tick]);

  return { ...state, refresh };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
}
