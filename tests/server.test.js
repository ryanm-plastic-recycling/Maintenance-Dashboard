import request from 'supertest';
import app from '../server.js';

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
