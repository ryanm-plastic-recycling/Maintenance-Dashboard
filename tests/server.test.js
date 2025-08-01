import request from 'supertest';
import { jest } from '@jest/globals';
import app from '../server.js';

const dummyOverall = {
  uptimePct: 99,
  downtimeHrs: 1,
  mttrHrs: 2,
  mtbfHrs: 3,
  plannedCount: 4,
  unplannedCount: 5
};

const dummyByAsset = {
  assets: { 1: { name: 'Asset1' } },
  totals: { foo: 'bar' }
};

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

  test('GET /api/kpis returns cached values', async () => {
    const spy = jest.spyOn(app, 'fetchAndCache').mockImplementation(async (key) => {
      if (key === 'kpis_overall') return dummyOverall;
      if (key === 'kpis_byAsset') return dummyByAsset;
    });

    const res = await request(app).get('/api/kpis');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ overall: dummyOverall, byAsset: dummyByAsset });

    spy.mockRestore();
  });

  test('GET /api/kpis-by-asset returns cached values', async () => {
    const spy = jest.spyOn(app, 'fetchAndCache').mockImplementation(async (key) => {
      if (key === 'kpis_byAsset') return dummyByAsset;
    });

    const res = await request(app).get('/api/kpis-by-asset');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dummyByAsset);

    spy.mockRestore();
  });
});
