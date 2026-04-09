import { Middleware } from '../http/Middleware';
import { current } from '../http/Context';
import type { Request } from '../http/types';

export class TrackMiddleware extends Middleware {
    /**
     * Handles three decorator use-cases:
     *
     * 1. `@Track()` — factory call (no args) → returns a decorator function
     * 2. `@Track`   — method decorator → wraps descriptor.value
     * 3. `@Track`   — class decorator  → wraps all prototype route handlers
     */
    protected __apply__(...args: any[]): any {
        // 1. Factory mode: @Track()
        if (args.length === 0) {
            return (...decoratorArgs: any[]) => this.__apply__(...decoratorArgs);
        }

        const [target, , descriptor] = args;

        // 2. Method decorator: @Track or @Track()
        if (descriptor !== undefined && typeof descriptor.value === 'function') {
            const original: (req: Request) => unknown = descriptor.value;
            const self = this;
            descriptor.value = async function (this: unknown, req: Request) {
                return self.handler(req, (r) => Promise.resolve(original.call(this, r)));
            };
            return descriptor;
        }

        // 3. Class decorator: @Track or @Track()
        if (typeof target === 'function') {
            const proto = target.prototype;
            const self = this;
            for (const key of Object.getOwnPropertyNames(proto)) {
                if (key === 'constructor') continue;
                const desc = Object.getOwnPropertyDescriptor(proto, key);
                if (!desc || typeof desc.value !== 'function') continue;
                const original: (req: Request) => unknown = desc.value;
                desc.value = async function (this: unknown, req: Request) {
                    return self.handler(req, (r) => Promise.resolve(original.call(this, r)));
                };
                Object.defineProperty(proto, key, desc);
            }
        }
    }


    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        const trackId = Math.random().toString(36).substring(2, 10);
        current.trackId = trackId;

        const withTrackId = (response: globalThis.Response): globalThis.Response => {
            const cloned = new globalThis.Response(response.body, response);
            cloned.headers.set('X-Track-Id', trackId);
            return cloned;
        };

        let res: unknown;
        try {
            res = await next(req);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const errName = err instanceof Error && err.name && err.name !== 'Error' ? ` [${err.name}]` : '';

            const extras: string[] = [];
            if (err instanceof Error) {
                const e = err as any;
                // Nested validation error items (e.g. ORM validation errors)
                if (Array.isArray(e.errors) && e.errors.length > 0) {
                    const items = e.errors.map((ve: any) => {
                        const field = ve.path ?? ve.field ?? ve.property ?? '?';
                        const msg = ve.message ?? String(ve);
                        return `${field}: ${msg}`;
                    });
                    extras.push(`Errors: ${items.join('; ')}`);
                }
                // Field map (e.g. unique constraint fields)
                if (e.fields && typeof e.fields === 'object' && !Array.isArray(e.fields)) {
                    extras.push(`Fields: ${JSON.stringify(e.fields)}`);
                }
                // Underlying DB / cause error
                const cause: unknown = e.parent ?? e.cause ?? e.original;
                if (cause instanceof Error) {
                    extras.push(`Cause: ${cause.message}`);
                }
            }

            const detail = extras.length > 0 ? `\n  ${extras.join('\n  ')}` : '';
            console.error(`Error${errName}: ${message}${detail}\nStack: ${err instanceof Error ? err.stack?.split('\n').join('\t\t\t\n') : 'No stack trace available'}`);
            return withTrackId(Response.json({ error: message }, { status: 500 }));
        }
        delete current.trackId;

        if (res instanceof globalThis.Response) {
            return withTrackId(res);
        }

        return withTrackId(Response.json({ data: res }));
    }
}

/**
 * Singleton `TrackMiddleware` instance, usable as:
 *
 * - `router.use(Track)` — global middleware
 * - `@Track`  on a method — wraps that handler only
 * - `@Track`  on a class  — wraps all route handlers on the controller
 * - `@Track()` — factory call, both styles supported
 */
export const Track = new TrackMiddleware() as TrackMiddleware
    & ClassDecorator
    & MethodDecorator
    & (() => ClassDecorator & MethodDecorator);