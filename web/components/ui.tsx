import type { ComponentProps, ReactNode } from 'react';
import type { Hex } from '@signvault/shared';
import { shortAddress } from '@/lib/approve';
import { txUrl } from '@/lib/format';
import type { Badge as BadgeData, Step, StepKind } from '@/lib/story';

/** The board's building blocks, shaped like shadcn's card, badge and button, in plain Tailwind. */

/** The flat, full-colour icons in public/icons. */
export type IconName =
  | 'logo' | 'coins' | 'money' | 'gmail' | 'qwen' | 'gauge' | 'store' | 'phone'
  | 'lock' | 'mail-alert' | 'lock-shield' | 'shield-check';

/** Height over width, for the icons that are not square. */
const ASPECT: Partial<Record<IconName, number>> = { gmail: 66 / 88 };

export function Icon({ name, size, className = '' }: { name: IconName; size: number; className?: string }) {
  return <img src={`/icons/${name}.svg`} width={size} height={Math.round(size * (ASPECT[name] ?? 1))} alt="" aria-hidden="true" className={`flex-none ${className}`} />;
}

/** The small stroked clock on the "Waiting" and "Awaiting signature" pills. */
export function ClockGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

export function Card({ className = '', ...props }: ComponentProps<'section'>) {
  return <section className={`flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-card ${className}`} {...props} />;
}

/** The 40px tile beside a card's title. The logo fills it with no frame. */
export function CardIcon({ name }: { name: IconName }) {
  if (name === 'logo') return <Icon name="logo" size={40} />;
  return (
    <span className="flex size-10 flex-none items-center justify-center rounded-xl border border-border bg-card">
      <Icon name={name} size={22} />
    </span>
  );
}

export function CardTitle({ size = 'md', ...props }: { size?: 'lg' | 'md' } & ComponentProps<'h2'>) {
  const text = size === 'lg' ? 'text-2xl leading-[1.15] tracking-[-0.015em]' : 'text-xl leading-[1.2] tracking-[-0.01em]';
  return <h2 className={`font-display font-[650] ${text}`} {...props} />;
}

export function CardDescription({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-[1.45] text-balance text-muted-foreground">{children}</p>;
}

/** A panel's header: icon tile, title and one line of description. */
export function PanelHead({ icon, id, title, description }: { icon: IconName; id: string; title: string; description: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3.5">
      <CardIcon name={icon} />
      <div className="flex min-w-0 flex-col gap-1">
        <CardTitle id={id}>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </div>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="font-display text-[17px] font-[650]">{children}</h3>;
}

const BADGE: Record<BadgeData['tone'], string> = {
  breach: 'border-destructive-border bg-destructive-soft text-destructive-text',
  held: 'border-primary-border bg-primary-soft text-primary-text',
  neutral: 'border-border bg-muted text-secondary-foreground',
};

export function Badge({ tone, children }: { tone: BadgeData['tone']; children: ReactNode }) {
  return <span className={`inline-flex flex-none items-center rounded-lg border px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap ${BADGE[tone]}`}>{children}</span>;
}

const BUTTON = {
  default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary-hover',
  outline: 'border-input bg-card text-foreground hover:border-primary-border hover:bg-primary-tint',
};
const BUTTON_SIZE = { md: 'min-h-11 px-5 text-sm', sm: 'min-h-10 px-4 text-[13px]' };

export function buttonClass(variant: keyof typeof BUTTON = 'default', size: keyof typeof BUTTON_SIZE = 'md') {
  return `inline-flex cursor-pointer items-center justify-center rounded-full border font-semibold transition-[background-color,border-color,translate] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-50 ${BUTTON[variant]} ${BUTTON_SIZE[size]}`;
}

/** A button that reads as a link: "Show every event". */
export const linkButtonClass = 'cursor-pointer self-start text-sm font-semibold text-primary-text underline-offset-[3px] hover:text-primary-deep hover:underline';

const linkClass = 'text-primary-text underline-offset-[3px] hover:text-primary-deep hover:underline';

/** A link on a chain with an explorer. Anvil has none, so there it is the plain hash or address. */
export function ExplorerLink({ href, text, fallback, className = '' }: { href: string | undefined; text: string; fallback: string; className?: string }) {
  if (!href) return <span className={`font-mono whitespace-nowrap text-subtle-foreground ${className}`}>{fallback}</span>;
  return <a className={`whitespace-nowrap ${linkClass} ${className}`} href={href} target="_blank" rel="noreferrer">{text}</a>;
}

export function TxLink({ txHash, explorerUrl, text = 'Transaction', className }: { txHash: Hex; explorerUrl: string | undefined; text?: string; className?: string }) {
  return <ExplorerLink href={explorerUrl && txUrl(explorerUrl, txHash)} text={text} fallback={shortAddress(txHash)} className={className} />;
}

/** "18:42:07" in the viewer's time zone. */
export function clock(ts: number) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

const ROW: Record<StepKind, { row: string; time: string; text: string }> = {
  ok: { row: '', time: 'text-subtle-foreground', text: '' },
  no: { row: '', time: 'text-subtle-foreground', text: '' },
  info: { row: '', time: 'text-subtle-foreground', text: '' },
  breach: { row: 'bg-destructive-tint', time: 'text-destructive-text', text: 'font-medium text-destructive-deep' },
  held: { row: 'bg-primary-tint', time: 'text-primary-text', text: 'font-medium text-primary-deep' },
  wait: { row: 'outline-1 -outline-offset-1 outline-pending outline-dashed', time: 'text-primary-text', text: 'font-medium' },
};
/** On a refusal the detail is the Solidity error name. */
const ERROR_NAME: Partial<Record<StepKind, true>> = { no: true, held: true };

/** "What happened": one row per step, with its time, its words and its transaction. */
export function StepList({ steps, explorerUrl }: { steps: Step[]; explorerUrl: string | undefined }) {
  return (
    <ol className="flex flex-col gap-0.5">
      {steps.map((step, i) => {
        const t = ROW[step.kind];
        return (
          <li
            key={i}
            data-kind={step.kind}
            className={`grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-xl px-3 py-[9px] min-[560px]:grid-cols-[64px_minmax(0,1fr)_auto] ${t.row}`}
          >
            <span className={`col-span-full text-[13px] tabular-nums min-[560px]:col-span-1 ${t.time}`}>{step.ts !== undefined ? clock(step.ts) : ''}</span>
            <span className={`text-[15px] leading-[1.45] ${t.text}`}>
              {step.title}
              {step.detail && (
                <span className={`ml-2 text-[13px] ${ERROR_NAME[step.kind] ? 'font-mono font-medium text-destructive-text' : 'font-normal text-subtle-foreground'}`}>{step.detail}</span>
              )}
            </span>
            {step.txHash ? <TxLink txHash={step.txHash} explorerUrl={explorerUrl} className="text-sm font-medium" />
              : step.kind === 'wait' ? <a className={`text-sm font-medium ${linkClass}`} href="/approve">Approve</a>
              : <span />}
          </li>
        );
      })}
    </ol>
  );
}
