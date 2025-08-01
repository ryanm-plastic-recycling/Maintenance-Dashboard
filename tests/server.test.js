// tests/server.test.js
import * as serverModule from '../server.js';
import app from '../server.js';
import request from 'supertest';
import { jest } from '@jest/globals';

const dummyOverall = {
  uptimePct: 98,
  downtimeHrs: 2,
  mttrHrs: 1,
  mtbfHrs: 100,
  plannedCount: 5,
  unplannedCount: 1
};

const dummyByAsset = {
  assets: {
    '2399': {
      name: 'Asset1',
      uptimePct: 97,
      downtimeHrs: 3,
      mttrHrs: 2,
      mtbfHrs: 50,
      plannedCount: 4,
      unplannedCount: 2
    }
  },
  totals: {
    uptimePct: 97,
    downtimeHrs: 3,
    mttrHrs: 2,
    mtbfHrs: 50,
    plannedCount: 4,
    unplannedCount: 2
  }
};

const dummyStatus = [
  { assetID: 2399, status: 'Available for Production' }
];

beforeAll(() => {
  // Mock fetchAndCache for all routes
  jest.spyOn(serverModule, 'fetchAndCache').mockImplementation(async (key) => {
    if (key === 'kpis_overall') return dummyOverall;
    if (key === 'kpis_byAsset') return dummyByAsset;
    if (key === 'status')       return dummyStatus;
    return null;
  });
});

afterAll(() => {
  serverModule.fetchAndCache.mockRestore();
});

describe('Static HTML routes', () => {
  ['/', '/pm', '/admin'].forEach(route => {
    test(`GET ${route} responds with HTML`, async () => {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<!DOCTYPE html>');
    });
  });
});

describe('Configuration API', () => {
  test('GET /api/config returns JSON', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('KPI endpoints', () => {
  test('GET /api/kpis returns combined overall + byAsset', async () => {
    const res = await request(app).get('/api/kpis');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      overall: dummyOverall,
      byAsset: dummyByAsset
    });
  });

  test('GET /api/kpis-by-asset returns just byAsset', async () => {
    const res = await request(app).get('/api/kpis-by-asset');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dummyByAsset);
  });
});

describe('Status endpoint', () => {
  test('GET /api/status returns asset status array', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dummyStatus);
  });
});
