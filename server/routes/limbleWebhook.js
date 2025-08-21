// server/routes/limbleWebhook.js
import express from 'express';
import crypto  from 'crypto';
import { exec } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);

function verifyWithClientSecret(req, clientSecret) {
  const ts    = req.get('timestamp') || '';
  const token = req.get('token') || '';
  const sig   = (req.get('signature') || '').toLowerCase();

  // hash the secret (sha256), then HMAC(timestamp+token) with that hash
  const keyHashed = crypto.createHash('sha256').update(clientSecret).digest('hex');
  const calc      = crypto.createHmac('sha256', keyHashed).update(ts + token).digest('hex');

  // constant-time compare
  return (
    sig.length === calc.length &&
    crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(sig, 'hex'))
  );
}

export default function limbleWebhook(poolPromise) {
  const r = express.Router();

  r.post('/limble/webhook', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const clientSecret = process.env.CLIENT_SECRET;
      if (!clientSecret) return res.status(406).json({ ok: false, error: 'no client secret' });
      if (!verifyWithClientSecret(req, clientSecret)) return res.status(406).json({ ok: false, error: 'bad signature' });

      const { category, taskID, assetID, valueID } = req.body || {};

      // ACK fast (so Limble won’t retry)
      res.status(200).json({ ok: true });

      // Fire-and-forget: pull the specific object and upsert
      try {
        const base = (process.env.API_BASE_URL || 'https://api.limblecmms.com:443').replace(/\/+$/,'');
        if (category === 'task' && taskID) {
          const taskUrl = `${base}/v2/tasks/${taskID}`;
          await execAsync(`powershell.exe -ExecutionPolicy Bypass -Command "$env:TASK_SINGLE='${taskUrl}'; & 'C:\\Scripts\\limble-pull.ps1'"`);
        } else if (category === 'asset' && assetID) {
          const assetUrl = `${base}/v2/assets/${assetID}`;
          await execAsync(`powershell.exe -ExecutionPolicy Bypass -Command "$env:ASSET_SINGLE='${assetUrl}'; & 'C:\\Scripts\\limble-pull.ps1'"`);
        } else if (category === 'assetField' && valueID) {
          // simplest: refresh fields (script already upserts all fields)
          await execAsync(`powershell.exe -ExecutionPolicy Bypass -File "C:\\Scripts\\limble-pull.ps1"`);
        }
      } catch (e) {
        console.warn('[webhook worker] failed:', e.message);
      }
    } catch {
      try { res.status(406).json({ ok: false }); } catch {}
    }
  });

  return r;
}
