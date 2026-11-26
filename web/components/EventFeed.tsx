'use client';

import { useEffect, useRef } from 'react';
import type { RunEvent, RunEventKind } from '@signvault/shared';
import { txUrl } from '@/lib/format';

const KIND_STYLE: Record<RunEventKind, string> = {
  run_started: 'font-semibold text-neutral-900',
  model_text: 'italic text-neutral-700',
  tool_call: 'text-neutral-900',
  tool_result: 'text-neutral-500',
  email_delivered: 'text-sky-800',
  tx_sent: 'text-green-700',
  tx_refused: 'font-semibold text-destructive-text',
  run_finished: 'font-semibold text-neutral-900',
};

const KIND_LABEL: Record<RunEventKind, string> = {
  run_started: 'start',
  model_text: 'agent',
  tool_call: 'tool',
  tool_result: 'result',
  email_delivered: 'email',
  tx_sent: 'tx',
  tx_refused: 'refused',
  run_finished: 'end',
};

/** The live feed of one wallet's RunEvent lines. Anything with an error is a refusal: red, with its name. */
export function EventFeed({ events, explorerUrl }: { events: RunEvent[]; explorerUrl: string | undefined }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // Scroll the feed, not the page, so a reader lower down is not pulled back up.
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [events.length]);

  if (events.length === 0) {
    return <p className="px-4 py-4 text-sm text-subtle-foreground">No events yet.</p>;
  }
  return (
    <ol ref={list} className="flex max-h-[28rem] flex-col gap-1 overflow-y-auto px-3 py-3 text-sm">
      {events.map((e) => (
        <li
          key={e.id}
          data-kind={e.kind}
          data-error={e.error}
          className={`flex gap-2 rounded px-2 py-1 ${e.error ? 'bg-destructive-tint text-destructive-deep' : KIND_STYLE[e.kind]}`}
        >
          <span className="w-14 shrink-0 font-mono text-xs uppercase leading-5 text-neutral-400">{KIND_LABEL[e.kind]}</span>
          <span className="min-w-0 flex-1 break-words">
            {e.error && (
              <span className="mr-2 rounded bg-destructive px-1.5 py-0.5 font-mono text-xs font-semibold text-white">
                {e.error}
              </span>
            )}
            {e.text}
            {e.txHash && e.kind !== 'tool_result' && explorerUrl && (
              <>
                {' '}
                <a className="whitespace-nowrap underline" href={txUrl(explorerUrl, e.txHash)} target="_blank" rel="noreferrer">
                  view tx
                </a>
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
