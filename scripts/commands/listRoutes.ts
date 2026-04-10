/**
 * List all registered HTTP endpoints for a given server.
 *
 * Usage:
 *   bun scripts/listRoutes.ts --server=api [--format=table|json|openapi]
 */

import path from 'path';
import type { HttpMethod, RouteSpec } from '../../src/http/types';
import { buildOpenApiDocument } from '../../src/http/openapi';

const serverArg = process.argv.find(a => a.startsWith('--server='));
const server = serverArg ? serverArg.split('=')[1] : null;
const formatArg = process.argv.find(a => a.startsWith('--format='));
const format = formatArg ? formatArg.split('=')[1] : 'table';
const titleArg = process.argv.find(a => a.startsWith('--title='));
const versionArg = process.argv.find(a => a.startsWith('--version='));
const descriptionArg = process.argv.find(a => a.startsWith('--description='));

// Disable LoggerMiddleware console patching for route listing
process.argv.push('--skip-logger');

if (!server) {
    console.error('[listRoutes] Missing --server=<name> argument.');
    console.error('  Example: bun scripts/listRoutes.ts --server=api --format=json');
    process.exit(1);
}

if (!['table', 'json', 'openapi'].includes(format)) {
    console.error(`[listRoutes] Unsupported --format=${format}. Use table, json, or openapi.`);
    process.exit(1);
}

const routesFile = path.resolve(process.cwd(), `src/routes/${server}.ts`);

// Verify the routes file exists
const file = Bun.file(routesFile);
if (!(await file.exists())) {
    console.error(`[listRoutes] Routes file not found: src/routes/${server}.ts`);
    process.exit(1);
}

const mod = await import(routesFile);
const router = mod.default;

if (!router || typeof router.getRoutes !== 'function') {
    console.error('[listRoutes] Default export must be a Router instance with getRoutes().');
    process.exit(1);
}

interface RouteInfo {
    method: HttpMethod;
    path: string;
    action: string;
    middlewares: string[];
}

const routes: RouteInfo[] = router.getRoutes();
const routeSpecs: RouteSpec[] = typeof router.getRouteSpecs === 'function'
    ? await router.getRouteSpecs()
    : routes.map(route => ({
        method: route.method,
        path: route.path,
        action: route.action,
        traceCaller: route.action,
        middlewares: route.middlewares,
        globalMiddlewares: [],
        pathParams: [],
        validation: {},
    }));
const globalMwNames: string[] = typeof router.getGlobalMiddlewares === 'function'
    ? router.getGlobalMiddlewares()
    : [];

function routeMiddlewareLabel(route: RouteInfo): string {
    return [...globalMwNames, ...route.middlewares].join(', ');
}

// Column widths
const COL_DOMAIN = Math.max(6, server.length);
const COL_METHOD = Math.max(6, ...routes.map(r => r.method.length));
const COL_ENDPOINT = Math.max(8, ...routes.map(r => r.path.length));
const COL_ACTION = Math.max(6, ...routes.map(r => r.action.length));
const COL_MIDDLEWARE = Math.max(10, 'Middleware'.length, ...routes.map(r => routeMiddlewareLabel(r).length));

function pad(str: string, width: number) {
    return str.padEnd(width);
}

function divider() {
    return [
        '-'.repeat(COL_DOMAIN),
        '-'.repeat(COL_METHOD),
        '-'.repeat(COL_ENDPOINT),
        '-'.repeat(COL_ACTION),
        '-'.repeat(COL_MIDDLEWARE),
    ].join('-+-') + '-';
}

function row(domain: string, method: string, endpoint: string, action: string, middleware: string) {
    return [
        pad(domain, COL_DOMAIN),
        pad(method, COL_METHOD),
        pad(endpoint, COL_ENDPOINT),
        pad(action, COL_ACTION),
        pad(middleware, COL_MIDDLEWARE),
    ].join(' | ');
}

if (format === 'json') {
    console.log(JSON.stringify({
        server,
        routes: routeSpecs,
    }, null, 2));
    process.exit(0);
}

if (format === 'openapi') {
    const document = buildOpenApiDocument(server, routeSpecs, {
        title: titleArg ? titleArg.split('=')[1] : undefined,
        version: versionArg ? versionArg.split('=')[1] : undefined,
        description: descriptionArg ? descriptionArg.split('=')[1] : undefined,
    });
    console.log(JSON.stringify(document, null, 2));
    process.exit(0);
}

console.log();
console.log(row('Domain', 'Method', 'Endpoint', 'Action', 'Middleware'));
console.log(divider());

for (const route of routes) {
    console.log(row(server, route.method, route.path, route.action, routeMiddlewareLabel(route)));
}

console.log();
