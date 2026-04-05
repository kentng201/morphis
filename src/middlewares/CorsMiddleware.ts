import { Middleware } from '../http/Middleware';
import type { Request } from '../http/types';

export interface CorsOptions {
    /** Allowed origins. Use '*' to allow all, or pass a list of specific origins. */
    origins?: string | string[];
    methods?: string;
    headers?: string;
    maxAge?: number;
}

const DEFAULT_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const DEFAULT_HEADERS = 'Content-Type, Authorization';
const DEFAULT_MAX_AGE = 86400;

export class CorsMiddleware extends Middleware {
    private readonly origins: string | string[];
    private readonly methods: string;
    private readonly headers: string;
    private readonly maxAge: number;

    constructor(options: CorsOptions = {}) {
        super();
        this.origins = options.origins ?? '*';
        this.methods = options.methods ?? DEFAULT_METHODS;
        this.headers = options.headers ?? DEFAULT_HEADERS;
        this.maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
    }

    private resolveOrigin(requestOrigin: string | null): string {
        if (this.origins === '*') return '*';
        if (!requestOrigin) return '';

        const list = Array.isArray(this.origins) ? this.origins : [this.origins];
        return list.includes(requestOrigin) ? requestOrigin : '';
    }

    handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        const requestOrigin = req.headers.get('origin');
        const allowedOrigin = this.resolveOrigin(requestOrigin);

        const corsHeaders: Record<string, string> = {
            'Access-Control-Allow-Methods': this.methods,
            'Access-Control-Allow-Headers': this.headers,
            'Access-Control-Max-Age': String(this.maxAge),
        };

        if (allowedOrigin) {
            corsHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
            // Required when origin is not '*' so the browser sends credentials
            if (allowedOrigin !== '*') {
                corsHeaders['Vary'] = 'Origin';
            }
        }

        // Preflight — short-circuit, no need to call next()
        if (req.raw.method === 'OPTIONS') {
            return Promise.resolve(new Response(null, { status: 204, headers: corsHeaders }));
        }

        return next(req).then(result => {
            if (result instanceof Response) {
                // Clone the response and inject CORS headers
                const res = new Response(result.body, {
                    status: result.status,
                    statusText: result.statusText,
                    headers: result.headers,
                });
                Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
                return res;
            }
            return result;
        });
    }
}

export const Cors = (options?: CorsOptions) => new CorsMiddleware(options);
