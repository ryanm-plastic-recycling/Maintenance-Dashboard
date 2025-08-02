import { jest } from '@jest/globals';
import request from 'supertest';

// Mock node-fetch before importing the server module
const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));

const serverModule = await import('../server.js');
const app = serverModule.default;

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
  jest.spyOn(app, 'fetchAndCache').mockImplementation(async (key) => {
    if (key === 'kpis_overall') return dummyOverall;
    if (key === 'kpis_byAsset') return dummyByAsset;
    if (key === 'status')       return dummyStatus;
    return null;
  });
});

afterAll(() => {
  app.fetchAndCache.mockRestore();
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

describe('KPI loader error handling', () => {
  beforeEach(() => {
    process.env.CLIENT_ID = 'id';
    process.env.CLIENT_SECRET = 'secret';
    fetchMock.mockReset();
  });

  test('loadOverallKpis logs and throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(serverModule.loadOverallKpis()).rejects.toThrow('500');
    expect(errSpy).toHaveBeenCalledWith('loadOverallKpis weekTasks error:', 500);
    errSpy.mockRestore();
  });

  test('loadByAssetKpis logs and throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(serverModule.loadByAssetKpis()).rejects.toThrow('404');
    expect(errSpy).toHaveBeenCalledWith('loadByAssetKpis tasks error:', 404);
    errSpy.mockRestore();
  });
});

