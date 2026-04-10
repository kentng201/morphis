import { HttpMethod, Request, RawRequest, RouteSpec, ValidateMap } from './types';
import { HttpMethodMiddleware, ValidateMiddleware, EndpointMiddleware } from './decorators';
import { TransformerMiddleware } from '../middlewares/TransformerMiddleware';
import { ConnectMiddleware } from '../middlewares/ConnectMiddleware';
import { Middleware } from './Middleware';
import { current, runWithContext } from './Context';
import { ROUTE_KEY, VALIDATE_KEY } from './metadata';
import { inspectValidateMap } from './Validator';
import {
    createErrorResponse,
    defaultErrorFormatter,
    type ErrorFormatter,
    NotFoundError,
} from '../errors';

interface RouteEntry {
    method: HttpMethod;
    path: string;
    pattern: RegExp;
    paramNames: string[];
    handler: (req: Request) => unknown;
    action: string;
    traceCaller: string;
    middlewares: string[];
    controllerName?: string;
    handlerKey?: string;
    validateMap?: ValidateMap;
}

/** Map from resource method name → HTTP verb + path suffix */
const RESOURCE_MAP: Array<{ name: string; method: HttpMethod; suffix: string }> = [
    { name: 'list', method: 'GET', suffix: '' },
    { name: 'get', method: 'GET', suffix: '/:id' },
    { name: 'create', method: 'POST', suffix: '' },
    { name: 'update', method: 'PUT', suffix: '/:id' },
    { name: 'delete', method: 'DELETE', suffix: '/:id' },
];

function buildPattern(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const regexStr = path
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape special chars
        .replace(/:(\w+)/g, (_, name) => {
            paramNames.push(name);
            return '([^/]+)';
        });
    return { pattern: new RegExp(`^${regexStr}$`), paramNames };
}

function resolveRouteKey(fn: Function): { method: HttpMethod; path: string } | null {
    const meta = (fn as any)[ROUTE_KEY];
    if (!meta) return null;
    return meta;
}

function resolveValidateMap(fn: Function): ValidateMap | undefined {
    const map = (fn as any)[VALIDATE_KEY] as ValidateMap | undefined;
    if (!map) return undefined;
    return Object.keys(map).length > 0 ? map : undefined;
}

export class Router {
    private routes: RouteEntry[] = [];
    private globalMiddlewares: Middleware[] = [];
    private errorFormatter: ErrorFormatter = defaultErrorFormatter;

    /**
     * Register a global middleware that wraps every request.
     * Middlewares are applied in the order they are added (outermost first).
     *
     * @example
     * router.use(new TrackMiddleware());
     */
    use(middleware: Middleware | Middleware[]): this {
        if (Array.isArray(middleware)) {
            this.globalMiddlewares.push(...middleware);
        } else {
            this.globalMiddlewares.push(middleware);
        }
        return this;
    }

    setErrorFormatter(formatter: ErrorFormatter): this {
        this.errorFormatter = formatter;
        return this;
    }

    private addRoute(
        method: HttpMethod,
        path: string,
        handler: (req: Request) => unknown,
        action: string,
        middlewares: string[] = [],
        traceCaller: string = action,
        options: {
            controllerName?: string;
            handlerKey?: string;
            validateMap?: ValidateMap;
        } = {},
    ): this {
        const { pattern, paramNames } = buildPattern(path);
        this.routes.push({
            method,
            path,
            pattern,
            paramNames,
            handler,
            action,
            traceCaller,
            middlewares,
            controllerName: options.controllerName,
            handlerKey: options.handlerKey,
            validateMap: options.validateMap,
        });
        return this;
    }

    /** Returns all registered routes for inspection (e.g. listRoutes script). */
    getRoutes(): Array<{ method: HttpMethod; path: string; action: string; middlewares: string[] }> {
        return this.routes.map(r => ({ method: r.method, path: r.path, action: r.action, middlewares: r.middlewares }));
    }

    /** Returns the names of all global middlewares registered via use(). */
    getGlobalMiddlewares(): string[] {
        return this.globalMiddlewares.map(m => m.constructor.name);
    }

    async getRouteSpecs(): Promise<RouteSpec[]> {
        const globalMiddlewares = this.getGlobalMiddlewares();

        return Promise.all(this.routes.map(async route => ({
            method: route.method,
            path: route.path,
            action: route.action,
            traceCaller: route.traceCaller,
            middlewares: [...route.middlewares],
            globalMiddlewares: [...globalMiddlewares],
            pathParams: [...route.paramNames],
            controllerName: route.controllerName,
            handlerKey: route.handlerKey,
            validation: await inspectValidateMap(route.validateMap),
        })));
    }

    /**
     * Wraps a handler with any ValidateMiddleware instances in the array.
     * Uses the middleware's own handler() so there is a single source of truth.
     */
    private applyValidateMiddlewares(
        handler: (req: Request) => unknown,
        middlewares: EndpointMiddleware[],
    ): (req: Request) => unknown {
        // Walk in reverse so the first validate() in the array is outermost.
        const validates = middlewares.filter((m): m is ValidateMiddleware => (m as any)._kind === 'validate');
        return validates.reduceRight(
            (next, mw) => (req: Request) => mw.handler(req, next as (req: Request) => Promise<unknown>) as Promise<unknown>,
            handler,
        );
    }

    /**
     * Wraps a handler with any TransformerMiddleware instances in the array.
     * Transforms are applied after validation (validate wraps transform wraps handler).
     */
    private applyTransformMiddlewares(
        handler: (req: Request) => unknown,
        middlewares: EndpointMiddleware[],
    ): (req: Request) => unknown {
        const transforms = middlewares.filter((m): m is TransformerMiddleware => (m as any)._kind === 'transform');
        return transforms.reduceRight(
            (next, mw) => (req: Request) => mw.handler(req, next as (req: Request) => Promise<unknown>) as Promise<unknown>,
            handler,
        );
    }

    /**
     * Wraps a handler with any ConnectMiddleware instances in the array.
     * Connection is resolved innermost — after validation and transform, before the handler.
     */
    private applyConnectMiddlewares(
        handler: (req: Request) => unknown,
        middlewares: EndpointMiddleware[],
    ): (req: Request) => unknown {
        const connects = middlewares.filter((m): m is ConnectMiddleware => (m as any)._kind === 'connect');
        return connects.reduceRight(
            (next, mw) => (req: Request) => mw.handler(req, next as (req: Request) => Promise<unknown>) as Promise<unknown>,
            handler,
        );
    }

    /** Collect middleware names for route inspection (excludes the method middleware). */
    private collectMiddlewareNames(middlewares: EndpointMiddleware[]): string[] {
        return middlewares
            .filter((m): m is ValidateMiddleware | TransformerMiddleware | ConnectMiddleware =>
                (m as any)._kind === 'validate' || (m as any)._kind === 'transform' || (m as any)._kind === 'connect',
            )
            .map(m => m.constructor.name);
    }

    private collectValidateMap(middlewares: EndpointMiddleware[]): ValidateMap | undefined {
        const map = middlewares
            .filter((middleware): middleware is ValidateMiddleware => (middleware as any)._kind === 'validate')
            .reduce<ValidateMap>((merged, middleware) => Object.assign(merged, middleware.map), {});

        return Object.keys(map).length > 0 ? map : undefined;
    }

    /**
     * Register an inline handler with a middleware array.
     * The array must contain at least one method middleware (e.g. get('/path'))
     * and can contain any number of validate() middlewares.
     *
     * @example
     * router.endpoint(function rootIndex() { return { ok: true }; }, [
     *   Get('/'),
     *   Validate({ headers: AuthValidator }),
     * ]);
     */
    endpoint(handler: (req: Request) => unknown, middlewares: EndpointMiddleware[]): this {
        const methodMw = middlewares.find((m): m is HttpMethodMiddleware => (m as any)._kind === 'method');
        if (!methodMw) return this;
        const connectWrapped = this.applyConnectMiddlewares(handler, middlewares);
        const transformWrapped = this.applyTransformMiddlewares(connectWrapped, middlewares);
        const wrapped = this.applyValidateMiddlewares(transformWrapped, middlewares);
        const action = handler.name.replace(/^bound\s+/, '') || '<anonymous>';
        const mwNames = this.collectMiddlewareNames(middlewares);
        return this.addRoute(methodMw.method, methodMw.path, wrapped, action, mwNames, action, {
            validateMap: this.collectValidateMap(middlewares),
        });
    }

    /** Register a controller method, or an inline handler with options.middlewares. */
    get(fn: (req: Request) => unknown, middlewares?: EndpointMiddleware[]): this { return this.registerFn('GET', fn, middlewares); }
    post(fn: (req: Request) => unknown, middlewares?: EndpointMiddleware[]): this { return this.registerFn('POST', fn, middlewares); }
    put(fn: (req: Request) => unknown, middlewares?: EndpointMiddleware[]): this { return this.registerFn('PUT', fn, middlewares); }
    delete(fn: (req: Request) => unknown, middlewares?: EndpointMiddleware[]): this { return this.registerFn('DELETE', fn, middlewares); }
    patch(fn: (req: Request) => unknown, middlewares?: EndpointMiddleware[]): this { return this.registerFn('PATCH', fn, middlewares); }

    private registerFn(expectedMethod: HttpMethod, fn: (req: Request) => unknown, middlewares?: EndpointMiddleware[]): this {
        if (middlewares) {
            // Path and method come from the HttpMethodMiddleware inside the array
            const methodMw = middlewares.find((m): m is HttpMethodMiddleware => (m as any)._kind === 'method');
            if (!methodMw) return this;
            const connectWrapped = this.applyConnectMiddlewares(fn, middlewares);
            const transformWrapped = this.applyTransformMiddlewares(connectWrapped, middlewares);
            const wrapped = this.applyValidateMiddlewares(transformWrapped, middlewares);
            const action = fn.name.replace(/^bound\s+/, '') || '<anonymous>';
            const mwNames = this.collectMiddlewareNames(middlewares);
            return this.addRoute(methodMw.method, methodMw.path, wrapped, action, mwNames, action, {
                validateMap: this.collectValidateMap(middlewares),
            });
        }
        const meta = resolveRouteKey(fn) as any;
        if (!meta) {
            // No metadata and no options — custom handler with no path, skip registration
            return this;
        }
        const action = meta.controllerName
            ? `${meta.controllerName[0].toLowerCase()}${meta.controllerName.slice(1)}.${meta.handlerKey}`
            : fn.name.replace(/^bound\s+/, '') || '<anonymous>';
        const traceCaller = meta.controllerName
            ? `${meta.controllerName}.${meta.handlerKey}`
            : action;
        return this.addRoute(meta.method, meta.path, fn, action, [], traceCaller, {
            controllerName: meta.controllerName,
            handlerKey: meta.handlerKey,
            validateMap: resolveValidateMap(fn),
        });
    }

    /**
     * Auto-registers all matching resource methods on the controller instance:
     *   list   → GET    /base
     *   get    → GET    /base/:id
     *   create → POST   /base
     *   update → PUT    /base/:id
     *   delete → DELETE /base/:id
     */
    resources(instance: object): this {
        for (const { name, method, suffix } of RESOURCE_MAP) {
            const fn = (instance as any)[name];
            if (typeof fn !== 'function') continue;
            const meta = resolveRouteKey(fn);
            if (!meta) continue;

            // Derive the base path from the metadata (strip trailing /:id if present),
            // then append the canonical suffix instead.
            const base = meta.path.replace(/\/:[^/]+$/, '');
            const fullPath = base + suffix || '/';
            const controllerName = (meta as any).controllerName;
            const action = controllerName
                ? `${controllerName[0].toLowerCase()}${controllerName.slice(1)}.${name}`
                : name;
            const traceCaller = controllerName ? `${controllerName}.${name}` : action;
            this.addRoute(method, fullPath, fn as (req: Request) => unknown, action, [], traceCaller, {
                controllerName,
                handlerKey: name,
                validateMap: resolveValidateMap(fn),
            });
        }
        return this;
    }

    /** Main request handler — pass to Bun.serve({ fetch }) */
    async handle(rawReq: RawRequest): Promise<globalThis.Response> {
        return runWithContext(async () => {
            const url = new URL(rawReq.url);
            const pathname = url.pathname;
            const method = rawReq.method as HttpMethod;

            // OPTIONS preflight — pass through global middlewares (e.g. CorsMiddleware
            // will intercept and return 204 before reaching the route handler).
            if (method === 'OPTIONS') {
                const preflightReq: Request = {
                    raw: rawReq,
                    path: pathname,
                    headers: rawReq.headers,
                    params: {},
                    query: Object.fromEntries(url.searchParams),
                    body: undefined,
                };
                const noopHandler = () => Promise.resolve(new Response(null, { status: 204 }));
                const chain = this.globalMiddlewares.reduceRight(
                    (next, mw) => (req: Request) => mw.handler(req, next),
                    noopHandler as (req: Request) => Promise<unknown>,
                );
                try {
                    const result = await chain(preflightReq);
                    if (result instanceof Response) return result;
                    return new Response(null, { status: 204 });
                } catch (err) {
                    return this.serializeError(err, preflightReq);
                }
            }

            for (const route of this.routes) {
                if (route.method !== method) continue;
                const match = pathname.match(route.pattern);
                if (!match) continue;

                const params: Record<string, string> = {};
                route.paramNames.forEach((name, i) => {
                    params[name] = decodeURIComponent(match[i + 1]);
                });

                const parsedBody = ['POST', 'PUT', 'PATCH'].includes(method)
                    ? await rawReq.json().catch(() => undefined)
                    : undefined;

                const appReq: Request = {
                    raw: rawReq,
                    path: pathname,
                    headers: rawReq.headers,
                    params,
                    query: Object.fromEntries(url.searchParams),
                    body: parsedBody,
                };

                try {
                    const trace = (current.trace ??= []);
                    const shouldPushTrace = trace[trace.length - 1] !== route.traceCaller;
                    if (shouldPushTrace) trace.push(route.traceCaller);
                    // Compose global middlewares around the matched route handler.
                    // The last global middleware calls the route handler as `next`.
                    const routeHandler = (req: Request) => Promise.resolve(route.handler(req));
                    const chain = this.globalMiddlewares.reduceRight(
                        (next, mw) => (req: Request) => mw.handler(req, next),
                        routeHandler as (req: Request) => Promise<unknown>,
                    );

                    const result = await chain(appReq);
                    if (result instanceof Response) return result;
                    return Response.json(result, { status: 200 });
                } catch (err) {
                    return this.serializeError(err, appReq);
                } finally {
                    const trace = current.trace;
                    if (trace?.[trace.length - 1] === route.traceCaller) trace.pop();
                }
            }

            const notFoundReq: Request = {
                raw: rawReq,
                path: pathname,
                headers: rawReq.headers,
                params: {},
                query: Object.fromEntries(url.searchParams),
                body: undefined,
            };

            return this.serializeError(
                new NotFoundError('Not found', {
                    details: { path: pathname, method },
                }),
                notFoundReq,
            );
        });
    }

    private serializeError(error: unknown, request: Request): Promise<Response> {
        return createErrorResponse(error, {
            request,
            trackId: current.trackId,
        }, this.errorFormatter);
    }
}
