import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { runInProject } from '../utils/spawnInProject';

/** Drivers that use plain-SQL migrations */
const SQL_DRIVERS = new Set(['mysql', 'mariadb', 'postgres', 'mssql', 'sqlite', 'd1']);

export function splitMigrationStatements(sql: string): string[] {
    return sql
        .replace(/\r\n/g, '\n')
        .split(/\n\s*-->\s*statement-breakpoint\s*\n/g)
        .flatMap(chunk => chunk.split(/;\s*(?=\n|$)/g))
        .map(statement => statement
            .split('\n')
            .filter(line => !/^\s*--/.test(line))
            .join('\n')
            .trim())
        .filter(Boolean);
}

const splitMigrationStatementsHelper = `
function splitMigrationStatements(sql) {
    return sql
        .replace(/\\r\\n/g, '\\n')
        .split(/\\n\\s*-->\\s*statement-breakpoint\\s*\\n/g)
        .flatMap(chunk => chunk.split(/;\\s*(?=\\n|$)/g))
        .map(statement => statement
            .split('\\n')
            .filter(line => !/^\\s*--/.test(line))
            .join('\\n')
            .trim())
        .filter(Boolean);
}
`;

export async function runMigrate(rest: string[]) {
    const cwd = process.cwd();

    // --connection selects which named connection to use (default: isDefault entry)
    const connArg = rest.find(a => a.startsWith('--connection='));
    const connectionName = connArg ? connArg.split('=')[1] : 'default';

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

    if (!databases || typeof databases !== 'object' || Object.keys(databases).length === 0) {
        console.error(chalk.red('\n  src/config/database.ts has no connections configured\n'));
        process.exit(1);
    }

    // ── Resolve target connection ─────────────────────────────────────────────
    const entries = Object.entries(databases);
    const [resolvedConnectionName, config]: [string, any] = connectionName === 'default'
        ? (entries.find(([, d]) => d.isDefault) ?? entries[0])
        : [connectionName, databases[connectionName]];

    if (!config) {
        console.error(chalk.red(`\n  Connection "${connectionName}" not found in src/config/database.ts\n`));
        process.exit(1);
    }

    const driver: string = config.driver;

    if (!SQL_DRIVERS.has(driver)) {
        console.error(chalk.red(
            `\n  Driver "${driver}" does not support .sql migrations.\n` +
            `  Supported: mysql, mariadb, postgres, mssql, sqlite, d1\n`,
        ));
        process.exit(1);
    }

    // ── Verify migrations/<connection>/ folder exists ───────────────────────
    const connectionFolder = resolvedConnectionName;
    const migrationsDir = path.join(cwd, 'migrations', connectionFolder);
    if (!fs.existsSync(migrationsDir)) {
        console.error(chalk.red(`\n  migrations/${connectionFolder}/ folder not found. Run: morphis new:migration <name> --connection=${connectionFolder}\n`));
        process.exit(1);
    }

    // ── Build the temp migration script for the target project ──────────────
    const connectionJson = JSON.stringify({ ...config.connection });
    const migrationsDirJson = JSON.stringify(migrationsDir);
    const configName = resolvedConnectionName;

    const tmpScript = buildMigrationScript(driver, connectionJson, migrationsDirJson, configName);

    console.log();
    console.log(chalk.bold.cyan(`  Running migrations`) + chalk.gray(` → "${configName}" (${driver})`));
    console.log();

    try {
        await runInProject(cwd, tmpScript);
    } catch {
        // errors printed by the spawned script itself
        process.exit(1);
    }

    console.log();
}

// ── Script builders per driver ──────────────────────────────────────────────

function buildMigrationScript(
    driver: string,
    connectionJson: string,
    migrationsDirJson: string,
    configName: string,
): string {
    switch (driver) {
        case 'postgres':
            return buildPostgresScript(connectionJson, migrationsDirJson, configName);
        case 'mysql':
        case 'mariadb':
            return buildMysqlScript(connectionJson, migrationsDirJson, configName, driver);
        case 'sqlite':
            return buildSqliteScript(connectionJson, migrationsDirJson, configName);
        case 'd1':
            return buildD1Script(connectionJson, migrationsDirJson, configName);
        case 'mssql':
            return buildMssqlScript(connectionJson, migrationsDirJson, configName);
        default:
            throw new Error(`Unsupported driver: ${driver}`);
    }
}

function buildPostgresScript(connectionJson: string, migrationsDirJson: string, configName: string): string {
    return `
import pg from 'pg';
import fs from 'fs';
import path from 'path';
${splitMigrationStatementsHelper}

const client = new pg.Client(${connectionJson});
try { await client.connect(); } catch (err) {
    console.error('Cannot connect to ${configName} (postgres):', err instanceof Error ? err.message : err);
    process.exit(1);
}

await client.query(\`
    CREATE TABLE IF NOT EXISTS migrations (
        id        SERIAL PRIMARY KEY,
        batch     INTEGER NOT NULL,
        name      VARCHAR(255) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
\`);

const ran = await client.query('SELECT name FROM migrations');
const ranNames = new Set(ran.rows.map(r => r.name));

const batchRes = await client.query('SELECT COALESCE(MAX(batch), 0) AS maxbatch FROM migrations');
const nextBatch = Number(batchRes.rows[0].maxbatch) + 1;

const migrationsDir = ${migrationsDirJson};
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
const pending = files.filter(f => !ranNames.has(f));

if (pending.length === 0) {
    console.log('  Nothing to migrate — all migrations are up to date.');
} else {
    for (const file of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const statements = splitMigrationStatements(sql);
        for (const statement of statements) {
            await client.query(statement);
        }
        await client.query(
            'INSERT INTO migrations (batch, name, timestamp) VALUES ($1, $2, $3)',
            [nextBatch, file, new Date()]
        );
        console.log('  migrate  ' + file);
    }
    console.log('  Batch ' + nextBatch + ' complete — ' + pending.length + ' migration(s) ran.');
}

await client.end();
`;
}

function buildMysqlScript(connectionJson: string, migrationsDirJson: string, configName: string, driver: string): string {
    return `
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
${splitMigrationStatementsHelper}

let conn;
try { conn = await mysql.createConnection(${connectionJson}); } catch (err) {
    console.error('Cannot connect to ${configName} (${driver}):', err instanceof Error ? err.message : err);
    process.exit(1);
}

await conn.execute(\`
    CREATE TABLE IF NOT EXISTS migrations (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        batch     INT NOT NULL,
        name      VARCHAR(255) NOT NULL,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
\`);

const [ran] = await conn.execute('SELECT name FROM migrations');
const ranNames = new Set((ran as any[]).map(r => r.name));

const [batchRows] = await conn.execute('SELECT COALESCE(MAX(batch), 0) AS maxbatch FROM migrations');
const nextBatch = Number((batchRows as any[])[0].maxbatch) + 1;

const migrationsDir = ${migrationsDirJson};
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
const pending = files.filter(f => !ranNames.has(f));

if (pending.length === 0) {
    console.log('  Nothing to migrate — all migrations are up to date.');
} else {
    for (const file of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const statements = splitMigrationStatements(sql);
        for (const statement of statements) {
            await conn.execute(statement);
        }
        await conn.execute(
            'INSERT INTO migrations (batch, name, timestamp) VALUES (?, ?, ?)',
            [nextBatch, file, new Date()]
        );
        console.log('  migrate  ' + file);
    }
    console.log('  Batch ' + nextBatch + ' complete — ' + pending.length + ' migration(s) ran.');
}

await conn.end();
`;
}

function buildSqliteScript(connectionJson: string, migrationsDirJson: string, configName: string): string {
    return `
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
${splitMigrationStatementsHelper}

const connOpts = ${connectionJson};
const db = new Database(connOpts.storage || ':memory:');

db.run(\`
    CREATE TABLE IF NOT EXISTS migrations (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        batch     INTEGER NOT NULL,
        name      TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    )
\`);

const ran = db.prepare('SELECT name FROM migrations').all() as { name: string }[];
const ranNames = new Set(ran.map(r => r.name));

const batchRow = db.prepare('SELECT COALESCE(MAX(batch), 0) AS maxbatch FROM migrations').get() as any;
const nextBatch = Number(batchRow.maxbatch) + 1;

const migrationsDir = ${migrationsDirJson};
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
const pending = files.filter(f => !ranNames.has(f));

if (pending.length === 0) {
    console.log('  Nothing to migrate — all migrations are up to date.');
} else {
    for (const file of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const statements = splitMigrationStatements(sql);
        for (const statement of statements) {
            db.run(statement);
        }
        db.prepare('INSERT INTO migrations (batch, name, timestamp) VALUES (?, ?, ?)').run(
            nextBatch, file, new Date().toISOString()
        );
        console.log('  migrate  ' + file);
    }
    console.log('  Batch ' + nextBatch + ' complete — ' + pending.length + ' migration(s) ran.');
}

db.close();
`;
}

function buildD1Script(connectionJson: string, migrationsDirJson: string, configName: string): string {
    return `
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
${splitMigrationStatementsHelper}

const connOpts = ${connectionJson};
if (!connOpts.storage) {
    console.error('Cannot run D1 migrations for ${configName}: connection.storage is missing.');
    console.error('Set a local SQLite path in src/config/database.ts for local Bun migration support.');
    process.exit(1);
}

const db = new Database(connOpts.storage);

db.run(\`
    CREATE TABLE IF NOT EXISTS migrations (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        batch     INTEGER NOT NULL,
        name      TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    )
\`);

const ran = db.prepare('SELECT name FROM migrations').all() as { name: string }[];
const ranNames = new Set(ran.map(r => r.name));

const batchRow = db.prepare('SELECT COALESCE(MAX(batch), 0) AS maxbatch FROM migrations').get() as any;
const nextBatch = Number(batchRow.maxbatch) + 1;

const migrationsDir = ${migrationsDirJson};
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
const pending = files.filter(f => !ranNames.has(f));

if (pending.length === 0) {
    console.log('  Nothing to migrate — all migrations are up to date.');
} else {
    for (const file of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const statements = splitMigrationStatements(sql);
        for (const statement of statements) {
            db.run(statement);
        }
        db.prepare('INSERT INTO migrations (batch, name, timestamp) VALUES (?, ?, ?)').run(
            nextBatch, file, new Date().toISOString()
        );
        console.log('  migrate  ' + file);
    }
    console.log('  Batch ' + nextBatch + ' complete — ' + pending.length + ' migration(s) ran.');
}

db.close();
`;
}

function buildMssqlScript(connectionJson: string, migrationsDirJson: string, configName: string): string {
    return `
import mssql from 'mssql';
import fs from 'fs';
import path from 'path';
${splitMigrationStatementsHelper}

let pool;
try { pool = await mssql.connect(${connectionJson}); } catch (err) {
    console.error('Cannot connect to ${configName} (mssql):', err instanceof Error ? err.message : err);
    process.exit(1);
}

await pool.request().query(\`
    IF OBJECT_ID('migrations', 'U') IS NULL
    CREATE TABLE migrations (
        id        INT IDENTITY(1,1) PRIMARY KEY,
        batch     INT NOT NULL,
        name      NVARCHAR(255) NOT NULL,
        timestamp DATETIME2 NOT NULL DEFAULT GETUTCDATE()
    )
\`);

const ran = await pool.request().query('SELECT name FROM migrations');
const ranNames = new Set(ran.recordset.map(r => r.name));

const batchRes = await pool.request().query('SELECT COALESCE(MAX(batch), 0) AS maxbatch FROM migrations');
const nextBatch = Number(batchRes.recordset[0].maxbatch) + 1;

const migrationsDir = ${migrationsDirJson};
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
const pending = files.filter(f => !ranNames.has(f));

if (pending.length === 0) {
    console.log('  Nothing to migrate — all migrations are up to date.');
} else {
    for (const file of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const statements = splitMigrationStatements(sql);
        for (const statement of statements) {
            await pool.request().query(statement);
        }
        await pool.request()
            .input('batch', mssql.Int, nextBatch)
            .input('name', mssql.NVarChar, file)
            .input('ts', mssql.DateTime2, new Date())
            .query('INSERT INTO migrations (batch, name, timestamp) VALUES (@batch, @name, @ts)');
        console.log('  migrate  ' + file);
    }
    console.log('  Batch ' + nextBatch + ' complete — ' + pending.length + ' migration(s) ran.');
}

await pool.close();
`;
}
