import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverHostname = os.hostname();

let appVersion = 'unknown';
try {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  appVersion = pkg.version || process.env.APP_VERSION || 'unknown';
} catch {
  appVersion = process.env.APP_VERSION || 'unknown';
}

const resolveTelemetryPath = () => {
  const rawPath = process.env.TELEMETRY_PATH || 'logs/telemetry.jsonl';
  return path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath);
};

export function appendTelemetry(eventObject = {}) {
  try {
    if (process.env.TELEMETRY_ENABLED === 'false') return;

    const payload = {
      ...eventObject,
      ts: eventObject.ts || new Date().toISOString(),
      appVersion,
      serverHostname
    };

    const filePath = resolveTelemetryPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    fs.appendFile(filePath, JSON.stringify(payload) + '\n', 'utf8', (err) => {
      if (err) console.warn('Telemetry append failed:', err);
    });
  } catch (err) {
    console.warn('Telemetry logging error:', err);
  }
}
