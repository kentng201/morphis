import { Middleware } from '../http/Middleware';
import type { Request } from '../http/types';

export interface CorsOptions {
    /** Allowed origins. Use '*' to allow all, or pass a list of specific origins. */
    origins?: string | string[];
    methods?: string | string[];
    headers?: string | string[];
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
        this.methods = Array.isArray(options.methods) ? options.methods.join(', ') : (options.methods ?? DEFAULT_METHODS);
        this.headers = Array.isArray(options.headers) ? options.headers.join(', ') : (options.headers ?? DEFAULT_HEADERS);
        this.maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
    }

    private resolveOrigin(requestOrigin: string | null): string {
        if (this.origins === '*') return '*';
        if (Array.isArray(this.origins) && this.origins.includes('*')) return '*';
        if (!requestOrigin) return '';

        const list = Array.isArray(this.origins) ? this.origins : [this.origins];
        return list.includes(requestOrigin) ? requestOrigin : '';
    }

    private buildCorsHeaders(requestOrigin: string | null): Record<string, string> {
        const allowedOrigin = this.resolveOrigin(requestOrigin);
        const corsHeaders: Record<string, string> = {
            'Access-Control-Allow-Methods': this.methods,
            'Access-Control-Allow-Headers': this.headers,
            'Access-Control-Max-Age': String(this.maxAge),
        };

        if (allowedOrigin) {
            corsHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
            if (allowedOrigin !== '*') {
                corsHeaders['Vary'] = 'Origin';
            }
        }

        return corsHeaders;
    }

    applyToResponse(req: Pick<Request, 'headers'>, response: Response): Response {
        const corsHeaders = this.buildCorsHeaders(req.headers.get('origin'));
        const res = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });

        Object.entries(corsHeaders).forEach(([key, value]) => res.headers.set(key, value));
        return res;
    }

    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        const corsHeaders = this.buildCorsHeaders(req.headers.get('origin'));

        // Preflight — short-circuit, no need to call next()
        if (req.raw.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const result = await next(req);
        if (result instanceof Response) {
            return this.applyToResponse(req, result);
        }

        return result;
    }
}

export const Cors = (options?: CorsOptions) => new CorsMiddleware(options);
