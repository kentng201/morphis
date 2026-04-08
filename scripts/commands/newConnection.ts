import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { selectOption, inputText } from '../utils/prompt';
import { DB_OPTIONS, buildConnectionEntry, buildDatabaseFile } from './new';

export async function runNewConnection(_rest: string[]) {
    const cwd = process.cwd();

    // Must be inside a morphis project
    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        console.error(chalk.red('\n  Not in a project directory — package.json not found\n'));
        process.exit(1);
    }

    // ── Connection name ───────────────────────────────────────────────────────
    const rawName = await inputText('Connection name:');
    const connectionName = rawName.trim();
    if (!connectionName) {
        console.error(chalk.red('\n  Connection name cannot be empty\n'));
        process.exit(1);
    }

    // ── Database dialect ──────────────────────────────────────────────────────
    const dbLabel = await selectOption(
        'What database will you use?',
        DB_OPTIONS.map(o => o.label),
    );
    const dbOption = DB_OPTIONS.find(o => o.label === dbLabel)!;

    // ── Determine isDefault & file path ──────────────────────────────────────
    const configDir = path.join(cwd, 'src', 'config');
    const configFile = path.join(configDir, 'database.ts');
    const fileExists = fs.existsSync(configFile);
    const isDefault = !fileExists;

    const entry = buildConnectionEntry(dbOption.driver, connectionName, isDefault);

    console.log();

    // ── Update package.json with missing sequelize deps ───────────────────────
    const pkgPath = path.join(cwd, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const existingDeps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
    };
    const missingDeps = dbOption.deps.filter(dep => !(dep in existingDeps));

    if (missingDeps.length > 0) {
        pkg.dependencies = pkg.dependencies ?? {};
        for (const dep of missingDeps) {
            pkg.dependencies[dep] = 'latest';
        }
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
        for (const dep of missingDeps) {
            console.log(chalk.gray(`    add dep  ${dep}`));
        }
    }

    // ── Write / update src/config/database.ts ────────────────────────────────
    if (!fileExists) {
        // Create src/config/ if needed and write the file from scratch
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configFile, buildDatabaseFile(entry));
        console.log(chalk.gray('    create src/config/database.ts'));
    } else {
        // Append new entry before the closing `});` that precedes the exports
        const content = fs.readFileSync(configFile, 'utf8');
        const marker = '\n});\n\nexport type ConnectionName';
        if (!content.includes(marker)) {
            console.error(chalk.red('\n  Cannot parse src/config/database.ts — unexpected format\n'));
            process.exit(1);
        }
        const updated = content.replace(marker, `\n${entry}${marker}`);
        fs.writeFileSync(configFile, updated);
        console.log(chalk.gray('    update src/config/database.ts'));
    }

    console.log();
    console.log(
        chalk.bold('  Connection added:') +
        chalk.cyan(` ${connectionName}`) +
        chalk.gray(` (${dbOption.driver})`),
    );
    if (isDefault) {
        console.log(chalk.gray('  (set as default connection)'));
    }
    if (missingDeps.length > 0) {
        console.log(chalk.yellow(`\n  Run ${chalk.cyan('bun install')} to install the new dependencies.`));
    }
    console.log();
}
