import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { runInProject } from '../utils/spawnInProject';

/** Drivers that support table introspection */
const SQL_DRIVERS = new Set(['mysql', 'mariadb', 'postgres', 'mssql', 'sqlite', 'd1']);

/** Convert PascalCase / camelCase → snake_case */
function toSnakeCase(str: string): string {
    return str
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c : '_' + c))
        .toLowerCase();
}

/** Very simple English pluraliser */
function pluralize(word: string): string {
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|sh|ch|x|z)$/i.test(word)) return word + 'es';
    return word + 's';
}

/** Map a SQL column type string to a TypeScript type */
function sqlTypeToTs(sqlType: string): string {
    const t = sqlType.toUpperCase();
    // TINYINT(1) is MySQL/MariaDB's boolean representation — check before TINYINT
    if (/^TINYINT\(1\)/.test(t)) return 'boolean';
    if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT)/.test(t)) return 'number';
    if (/^(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)/.test(t)) return 'number';
    if (/^(BOOLEAN|BOOL)/.test(t)) return 'boolean';
    if (/^(VARCHAR|TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|CHAR|STRING|NVARCHAR)/.test(t)) return 'string';
    if (/^(DATE|DATETIME|TIMESTAMP|TIME)/.test(t)) return 'Date';
    if (/^(JSON|JSONB)/.test(t)) return 'Record<string, any>';
    if (/^(BLOB|VARBINARY|BINARY)/.test(t)) return 'Buffer';
    return 'any';
}

export async function runNewModel(rest: string[]) {
    const cwd = process.cwd();

    // ── Parse flags ───────────────────────────────────────────────────────────
    const withMigration = rest.includes('-m');
    const withController = rest.includes('-c') || rest.includes('-r');
    const withResource = rest.includes('-r');
    const withFactory = rest.includes('-f');
    const withSeeder = rest.includes('-s');

    const connArg = rest.find(a => a.startsWith('--connection='));
    const connectionName = connArg ? connArg.split('=')[1] : 'default';

    // Positional: model name (PascalCase, required)
    const modelName = rest.find(a => !a.startsWith('-'));
    if (!modelName) {
        console.error(chalk.red('\n  Missing required argument: <ModelName>'));
        console.error(chalk.gray('  Example: morphis new:model Post\n'));
        process.exit(1);
    }
    if (!/^[A-Z][A-Za-z0-9]*$/.test(modelName)) {
        console.error(chalk.red('\n  Model name must be PascalCase (e.g. Post, UserProfile)\n'));
        process.exit(1);
    }

    // ── Project guard ─────────────────────────────────────────────────────────
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        console.error(chalk.red('\n  Not in a project directory — package.json not found\n'));
        process.exit(1);
    }

    const configPath = path.join(cwd, 'src', 'config', 'database.ts');
    if (!fs.existsSync(configPath)) {
        console.error(chalk.red('\n  src/config/database.ts not found. Run: morphis new:connection\n'));
        process.exit(1);
    }

    // ── Load database config ──────────────────────────────────────────────────
    let databases: Record<string, any>;
    try {
        const mod = await import(configPath);
        databases = mod.default;
    } catch (err) {
        console.error(chalk.red(
            `\n  Failed to load src/config/database.ts: ${err instanceof Error ? err.message : String(err)}\n`,
        ));
        process.exit(1);
    }

    const entries = Object.entries(databases);
    if (entries.length === 0) {
        console.error(chalk.red('\n  src/config/database.ts has no connections configured\n'));
        process.exit(1);
    }

    // ── Resolve target connection ─────────────────────────────────────────────
    const [resolvedConnectionName, config]: [string, any] = connectionName === 'default'
        ? (entries.find(([, d]) => d.isDefault) ?? entries[0])
        : [connectionName, databases[connectionName]];

    if (!config) {
        console.error(chalk.red(`\n  Connection "${connectionName}" not found in src/config/database.ts\n`));
        process.exit(1);
    }

    const driver: string = config.driver;

    // ── Derive table name (PascalCase → snake_case → pluralise) ──────────────
    const snakeName = toSnakeCase(modelName);   // UserProfile → user_profile
    const tableName = pluralize(snakeName);     // user_profile → user_profiles

    console.log();
    console.log(
        chalk.bold.cyan('  Generating model') +
        chalk.gray(` → ${modelName} (${resolvedConnectionName}, table: ${tableName})`),
    );
    console.log();

    // ── Introspect DB for column info ─────────────────────────────────────────
    type ColumnMeta = { type: string; allowNull: boolean; primaryKey: boolean; defaultValue: any };
    let columns: Record<string, ColumnMeta> = {};

    if (SQL_DRIVERS.has(driver)) {
        const outputFile = path.join(cwd, '.__morphis_columns.json');
        const connectionJson = JSON.stringify({ ...config.connection });

        const introspectScript = buildIntrospectScript(driver, connectionJson, tableName, outputFile);

        try {
            await runInProject(cwd, introspectScript);
            if (fs.existsSync(outputFile)) {
                const raw = fs.readFileSync(outputFile, 'utf8');
                columns = JSON.parse(raw);
                fs.unlinkSync(outputFile);
            }
        } catch {
            // Introspection failed — proceed with empty columns
        }
    }

    // ── Build model file content ──────────────────────────────────────────────
    const columnEntries = Object.entries(columns);

    const fields = columnEntries.map(([colName, meta]) => {
        // snake_case column → camelCase property name
        const propName = colName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const tsType = sqlTypeToTs(String(meta.type));
        const nullable = meta.allowNull ? ' | null' : '';
        return `    declare ${propName}: ${tsType}${nullable};`;
    });

    const modelContent = [
        `import { Model } from 'morphis';`,
        `import type { ConnectionName } from '../config/database';`,
        ``,
        `export class ${modelName} extends Model {`,
        `    static connection: ConnectionName = ${JSON.stringify(resolvedConnectionName)};`,
        ...(fields.length > 0 ? [``, ...fields] : []),
        `}`,
        ``,
    ].join('\n');

    // ── Write model file ──────────────────────────────────────────────────────
    const modelsDir = path.join(cwd, 'src', 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    const modelFile = path.join(modelsDir, `${modelName}.ts`);
    if (fs.existsSync(modelFile)) {
        console.error(chalk.red(`  src/models/${modelName}.ts already exists — aborting\n`));
        process.exit(1);
    }
    fs.writeFileSync(modelFile, modelContent);
    console.log(chalk.gray(`    create src/models/${modelName}.ts`));

    // ── TODO stubs ────────────────────────────────────────────────────────────
    if (withMigration) {
        // TODO: scaffold a migration .sql file for this model's table
        console.log(chalk.yellow(`    todo   -m  migration scaffold (coming soon)`));
    }
    if (withController) {
        // TODO: scaffold a controller file at src/controllers/<ModelName>Controller.ts
        const label = withResource ? 'resource controller scaffold' : 'controller scaffold';
        console.log(chalk.yellow(`    todo   -c/-r  ${label} (coming soon)`));
    }
    if (withFactory) {
        // TODO: scaffold a factory file at src/factories/<ModelName>Factory.ts
        console.log(chalk.yellow(`    todo   -f  factory scaffold (coming soon)`));
    }
    if (withSeeder) {
        // TODO: scaffold a seeder file at src/seeders/<ModelName>Seeder.ts
        console.log(chalk.yellow(`    todo   -s  seeder scaffold (coming soon)`));
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log();
    console.log(chalk.bold('  Model created: ') + chalk.cyan(`src/models/${modelName}.ts`));
    if (columnEntries.length > 0) {
        console.log(chalk.gray(`  ${columnEntries.length} column(s) mapped from table "${tableName}"`));
    } else {
        console.log(chalk.gray(`  Table "${tableName}" not found or not yet created — model has no declared fields`));
        console.log(chalk.gray(`  Run ${chalk.cyan('morphis new:migration')} and ${chalk.cyan('morphis migrate')} first, then run ${chalk.cyan(`morphis sync:model ${modelName}`)}.`));
    }
    console.log();
}

// ── Per-driver introspection scripts ────────────────────────────────────────

function buildIntrospectScript(driver: string, connectionJson: string, tableName: string, outputFile: string): string {
    const tableJson = JSON.stringify(tableName);
    const outJson = JSON.stringify(outputFile);

    switch (driver) {
        case 'postgres':
            return `
import pg from 'pg';
import fs from 'fs';
const client = new pg.Client(${connectionJson});
try {
    await client.connect();
    const res = await client.query(
        \`SELECT column_name, data_type, is_nullable, column_default,
                (SELECT COUNT(*) FROM information_schema.key_column_usage k
                 JOIN information_schema.table_constraints tc ON k.constraint_name = tc.constraint_name
                 WHERE tc.constraint_type = 'PRIMARY KEY' AND k.column_name = c.column_name AND k.table_name = c.table_name) AS is_pk
         FROM information_schema.columns c WHERE table_name = \${tableJson}\`
    );
    const cols = {};
    for (const r of res.rows) {
        cols[r.column_name] = {
            type: r.data_type.toUpperCase(),
            allowNull: r.is_nullable === 'YES',
            primaryKey: Number(r.is_pk) > 0,
            defaultValue: r.column_default,
        };
    }
    fs.writeFileSync(${outJson}, JSON.stringify(cols));
} catch { fs.writeFileSync(${outJson}, JSON.stringify({})); }
await client.end();
`;

        case 'mysql':
        case 'mariadb':
            return `
import mysql from 'mysql2/promise';
import fs from 'fs';
const conn = await mysql.createConnection(${connectionJson});
try {
    const [rows] = await conn.execute(
        \`SELECT column_name, column_type, is_nullable, column_default, column_key
         FROM information_schema.columns WHERE table_name = ${tableJson} AND table_schema = DATABASE()\`
    );
    const cols = {};
    for (const r of rows) {
        cols[r.COLUMN_NAME || r.column_name] = {
            type: (r.COLUMN_TYPE || r.column_type || '').toUpperCase(),
            allowNull: (r.IS_NULLABLE || r.is_nullable) === 'YES',
            primaryKey: (r.COLUMN_KEY || r.column_key) === 'PRI',
            defaultValue: r.COLUMN_DEFAULT || r.column_default,
        };
    }
    fs.writeFileSync(${outJson}, JSON.stringify(cols));
} catch { fs.writeFileSync(${outJson}, JSON.stringify({})); }
await conn.end();
`;

        case 'sqlite':
        case 'd1':
            return `
import { Database } from 'bun:sqlite';
import fs from 'fs';
const connOpts = ${connectionJson};
const db = new Database(connOpts.storage || ':memory:');
try {
    const rows = db.prepare('PRAGMA table_info(${tableName})').all();
    const cols = {};
    for (const r of rows) {
        cols[r.name] = {
            type: (r.type || 'TEXT').toUpperCase(),
            allowNull: r.notnull === 0,
            primaryKey: r.pk === 1,
            defaultValue: r.dflt_value,
        };
    }
    fs.writeFileSync(${outJson}, JSON.stringify(cols));
} catch { fs.writeFileSync(${outJson}, JSON.stringify({})); }
db.close();
`;

        case 'mssql':
            return `
import mssql from 'mssql';
import fs from 'fs';
try {
    const pool = await mssql.connect(${connectionJson});
    const res = await pool.request().query(
        \`SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
                CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk
         FROM INFORMATION_SCHEMA.COLUMNS c
         LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON kcu.TABLE_NAME = c.TABLE_NAME AND kcu.COLUMN_NAME = c.COLUMN_NAME
           AND kcu.CONSTRAINT_NAME IN (SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND TABLE_NAME = c.TABLE_NAME)
         WHERE c.TABLE_NAME = ${tableJson}\`
    );
    const cols = {};
    for (const r of res.recordset) {
        cols[r.COLUMN_NAME] = {
            type: r.DATA_TYPE.toUpperCase(),
            allowNull: r.IS_NULLABLE === 'YES',
            primaryKey: r.is_pk === 1,
            defaultValue: r.COLUMN_DEFAULT,
        };
    }
    fs.writeFileSync(${outJson}, JSON.stringify(cols));
    await pool.close();
} catch { fs.writeFileSync(${outJson}, JSON.stringify({})); }
`;

        default:
            return `import fs from 'fs'; fs.writeFileSync(${outJson}, JSON.stringify({}));`;
    }
}
