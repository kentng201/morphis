export interface MariadbConnection {
    host: string;
    port?: number;
    database: string;
    username: string;
    password: string;
}

export interface MysqlConnection {
    host: string;
    port?: number;
    database: string;
    username: string;
    password: string;
}

export interface MssqlConnection {
    host: string;
    port?: number;
    database: string;
    username: string;
    password: string;
}

export interface PostgresConnection {
    host: string;
    port?: number;
    database: string;
    username: string;
    password: string;
}

export interface SqliteConnection {
    storage: string;
}

export interface D1Connection {
    binding?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    database?: any;
    storage?: string;
}

export type DatabaseConfig =
    | { isDefault?: boolean; driver: 'mariadb'; connection: MariadbConnection }
    | { isDefault?: boolean; driver: 'mysql'; connection: MysqlConnection }
    | { isDefault?: boolean; driver: 'mssql'; connection: MssqlConnection }
    | { isDefault?: boolean; driver: 'postgres'; connection: PostgresConnection }
    | { isDefault?: boolean; driver: 'sqlite'; connection: SqliteConnection }
    | { isDefault?: boolean; driver: 'd1'; connection: D1Connection };

/**
 * Define a database configuration map with literal key inference, preventing
 * duplicate connection names and enabling `DatabaseName<T>` type derivation.
 *
 * @example
 * const databases = defineDatabases({
 *   default: { isDefault: true, driver: 'postgres', connection: { ... } },
 *   analytics: { driver: 'postgres', connection: { ... } },
 * });
 * export type ConnectionName = DatabaseName<typeof databases>;
 * export default databases;
 */
export function defineDatabases<T extends Record<string, DatabaseConfig>>(config: T): T {
    return config;
}

/**
 * Derives a union of valid connection name strings from a `defineDatabases` result.
 *
 * @example
 * export type ConnectionName = DatabaseName<typeof databases>;
 * // → 'default' | 'analytics'
 */
export type DatabaseName<T extends Record<string, DatabaseConfig>> = keyof T & string;
