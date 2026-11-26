import type { ReactNode } from 'react';

const SHAPES = {
  shield: <><path d="M12 3 L19 6 L19 11.5 Q19 17 12 21 Q5 17 5 11.5 L5 6 Z" /><path d="M9 12 L11.2 14.2 L15.2 10" /></>,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M16 12.5 L18 12.5" /><path d="M5 6 L15 3.5 L16 6" /></>,
  inbox: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5 L12 13 L20.5 6.5" /></>,
  agent: <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8 L12 5" /><circle cx="12" cy="4" r="1" /><path d="M9.5 13 L9.5 13.5 M14.5 13 L14.5 13.5" /></>,
  contract: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11 L8 8 Q8 4 12 4 Q16 4 16 8 L16 11" /></>,
  vendors: <><path d="M4 9 L5.5 4.5 L18.5 4.5 L20 9" /><path d="M4 9 L20 9" /><path d="M5.5 9 L5.5 19.5 L18.5 19.5 L18.5 9" /><path d="M10 19.5 L10 15 L14 15 L14 19.5" /></>,
  xCircle: <><circle cx="12" cy="12" r="9" /><path d="M9 9 L15 15 M15 9 L9 15" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7 L12 12 L15 14" /></>,
  ok: <path d="M5 12.5 L10 17 L19 7" />,
  no: <path d="M6 6 L18 18 M18 6 L6 18" />,
  warn: <path d="M12 6 L12 13 M12 17.5 L12 17.6" />,
  mail: <path d="M4 7 L12 13 L20 7" />,
  wait: <path d="M12 6 L12 12 L16 14" />,
  up: <path d="M12 19 L12 5 M6 11 L12 5 L18 11" />,
  run: <path d="M8 6 L17 12 L8 18 Z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof SHAPES;

export function Icon({ name, size = 20, strokeWidth = 1.75, className }: { name: IconName; size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {SHAPES[name]}
    </svg>
  );
}
