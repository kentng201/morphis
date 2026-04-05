#!/usr/bin/env bun
/**
 * morphis — CLI management tool (Laravel artisan-style).
 *
 * Usage:
 *   bun scripts/index.ts <command> [options]
 *   bun run morphis <command> [options]
 *
 * Run `morphis help` to list all available commands.
 */

import chalk from 'chalk';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runNew } from './commands/new';
import { runNewServer } from './commands/newServer';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

// Absolute path to the morphis package scripts/ directory.
// Referenced so sibling scripts (build.ts, listRoutes.ts) are found by
// absolute path regardless of the user cwd (important after bun link).
const scriptsDir = import.meta.dirname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAvailableServers(): string[] {
    const cwd = process.cwd();
    return fs.readdirSync(cwd)
        .map(f => f.match(/^\.env\.(.+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map(m => m[1])
        .sort();
}

function availableServersHint(): string {
    const servers = getAvailableServers();
    return servers.length > 0
        ? `Available servers: ${servers.join(', ')}`
        : 'No .env.<name> files found in project root';
}

function getAvailableEnvFiles(): string[] {
    const cwd = process.cwd();
    return fs.readdirSync(cwd)
        .filter(f => /^\.env\..+$/.test(f))
        .sort();
}

function availableEnvFilesHint(): string {
    const files = getAvailableEnvFiles();
    return files.length > 0
        ? `Available env files: ${files.join(', ')}`
        : 'No .env.<name> files found in project root';
}

function spawnBun(cmdArgs: string[]) {
    // Use shell on Windows so that `bun` resolves correctly.
    // cwd is always the user project directory.
    const proc = spawn('bun', cmdArgs, {
        stdio: 'inherit',
        cwd: process.cwd(),
        shell: process.platform === 'win32',
    });
    proc.on('exit', (code) => process.exit(code ?? 0));
    proc.on('error', (err) => {
        console.error(chalk.red(`  Failed to start process: ${err.message}`));
        process.exit(1);
    });
}

function getServer(): string | null {
    const serverArg = rest.find(a => a.startsWith('--server='));
    if (serverArg) return serverArg.split('=')[1];

    // Derive server name from --env=.env.<name> or --env-file=.env.<name>
    const envArg = rest.find(a => a.startsWith('--env=') || a.startsWith('--env-file='));
    if (envArg) {
        const envPath = envArg.split('=')[1];
        const basename = path.basename(envPath); // e.g. ".env.api"
        const match = basename.match(/^\.env\.(.+)$/);
        if (match) return match[1];
    }

    return null;
}

function requireServer(): string {
    const serverArg = rest.find(a => a.startsWith('--server='));
    const envArg = rest.find(a => a.startsWith('--env=') || a.startsWith('--env-file='));

    // Validate --server flag
    if (serverArg) {
        const server = serverArg.split('=')[1];
        const available = getAvailableServers();
        if (available.length > 0 && !available.includes(server)) {
            console.error(chalk.red(`\n  Incorrect server: ${chalk.bold(server)}`));
            console.error(chalk.gray(`  ${availableServersHint()}\n`));
            process.exit(1);
        }
        return server;
    }

    // Validate --env / --env-file flag
    if (envArg) {
        const envPath = envArg.split('=')[1];
        const basename = path.basename(envPath);
        const match = basename.match(/^\.env\.(.+)$/);
        if (match) {
            const server = match[1];
            const cwd = process.cwd();
            const absEnvPath = path.isAbsolute(envPath) ? envPath : path.join(cwd, envPath);
            if (!fs.existsSync(absEnvPath)) {
                console.error(chalk.red(`\n  Incorrect env file: ${chalk.bold(envPath)}`));
                console.error(chalk.gray(`  ${availableEnvFilesHint()}\n`));
                process.exit(1);
            }
            return server;
        }
    }

    console.error(chalk.red('\n  Missing required option: --server=<name> or --env=.env.<name>'));
    console.error(chalk.gray(`  ${availableServersHint()}\n`));
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

interface CommandDef {
    description: string;
    usage: string;
    run(): void;
}

const commands: Record<string, CommandDef> = {
    // ── New project scaffold ─────────────────────────────────────────────────
    'new': {
        description: 'Scaffold a new morphis project',
        usage: 'morphis new <project-name>',
        run() {
            runNew(rest);
        },
    },

    // ── New server scaffold ───────────────────────────────────────────────────
    'new:server': {
        description: 'Scaffold a new server (routes file + env file)',
        usage: 'morphis new:server <server-name>',
        run() {
            runNewServer(rest);
        },
    },

    // ── Route listing ────────────────────────────────────────────────────────
    'route:list': {
        description: 'List all registered HTTP routes for a server',
        usage: 'morphis route:list --server=<name>',
        run() {
            const server = requireServer();
            spawnBun([path.join(scriptsDir, 'listRoutes.ts'), `--server=${server}`]);
        },
    },

    // ── Build ────────────────────────────────────────────────────────────────
    'build': {
        description: 'Bundle a server for production',
        usage: 'morphis build --server=<name>',
        run() {
            const server = requireServer();
            spawnBun([path.join(scriptsDir, 'build.ts'), `--server=${server}`]);
        },
    },

    // ── Dev server ───────────────────────────────────────────────────────────
    'dev': {
        description: 'Start development server in watch mode',
        usage: 'morphis dev --server=<name>',
        run() {
            const server = requireServer();
            spawnBun(['--watch', `--env-file=.env.${server}`, 'src/index.ts', `--server=${server}`]);
        },
    },

    // ── Production server ────────────────────────────────────────────────────
    'start': {
        description: 'Start the built production server',
        usage: 'morphis start --server=<name>',
        run() {
            const server = requireServer();
            spawnBun([`--env-file=.env.${server}`, `dist/${server}/index.js`, '--colorless']);
        },
    },
};

// ---------------------------------------------------------------------------
// Help screen
// ---------------------------------------------------------------------------

function printHelp() {
    const maxLen = Math.max(...Object.keys(commands).map(k => k.length));

    console.log();
    console.log(chalk.bold.cyan('  morphis') + chalk.gray('  CLI management tool'));
    console.log();
    console.log(chalk.bold('  Usage'));
    console.log(chalk.gray('    morphis <command> [options]'));
    console.log();
    console.log(chalk.bold('  Commands'));

    for (const [name, def] of Object.entries(commands)) {
        console.log(
            '    ' + chalk.green(name.padEnd(maxLen + 2)) + chalk.white(def.description),
        );
    }

    console.log(
        '    ' + chalk.green('help'.padEnd(maxLen + 2)) + chalk.white('Show this help message'),
    );
    console.log();
    console.log(chalk.bold('  Options'));
    console.log(
        '    ' + chalk.yellow('--server=<name>') + '      ' +
        chalk.gray(`Target server name  (${availableServersHint()})`),
    );
    console.log(
        '    ' + chalk.yellow('--env=.env.<name>') + '    ' +
        chalk.gray('Derive server name from env file path'),
    );
    console.log();
    console.log(chalk.bold('  Examples'));
    console.log(chalk.gray('    morphis new         my-app'));
    console.log(chalk.gray('    morphis route:list  --server=api'));
    console.log(chalk.gray('    morphis build       --server=chat'));
    console.log(chalk.gray('    morphis dev         --env=.env.mini'));
    console.log(chalk.gray('    morphis start       --env=.env.api'));
    console.log();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
}

const cmd = commands[command];
if (!cmd) {
    console.error(chalk.red(`\n  Unknown command: ${chalk.bold(command)}\n`));
    printHelp();
    process.exit(1);
}

cmd.run();
