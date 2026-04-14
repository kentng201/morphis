import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionManager, type ConnectionEntry } from '../db/ConnectionManager';
import { current } from '../http/Context';

// ── Schema helpers ────────────────────────────────────────────────────────────

function toSnakeCase(str: string): string {
    return str
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c : '_' + c))
        .toLowerCase();
}

function toCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function pluralize(word: string): string {
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|sh|ch|x|z)$/i.test(word)) return word + 'es';
    return word + 's';
}

/**
 * Resolve a package from the target (consumer) project's node_modules,
 * then dynamically import it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importFromProject(pkg: string): Promise<any> {
    const isWorkerRuntime = typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined';

    if (isWorkerRuntime) {
        switch (pkg) {
            case 'drizzle-orm': return import('drizzle-orm');
            case 'drizzle-orm/d1': return import('drizzle-orm/d1');
            case 'drizzle-orm/sqlite-core': return import('drizzle-orm/sqlite-core');
            case 'drizzle-orm/pg-core': return import('drizzle-orm/pg-core');
            case 'drizzle-orm/mysql-core': return import('drizzle-orm/mysql-core');
            default: return import(pkg);
        }
    }

    let resolved: string;
    try {
        resolved = require.resolve(pkg, { paths: [process.cwd()] });
    } catch {
        resolved = pkg;
    }
    return import(resolved);
}

// ── Column introspection helpers ──────────────────────────────────────────────

interface ColumnMeta {
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    defaultValue: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function introspectPostgres(db: any, tableName: string): Promise<ColumnMeta[]> {
    const rows = await db.$client.query(
        `SELECT column_name, data_type, is_nullable, column_default,
                (SELECT COUNT(*) > 0 FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
                    WHERE tc.table_name = c.table_name AND kcu.column_name = c.column_name
                    AND tc.constraint_type = 'PRIMARY KEY') AS is_pk
         FROM information_schema.columns c
         WHERE table_name = $1
         ORDER BY ordinal_position`,
        [tableName],
    );
    return (rows.rows ?? rows).map((r: Record<string, string>) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        primaryKey: String((r as Record<string, unknown>).is_pk) === 'true'
            || r.is_pk === 't'
            || r.is_pk === '1',
        defaultValue: r.column_default ?? null,
    }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function introspectMysql(db: any, tableName: string): Promise<ColumnMeta[]> {
    const [rows] = await db.$client.pool.query(
        `SELECT column_name, data_type, is_nullable, column_default, column_key
         FROM information_schema.columns
         WHERE table_name = ? AND table_schema = DATABASE()
         ORDER BY ordinal_position`,
        [tableName],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({
        name: r.COLUMN_NAME ?? r.column_name,
        type: r.DATA_TYPE ?? r.data_type,
        nullable: (r.IS_NULLABLE ?? r.is_nullable) === 'YES',
        primaryKey: (r.COLUMN_KEY ?? r.column_key) === 'PRI',
        defaultValue: r.COLUMN_DEFAULT ?? r.column_default ?? null,
    }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function introspectSqlite(db: any, tableName: string): ColumnMeta[] {
    const rows = db.$client.query(`PRAGMA table_info(${tableName})`).all();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({
        name: r.name,
        type: r.type,
        nullable: r.notnull === 0,
        primaryKey: r.pk === 1,
        defaultValue: r.dflt_value,
    }));
}

function quoteSqliteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function introspectD1(db: any, tableName: string): Promise<ColumnMeta[]> {
    if (typeof db.$client?.prepare === 'function') {
        const result = await db.$client.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all();
        const rows = Array.isArray(result) ? result : (result?.results ?? []);
        return rows.map((r: Record<string, any>) => ({
            name: String(r.name),
            type: String(r.type ?? 'TEXT'),
            nullable: Number(r.notnull ?? 0) === 0,
            primaryKey: Number(r.pk ?? 0) === 1,
            defaultValue: (r.dflt_value as string | null | undefined) ?? null,
        }));
    }

    return introspectSqlite(db, tableName);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function introspectMssql(db: any, tableName: string): Promise<ColumnMeta[]> {
    const result = await db.$client.query(
        `SELECT column_name, data_type, is_nullable, column_default,
                CASE WHEN EXISTS (
                    SELECT 1 FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
                    WHERE tc.table_name = c.table_name AND kcu.column_name = c.column_name
                    AND tc.constraint_type = 'PRIMARY KEY'
                ) THEN 1 ELSE 0 END AS is_pk
         FROM information_schema.columns c
         WHERE table_name = '${tableName}'
         ORDER BY ordinal_position`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result.recordset ?? []).map((r: any) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        primaryKey: r.is_pk === 1,
        defaultValue: r.column_default ?? null,
    }));
}

/**
 * Build a Drizzle table definition from introspected column metadata.
 * This dynamically imports the correct drizzle-orm core module from the
 * consumer project.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDrizzleTable(driver: string, tableName: string, columns: ColumnMeta[]): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let coreMod: any;
    let tableBuilder: string;

    switch (driver) {
        case 'postgres':
            coreMod = await importFromProject('drizzle-orm/pg-core');
            tableBuilder = 'pgTable';
            break;
        case 'mysql':
        case 'mariadb':
            coreMod = await importFromProject('drizzle-orm/mysql-core');
            tableBuilder = 'mysqlTable';
            break;
        case 'sqlite':
        case 'd1':
            coreMod = await importFromProject('drizzle-orm/sqlite-core');
            tableBuilder = 'sqliteTable';
            break;
        case 'mssql':
            coreMod = await importFromProject('drizzle-orm/mssql-core');
            tableBuilder = 'mssqlTable';
            break;
        default:
            throw new Error(`Cannot build Drizzle table for driver: "${driver}"`);
    }

    const createTable = coreMod[tableBuilder];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const columnDefs: Record<string, any> = {};

    for (const col of columns) {
        columnDefs[col.name] = await buildColumn(coreMod, driver, col);
    }

    return createTable(tableName, columnDefs);
}

/**
 * Map a single column's SQL type to a Drizzle column builder call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildColumn(mod: any, driver: string, col: ColumnMeta): Promise<any> {
    const t = col.type.toUpperCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let c: any;

    if (/^(INT|INTEGER|INT4)/.test(t)) {
        c = mod.integer(col.name);
    } else if (/^(BIGINT|INT8)/.test(t)) {
        c = mod.bigint?.(col.name, { mode: 'number' }) ?? mod.integer(col.name);
    } else if (/^(SMALLINT|INT2)/.test(t)) {
        c = mod.smallint?.(col.name) ?? mod.integer(col.name);
    } else if (/^(BOOLEAN|BOOL|TINYINT\(1\))/.test(t)) {
        c = mod.boolean(col.name);
    } else if (/^(FLOAT|REAL)/.test(t)) {
        c = mod.real?.(col.name) ?? mod.doublePrecision?.(col.name) ?? mod.integer(col.name);
    } else if (/^(DOUBLE|DECIMAL|NUMERIC)/.test(t)) {
        c = mod.doublePrecision?.(col.name) ?? mod.numeric?.(col.name) ?? mod.text(col.name);
    } else if (/^(SERIAL)/.test(t)) {
        c = mod.serial?.(col.name) ?? mod.integer(col.name);
    } else if (/^(BIGSERIAL)/.test(t)) {
        c = mod.bigserial?.(col.name, { mode: 'number' }) ?? mod.integer(col.name);
    } else if (/^(TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT)/.test(t)) {
        c = mod.text(col.name);
    } else if (/^(VARCHAR|CHARACTER VARYING|CHAR|NVARCHAR)/.test(t)) {
        c = mod.varchar?.(col.name) ?? mod.text(col.name);
    } else if (/^(JSONB)/.test(t)) {
        c = mod.jsonb?.(col.name) ?? mod.json?.(col.name) ?? mod.text(col.name);
    } else if (/^(JSON)/.test(t)) {
        c = mod.json?.(col.name) ?? mod.text(col.name);
    } else if (/^(TIMESTAMP|DATETIME)/.test(t)) {
        c = mod.timestamp?.(col.name) ?? mod.text(col.name);
    } else if (/^(DATE)/.test(t)) {
        c = mod.date?.(col.name) ?? mod.text(col.name);
    } else if (/^(TIME)/.test(t)) {
        c = mod.time?.(col.name) ?? mod.text(col.name);
    } else if (/^(BLOB|BYTEA|VARBINARY|BINARY)/.test(t)) {
        c = mod.customType?.({
            dataType: () => col.type,
        })(col.name) ?? mod.text(col.name);
    } else {
        c = mod.text(col.name);
    }

    const rawDefault = typeof col.defaultValue === 'string' ? col.defaultValue.trim() : col.defaultValue;
    if (rawDefault !== null && rawDefault !== undefined && rawDefault !== '' && typeof c.default === 'function') {
        const drizzleMod = await importFromProject('drizzle-orm');
        const { sql } = drizzleMod;
        const normalizedDefault = String(rawDefault).replace(/^\((.*)\)$/s, '$1').trim();
        const isCurrentTimeDefault = /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW\(\))$/i.test(normalizedDefault);

        c = isCurrentTimeDefault && typeof c.defaultNow === 'function'
            ? c.defaultNow()
            : c.default(sql.raw(normalizedDefault));
    }

    if (col.primaryKey) c = c.primaryKey();
    if (!col.nullable) c = c.notNull();

    return c;
}

// ── Query options ─────────────────────────────────────────────────────────────

export interface QueryOptions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where?: any;
    limit?: number;
    offset?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orderBy?: any;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveTableKey(table: any, key: string): string | undefined {
    if (!table || typeof table !== 'object') return undefined;
    if (key in table) return key;

    const snakeKey = toSnakeCase(key);
    if (snakeKey in table) return snakeKey;

    const camelKey = toCamelCase(key);
    if (camelKey in table) return camelKey;

    for (const [candidateKey, column] of Object.entries(table as Record<string, unknown>)) {
        const columnName = (column as { name?: string })?.name;
        if (typeof columnName !== 'string') continue;
        if (columnName === key || columnName === snakeKey || toCamelCase(columnName) === key) {
            return candidateKey;
        }
    }

    return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveTableColumn(table: any, key: string): any {
    const resolvedKey = resolveTableKey(table, key);
    return resolvedKey ? table[resolvedKey] : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeInputRecord(table: any, values: Record<string, any>): Record<string, any> {
    if (!isPlainObject(values)) return values;

    const normalized: Record<string, any> = {};
    for (const [key, value] of Object.entries(values)) {
        normalized[resolveTableKey(table, key) ?? key] = value;
    }
    return normalized;
}

function normalizeOutputRecord<T extends Record<string, unknown>>(row: T): T {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        const outputKey = key.includes('_') ? toCamelCase(key) : key;
        if (!(outputKey in normalized)) {
            normalized[outputKey] = value;
        }
    }

    return normalized as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function normalizeWhere(table: any, where: unknown): Promise<any> {
    if (!isPlainObject(where)) return where;

    const drizzleMod = await importFromProject('drizzle-orm');
    const { and, eq, isNull } = drizzleMod;
    const predicates = Object.entries(where).map(([key, value]) => {
        const column = resolveTableColumn(table, key);
        if (!column) {
            throw new Error(`Unknown column "${key}" in where clause`);
        }

        return value === null ? isNull(column) : eq(column, value);
    });

    if (predicates.length === 0) return undefined;
    if (predicates.length === 1) return predicates[0];
    return and(...predicates);
}

function withModelTrace<T>(
    modelName: string,
    methodName: string,
    run: () => Promise<T>,
): Promise<T> {
    const callSite = new Error(`[Morphis Trace] ${modelName}.${methodName}`);

    return run().catch((err: unknown) => {
        const traceFrames = buildModelTraceFrames(callSite.stack, methodName, current.trace ?? []);
        const traceBlock = traceFrames.length > 0 ? `\n${traceFrames.join('\n')}` : '';

        if (err instanceof Error) {
            if (traceFrames.length > 0 && !traceFrames.every(frame => err.stack?.includes(frame))) {
                err.stack = `${err.stack ?? `${err.name}: ${err.message}`}${traceBlock}`;
            }
            throw err;
        }

        const wrapped = new Error(String(err));
        wrapped.stack = `${wrapped.stack ?? `Error: ${wrapped.message}`}${traceBlock}`;
        throw wrapped;
    });
}

type TraceFrame = {
    raw: string;
    filePath?: string;
    lineNumber?: number;
    columnNumber?: number;
    method?: string;
    owner?: string;
};

type TraceIdentity = {
    owner?: string;
    method?: string;
    columnNumber?: number;
};

const modelSourceCache = new Map<string, string[]>();
const traceLabelCache = new Map<string, string | null>();

function getModelSourceLines(filePath: string): string[] | null {
    if (filePath === 'native' || filePath.startsWith('node:') || filePath.includes('[eval]')) return null;
    const cached = modelSourceCache.get(filePath);
    if (cached) return cached;

    try {
        const lines = readFileSync(filePath, 'utf8').split('\n');
        modelSourceCache.set(filePath, lines);
        return lines;
    } catch {
        return null;
    }
}

function inferTraceIdentity(filePath?: string, lineNumber?: number): TraceIdentity {
    if (!filePath || !lineNumber) return {};
    const lines = getModelSourceLines(filePath);
    if (!lines) return {};

    let owner: string | undefined;
    let method: string | undefined;
    let columnNumber: number | undefined;

    for (let index = Math.min(lineNumber - 1, lines.length - 1); index >= 0; index -= 1) {
        const line = lines[index];
        const classMatch = line.match(/(?:export\s+default\s+|export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/);
        if (!owner && classMatch) owner = classMatch[1];

        const methodMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
        if (!method && methodMatch && methodMatch[1] !== 'constructor') {
            method = methodMatch[1];
            columnNumber = line.indexOf(method) + 1;
        }

        const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
        if (!method && functionMatch) {
            method = functionMatch[1];
            columnNumber = line.indexOf(method) + 1;
        }

        if (owner && method) break;
    }

    return { owner, method, columnNumber };
}

function walkSourceFiles(dirPath: string): string[] {
    try {
        return readdirSync(dirPath).flatMap((entry) => {
            const fullPath = join(dirPath, entry);
            const stats = statSync(fullPath);
            if (stats.isDirectory()) return walkSourceFiles(fullPath);
            if (!/\.(ts|tsx|js|jsx)$/.test(entry) || entry.endsWith('.d.ts')) return [];
            return [fullPath];
        });
    } catch {
        return [];
    }
}

function resolveTraceLabelLine(label?: string): string | undefined {
    if (!label) return undefined;
    const cached = traceLabelCache.get(label);
    if (cached !== undefined) return cached ?? undefined;

    const [owner, method] = label.split('.');
    if (!owner || !method) {
        traceLabelCache.set(label, label);
        return label;
    }

    const sourceRoot = join(process.cwd(), 'src');
    for (const filePath of walkSourceFiles(sourceRoot)) {
        const lines = getModelSourceLines(filePath);
        if (!lines) continue;

        let insideOwner = false;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const classMatch = line.match(/(?:export\s+default\s+|export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/);
            if (classMatch) {
                insideOwner = classMatch[1] === owner;
            }
            if (!insideOwner) continue;

            const methodMatch = line.match(new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?${method}\\s*\\(`));
            if (!methodMatch) continue;

            const column = line.indexOf(method) + 1;
            const resolved = `${method} (${filePath}:${index + 1}:${column})`;
            traceLabelCache.set(label, resolved);
            return resolved;
        }
    }

    traceLabelCache.set(label, label);
    return label;
}

function parseTraceFrames(stack?: string): TraceFrame[] {
    if (!stack) return [];

    const frames: Array<TraceFrame | null> = stack
        .split('\n')
        .slice(1)
        .map((line) => {
            const match = line.match(/^\s*at (?:(?:async )?(?:new )?([^\s(]+) )?\(?(.+):(\d+):(\d+)\)?$/);
            const raw = match?.[1] ?? '';
            const filePath = match?.[2];
            const lineNumber = match?.[3] ? Number(match[3]) : undefined;
            const columnNumber = match?.[4] ? Number(match[4]) : undefined;

            if (!match || (!raw && !filePath)) return null;

            const parts = raw.split('.');
            const inferred = inferTraceIdentity(filePath, lineNumber);
            const method = raw && raw !== '<anonymous>' ? parts[parts.length - 1] : inferred.method;
            const owner = parts.length > 1 ? parts[parts.length - 2] : inferred.owner;

            return {
                raw,
                filePath,
                lineNumber,
                columnNumber: columnNumber ?? inferred.columnNumber,
                method,
                owner,
            };
        });

    return frames.filter((frame): frame is TraceFrame => frame !== null);
}

function isInternalTraceFrame(frame: TraceFrame): boolean {
    const isNodeFile = frame.filePath !== undefined && frame.filePath.startsWith('node:');
    const isRouterWrapper = frame.filePath !== undefined
        && frame.filePath.includes('/src/http/Router.ts')
        && frame.raw === 'routeHandler';

    return frame.raw === 'withModelTrace'
        || frame.raw === 'withTrace'
        || frame.raw === 'moduleEvaluation'
        || frame.raw === 'loadAndEvaluateModule'
        || frame.raw === 'asyncModuleEvaluation'
        || frame.raw === 'run'
        || isRouterWrapper
        || frame.raw.startsWith('processTicksAndRejections')
        || frame.filePath === 'native'
        || isNodeFile;
}

function hasUsefulTraceIdentity(frame: TraceFrame): boolean {
    return Boolean(frame.owner || frame.method);
}

function formatTraceFrame(frame: TraceFrame): string | undefined {
    const label = frame.raw && frame.raw !== '<anonymous>'
        ? frame.raw
        : frame.method ?? frame.owner;
    if (!label) return undefined;

    if (!frame.filePath || !frame.lineNumber) return `    at ${label}`;
    const location = `${frame.filePath}:${frame.lineNumber}${frame.columnNumber ? `:${frame.columnNumber}` : ''}`;
    return `    at ${label} (${location})`;
}

function buildModelTraceFrames(stack: string | undefined, methodName: string, trace: string[]): string[] {
    const frames = parseTraceFrames(stack)
        .filter(frame => hasUsefulTraceIdentity(frame) && !isInternalTraceFrame(frame));
    const tracedFrames = trace
        .map(label => resolveTraceLabelLine(label) ?? label)
        .map(label => `    at ${label}`);
    const traceLines: string[] = [];
    const tracedMethods = new Set(trace.map(label => label.split('.')[1]).filter(Boolean));
    const missingTracedFrames = tracedFrames.filter((_, index) => {
        const method = trace[index]?.split('.')[1];
        return method ? !frames.some(frame => frame.method === method) : true;
    });

    for (const frame of frames) {
        const formatted = formatTraceFrame(frame);
        if (!formatted) continue;

        traceLines.push(formatted);

        if (frame.method === methodName && missingTracedFrames.length > 0) {
            traceLines.push(...missingTracedFrames);
        }
    }

    if (traceLines.length === 0 && tracedFrames.length > 0) {
        traceLines.push(...tracedFrames);
    } else if (traceLines.length > 0) {
        for (const frame of missingTracedFrames) {
            if (!traceLines.includes(frame)) traceLines.push(frame);
        }
    }

    return Array.from(new Set(traceLines));
}

// ── ModelInstance wrapper ──────────────────────────────────────────────────────

export class ModelInstance {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _modelClass: typeof Model;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(modelClass: typeof Model, data: Record<string, any>) {
        this._modelClass = modelClass;
        Object.assign(this, normalizeOutputRecord(data));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async update(values: Record<string, any>): Promise<ModelInstance> {
        const M = this._modelClass;
        await M.initialize();
        const table = M.table;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = (M as any)._drizzle;
        const pkCol = findPrimaryKeyColumn(table);
        if (!pkCol) throw new Error('Cannot update: no primary key column found');

        const eqMod = await importFromProject('drizzle-orm');
        const eq = eqMod.eq;
        const normalizedValues = normalizeInputRecord(table, values);
        const primaryKeyValue = this[pkCol.name] ?? this[toCamelCase(pkCol.name)];

        const result = await db.update(table).set(normalizedValues).where(eq(pkCol, primaryKeyValue)).returning();
        const row = normalizeOutputRecord(result[0] ?? { ...this, ...normalizedValues });
        Object.assign(this, row);
        return this;
    }

    async destroy(): Promise<void> {
        const M = this._modelClass;
        await M.initialize();
        const table = M.table;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = (M as any)._drizzle;
        const pkCol = findPrimaryKeyColumn(table);
        if (!pkCol) throw new Error('Cannot destroy: no primary key column found');

        const eqMod = await importFromProject('drizzle-orm');
        const eq = eqMod.eq;
        const primaryKeyValue = this[pkCol.name] ?? this[toCamelCase(pkCol.name)];

        await db.delete(table).where(eq(pkCol, primaryKeyValue));
    }

    toJSON(): Record<string, unknown> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: Record<string, any> = {};
        for (const key of Object.keys(this)) {
            if (key === '_modelClass') continue;
            result[key] = this[key];
        }
        return result;
    }
}

/**
 * Find primary key column from a Drizzle table definition.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findPrimaryKeyColumn(table: any): any {
    for (const col of Object.values(table)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((col as any)?.primaryKey || (col as any)?.primary) return col;
    }
    // Fallback: look for column named 'id'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (table as any).id ?? null;
}

// ── Booted registry ───────────────────────────────────────────────────────────

const booted = new WeakSet<typeof Model>();

// ── Base Model ────────────────────────────────────────────────────────────────

export class Model {
    /**
     * The connection name that maps to an entry in the consuming project's
     * src/config/database.ts. Defaults to the isDefault connection.
     */
    static connection: string = 'default';

    /**
     * The database table name. Defaults to the snake_case, pluralised class name.
     * Override in a subclass for a custom name.
     */
    static tableName: string = '';

    /**
     * Set by subclass after `morphis sync:model` generates a `.schema.ts` file.
     * When set, `initialize()` skips runtime introspection and uses this typed table.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static schema?: any;

    /** @internal Runtime-introspected Drizzle table (used when schema is not set). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static _table: any;
    /** @internal Cached Drizzle db instance. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static _drizzle: any;
    /** @internal Cached driver name. */
    private static _driver: string;
    /** @internal Last initialization error, if any. */
    private static _initializationError?: Error;

    /**
     * Derive the default table name from the class name (PascalCase → snake_case + plural).
     * e.g.  Post → posts,  UserProfile → user_profiles
     */
    static get inferredTableName(): string {
        return pluralize(toSnakeCase(this.name));
    }

    /**
     * Returns the Drizzle table definition. Uses `schema` if set by the subclass,
     * otherwise falls back to the runtime-introspected `_table`.
     * Throws if `initialize()` has not been called yet.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static get table(): any {
        const t = this.schema ?? this._table;
        if (!t) {
            const reason = this._initializationError
                ? ` Initialization failed: ${this._initializationError.message}`
                : ` Call ${this.name}.initialize() or bootstrap([${this.name}]) first.`;
            throw new Error(`${this.name}.table is not available.${reason}`);
        }
        return t;
    }

    /**
     * Connect to the database and initialise this model by introspecting the
     * live table schema (unless `schema` is set). Idempotent — safe to call
     * multiple times; subsequent calls return immediately.
     */
    static async initialize(): Promise<void> {
        if (booted.has(this)) return;

        this._initializationError = undefined;

        const entry: ConnectionEntry = await ConnectionManager.get(this.connection);
        this._drizzle = entry.db;
        this._driver = entry.driver;

        if (this.schema) {
            // Schema provided by sync:model — no introspection needed.
            this._initializationError = undefined;
            booted.add(this);
            return;
        }

        const tableName = (this.tableName && this.tableName !== '')
            ? this.tableName
            : this.inferredTableName;

        let columns: ColumnMeta[] = [];

        try {
            switch (this._driver) {
                case 'postgres':
                    columns = await introspectPostgres(entry.db, tableName);
                    break;
                case 'mysql':
                case 'mariadb':
                    columns = await introspectMysql(entry.db, tableName);
                    break;
                case 'sqlite':
                    columns = introspectSqlite(entry.db, tableName);
                    break;
                case 'd1':
                    columns = await introspectD1(entry.db, tableName);
                    break;
                case 'mssql':
                    columns = await introspectMssql(entry.db, tableName);
                    break;
            }
        } catch (err) {
            this._initializationError = err instanceof Error ? err : new Error(String(err));
            return;
        }

        if (columns.length === 0) {
            this._initializationError = new Error(
                `Table "${tableName}" could not be introspected for the "${this._driver}" connection. Check that the database is reachable and the table exists.`,
            );
            return;
        }

        this._table = await buildDrizzleTable(this._driver, tableName, columns);
        this._initializationError = undefined;
        booted.add(this);
    }

    // ── Drizzle builder shortcut ─────────────────────────────────────────────

    /**
     * Returns a raw Drizzle select query builder: `db.select().from(table)`.
     * Results are plain row objects, fully chainable with `.where()`, `.limit()`, etc.
     *
     * @example
     * const posts = await Post.find().where(eq(Post.table.id, 1)).limit(10);
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async find(): Promise<any> {
        await this.initialize();
        return this._drizzle.select().from(this.table);
    }

    // ── Sequelize-like compat methods ────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async findAll(this: any, options?: QueryOptions): Promise<ModelInstance[]> {
        return withModelTrace(this.name, 'findAll', async () => {
            await this.initialize();
            let query = this._drizzle.select().from(this.table);
            const where = await normalizeWhere(this.table, options?.where);
            if (where) query = query.where(where);
            if (options?.orderBy) query = query.orderBy(options.orderBy);
            if (options?.limit) query = query.limit(options.limit);
            if (options?.offset) query = query.offset(options.offset);
            const rows = await query;
            return rows.map((r: Record<string, unknown>) => new ModelInstance(this, r));
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async findOne(this: any, options?: QueryOptions): Promise<ModelInstance | null> {
        return withModelTrace(this.name, 'findOne', async () => {
            await this.initialize();
            let query = this._drizzle.select().from(this.table);
            const where = await normalizeWhere(this.table, options?.where);
            if (where) query = query.where(where);
            if (options?.orderBy) query = query.orderBy(options.orderBy);
            query = query.limit(1);
            const rows = await query;
            return rows.length > 0 ? new ModelInstance(this, rows[0]) : null;
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async findByPk(this: any, id: any, options?: Omit<QueryOptions, 'where'>): Promise<ModelInstance | null> {
        return withModelTrace(this.name, 'findByPk', async () => {
            await this.initialize();
            const pkCol = findPrimaryKeyColumn(this.table);
            if (!pkCol) throw new Error('Cannot findByPk: no primary key column found');

            const eqMod = await importFromProject('drizzle-orm');
            const eq = eqMod.eq;

            let query = this._drizzle.select().from(this.table).where(eq(pkCol, id));
            if (options?.orderBy) query = query.orderBy(options.orderBy);
            query = query.limit(1);
            const rows = await query;
            return rows.length > 0 ? new ModelInstance(this, rows[0]) : null;
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async create(this: any, values: Record<string, any>): Promise<ModelInstance> {
        return withModelTrace(this.name, 'create', async () => {
            await this.initialize();
            const normalizedValues = normalizeInputRecord(this.table, values);
            const result = await this._drizzle.insert(this.table).values(normalizedValues).returning();
            return new ModelInstance(this, result[0] ?? normalizeOutputRecord(normalizedValues));
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async bulkCreate(this: any, records: Record<string, any>[]): Promise<ModelInstance[]> {
        return withModelTrace(this.name, 'bulkCreate', async () => {
            await this.initialize();
            const normalizedRecords = records.map((record: Record<string, any>) => normalizeInputRecord(this.table, record));
            const result = await this._drizzle.insert(this.table).values(normalizedRecords).returning();
            return result.map((r: Record<string, unknown>) => new ModelInstance(this, r));
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async update(this: any, values: Record<string, any>, options: Pick<QueryOptions, 'where'>): Promise<any[]> {
        return withModelTrace(this.name, 'update', async () => {
            await this.initialize();
            const normalizedValues = normalizeInputRecord(this.table, values);
            let query = this._drizzle.update(this.table).set(normalizedValues);
            const where = await normalizeWhere(this.table, options?.where);
            if (where) query = query.where(where);
            const result = await query.returning();
            return result.map((row: Record<string, unknown>) => normalizeOutputRecord(row));
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async destroy(this: any, options: Pick<QueryOptions, 'where'>): Promise<any[]> {
        return withModelTrace(this.name, 'destroy', async () => {
            await this.initialize();
            let query = this._drizzle.delete(this.table);
            const where = await normalizeWhere(this.table, options?.where);
            if (where) query = query.where(where);
            const result = await query.returning();
            return result.map((row: Record<string, unknown>) => normalizeOutputRecord(row));
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async count(this: any, options?: QueryOptions): Promise<number> {
        return withModelTrace(this.name, 'count', async () => {
            await this.initialize();
            const sqlMod = await importFromProject('drizzle-orm');
            const { sql } = sqlMod;

            let query = this._drizzle.select({ count: sql`count(*)` }).from(this.table);
            const where = await normalizeWhere(this.table, options?.where);
            if (where) query = query.where(where);
            const rows = await query;
            return Number(rows[0]?.count ?? 0);
        });
    }

    static async findAndCountAll(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this: any,
        options?: QueryOptions,
    ): Promise<{ count: number; rows: ModelInstance[] }> {
        const [count, rows] = await Promise.all([
            this.count(options),
            this.findAll(options),
        ]);
        return { count, rows };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async upsert(this: any, values: Record<string, any>): Promise<ModelInstance> {
        return withModelTrace(this.name, 'upsert', async () => {
            await this.initialize();
            const pkCol = findPrimaryKeyColumn(this.table);
            if (!pkCol) throw new Error('Cannot upsert: no primary key column found');

            const normalizedValues = normalizeInputRecord(this.table, values);
            const result = await this._drizzle
                .insert(this.table)
                .values(normalizedValues)
                .onConflictDoUpdate({
                    target: pkCol,
                    set: normalizedValues,
                })
                .returning();
            return new ModelInstance(this, result[0] ?? normalizeOutputRecord(normalizedValues));
        });
    }
}

/**
 * Initialise a set of models in parallel. Call this once at application
 * startup before handling any requests.
 *
 * @example
 * import { bootstrap } from 'morphis';
 * import { Post } from './models/Post';
 * import { User } from './models/User';
 *
 * await bootstrap([Post, User]);
 */
export async function bootstrap(models: (typeof Model)[]): Promise<void> {
    await Promise.all(models.map(m => m.initialize()));
}
