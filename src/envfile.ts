/**
 * Hilfen zum sicheren Ändern einzelner Werte in der .env-Datei, ohne
 * Kommentare und Reihenfolge der übrigen Einstellungen zu zerstören.
 */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wert so formatieren, dass dotenv ihn exakt wieder einliest. */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Wert darf keinen Zeilenumbruch enthalten');
  if (value === '' || /^[^\s#"'`]+$/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error('Wert enthält sowohl " als auch \' und kann nicht gespeichert werden');
}

/**
 * Setzt Werte in einer .env-Datei.
 * - `string`: aktive Zeile ersetzen; sonst auskommentierte Vorlage-Zeile aktivieren; sonst anhängen.
 * - `null`: aktive Zeile auskommentieren (Wert wird deaktiviert).
 */
export function setEnvValues(content: string, values: Record<string, string | null>): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const [key, value] of Object.entries(values)) {
    const active = new RegExp(`^\\s*(?:export\\s+)?${escapeRe(key)}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*${escapeRe(key)}\\s*=`);
    const activeIdx = lines.findIndex((l) => active.test(l));

    if (value === null) {
      if (activeIdx >= 0) lines[activeIdx] = `# ${lines[activeIdx]!.trim()}`;
      continue;
    }
    const line = `${key}=${formatEnvValue(value)}`;
    if (activeIdx >= 0) {
      lines[activeIdx] = line;
      // Doppelte aktive Einträge entfernen (der erste gilt sonst nicht eindeutig).
      for (let i = lines.length - 1; i > activeIdx; i--) if (active.test(lines[i]!)) lines.splice(i, 1);
      continue;
    }
    const commentedIdx = lines.findIndex((l) => commented.test(l));
    if (commentedIdx >= 0) lines[commentedIdx] = line;
    else lines.push(line);
  }
  return lines.join(eol) + eol;
}
