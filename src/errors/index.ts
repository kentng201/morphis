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

const HTTP_ERROR_DEFINITIONS = {
    400: { name: 'BadRequestError', message: 'Bad request', code: 'BAD_REQUEST' },
    401: { name: 'UnauthorizedError', message: 'Unauthorized', code: 'UNAUTHORIZED' },
    402: { name: 'PaymentRequiredError', message: 'Payment required', code: 'PAYMENT_REQUIRED' },
    403: { name: 'ForbiddenError', message: 'Forbidden', code: 'FORBIDDEN' },
    404: { name: 'NotFoundError', message: 'Not found', code: 'NOT_FOUND' },
    405: { name: 'MethodNotAllowedError', message: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' },
    406: { name: 'NotAcceptableError', message: 'Not acceptable', code: 'NOT_ACCEPTABLE' },
    407: { name: 'ProxyAuthenticationRequiredError', message: 'Proxy authentication required', code: 'PROXY_AUTHENTICATION_REQUIRED' },
    408: { name: 'RequestTimeoutError', message: 'Request timeout', code: 'REQUEST_TIMEOUT' },
    409: { name: 'ConflictError', message: 'Conflict', code: 'CONFLICT' },
    410: { name: 'GoneError', message: 'Gone', code: 'GONE' },
    411: { name: 'LengthRequiredError', message: 'Length required', code: 'LENGTH_REQUIRED' },
    412: { name: 'PreconditionFailedError', message: 'Precondition failed', code: 'PRECONDITION_FAILED' },
    413: { name: 'PayloadTooLargeError', message: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' },
    414: { name: 'UriTooLongError', message: 'URI too long', code: 'URI_TOO_LONG' },
    415: { name: 'UnsupportedMediaTypeError', message: 'Unsupported media type', code: 'UNSUPPORTED_MEDIA_TYPE' },
    416: { name: 'RangeNotSatisfiableError', message: 'Range not satisfiable', code: 'RANGE_NOT_SATISFIABLE' },
    417: { name: 'ExpectationFailedError', message: 'Expectation failed', code: 'EXPECTATION_FAILED' },
    418: { name: 'ImATeapotError', message: "I'm a teapot", code: 'IM_A_TEAPOT' },
    421: { name: 'MisdirectedRequestError', message: 'Misdirected request', code: 'MISDIRECTED_REQUEST' },
    422: { name: 'UnprocessableEntityError', message: 'Unprocessable entity', code: 'UNPROCESSABLE_ENTITY' },
    423: { name: 'LockedError', message: 'Locked', code: 'LOCKED' },
    424: { name: 'FailedDependencyError', message: 'Failed dependency', code: 'FAILED_DEPENDENCY' },
    425: { name: 'TooEarlyError', message: 'Too early', code: 'TOO_EARLY' },
    426: { name: 'UpgradeRequiredError', message: 'Upgrade required', code: 'UPGRADE_REQUIRED' },
    428: { name: 'PreconditionRequiredError', message: 'Precondition required', code: 'PRECONDITION_REQUIRED' },
    429: { name: 'TooManyRequestsError', message: 'Too many requests', code: 'TOO_MANY_REQUESTS' },
    431: { name: 'RequestHeaderFieldsTooLargeError', message: 'Request header fields too large', code: 'REQUEST_HEADER_FIELDS_TOO_LARGE' },
    451: { name: 'UnavailableForLegalReasonsError', message: 'Unavailable for legal reasons', code: 'UNAVAILABLE_FOR_LEGAL_REASONS' },
    500: { name: 'InternalServerError', message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' },
    501: { name: 'NotImplementedError', message: 'Not implemented', code: 'NOT_IMPLEMENTED' },
    502: { name: 'BadGatewayError', message: 'Bad gateway', code: 'BAD_GATEWAY' },
    503: { name: 'ServiceUnavailableError', message: 'Service unavailable', code: 'SERVICE_UNAVAILABLE' },
    504: { name: 'GatewayTimeoutError', message: 'Gateway timeout', code: 'GATEWAY_TIMEOUT' },
    505: { name: 'HttpVersionNotSupportedError', message: 'HTTP version not supported', code: 'HTTP_VERSION_NOT_SUPPORTED' },
    506: { name: 'VariantAlsoNegotiatesError', message: 'Variant also negotiates', code: 'VARIANT_ALSO_NEGOTIATES' },
    507: { name: 'InsufficientStorageError', message: 'Insufficient storage', code: 'INSUFFICIENT_STORAGE' },
    508: { name: 'LoopDetectedError', message: 'Loop detected', code: 'LOOP_DETECTED' },
    510: { name: 'NotExtendedError', message: 'Not extended', code: 'NOT_EXTENDED' },
    511: { name: 'NetworkAuthenticationRequiredError', message: 'Network authentication required', code: 'NETWORK_AUTHENTICATION_REQUIRED' },
} as const;

export type HttpErrorStatusCode = keyof typeof HTTP_ERROR_DEFINITIONS;

type StandardHttpErrorConstructor = new (
    message?: string,
    options?: Omit<HttpErrorOptions, 'statusCode'>,
) => HttpError;

export const HTTP_ERROR_STATUS_CODES = Object.freeze(
    Object.keys(HTTP_ERROR_DEFINITIONS).map(statusCode => Number(statusCode)) as HttpErrorStatusCode[],
);

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

function createHttpErrorClass(statusCode: HttpErrorStatusCode): StandardHttpErrorConstructor {
    const definition = HTTP_ERROR_DEFINITIONS[statusCode];

    return class extends HttpError {
        constructor(message: string = definition.message, options: Omit<HttpErrorOptions, 'statusCode'> = {}) {
            super(message, {
                ...options,
                statusCode,
                code: options.code ?? definition.code,
            });
            this.name = definition.name;
        }
    };
}

export function isHttpErrorStatusCode(statusCode: number): statusCode is HttpErrorStatusCode {
    return statusCode in HTTP_ERROR_DEFINITIONS;
}

export function getHttpErrorStatusText(statusCode: number): string | undefined {
    return isHttpErrorStatusCode(statusCode) ? HTTP_ERROR_DEFINITIONS[statusCode].message : undefined;
}

export function getHttpErrorCode(statusCode: number): string | undefined {
    return isHttpErrorStatusCode(statusCode) ? HTTP_ERROR_DEFINITIONS[statusCode].code : undefined;
}

export function createHttpError(
    statusCode: number,
    message?: string,
    options: Omit<HttpErrorOptions, 'statusCode'> = {},
): HttpError {
    const definition = isHttpErrorStatusCode(statusCode) ? HTTP_ERROR_DEFINITIONS[statusCode] : undefined;
    const error = new HttpError(message ?? definition?.message ?? 'Internal server error', {
        ...options,
        statusCode,
        code: options.code ?? definition?.code,
    });

    if (definition) error.name = definition.name;

    return error;
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

export const BadRequestError = createHttpErrorClass(400);
export const UnauthorizedError = createHttpErrorClass(401);
export const PaymentRequiredError = createHttpErrorClass(402);
export const ForbiddenError = createHttpErrorClass(403);
export const NotFoundError = createHttpErrorClass(404);
export const MethodNotAllowedError = createHttpErrorClass(405);
export const NotAcceptableError = createHttpErrorClass(406);
export const ProxyAuthenticationRequiredError = createHttpErrorClass(407);
export const RequestTimeoutError = createHttpErrorClass(408);
export const ConflictError = createHttpErrorClass(409);
export const GoneError = createHttpErrorClass(410);
export const LengthRequiredError = createHttpErrorClass(411);
export const PreconditionFailedError = createHttpErrorClass(412);
export const PayloadTooLargeError = createHttpErrorClass(413);
export const UriTooLongError = createHttpErrorClass(414);
export const UnsupportedMediaTypeError = createHttpErrorClass(415);
export const RangeNotSatisfiableError = createHttpErrorClass(416);
export const ExpectationFailedError = createHttpErrorClass(417);
export const ImATeapotError = createHttpErrorClass(418);
export const MisdirectedRequestError = createHttpErrorClass(421);
export const UnprocessableEntityError = createHttpErrorClass(422);
export const LockedError = createHttpErrorClass(423);
export const FailedDependencyError = createHttpErrorClass(424);
export const TooEarlyError = createHttpErrorClass(425);
export const UpgradeRequiredError = createHttpErrorClass(426);
export const PreconditionRequiredError = createHttpErrorClass(428);
export const TooManyRequestsError = createHttpErrorClass(429);
export const RequestHeaderFieldsTooLargeError = createHttpErrorClass(431);
export const UnavailableForLegalReasonsError = createHttpErrorClass(451);
export const InternalServerError = createHttpErrorClass(500);
export const NotImplementedError = createHttpErrorClass(501);
export const BadGatewayError = createHttpErrorClass(502);
export const ServiceUnavailableError = createHttpErrorClass(503);
export const GatewayTimeoutError = createHttpErrorClass(504);
export const HttpVersionNotSupportedError = createHttpErrorClass(505);
export const VariantAlsoNegotiatesError = createHttpErrorClass(506);
export const InsufficientStorageError = createHttpErrorClass(507);
export const LoopDetectedError = createHttpErrorClass(508);
export const NotExtendedError = createHttpErrorClass(510);
export const NetworkAuthenticationRequiredError = createHttpErrorClass(511);

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
        const mappedMessage = getHttpErrorStatusText(statusCode);
        const mappedCode = getHttpErrorCode(statusCode);
        const errors = isErrorMap(error.errors) ? error.errors : undefined;
        const message = typeof error.message === 'string'
            ? error.message
            : errors
                ? 'Validation failed'
                : mappedMessage ?? 'Internal server error';

        return {
            raw: error,
            name: typeof error.name === 'string' ? error.name : 'Error',
            message,
            statusCode,
            code: typeof error.code === 'string' ? error.code : mappedCode,
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