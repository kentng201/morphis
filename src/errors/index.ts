import type { Request } from '../http/types';

type HeaderValue = string | readonly string[];
export type HeaderInit = Headers | Record<string, HeaderValue> | Array<[string, string]>;

export interface HttpErrorOptions {
    statusCode?: number;
    code?: string;
    headers?: HeaderInit;
    details?: unknown;
    expose?: boolean;
    cause?: unknown;
    body?: unknown;
}

export interface NormalizedError {
    raw: unknown;
    name: string;
    message: string;
    statusCode: number;
    code?: string;
    headers: Headers;
    details?: unknown;
    expose: boolean;
    errors?: Record<string, string[]>;
    body?: unknown;
}

export interface ErrorFormatterContext {
    request?: Request;
    trackId?: string;
}

export interface FormattedError {
    statusCode: number;
    headers?: HeaderInit;
    body: unknown;
}

export type ErrorFormatter = (
    error: NormalizedError,
    context: ErrorFormatterContext,
) => FormattedError | Promise<FormattedError>;

export class HttpError extends Error {
    readonly statusCode: number;
    readonly code?: string;
    readonly headers: Headers;
    readonly details?: unknown;
    readonly expose: boolean;
    protected readonly body?: unknown;

    constructor(message: string, options: HttpErrorOptions = {}) {
        super(message);
        this.name = new.target.name;
        this.statusCode = options.statusCode ?? 500;
        this.code = options.code;
        this.headers = asHeaders(options.headers);
        this.details = options.details;
        this.expose = options.expose ?? true;
        this.body = options.body;

        if (options.cause !== undefined && !(this as { cause?: unknown }).cause) {
            (this as { cause?: unknown }).cause = options.cause;
        }
    }

    toResponseBody(): unknown {
        if (this.body !== undefined) return this.body;
        return { error: this.message };
    }
}

export class ValidationError extends HttpError {
    readonly errors: Record<string, string[]>;

    constructor(
        errors: Record<string, string[]>,
        message: string = 'Validation failed',
        options: Omit<HttpErrorOptions, 'statusCode'> = {},
    ) {
        super(message, {
            ...options,
            statusCode: 400,
            code: options.code ?? 'VALIDATION_ERROR',
        });
        this.errors = errors;
    }

    override toResponseBody(): unknown {
        if (this.body !== undefined) return this.body;
        return { errors: this.errors };
    }
}

export class NotFoundError extends HttpError {
    constructor(message: string = 'Not found', options: Omit<HttpErrorOptions, 'statusCode'> = {}) {
        super(message, {
            ...options,
            statusCode: 404,
            code: options.code ?? 'NOT_FOUND',
        });
    }
}

export class ServiceUnavailableError extends HttpError {
    constructor(message: string = 'Service unavailable', options: Omit<HttpErrorOptions, 'statusCode'> = {}) {
        super(message, {
            ...options,
            statusCode: 503,
            code: options.code ?? 'SERVICE_UNAVAILABLE',
        });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isErrorMap(value: unknown): value is Record<string, string[]> {
    if (!isRecord(value)) return false;
    return Object.values(value).every(item => Array.isArray(item) && item.every(entry => typeof entry === 'string'));
}

function asHeaders(value: unknown): Headers {
    if (!value) return new Headers();

    if (value instanceof Headers) {
        return new Headers(value);
    }

    const headers = new Headers();

    if (Array.isArray(value)) {
        for (const [key, headerValue] of value) {
            headers.append(key, headerValue);
        }
        return headers;
    }

    if (isRecord(value)) {
        for (const [key, headerValue] of Object.entries(value)) {
            if (Array.isArray(headerValue)) {
                for (const item of headerValue) {
                    headers.append(key, item);
                }
                continue;
            }

            if (typeof headerValue === 'string') {
                headers.append(key, headerValue);
            }
        }
    }

    return headers;
}

function resolveBody(error: unknown): unknown {
    if (error instanceof HttpError) return error.toResponseBody();

    if (isRecord(error) && typeof error.toResponseBody === 'function') {
        return (error.toResponseBody as () => unknown).call(error);
    }

    if (isRecord(error) && 'body' in error) {
        return error.body;
    }

    return undefined;
}

export function normalizeError(error: unknown): NormalizedError {
    if (error instanceof ValidationError) {
        return {
            raw: error,
            name: error.name,
            message: error.message,
            statusCode: error.statusCode,
            code: error.code,
            headers: new Headers(error.headers),
            details: error.details,
            expose: error.expose,
            errors: error.errors,
            body: error.toResponseBody(),
        };
    }

    if (error instanceof HttpError) {
        return {
            raw: error,
            name: error.name,
            message: error.message,
            statusCode: error.statusCode,
            code: error.code,
            headers: new Headers(error.headers),
            details: error.details,
            expose: error.expose,
            body: error.toResponseBody(),
        };
    }

    if (isRecord(error)) {
        const statusCode = typeof error.statusCode === 'number'
            ? error.statusCode
            : typeof error.status === 'number'
                ? error.status
                : 500;
        const errors = isErrorMap(error.errors) ? error.errors : undefined;
        const message = typeof error.message === 'string'
            ? error.message
            : errors
                ? 'Validation failed'
                : 'Internal server error';

        return {
            raw: error,
            name: typeof error.name === 'string' ? error.name : 'Error',
            message,
            statusCode,
            code: typeof error.code === 'string' ? error.code : undefined,
            headers: asHeaders(error.headers),
            details: error.details,
            expose: typeof error.expose === 'boolean' ? error.expose : true,
            errors,
            body: resolveBody(error),
        };
    }

    if (error instanceof Error) {
        return {
            raw: error,
            name: error.name,
            message: error.message,
            statusCode: 500,
            headers: new Headers(),
            expose: true,
            body: { error: error.message },
        };
    }

    return {
        raw: error,
        name: 'Error',
        message: String(error),
        statusCode: 500,
        headers: new Headers(),
        expose: true,
        body: { error: String(error) },
    };
}

export const defaultErrorFormatter: ErrorFormatter = (error) => {
    if (error.body !== undefined) {
        return {
            statusCode: error.statusCode,
            headers: error.headers,
            body: error.body,
        };
    }

    if (error.errors) {
        return {
            statusCode: error.statusCode,
            headers: error.headers,
            body: { errors: error.errors },
        };
    }

    return {
        statusCode: error.statusCode,
        headers: error.headers,
        body: { error: error.expose ? error.message : 'Internal server error' },
    };
};

export async function formatErrorPayload(
    error: unknown,
    context: ErrorFormatterContext = {},
    formatter: ErrorFormatter = defaultErrorFormatter,
): Promise<{ normalized: NormalizedError; formatted: FormattedError; headers: Headers }> {
    const normalized = normalizeError(error);
    const formatted = await formatter(normalized, context);
    const headers = asHeaders(formatted.headers ?? normalized.headers);
    if (context.trackId) headers.set('X-Track-Id', context.trackId);

    return {
        normalized,
        formatted,
        headers,
    };
}

export async function createErrorResponse(
    error: unknown,
    context: ErrorFormatterContext = {},
    formatter: ErrorFormatter = defaultErrorFormatter,
): Promise<Response> {
    const { formatted, headers } = await formatErrorPayload(error, context, formatter);
    return Response.json(formatted.body, {
        status: formatted.statusCode,
        headers,
    });
}