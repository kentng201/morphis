import { ConnectionManager, type ConnectionEntry } from '../db/ConnectionManager';

// ── Schema helpers ────────────────────────────────────────────────────────────

function toSnakeCase(str: string): string {
    return str
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c : '_' + c))
        .toLowerCase();
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
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('p', 'return import(p)');
    let resolved: string;
    try {
        resolved = require.resolve(pkg, { paths: [process.cwd()] });
    } catch {
        resolved = pkg;
    }
    return dynamicImport(resolved);
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
        primaryKey: r.is_pk === true || r.is_pk === 't' || r.is_pk === '1',
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
        columnDefs[col.name] = buildColumn(coreMod, driver, col);
    }

    return createTable(tableName, columnDefs);
}

/**
 * Map a single column's SQL type to a Drizzle column builder call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildColumn(mod: any, driver: string, col: ColumnMeta): any {
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

// ── ModelInstance wrapper ──────────────────────────────────────────────────────

export class ModelInstance {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _modelClass: typeof Model;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(modelClass: typeof Model, data: Record<string, any>) {
        this._modelClass = modelClass;
        Object.assign(this, data);
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

        const result = await db.update(table).set(values).where(eq(pkCol, this[pkCol.name])).returning();
        const row = result[0] ?? { ...this, ...values };
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

        await db.delete(table).where(eq(pkCol, this[pkCol.name]));
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
            throw new Error(
                `${this.name}.table is not available. Call ${this.name}.initialize() or bootstrap([${this.name}]) first.`,
            );
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

        const entry: ConnectionEntry = await ConnectionManager.get(this.connection);
        this._drizzle = entry.db;
        this._driver = entry.driver;

        if (this.schema) {
            // Schema provided by sync:model — no introspection needed.
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
                case 'mssql':
                    columns = await introspectMssql(entry.db, tableName);
                    break;
            }
        } catch {
            // Table not yet created — _table stays undefined; queries will fail
            // at the DB layer with a descriptive error.
        }

        if (columns.length > 0) {
            this._table = await buildDrizzleTable(this._driver, tableName, columns);
        }

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
        await this.initialize();
        let query = this._drizzle.select().from(this.table);
        if (options?.where) query = query.where(options.where);
        if (options?.orderBy) query = query.orderBy(options.orderBy);
        if (options?.limit) query = query.limit(options.limit);
        if (options?.offset) query = query.offset(options.offset);
        const rows = await query;
        return rows.map((r: Record<string, unknown>) => new ModelInstance(this, r));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async findOne(this: any, options?: QueryOptions): Promise<ModelInstance | null> {
        await this.initialize();
        let query = this._drizzle.select().from(this.table);
        if (options?.where) query = query.where(options.where);
        if (options?.orderBy) query = query.orderBy(options.orderBy);
        query = query.limit(1);
        const rows = await query;
        return rows.length > 0 ? new ModelInstance(this, rows[0]) : null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async findByPk(this: any, id: any, options?: Omit<QueryOptions, 'where'>): Promise<ModelInstance | null> {
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
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async create(this: any, values: Record<string, any>): Promise<ModelInstance> {
        await this.initialize();
        const result = await this._drizzle.insert(this.table).values(values).returning();
        return new ModelInstance(this, result[0] ?? values);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async bulkCreate(this: any, records: Record<string, any>[]): Promise<ModelInstance[]> {
        await this.initialize();
        const result = await this._drizzle.insert(this.table).values(records).returning();
        return result.map((r: Record<string, unknown>) => new ModelInstance(this, r));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async update(this: any, values: Record<string, any>, options: Pick<QueryOptions, 'where'>): Promise<any[]> {
        await this.initialize();
        let query = this._drizzle.update(this.table).set(values);
        if (options?.where) query = query.where(options.where);
        const result = await query.returning();
        return result;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async destroy(this: any, options: Pick<QueryOptions, 'where'>): Promise<any[]> {
        await this.initialize();
        let query = this._drizzle.delete(this.table);
        if (options?.where) query = query.where(options.where);
        const result = await query.returning();
        return result;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async count(this: any, options?: QueryOptions): Promise<number> {
        await this.initialize();
        const sqlMod = await importFromProject('drizzle-orm');
        const { sql } = sqlMod;

        let query = this._drizzle.select({ count: sql`count(*)` }).from(this.table);
        if (options?.where) query = query.where(options.where);
        const rows = await query;
        return Number(rows[0]?.count ?? 0);
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
        await this.initialize();
        const pkCol = findPrimaryKeyColumn(this.table);
        if (!pkCol) throw new Error('Cannot upsert: no primary key column found');

        const result = await this._drizzle
            .insert(this.table)
            .values(values)
            .onConflictDoUpdate({
                target: pkCol,
                set: values,
            })
            .returning();
        return new ModelInstance(this, result[0] ?? values);
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
