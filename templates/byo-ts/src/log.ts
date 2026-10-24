/** One JSON line per event on stdout. Never pass config, env, or request bodies here. */
export function log(event: string, fields: Record<string, string | number> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}
