import express from 'express';
import crypto from 'crypto';
import sql from 'mssql';
import { exec } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);

function verifySignature(req, apiKey) {
  const ts   = req.get('timestamp') || '';
  const sig  = (req.get('signature') || '').toLowerCase();
  const token= req.get('token') || '';
  // Step 1: hash the API key (sha256 hex)
  const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');
  // Step 2: HMAC(timestamp + token, hashedKey) sha256 hex
  const calc = crypto.createHmac('sha256', hashedKey).update(ts + token).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(calc,'hex'), Buffer.from(sig,'hex'));
}

export default function limbleWebhook(poolPromise) {
  const r = express.Router();

  r.post('/limble/webhook', express.json({ limit:'1mb' }), async (req, res) => {
    // const pool = await poolPromise; // uncomment if you query SQL here
    try {
      const apiKey = process.env.LIMBLE_API_KEY;
      if (!apiKey) return res.status(406).json({ ok:false, error:'no api key' });
      if (!verifySignature(req, apiKey)) return res.status(406).json({ ok:false, error:'bad signature' });

      const { category, status, taskID, assetID, valueID } = req.body || {};
      // Fast ACK so Limble stops retrying
      res.status(200).json({ ok:true });

      // Fire-and-forget: fetch details + upsert via PowerShell path you already have
      // (you can also call the SQL procs directly from Node if you prefer)
      try {
        if (category === 'task' && taskID) {
          // minimal pull for a single task
          const base = (process.env.API_BASE_URL || 'https://api.limblecmms.com:443').replace(/\/+$/,'');
          const taskUrl = `${base}/v2/tasks/${taskID}`;
          // Call your PS script with an override env var telling it to pull just this task
          await execAsync(`powershell.exe -ExecutionPolicy Bypass -Command "$env:TASK_SINGLE='${taskUrl}'; & 'C:\\Scripts\\limble-pull.ps1'"`);
        } else if (category === 'asset' && assetID) {
          const base = (process.env.API_BASE_URL || 'https://api.limblecmms.com:443').replace(/\/+$/,'');
          const assetUrl = `${base}/v2/assets/${assetID}`;
          await execAsync(`powershell.exe -ExecutionPolicy Bypass -Command "$env:ASSET_SINGLE='${assetUrl}'; & 'C:\\Scripts\\limble-pull.ps1'"`);
        } else if (category === 'assetField' && valueID) {
          // For fields, you might need to fetch by asset or use a fields endpoint you prefer
          // As a simple path, trigger a fields refresh for the asset pages:
          await execAsync(`powershell.exe -ExecutionPolicy Bypass -File "C:\\Scripts\\limble-pull.ps1"`);
        }
      } catch (e) {
        console.warn('[webhook worker] failed:', e.message);
      }
    } catch (e) {
      // If anything fails before ACK, return 406 so Limble won’t keep retrying forever
      try { res.status(406).json({ ok:false }); } catch {}
    }
  });

  return r;
}
