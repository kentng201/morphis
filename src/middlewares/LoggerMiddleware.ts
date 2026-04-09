import { Middleware } from '../http/Middleware';
import { current } from '../http/Context';
import type { Request } from '../http/types';
import { LoggerService } from '../services/LoggerService';

/** Shared timer store for console.time / console.timeEnd / console.timeLog. */
const timers = new Map<string, number>();

/**
 * Patches the global `console` object once so that every call to
 * `console.log`, `console.warn`, `console.error`, `console.debug`,
 * `console.info`, `console.table`, `console.time`, `console.timeEnd`, and
 * `console.timeLog` is routed through `LoggerService`.
 *
 * Each log line is prefixed with the per-request context
 * (server · trackId · path · serviceCalled) read live from AsyncLocalStorage,
 * so concurrent requests never bleed into each other.
 *
 * Output is colourised via chalk by default:
 * - Prefix brackets are dim for regular logs, yellow for warnings, red for errors.
 * - JSON objects and arrays are syntax-highlighted (keys cyan, strings green,
 *   booleans yellow, numbers magenta, null dim-red).
 *
 * Pass `--colorless` to strip all ANSI colour codes (recommended for build
 * output or CI environments where colour is not supported):
 * @example
 * bun scripts/build.ts --colorless
 *
 * Pass `--skip-logger` to disable the console patches entirely:
 * @example
 * bun scripts/build.ts --skip-logger
 *
 * Register as global middleware **before** any route handlers:
 * @example
 * router.use(Logger);
 */
export class LoggerMiddleware extends Middleware {
    private static patched = false;
    static loggerService = new LoggerService(LoggerMiddleware.name);

    constructor() {
        super();
        LoggerMiddleware.patch();
    }

    private static patch(): void {
        if (LoggerMiddleware.patched) return;
        if (process.argv.includes('--skip-logger')) return;
        LoggerMiddleware.patched = true;

        console.log = console.info = (...args: any[]): void => {
            this.loggerService._patch('log', ...args);
        };

        console.warn = (...args: any[]): void => {
            this.loggerService._patch('warn', ...args);
        };

        console.error = (...args: any[]): void => {
            this.loggerService._patch('error', ...args);
        };

        console.debug = (...args: any[]): void => {
            this.loggerService._patch('log', ...args);
        };

        console.table = (data: any, _columns?: readonly string[]): void => {
            this.loggerService._patch('log', data);
        };

        console.time = (label = 'default'): void => {
            timers.set(label, performance.now());
        };

        console.timeEnd = (label = 'default'): void => {
            const start = timers.get(label);
            if (start === undefined) return;
            const elapsed = (performance.now() - start).toFixed(3);
            this.loggerService._patch('log', `${label}: ${elapsed}ms`);
            timers.delete(label);
        };

        console.timeLog = (label = 'default', ...data: any[]): void => {
            const start = timers.get(label);
            if (start === undefined) return;
            const elapsed = (performance.now() - start).toFixed(3);
            this.loggerService._patch('log', `${label}: ${elapsed}ms`, ...data);
        };
    }

    /**
     * Stores the request path into the per-request AsyncLocalStorage context so
     * that any `console.*` call made deeper in the stack can include it.
     */
    async handler(req: Request, next: (req: Request) => Promise<unknown>): Promise<unknown> {
        current.path = Object.entries(req.params).reduce(
            (path, [key, value]) => path.replace(`:${key}`, value),
            req.path,
        );
        return next(req);
    }
}

/**
 * Singleton `LoggerMiddleware` instance.
 *
 * @example
 * router.use(Logger);
 */
export const Logger = new LoggerMiddleware();
