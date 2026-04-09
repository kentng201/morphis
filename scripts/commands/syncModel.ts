import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { runInProject } from '../utils/spawnInProject';

/** Drivers that support table introspection */
const SQL_DRIVERS = new Set(['mysql', 'mariadb', 'postgres', 'mssql', 'sqlite']);

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
    if (/^TINYINT\(1\)/.test(t)) return 'boolean';
    if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|SERIAL|BIGSERIAL)/.test(t)) return 'number';
    if (/^(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)/.test(t)) return 'number';
    if (/^(BOOLEAN|BOOL)/.test(t)) return 'boolean';
    if (/^(VARCHAR|TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|CHAR|STRING|NVARCHAR|CHARACTER VARYING)/.test(t)) return 'string';
    if (/^(DATE|DATETIME|TIMESTAMP|TIME)/.test(t)) return 'Date';
    if (/^(JSON|JSONB)/.test(t)) return 'Record<string, any>';
    if (/^(BLOB|VARBINARY|BINARY|BYTEA)/.test(t)) return 'Buffer';
    return 'any';
}

/** Map a SQL column type to a Drizzle column builder expression string */
function sqlTypeToDrizzle(driver: string, colName: string, sqlType: string, isPk: boolean, isNullable: boolean, defaultVal: string | null): string {
    const t = sqlType.toUpperCase();
    let expr: string;

    if (/^(SERIAL)/.test(t) && (driver === 'postgres')) {
        expr = `serial('${colName}')`;
    } else if (/^(BIGSERIAL)/.test(t) && (driver === 'postgres')) {
        expr = `bigserial('${colName}', { mode: 'number' })`;
    } else if (/^TINYINT\(1\)/.test(t)) {
        expr = `boolean('${colName}')`;
    } else if (/^(BIGINT|INT8)/.test(t)) {
        expr = `bigint('${colName}', { mode: 'number' })`;
    } else if (/^(INT|INTEGER|INT4|SMALLINT|INT2|TINYINT|MEDIUMINT)/.test(t)) {
        expr = `integer('${colName}')`;
    } else if (/^(BOOLEAN|BOOL)/.test(t)) {
        expr = `boolean('${colName}')`;
    } else if (/^(FLOAT|REAL)/.test(t)) {
        expr = `real('${colName}')`;
    } else if (/^(DOUBLE|DECIMAL|NUMERIC|DOUBLE PRECISION)/.test(t)) {
        expr = `doublePrecision('${colName}')`;
    } else if (/^(TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT)/.test(t)) {
        expr = `text('${colName}')`;
    } else if (/^(VARCHAR|CHARACTER VARYING|CHAR|NVARCHAR)/.test(t)) {
        const match = sqlType.match(/\((\d+)\)/);
        expr = match ? `varchar('${colName}', { length: ${match[1]} })` : `varchar('${colName}')`;
    } else if (/^JSONB/.test(t)) {
        expr = `jsonb('${colName}')`;
    } else if (/^JSON/.test(t)) {
        expr = `json('${colName}')`;
    } else if (/^(TIMESTAMP WITHOUT TIME ZONE|TIMESTAMP|DATETIME)/.test(t)) {
        expr = `timestamp('${colName}')`;
    } else if (/^(DATE)/.test(t)) {
        expr = `date('${colName}')`;
    } else if (/^(TIME)/.test(t)) {
        expr = `time('${colName}')`;
    } else {
        expr = `text('${colName}')`;
    }

    if (isPk) expr += '.primaryKey()';
    if (!isNullable && !isPk) expr += '.notNull()';

    if (defaultVal) {
        const dv = defaultVal.trim();
        if (/^(CURRENT_TIMESTAMP|NOW\(\))/i.test(dv)) {
            expr += '.defaultNow()';
        } else if (/^nextval\(/i.test(dv)) {
            // serial/autoincrement — skip default
        } else if (/^'.*'$/.test(dv)) {
            expr += `.default(${dv})`;
        } else if (/^\d+(\.\d+)?$/.test(dv)) {
            expr += `.default(${dv})`;
        }
    }

    return expr;
}

/** Get Drizzle core import path for a driver */
function drizzleCoreModule(driver: string): string {
    switch (driver) {
        case 'postgres': return 'drizzle-orm/pg-core';
        case 'mysql':
        case 'mariadb': return 'drizzle-orm/mysql-core';
        case 'sqlite': return 'drizzle-orm/sqlite-core';
        case 'mssql': return 'drizzle-orm/mssql-core';
        default: return 'drizzle-orm/pg-core';
    }
}

/** Get table builder function name for a driver */
function tableBuilderName(driver: string): string {
    switch (driver) {
        case 'postgres': return 'pgTable';
        case 'mysql':
        case 'mariadb': return 'mysqlTable';
        case 'sqlite': return 'sqliteTable';
        case 'mssql': return 'mssqlTable';
        default: return 'pgTable';
    }
}

/**
 * Regex that matches the declare fields block inside a model class.
 */
const DECLARE_BLOCK_RE = /(\n[ \t]*declare\s[^\n]+)+/g;

type IntrospectedColumn = {
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    defaultValue: string | null;
};

export async function runSyncModel(rest: string[]) {
    const cwd = process.cwd();

    const connArg = rest.find(a => a.startsWith('--connection='));
    const connectionName = connArg ? connArg.split('=')[1] : 'default';

    // Positional: model name (PascalCase, required)
    const modelName = rest.find(a => !a.startsWith('-'));
    if (!modelName) {
        console.error(chalk.red('\n  Missing required argument: <ModelName>'));
        console.error(chalk.gray('  Example: morphis sync:model Post\n'));
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

    const modelFile = path.join(cwd, 'src', 'models', `${modelName}.ts`);
    if (!fs.existsSync(modelFile)) {
        console.error(chalk.red(`\n  src/models/${modelName}.ts not found. Run: morphis new:model ${modelName}\n`));
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

    if (!SQL_DRIVERS.has(driver)) {
        console.error(chalk.red(
            `\n  Driver "${driver}" does not support table introspection.\n` +
            '  Supported: mysql, mariadb, postgres, mssql, sqlite\n',
        ));
        process.exit(1);
    }

    // ── Derive table name ─────────────────────────────────────────────────────
    const tableName = pluralize(toSnakeCase(modelName));

    console.log();
    console.log(
        chalk.bold.cyan('  Syncing model') +
        chalk.gray(` → ${modelName} (${resolvedConnectionName}, table: ${tableName})`),
    );
    console.log();

    // ── Introspect DB via raw driver client ───────────────────────────────────
    let introspectedColumns: IntrospectedColumn[] = [];

    const outputFile = path.join(cwd, '.__morphis_columns.json');
    const connectionJson = JSON.stringify({ ...config.connection });

    let introspectScript: string;

    if (driver === 'postgres') {
        introspectScript = `
import pg from 'pg';
import fs from 'fs';

const client = new pg.Client({
    host: ${JSON.stringify(config.connection.host)},
    port: ${JSON.stringify(config.connection.port ?? 5432)},
    database: ${JSON.stringify(config.connection.database)},
    user: ${JSON.stringify(config.connection.username)},
    password: ${JSON.stringify(config.connection.password)},
});
await client.connect();

try {
    const result = await client.query(
        \`SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length,
                (SELECT COUNT(*) > 0 FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
                    WHERE tc.table_name = c.table_name AND kcu.column_name = c.column_name
                    AND tc.constraint_type = 'PRIMARY KEY') AS is_pk
         FROM information_schema.columns c
         WHERE table_name = $1
         ORDER BY ordinal_position\`,
        [${JSON.stringify(tableName)}],
    );
    const cols = result.rows.map(r => ({
        name: r.column_name,
        type: r.character_maximum_length ? r.data_type + '(' + r.character_maximum_length + ')' : r.data_type,
        nullable: r.is_nullable === 'YES',
        primaryKey: r.is_pk === true || r.is_pk === 't',
        defaultValue: r.column_default ?? null,
    }));
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(cols));
} catch {
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify([]));
}
await client.end();
`;
    } else if (driver === 'mysql' || driver === 'mariadb') {
        introspectScript = `
import mysql from 'mysql2/promise';
import fs from 'fs';

const connection = await mysql.createConnection({
    host: ${JSON.stringify(config.connection.host)},
    port: ${JSON.stringify(config.connection.port ?? 3306)},
    database: ${JSON.stringify(config.connection.database)},
    user: ${JSON.stringify(config.connection.username)},
    password: ${JSON.stringify(config.connection.password)},
});

try {
    const [rows] = await connection.query(
        'SELECT column_name, data_type, is_nullable, column_default, column_key, character_maximum_length FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE() ORDER BY ordinal_position',
        [${JSON.stringify(tableName)}],
    );
    const cols = rows.map(r => ({
        name: r.COLUMN_NAME ?? r.column_name,
        type: r.CHARACTER_MAXIMUM_LENGTH ? (r.DATA_TYPE ?? r.data_type) + '(' + (r.CHARACTER_MAXIMUM_LENGTH ?? r.character_maximum_length) + ')' : (r.DATA_TYPE ?? r.data_type),
        nullable: (r.IS_NULLABLE ?? r.is_nullable) === 'YES',
        primaryKey: (r.COLUMN_KEY ?? r.column_key) === 'PRI',
        defaultValue: r.COLUMN_DEFAULT ?? r.column_default ?? null,
    }));
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(cols));
} catch {
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify([]));
}
await connection.end();
`;
    } else if (driver === 'sqlite') {
        introspectScript = `
import { Database } from 'bun:sqlite';
import fs from 'fs';

const db = new Database(${JSON.stringify(config.connection.storage)});
try {
    const rows = db.query('PRAGMA table_info(${tableName})').all();
    const cols = rows.map(r => ({
        name: r.name,
        type: r.type,
        nullable: r.notnull === 0,
        primaryKey: r.pk === 1,
        defaultValue: r.dflt_value,
    }));
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(cols));
} catch {
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify([]));
}
db.close();
`;
    } else {
        // mssql
        introspectScript = `
import mssql from 'mssql';
import fs from 'fs';

const pool = await new mssql.ConnectionPool({
    server: ${JSON.stringify(config.connection.host)},
    port: ${JSON.stringify(config.connection.port ?? 1433)},
    database: ${JSON.stringify(config.connection.database)},
    user: ${JSON.stringify(config.connection.username)},
    password: ${JSON.stringify(config.connection.password)},
    options: { encrypt: false, trustServerCertificate: true },
}).connect();

try {
    const result = await pool.query(
        \`SELECT column_name, data_type, is_nullable, column_default,
                CASE WHEN EXISTS (
                    SELECT 1 FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
                    WHERE tc.table_name = c.table_name AND kcu.column_name = c.column_name
                    AND tc.constraint_type = 'PRIMARY KEY'
                ) THEN 1 ELSE 0 END AS is_pk
         FROM information_schema.columns c
         WHERE table_name = '${tableName}'
         ORDER BY ordinal_position\`,
    );
    const cols = result.recordset.map(r => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        primaryKey: r.is_pk === 1,
        defaultValue: r.column_default ?? null,
    }));
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(cols));
} catch {
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify([]));
}
await pool.close();
`;
    }

    try {
        await runInProject(cwd, introspectScript);
        if (fs.existsSync(outputFile)) {
            const raw = fs.readFileSync(outputFile, 'utf8');
            introspectedColumns = JSON.parse(raw);
            fs.unlinkSync(outputFile);
        }
    } catch {
        // Introspection failed — columns stays empty
    }

    if (introspectedColumns.length === 0) {
        console.error(chalk.red(
            `\n  Table "${tableName}" not found or returned no columns.\n` +
            `  Run ${chalk.cyan('morphis new:migration')} and ${chalk.cyan('morphis migrate')} first.\n`,
        ));
        process.exit(1);
    }

    // ── Build new declare fields ──────────────────────────────────────────────
    const fields = introspectedColumns.map((col) => {
        const propName = col.name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const tsType = sqlTypeToTs(String(col.type));
        const nullable = col.nullable ? ' | null' : '';
        return `    declare ${propName}: ${tsType}${nullable};`;
    });

    const declareBlock = '\n\n' + fields.join('\n');

    // ── Generate .schema.ts file ──────────────────────────────────────────────
    const schemaFile = path.join(cwd, 'src', 'models', `${modelName}.schema.ts`);
    const coreModule = drizzleCoreModule(driver);
    const builderName = tableBuilderName(driver);
    const tableVarName = `${toSnakeCase(modelName)}sTable`;

    // Collect unique Drizzle column builder names used
    const usedBuilders = new Set<string>();
    usedBuilders.add(builderName);

    const columnLines = introspectedColumns.map((col) => {
        const drizzleExpr = sqlTypeToDrizzle(driver, col.name, col.type, col.primaryKey, col.nullable, col.defaultValue);
        // Extract builder function name (e.g. "integer" from "integer('id')")
        const match = drizzleExpr.match(/^(\w+)\(/);
        if (match) usedBuilders.add(match[1]);
        return `    ${col.name}: ${drizzleExpr},`;
    });

    const imports = Array.from(usedBuilders).sort();
    const schemaContent = [
        `// GENERATED FILE — do not edit. Re-generate with: morphis sync:model ${modelName}`,
        `import { ${imports.join(', ')} } from '${coreModule}';`,
        ``,
        `export const ${tableVarName} = ${builderName}('${tableName}', {`,
        ...columnLines,
        `});`,
        ``,
    ].join('\n');

    fs.writeFileSync(schemaFile, schemaContent);
    console.log(chalk.gray(`    create src/models/${modelName}.schema.ts`));

    // ── Rewrite the model file ────────────────────────────────────────────────
    let content = fs.readFileSync(modelFile, 'utf8');

    // Remove existing declare lines (if any)
    content = content.replace(DECLARE_BLOCK_RE, '');

    // Add schema import if not already present
    const schemaImportLine = `import { ${tableVarName} } from './${modelName}.schema';`;
    if (!content.includes(`./${modelName}.schema`)) {
        // Insert after the last import line
        const lastImportIdx = content.lastIndexOf('\nimport ');
        if (lastImportIdx !== -1) {
            const endOfLine = content.indexOf('\n', lastImportIdx + 1);
            content = content.slice(0, endOfLine + 1) + schemaImportLine + '\n' + content.slice(endOfLine + 1);
        } else {
            content = schemaImportLine + '\n' + content;
        }
    }

    // Add or update static schema property
    if (!content.includes('static schema')) {
        // Insert after the class opening brace, or after the first static property
        const classBodyMatch = content.match(/extends Model\s*\{/);
        if (classBodyMatch && classBodyMatch.index !== undefined) {
            const insertPos = classBodyMatch.index + classBodyMatch[0].length;
            content = content.slice(0, insertPos) + `\n    static schema = ${tableVarName};` + content.slice(insertPos);
        }
    } else {
        // Update existing static schema line
        content = content.replace(/static schema\s*=\s*[^;]+;/, `static schema = ${tableVarName};`);
    }

    // Insert new declare block before the closing `}` of the class
    const lastBrace = content.lastIndexOf('\n}');
    if (lastBrace === -1) {
        console.error(chalk.red('\n  Cannot parse model file — closing `}` not found\n'));
        process.exit(1);
    }
    content = content.slice(0, lastBrace) + declareBlock + '\n' + content.slice(lastBrace);

    fs.writeFileSync(modelFile, content);

    console.log(chalk.gray(`    update src/models/${modelName}.ts`));
    console.log();
    console.log(chalk.bold('  Model synced: ') + chalk.cyan(`src/models/${modelName}.ts`));
    console.log(chalk.gray(`  ${introspectedColumns.length} column(s) mapped from table "${tableName}"`));
    console.log(chalk.gray(`  Schema file: src/models/${modelName}.schema.ts`));
    console.log();
}
