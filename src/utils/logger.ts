/**
 * Minimal JSON logger writing to stdout (12-factor). Callers must never pass OTPs, tokens or secrets.
 */
type Meta = Record<string, unknown>;
const emit = (level: string, msg: string, meta?: Meta) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }) + '\n');

export const log = {
  info: (msg: string, meta?: Meta) => emit('info', msg, meta),
  warn: (msg: string, meta?: Meta) => emit('warn', msg, meta),
  error: (msg: string, meta?: Meta) => emit('error', msg, meta),
};
