import fs from 'node:fs';
import path from 'node:path';

let logFile: string | undefined;

export function setLogDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'bot.log');
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      // Logging darf den Bot nie zum Absturz bringen.
    }
  }
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
  trade: (msg: string) => write('TRADE', msg),
  debug: (msg: string) => {
    if (process.env.DEBUG === 'true') write('DEBUG', msg);
  },
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
