import request from 'supertest';
import app from '../server.js';

describe('API routes', () => {
  test('GET / responds with html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!DOCTYPE html>');
  });
});
