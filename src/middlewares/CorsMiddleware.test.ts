import { describe, expect, test } from 'bun:test';
import { BadRequestError, Cors, Get, Router, Track } from '../index';

describe('CorsMiddleware', () => {
    test('applies CORS headers when it is not first in the middleware list', async () => {
        const router = new Router();
        router.get(() => ({ ok: true }), [Get('/')]);
        router.use([
            Track,
            Cors({ origins: '*' }),
        ]);

        const response = await router.handle(new Request('http://localhost/', {
            headers: {
                Origin: 'http://client.example.com',
            },
        }));

        expect(response.status).toBe(200);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response.headers.get('X-Track-Id')).toBeTruthy();
        expect(await response.json()).toEqual({ data: { ok: true } });
    });

    test('applies CORS headers to downstream error responses', async () => {
        const router = new Router();
        router.get(() => {
            throw new BadRequestError('Invalid request');
        }, [Get('/')]);
        router.use([
            Track,
            Cors({ origins: '*' }),
        ]);

        const response = await router.handle(new Request('http://localhost/', {
            headers: {
                Origin: 'http://client.example.com',
            },
        }));

        expect(response.status).toBe(400);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await response.json()).toEqual({ error: 'Invalid request' });
    });

    test('applies CORS headers to router-level not found responses', async () => {
        const router = new Router();
        router.use([
            Track,
            Cors({ origins: '*' }),
        ]);

        const response = await router.handle(new Request('http://localhost/missing', {
            headers: {
                Origin: 'http://client.example.com',
            },
        }));

        expect(response.status).toBe(404);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
});
