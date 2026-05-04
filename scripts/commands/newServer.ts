import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

export function runNewServer(rest: string[]) {
    const serverName = rest[0];
    if (!serverName || serverName.startsWith('--')) {
        console.error(chalk.red('\n  Missing required argument: <server-name>'));
        console.error(chalk.gray('  Example: morphis new:server ws\n'));
        process.exit(1);
    }
    if (/[^a-zA-Z0-9_-]/.test(serverName)) {
        console.error(chalk.red('\n  Invalid server name — only letters, numbers, hyphens and underscores allowed\n'));
        process.exit(1);
    }

    const cwd = process.cwd();
    const routesDir = path.join(cwd, 'src', 'routes');
    const routesFile = path.join(routesDir, `${serverName}.ts`);
    const envFile = path.join(cwd, `.env.${serverName}`);

    const usedPorts = new Set(
        fs.readdirSync(cwd)
            .filter(f => /^\.env\..+$/.test(f))
            .flatMap(f => {
                const content = fs.readFileSync(path.join(cwd, f), 'utf8');
                const match = content.match(/^PORT=(\d+)/m);
                return match ? [Number(match[1])] : [];
            }),
    );
    let port = 3000;
    while (usedPorts.has(port)) port++;

    if (fs.existsSync(routesFile)) {
        console.error(chalk.red(`\n  Routes file already exists: src/routes/${serverName}.ts\n`));
        process.exit(1);
    }
    if (fs.existsSync(envFile)) {
        console.error(chalk.red(`\n  Env file already exists: .env.${serverName}\n`));
        process.exit(1);
    }

    // ── Read package.json for project name and existing scripts ──────────────
    const pkgPath = path.join(cwd, 'package.json');
    let pkg: Record<string, unknown> = {};
    if (fs.existsSync(pkgPath)) {
        try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
    }
    const projectName: string = typeof pkg.name === 'string' && pkg.name ? pkg.name : '';
    const scripts: Record<string, string> =
        pkg.scripts && typeof pkg.scripts === 'object' ? { ...(pkg.scripts as Record<string, string>) } : {};

    const newScripts: Record<string, string> = {
        [`dev:${serverName}`]: `morphis dev --server=${serverName}${projectName ? ` --project=${projectName}` : ''}`,
        [`build:${serverName}`]: `morphis build --server=${serverName}${projectName ? ` --project=${projectName}` : ''}`,
        [`start:${serverName}`]: `morphis start --server=${serverName}${projectName ? ` --project=${projectName}` : ''}`,
    };

    const conflicting = Object.keys(newScripts).filter(k => k in scripts);
    if (conflicting.length > 0) {
        console.error(chalk.red(`\n  The following scripts already exist in package.json:`));
        for (const k of conflicting) console.error(chalk.gray(`    ${k}: ${scripts[k]}`));
        console.error(chalk.red(`  Aborting. Remove or rename them first.\n`));
        process.exit(1);
    }

    console.log();
    console.log(chalk.bold.cyan('  Creating server') + chalk.gray(` → ${serverName}`));
    console.log();

    fs.mkdirSync(routesDir, { recursive: true });

    fs.writeFileSync(
        routesFile,
        [
            `import { Cors, Get, Router } from 'morphis';`,
            ``,
            `const router = new Router();`,
            ``,
            `router.get(() => ({ message: 'OK' }), [Get('/')]);`,
            ``,
            `router.use([`,
            `    Cors({`,
            `        origins: '*',`,
            `    }),`,
            `]);`,
            ``,
            `export default router;`,
            ``,
        ].join('\n'),
    );
    console.log(chalk.gray(`    create src/routes/${serverName}.ts`));

    fs.writeFileSync(envFile, `NAME=${serverName}\nPORT=${port}\nMULTI_THREAD=true\n`);
    console.log(chalk.gray(`    create .env.${serverName}`));

    // ── Inject new scripts into package.json ─────────────────────────────────
    if (fs.existsSync(pkgPath)) {
        pkg.scripts = { ...scripts, ...newScripts };
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
        for (const k of Object.keys(newScripts)) {
            console.log(chalk.gray(`    update package.json → scripts.${k}`));
        }
    }

    console.log();
    console.log(chalk.bold('  Run it with:'));
    console.log(chalk.cyan(`    bun run dev:${serverName}`));
    console.log();
}
