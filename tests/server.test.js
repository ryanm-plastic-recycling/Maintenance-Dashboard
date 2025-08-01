import request from 'supertest';
import { jest } from '@jest/globals';
import * as serverModule from '../server.js';
import app from '../server.js';

// 1️⃣ Mock fetchAndCache so no real HTTP or cache is used
jest.spyOn(serverModule, 'fetchAndCache').mockImplementation((key) => {
  if (key === 'kpis_overall') {
    return Promise.resolve({
      uptimePct: 98,
      downtimeHrs: 2,
      mttrHrs: 1,
      mtbfHrs: 100,
      plannedCount: 5,
      unplannedCount: 1
    });
  }
  if (key === 'kpis_byAsset') {
    return Promise.resolve({ 2399: { uptimePct: 97, downtimeHrs: 3 } });
  }
  if (key === 'status') {
    return Promise.resolve([
      { assetID: 2399, status: 'Available for Production' }
    ]);
  }
  return Promise.resolve(null);
});

describe('API routes', () => {
  test('GET / responds with html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!DOCTYPE html>');
  });

  test('GET /pm responds with html', async () => {
    const res = await request(app).get('/pm');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!DOCTYPE html>');
  });

  test('GET /admin responds with html', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!DOCTYPE html>');
  });

  test('GET /api/config returns json', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('Cached API routes', () => {
  test('GET /api/kpis returns overall and byAsset', async () => {
    const res = await request(app).get('/api/kpis');
    expect(res.status).toBe(200);
    expect(res.body.overall.uptimePct).toBe(98);
    expect(res.body.byAsset[2399].downtimeHrs).toBe(3);
  });

  test('GET /api/status returns asset status array', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ assetID: 2399, status: 'Available for Production' }]);
  });
});
