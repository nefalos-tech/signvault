import { describe, expect, it } from 'vitest';
import type { EventsPort, InboxPort } from '@signvault/shared';
import { COMPANY_INBOX, MemoryInbox } from '../src/inbox';
import { MemoryEvents } from '../src/events';

describe('MemoryInbox', () => {
  it('delivers emails with an id and a time, and lists them in arrival order', () => {
    const inbox: InboxPort = new MemoryInbox();
    const a = inbox.deliver({ from: 'billing@vendor1.test', to: COMPANY_INBOX, subject: 'Invoice 1', body: 'one' });
    const b = inbox.deliver({ from: 'billing@vendor2.test', to: COMPANY_INBOX, subject: 'Invoice 2', body: 'two' });

    expect(a.id).not.toBe(b.id);
    expect(typeof a.ts).toBe('number');
    expect(inbox.list().map((e) => e.subject)).toEqual(['Invoice 1', 'Invoice 2']);
    expect(inbox.get(b.id)).toEqual(b);
    expect(inbox.get('nope')).toBeUndefined();
  });

  it('does not let a caller change the inbox through the list it returns', () => {
    const inbox = new MemoryInbox();
    inbox.deliver({ from: 'a@x.test', to: COMPANY_INBOX, subject: 's', body: 'b' });
    inbox.list().pop();
    expect(inbox.list()).toHaveLength(1);
  });

  it('clears every email', () => {
    const inbox = new MemoryInbox();
    inbox.deliver({ from: 'a@x.test', to: COMPANY_INBOX, subject: 's', body: 'b' });
    inbox.clear();
    expect(inbox.list()).toEqual([]);
  });
});

describe('MemoryEvents', () => {
  const event = (text: string) => ({ runId: 'run-1', wallet: 'baseline' as const, kind: 'model_text' as const, text });

  it('gives each event an increasing id and a time', () => {
    const events: EventsPort = new MemoryEvents();
    const a = events.emit(event('a'));
    const b = events.emit(event('b'));
    expect(Number(b.id)).toBeGreaterThan(Number(a.id));
    expect(typeof a.ts).toBe('number');
    expect(a.text).toBe('a');
  });

  it('returns the last n events, oldest first', () => {
    const events = new MemoryEvents();
    for (let i = 1; i <= 5; i++) events.emit(event(`e${i}`));
    expect(events.recent(3).map((e) => e.text)).toEqual(['e3', 'e4', 'e5']);
    expect(events.recent(10)).toHaveLength(5);
    expect(events.recent(0)).toEqual([]);
  });

  it('keeps at least 200 events', () => {
    const events = new MemoryEvents();
    for (let i = 1; i <= 250; i++) events.emit(event(`e${i}`));
    const last = events.recent(200);
    expect(last).toHaveLength(200);
    expect(last[0].text).toBe('e51');
  });

  it('tells subscribers about new events until they unsubscribe', () => {
    const events = new MemoryEvents();
    const seen: string[] = [];
    const unsubscribe = events.subscribe((e) => seen.push(e.text));
    events.emit(event('a'));
    unsubscribe();
    events.emit(event('b'));
    expect(seen).toEqual(['a']);
  });
});
