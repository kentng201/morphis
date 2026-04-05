import { Middleware } from '../http/Middleware';
import { Request, RouteDefinition } from '../http/types';
import { controllerMeta, routeMeta, ROUTE_KEY } from '../http/metadata';
import { normalizePath } from './HttpMethodMiddleware';

export class ControllerMiddleware extends Middleware {
    readonly _kind = 'controller' as const;
    /** The normalised base path registered for this controller, e.g. `'/orders'`. */
    readonly path: string;

    constructor(path: string) {
        super();
        this.path = normalizePath(path);
    }

    /** Invoked when used as `@Controller('/path')` class decorator. */
    protected __apply__(target: Function): void {
        const basePath = this.path;
        controllerMeta.set(target, basePath);

        const defs: RouteDefinition[] = routeMeta.get(target) ?? [];
        for (const def of defs) {
            const methodPath = def.path === '/' ? '' : def.path;
            const fullPath = basePath === '/' ? (def.path || '/') : basePath + methodPath;
            const proto = (target as any).prototype;
            const fn = proto[def.handlerKey];
            if (typeof fn === 'function') {
                const routeKeyValue = {
                    method: def.method,
                    path: fullPath,
                    handlerKey: def.handlerKey,
                    controllerName: (target as any).name,
                };
                (fn as any)[ROUTE_KEY] = routeKeyValue;
                Object.defineProperty(proto, def.handlerKey, {
                    get() {
                        const bound = fn.bind(this);
                        (bound as any)[ROUTE_KEY] = routeKeyValue;
                        return bound;
                    },
                    configurable: true,
                });
            }
        }
    }

    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        return next(req);
    }
}

/**
 * Class decorator that binds a base path to all routes in the controller.
 * The returned value is also a `ControllerMiddleware` instance — so `.path`
 * is accessible for reuse in controller logic.
 *
 * @example
 * \@Controller('/orders')
 * class OrderController { ... }
 *
 * const dec = Controller('/orders');
 * dec.path; // '/orders'
 */
export function Controller(path: string): ControllerMiddleware & ClassDecorator {
    return new ControllerMiddleware(path) as ControllerMiddleware & ClassDecorator;
}
