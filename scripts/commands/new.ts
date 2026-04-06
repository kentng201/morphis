import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function hasBun(): boolean {
    try {
        execSync('bun --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function bunInstallInstructions(): string {
    if (process.platform === 'win32') {
        return chalk.gray('    powershell -c "irm bun.sh/install.ps1 | iex"');
    }
    return chalk.gray('    curl -fsSL https://bun.sh/install | bash');
}

export function runNew(rest: string[]) {
    const projectName = rest[0];
    if (!projectName || projectName.startsWith('--')) {
        console.error(chalk.red('\n  Missing required argument: <project-name>'));
        console.error(chalk.gray('  Example: morphis new my-app\n'));
        process.exit(1);
    }
    if (/[\/\\]/.test(projectName)) {
        console.error(chalk.red('\n  Invalid project name — must not contain path separators\n'));
        process.exit(1);
    }

    const dest = path.resolve(process.cwd(), projectName);
    if (fs.existsSync(dest)) {
        console.error(chalk.red(`\n  Directory already exists: ${projectName}\n`));
        process.exit(1);
    }

    console.log();
    console.log(chalk.bold.cyan('  Creating morphis project') + chalk.gray(` → ${projectName}/`));
    console.log();

    for (const dir of [
        'src/routes',
        'src/controllers',
        'src/middlewares',
        'src/providers',
        'src/services',
        'src/validations',
        'src/transformers',
        'src/types',
    ]) {
        fs.mkdirSync(path.join(dest, dir), { recursive: true });
        console.log(chalk.gray(`    mkdir  ${projectName}/${dir}`));
    }

    const files: Record<string, string> = {
        'src/index.ts': [
            `export { };`,
            ``,
            `const serverArg = process.argv.find(a => a.startsWith('--server='));`,
            `const server = serverArg ? serverArg.split('=')[1] : 'api';`,
            ``,
            `const port = Number(process.env.PORT);`,
            ``,
            "const { default: router } = await import(`./routes/${server}`);",
            ``,
            `Bun.serve({`,
            `    port,`,
            `    fetch: router.handle.bind(router),`,
            `});`,
            ``,
            "console.log(`Service running on http://localhost:${port}`);",
            ``,
        ].join('\n'),

        'src/routes/api.ts': [
            `import { Get, Router } from 'morphis';`,
            ``,
            `const router = new Router();`,
            ``,
            `router.get(() => ({ message: 'OK' }), [Get('/')]);`,
            ``,
            `export default router;`,
            ``,
        ].join('\n'),

        'src/types/Context.d.ts': [
            `export { };`,
            ``,
            `declare module 'morphis' {`,
            `    interface Context {`,
            `        // Add your custom context properties here`,
            `        // Example:`,
            `        // userId?: number;`,
            `    }`,
            `}`,
            ``,
        ].join('\n'),

        '.env.api': `NAME=api\nPORT=3000\n`,

        'package.json': JSON.stringify({
            name: projectName,
            version: '0.1.0',
            private: true,
            scripts: {
                dev: 'morphis dev --server=api',
                build: 'morphis build --server=api',
                start: 'morphis start --server=api',
                'route:list': 'morphis route:list --server=api',
            },
            devDependencies: {
                '@types/bun': 'latest',
                morphis: 'latest',
            },
        }, null, 4) + '\n',

        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'bundler',
                experimentalDecorators: true,
                lib: ['ES2020'],
                rootDir: 'src',
                outDir: 'dist',
                strict: true,
                esModuleInterop: true,
                declaration: true,
                declarationMap: true,
                sourceMap: true,
                skipLibCheck: true,
                types: ['bun'],
            },
            include: ['src/**/*'],
            exclude: ['node_modules', 'dist'],
        }, null, 4) + '\n',

        '.gitignore': `node_modules/\ndist/\n.env*\n!.env.*.example\n`,
    };

    for (const [filePath, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dest, filePath), content);
        console.log(chalk.gray(`    create ${projectName}/${filePath}`));
    }

    console.log();

    if (!hasBun()) {
        console.log(chalk.yellow('  Bun runtime not found. Install it first:'));
        console.log(bunInstallInstructions());
        console.log();
    }

    console.log(chalk.bold('  Next steps:'));
    console.log(chalk.cyan(`    cd ${projectName}`));
    console.log(chalk.cyan('    bun install'));
    console.log(chalk.cyan('    bun run dev'));
    console.log();
}
