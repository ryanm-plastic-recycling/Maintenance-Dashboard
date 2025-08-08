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
  test('GET /api/status returns asset status array with next refresh', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: dummyStatus, nextRefresh: expect.any(Number) });
  });
});

describe('KPI loader error handling', () => {
  beforeEach(() => {
    process.env.CLIENT_ID = 'id';
    process.env.CLIENT_SECRET = 'secret';
    fetchMock.mockReset();
  });

    test('loadOverallKpis logs and throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await expect(serverModule.loadOverallKpis()).rejects.toThrow('500');
      expect(errSpy).toHaveBeenCalled();
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

describe('KPI time range overrides', () => {
  beforeEach(() => {
    process.env.CLIENT_ID = 'id';
    process.env.CLIENT_SECRET = 'secret';
    fetchMock.mockReset();
  });

  test('loadOverallKpis uses KPI_* env vars', async () => {
    process.env.KPI_WEEK_START = '100';
    process.env.KPI_WEEK_END = '200';
    process.env.KPI_MONTH_START = '300';
    process.env.KPI_MONTH_END = '400';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { tasks: [], entries: [] } })
    });

    await serverModule.loadOverallKpis();

    const tasksUrl = fetchMock.mock.calls[0][0];
    expect(tasksUrl).toContain('tasks?assets=');
    expect(tasksUrl).toContain('&status=2');
    expect(tasksUrl).not.toContain('dateCompletedGte');
    expect(tasksUrl).not.toContain('dateCompletedLte');
    const laborWeekUrl = fetchMock.mock.calls[1][0];
    expect(laborWeekUrl).toContain('/tasks/labor?');
    expect(laborWeekUrl).toContain('limit=10000');
    expect(laborWeekUrl).toContain('start=100');
    expect(laborWeekUrl).toContain('end=200');
    const laborMonthUrl = fetchMock.mock.calls[2][0];
    expect(laborMonthUrl).toContain('/tasks/labor?');
    expect(laborMonthUrl).toContain('limit=10000');
    expect(laborMonthUrl).toContain('start=300');
    expect(laborMonthUrl).toContain('end=400');

    delete process.env.KPI_WEEK_START;
    delete process.env.KPI_WEEK_END;
    delete process.env.KPI_MONTH_START;
    delete process.env.KPI_MONTH_END;
  });

  test('loadByAssetKpis uses KPI_MONTH_* env vars', async () => {
    process.env.KPI_MONTH_START = '500';
    process.env.KPI_MONTH_END = '600';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { tasks: [], entries: [] } })
    });

    await serverModule.loadByAssetKpis();

    const monthTasksUrl = fetchMock.mock.calls[0][0];
    expect(monthTasksUrl).toContain('tasks?assets=');
    expect(monthTasksUrl).toContain('&status=2');
    expect(monthTasksUrl).not.toContain('dateCompletedGte');
    expect(monthTasksUrl).not.toContain('dateCompletedLte');
    const laborMonthUrl = fetchMock.mock.calls[1][0];
    expect(laborMonthUrl).toContain('/tasks/labor?limit=10000');
    expect(laborMonthUrl).not.toContain('start=');

    delete process.env.KPI_MONTH_START;
    delete process.env.KPI_MONTH_END;
  });
});

