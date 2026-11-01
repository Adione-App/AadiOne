/**
 * Payment-launch diagnostics for the INTERNAL diagnostic build only
 * (`eas build --profile diagnostic-apk`, which sets
 * EXPO_PUBLIC_PAYMENT_DIAGNOSTICS=1). Store / production builds: off — nothing
 * is recorded or shown, and Cashfree's SDK event stream is not subscribed.
 *
 * Keeps the last launch-stage lines in memory so they can be read on the
 * phone itself (PaymentDiagnosticsPanel, under the Cart) and copied — no adb
 * needed. Never secrets: session ids arrive here already masked, and any long
 * value from Cashfree's own events is shortened.
 */

import { create } from "zustand";

export const PAYMENT_DIAGNOSTICS = process.env["EXPO_PUBLIC_PAYMENT_DIAGNOSTICS"] === "1";

const MAX_LINES = 60;

export interface DiagnosticLine {
  at: string;
  event: string;
  data: string;
}

export const usePaymentDiagnostics = create<{ lines: DiagnosticLine[] }>(() => ({ lines: [] }));

/** Shortens values that could be tokens (anything long); keeps codes, statuses and short ids readable. */
export function sanitizeDiagnostic(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/secret|token|key|password|authorization/i.test(key)) {
      out[key] = "[hidden]";
    } else if (typeof value === "string" && (/session/i.test(key) ? !/…\(\d+\)$/.test(value) : value.length > 64)) {
      out[key] = `${value.slice(0, 10)}…(${value.length})`;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeDiagnostic(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function recordDiagnostic(event: string, data: Record<string, unknown>): void {
  if (!PAYMENT_DIAGNOSTICS) return;
  const line: DiagnosticLine = { at: new Date().toISOString(), event, data: JSON.stringify(sanitizeDiagnostic(data)) };
  usePaymentDiagnostics.setState((s) => ({ lines: [...s.lines, line].slice(-MAX_LINES) }));
}

export function clearDiagnostics(): void {
  usePaymentDiagnostics.setState({ lines: [] });
}
