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

export interface SnowflakeConnection {
    account: string;
    username: string;
    password: string;
    database: string;
    warehouse: string;
    schema?: string;
}

export type DatabaseConfig =
    | { name: string; isDefault?: boolean; driver: 'mariadb'; connection: MariadbConnection }
    | { name: string; isDefault?: boolean; driver: 'mysql'; connection: MysqlConnection }
    | { name: string; isDefault?: boolean; driver: 'mssql'; connection: MssqlConnection }
    | { name: string; isDefault?: boolean; driver: 'postgres'; connection: PostgresConnection }
    | { name: string; isDefault?: boolean; driver: 'sqlite'; connection: SqliteConnection }
    | { name: string; isDefault?: boolean; driver: 'snowflake'; connection: SnowflakeConnection };
