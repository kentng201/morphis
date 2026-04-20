import { Middleware } from '../http/Middleware';
import { Request, RouteDefinition } from '../http/types';
import { controllerMeta, controllerSourceMeta, methodSourceMeta, routeMeta, ROUTE_KEY, VALIDATE_KEY } from '../http/metadata';
import { normalizePath } from './HttpMethodMiddleware';
import { captureDecoratorSourceFile, resolveRouteDocs } from '../http/jsdoc';

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
        const sourceFile = captureDecoratorSourceFile();
        if (sourceFile) controllerSourceMeta.set(target, sourceFile);

        const defs: RouteDefinition[] = routeMeta.get(target) ?? [];
        for (const def of defs) {
            const methodPath = def.path === '/' ? '' : def.path;
            const fullPath = basePath === '/' ? (def.path || '/') : basePath + methodPath;
            const proto = (target as any).prototype;
            const fn = proto[def.handlerKey];
            if (typeof fn === 'function') {
                const resolvedSourceFile = methodSourceMeta.get(target)?.get(def.handlerKey)
                    ?? controllerSourceMeta.get(target);
                const routeKeyValue = {
                    method: def.method,
                    path: fullPath,
                    handlerKey: def.handlerKey,
                    controllerName: (target as any).name,
                    docs: resolveRouteDocs(resolvedSourceFile, (target as any).name, def.handlerKey),
                };
                (fn as any)[ROUTE_KEY] = routeKeyValue;
                Object.defineProperty(proto, def.handlerKey, {
                    get() {
                        const bound = fn.bind(this);
                        (bound as any)[ROUTE_KEY] = routeKeyValue;
                        if ((fn as any)[VALIDATE_KEY]) {
                            (bound as any)[VALIDATE_KEY] = (fn as any)[VALIDATE_KEY];
                        }
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
