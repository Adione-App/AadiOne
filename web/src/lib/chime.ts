/**
 * The panel's notification sound — the short 880 Hz beep the Orders page has
 * always used, shared so a new order sounds the same everywhere.
 *
 * Browsers block audio until the page has had a user gesture: then the beep
 * simply does not play (no error) and the visual alert does the job.
 */

let context: AudioContext | null = null;

export function playChime(): void {
  try {
    context ??= new AudioContext();
    // A context created before any gesture starts suspended; resume when allowed.
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.25);
  } catch {
    // Audio unavailable or blocked — the popup still shows.
  }
}
