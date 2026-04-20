import { Middleware } from '../http/Middleware';
import { HttpMethod, Request, RouteDefinition } from '../http/types';
import { routeMeta } from '../http/metadata';
import { methodSourceMeta } from '../http/metadata';
import { captureDecoratorSourceFile } from '../http/jsdoc';

export function normalizePath(p: string): string {
    const stripped = p.replace(/^\/+|\/+$/g, '');
    return stripped ? `/${stripped}` : '/';
}

export class HttpMethodMiddleware extends Middleware {
    readonly _kind = 'method' as const;
    readonly method: HttpMethod;
    /** The normalised path segment for this route, e.g. `'/:id'`. */
    readonly path: string;

    constructor(method: HttpMethod, path: string) {
        super();
        this.method = method;
        this.path = normalizePath(path);
    }

    /** Invoked when used as `@Get('/path')` method decorator. */
    protected __apply__(target: Object, propertyKey: string | symbol): void {
        const ctor = (target as any).constructor;
        const defs: RouteDefinition[] = routeMeta.get(ctor) ?? [];
        defs.push({ method: this.method, path: this.path, handlerKey: String(propertyKey) });
        routeMeta.set(ctor, defs);

        const sourceFile = captureDecoratorSourceFile();
        if (sourceFile) {
            const files = methodSourceMeta.get(ctor) ?? new Map<string, string>();
            files.set(String(propertyKey), sourceFile);
            methodSourceMeta.set(ctor, files);
        }
    }

    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        return next(req);
    }
}

function createHttpMethod(httpMethod: HttpMethod) {
    return function (path?: string): HttpMethodMiddleware & MethodDecorator {
        return new HttpMethodMiddleware(httpMethod, path ?? '') as HttpMethodMiddleware & MethodDecorator;
    };
}

export const Get = createHttpMethod('GET');
export const Post = createHttpMethod('POST');
export const Put = createHttpMethod('PUT');
export const Delete = createHttpMethod('DELETE');
export const Patch = createHttpMethod('PATCH');
