import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
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

function safeJson(value: unknown): string {
    return JSON.stringify(toSerializable(value, new WeakSet<object>()), null, 2);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (Object.prototype.toString.call(value) !== '[object Object]') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function toSerializable(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
    if (valueType === 'bigint') return `${value}n`;
    if (valueType === 'symbol') return String(value);
    if (valueType === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`;

    if (!(value instanceof Object)) return String(value);
    if (seen.has(value)) return '[...circular]';
    seen.add(value);

    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof URL) return value.toString();
    if (value instanceof Headers) {
        return {
            __type: 'Headers',
            entries: Object.fromEntries(value.entries()),
        };
    }
    if (value instanceof Request) {
        return {
            __type: 'Request',
            method: value.method,
            url: value.url,
            headers: toSerializable(value.headers, seen),
            bodyUsed: value.bodyUsed,
        };
    }
    if (value instanceof Response) {
        return {
            __type: 'Response',
            ok: value.ok,
            status: value.status,
            statusText: value.statusText,
            redirected: value.redirected,
            type: value.type,
            url: value.url,
            bodyUsed: value.bodyUsed,
            headers: toSerializable(value.headers, seen),
            body: value.body ? '[ReadableStream]' : null,
        };
    }
    if (value instanceof Error) {
        return {
            __type: value.constructor?.name || 'Error',
            name: value.name,
            message: value.message,
            stack: value.stack,
            cause: value.cause ? toSerializable(value.cause, seen) : undefined,
        };
    }
    if (value instanceof Map) {
        return {
            __type: 'Map',
            size: value.size,
            entries: Array.from(value.entries(), ([key, item]) => [toSerializable(key, seen), toSerializable(item, seen)]),
        };
    }
    if (value instanceof Set) {
        return {
            __type: 'Set',
            size: value.size,
            values: Array.from(value.values(), item => toSerializable(item, seen)),
        };
    }
    if (Array.isArray(value)) {
        return value.map(item => toSerializable(item, seen));
    }
    if (ArrayBuffer.isView(value)) {
        return {
            __type: value.constructor.name,
            values: Array.from(value as unknown as Iterable<number>),
        };
    }

    const entries = Object.entries(value);
    if (isPlainObject(value)) {
        return Object.fromEntries(entries.map(([key, item]) => [key, toSerializable(item, seen)]));
    }

    return {
        __type: value.constructor?.name || 'Object',
        ...Object.fromEntries(entries.map(([key, item]) => [key, toSerializable(item, seen)])),
    };
}

function formatInspectable(value: unknown): string {
    const json = safeJson(value);
    if (json !== undefined) return colorless ? json : colorizeJSON(json);

    return inspect(value, {
        colors: !colorless,
        depth: 4,
        compact: false,
        breakLength: 120,
    });
}

function formatArgument(value: unknown): string | null {
    if (value === null || value === undefined) return null;

    if (Array.isArray(value)) {
        if (value.length === 0) return null;
        return formatInspectable(value);
    }

    if (typeof value === 'object') {
        return formatInspectable(value);
    }

    return String(value);
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

type StackFrame = {
    raw: string;
    owner?: string;
    method?: string;
    service?: string;
    filePath?: string;
    lineNumber?: number;
};

const sourceLinesCache = new Map<string, string[]>();

function getSourceLines(filePath: string): string[] | null {
    if (filePath === 'native' || filePath.includes('[eval]')) return null;
    const cached = sourceLinesCache.get(filePath);
    if (cached) return cached;

    try {
        const lines = readFileSync(filePath, 'utf8').split('\n');
        sourceLinesCache.set(filePath, lines);
        return lines;
    } catch {
        return null;
    }
}

function inferOwnerFromSource(filePath?: string, lineNumber?: number): string | undefined {
    if (!filePath || !lineNumber) return undefined;
    const lines = getSourceLines(filePath);
    if (!lines) return undefined;

    for (let index = Math.min(lineNumber - 1, lines.length - 1); index >= 0; index -= 1) {
        const classMatch = lines[index].match(/(?:export\s+default\s+|export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/);
        if (classMatch) return classMatch[1];
    }

    return undefined;
}

function parseStackFrames(): StackFrame[] {
    const stack = new Error().stack ?? '';
    const frames: Array<StackFrame | null> = stack
        .split('\n')
        .slice(1)
        .map((line) => {
            const match = line.match(/^\s*at (?:(?:async )?(?:new )?([^\s(]+) )?\(?(.+):(\d+):(\d+)\)?$/);
            const raw = match?.[1] ?? '';
            const filePath = match?.[2];
            const lineNumber = match?.[3] ? Number(match[3]) : undefined;

            if (!match || (!raw && !filePath)) {
                return null;
            }

            const parts = raw.split('.');
            const method = raw && raw !== '<anonymous>' ? parts.at(-1) : undefined;
            const inferredOwner = inferOwnerFromSource(filePath, lineNumber);
            const owner = parts.length > 1 ? parts.at(-2) : inferredOwner;
            const serviceMatch = (owner ?? raw).match(/([A-Z][A-Za-z0-9]*Service)$/);

            return {
                raw,
                owner,
                method,
                service: serviceMatch?.[1],
                filePath,
                lineNumber,
            };
        });

    return frames.filter((frame): frame is StackFrame => frame !== null);
}

function isInternalLoggerFrame(frame: StackFrame): boolean {
    return frame.raw.startsWith('LoggerService.')
        || frame.owner === 'LoggerService'
        || frame.raw.startsWith('LoggerMiddleware.')
        || frame.raw.includes('LoggerMiddleware')
        || frame.owner === 'LoggerMiddleware'
        || frame.raw === 'parseStackFrames'
        || frame.raw === 'resolveCallerInfo'
        || frame.raw === 'formatMessage'
        || frame.raw === 'safeCtx'
        || frame.method === '_patch'
        || frame.raw.startsWith('console.');
}

function hasUsefulCallerIdentity(frame: StackFrame): boolean {
    return Boolean(frame.owner || frame.method || frame.service);
}

function resolveCallerInfo(serviceName?: string): { service?: string; method?: string; label?: string } {
    const frames = parseStackFrames();
    const directCaller = frames.find(frame => !isInternalLoggerFrame(frame) && hasUsefulCallerIdentity(frame));
    const serviceCaller = [...frames]
        .reverse()
        .find(frame => frame.service && frame.service !== LoggerService.name);

    const directOwner = directCaller?.owner ?? directCaller?.service;
    const mergedLabel = directCaller?.method && directOwner && (!serviceCaller || serviceCaller.service === directOwner)
        ? `${directOwner}.${directCaller.method}`
        : undefined;

    return {
        service: serviceCaller?.service ?? directCaller?.owner ?? serviceName,
        method: serviceCaller?.method ?? directCaller?.method,
        label: mergedLabel,
    };
}

function formatMessage(
    ctx: { trackId?: string; path?: string },
    callerInfo: { service?: string; method?: string; label?: string },
    args: any[],
    level: 'log' | 'warn' | 'error' = 'log',
): string {
    const message = args
        .map(a => formatArgument(a))
        .filter(a => a !== null)
        .join(' ');

    const parts: string[] = [`[${serverName}]`];
    if (ctx.trackId) parts.push(`[${ctx.trackId}]`);
    if (ctx.path) parts.push(`[${ctx.path}]`);
    if (callerInfo.label) parts.push(`[${callerInfo.label}]`);
    else {
        if (callerInfo.service) parts.push(`[${callerInfo.service}]`);
        if (callerInfo.method) parts.push(`[${callerInfo.method}]`);
    }

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

    error(...args: any[]): void {
        nativeError(formatMessage(safeCtx(), resolveCallerInfo(this.serviceName), args, 'error'));
    }

    warning(...args: any[]): void {
        nativeWarn(formatMessage(safeCtx(), resolveCallerInfo(this.serviceName), args, 'warn'));
    }

    info(...args: any[]): void {
        nativeLog(formatMessage(safeCtx(), resolveCallerInfo(this.serviceName), args, 'log'));
    }

    debug(...args: any[]): void {
        nativeLog(formatMessage(safeCtx(), resolveCallerInfo(this.serviceName), args, 'log'));
    }

    _patch(level: 'log' | 'warn' | 'error', ...args: any[]): void {
        const native = level === 'error' ? nativeError
            : level === 'warn' ? nativeWarn
                : nativeLog;
        native(formatMessage(safeCtx(), resolveCallerInfo(this.serviceName), args, level));
    }
}
