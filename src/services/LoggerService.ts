import chalk from 'chalk';
import { current } from '../http/Context';

/**
 * Resolves the server name from the CLI arg `--server=<name>`, defaulting to 'app'.
 * Captured once at module load — before any console overrides.
 */
const serverName =
    process.argv.find(a => a.startsWith('--server='))?.split('=')[1] ?? 'app';

/** When `--colorless` is passed, all chalk formatting is disabled. */
const colorless = process.argv.includes('--colorless');

/**
 * Syntax-highlights a JSON string with chalk colours:
 * - Keys           → cyan
 * - Strings        → green
 * - Booleans       → yellow
 * - Numbers        → magenta
 * - null/undefined → orange (dim)
 */
function colorizeJSON(json: string): string {
    return json.replace(
        /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        (match) => {
            if (match.endsWith(':')) return chalk.cyan(match);           // key
            if (match.startsWith('"')) return chalk.green(match);        // string value
            if (match === 'true' || match === 'false') return chalk.yellow(match);
            if (match === 'null' || match === 'undefined') return chalk.hex('#FFA500')(match);
            return chalk.magenta(match);                                  // number
        },
    );
}

function safeCtx(): { trackId?: string; path?: string } {
    try {
        return {
            trackId: current.trackId as string | undefined,
            path: current.path as string | undefined,
        };
    } catch {
        return {};
    }
}

/**
 * Returns the stack frame at `depth` levels above this function.
 *
 * depth guide (from inside getCallerLabel):
 *   0 = getCallerLabel itself
 *   1 = loggerService.info / loggerService._patch
 *   2 = real caller when loggerService method is called directly
 *   3 = real caller when call goes through the console-patch arrow wrapper
 */
function getCallerInfo(serviceName: string | undefined, depth: number): { service?: string; method?: string } {
    const stack = new Error().stack ?? '';
    const lines = stack.split('\n').slice(1); // drop the 'Error' header line
    const frame = lines[depth];
    if (!frame) return { service: serviceName };
    const match = frame.match(/at (?:new )?([^\s(]+)/);
    const raw = match?.[1] ?? '';
    // If raw looks like a bare file location (e.g. LoggerMiddleware.ts:23:9), skip it
    if (/\.\w+:\d+:\d+$/.test(raw)) return { service: serviceName };
    const method = raw.includes('.') ? raw.split('.').pop()! : raw;
    return { service: serviceName, method: method || undefined };
}

function formatMessage(
    ctx: { trackId?: string; path?: string },
    callerInfo: { service?: string; method?: string },
    args: any[],
    level: 'log' | 'warn' | 'error' = 'log',
): string {
    const message = args
        .map(a => {
            if (a === null || a === undefined) return null;
            if (Array.isArray(a)) {
                if (a.length === 0) return null;
                const json = JSON.stringify(a, null, 2);
                return colorless ? json : colorizeJSON(json);
            }
            if (typeof a === 'object') {
                const json = JSON.stringify(a, null, 2);
                return colorless ? json : colorizeJSON(json);
            }
            return String(a);
        })
        .filter(a => a !== null)
        .join(' ');

    const parts: string[] = [`[${serverName}]`];
    if (ctx.trackId) parts.push(`[${ctx.trackId}]`);
    if (ctx.path) parts.push(`[${ctx.path}]`);
    if (callerInfo.service) parts.push(`[${callerInfo.service}]`);
    if (callerInfo.method) parts.push(`[${callerInfo.method}]`);

    let prefix = parts.join(' ');
    if (!colorless) {
        if (level === 'error') prefix = chalk.red(prefix);
        else if (level === 'warn') prefix = chalk.yellow(prefix);
        else prefix = chalk.dim(prefix);
    }

    return `${prefix} ${message}`;
}

/**
 * Capture native console methods **before** LoggerMiddleware patches them so
 * LoggerService itself never recurses through the patched versions.
 */
const nativeLog = console.log.bind(console);
const nativeWarn = console.warn.bind(console);
const nativeError = console.error.bind(console);

export class LoggerService {
    constructor(private readonly serviceName?: string) { }

    // ── Public API: direct callers are 2 frames above getCallerLabel ─────────

    error(...args: any[]): void {
        nativeError(formatMessage(safeCtx(), getCallerInfo(this.serviceName, 2), args, 'error'));
    }

    warning(...args: any[]): void {
        nativeWarn(formatMessage(safeCtx(), getCallerInfo(this.serviceName, 2), args, 'warn'));
    }

    info(...args: any[]): void {
        nativeLog(formatMessage(safeCtx(), getCallerInfo(this.serviceName, 2), args, 'log'));
    }

    debug(...args: any[]): void {
        nativeLog(formatMessage(safeCtx(), getCallerInfo(this.serviceName, 2), args, 'log'));
    }

    // ── Internal: used by LoggerMiddleware's console patches ─────────────────
    // The patch arrow function adds one extra frame, so the real caller is at
    // depth 3: getCallerLabel → _patch → patch-arrow → real caller.

    _patch(level: 'log' | 'warn' | 'error', ...args: any[]): void {
        const native = level === 'error' ? nativeError
            : level === 'warn' ? nativeWarn
                : nativeLog;
        native(formatMessage(safeCtx(), getCallerInfo(this.serviceName, 3), args, level));
    }
}
