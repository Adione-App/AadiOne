/**
 * A detail page's "← Back" link.
 *
 * Opened from a list (or another page in `from`): it goes BACK in history —
 * the browser's own Back — so that list comes back with its filters, search,
 * page, "Show more" pages and scroll position (lib/scrollMemory.ts).
 * Opened any other way (a bookmark, a new tab, a notification): it opens `to`.
 */

import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useHistoryBackTarget } from '@/lib/scrollMemory';
import type { BackTarget } from '@/lib/scrollMemoryCore';

const linkClass = 'inline-flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900';

export function BackLink({ to, label, from = [] }: { to: string; label: string; from?: readonly BackTarget[] }) {
  const navigate = useNavigate();
  const fallbackPath = to.split(/[?#]/)[0]!;
  const target = useHistoryBackTarget([{ path: fallbackPath, label }, ...from]);

  if (target) {
    const back = (event: MouseEvent<HTMLAnchorElement>) => {
      // A new tab / window keeps its usual meaning.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(-1);
    };
    return (
      <a href={target.href} onClick={back} className={linkClass}>
        <span aria-hidden="true">←</span> {target.label}
      </a>
    );
  }
  return (
    <Link to={to} className={linkClass}>
      <span aria-hidden="true">←</span> {label}
    </Link>
  );
}
