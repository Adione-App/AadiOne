/**
 * Development timing: how long each stage of a request took. Logged at
 * DEBUG level only (LOG_LEVEL=debug) — never on in production by default,
 * never part of a response.
 */

export interface StageTimer {
  /** Records the time since the previous mark (or the start) under `stage`. */
  mark(stage: string): void;
  /** The stages so far plus the total, in milliseconds (0.1 ms precision). */
  summary(): Record<string, number>;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export function stageTimer(): StageTimer {
  const start = performance.now();
  let last = start;
  const stages: Record<string, number> = {};
  return {
    mark(stage) {
      const now = performance.now();
      stages[stage] = round(now - last);
      last = now;
    },
    summary() {
      return { ...stages, totalMs: round(performance.now() - start) };
    },
  };
}
