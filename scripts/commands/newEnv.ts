import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { getEnvFileName } from '../utils/env';

export function runNewEnv(rest: string[]) {
    const envName = rest.find(arg => !arg.startsWith('--'));
    const serverArg = rest.find(arg => arg.startsWith('--server='));
    const fromArg = rest.find(arg => arg.startsWith('--from='));

    if (!envName || envName.startsWith('--')) {
        console.error(chalk.red('\n  Missing required argument: <env-name>'));
        console.error(chalk.gray('  Example: morphis new:env dev --server=api'));
        console.error(chalk.gray('           morphis new:env --server=api dev\n'));
        process.exit(1);
    }

    if (/[^a-zA-Z0-9_-]/.test(envName)) {
        console.error(chalk.red('\n  Invalid env name — only letters, numbers, hyphens and underscores allowed\n'));
        process.exit(1);
    }

    const server = serverArg?.split('=')[1];
    if (!server) {
        console.error(chalk.red('\n  Missing required option: --server=<name>'));
        console.error(chalk.gray('  Example: morphis new:env dev --server=api'));
        console.error(chalk.gray('           morphis new:env --server=api dev\n'));
        process.exit(1);
    }

    const cwd = process.cwd();
    const sourceFile = fromArg?.split('=')[1] ?? getEnvFileName(server);
    const sourcePath = path.isAbsolute(sourceFile) ? sourceFile : path.join(cwd, sourceFile);
    const targetFile = getEnvFileName(server, envName);
    const targetPath = path.join(cwd, targetFile);

    if (!fs.existsSync(sourcePath)) {
        console.error(chalk.red(`\n  Source env file not found: ${path.basename(sourceFile)}\n`));
        process.exit(1);
    }

    if (fs.existsSync(targetPath)) {
        console.error(chalk.red(`\n  Env file already exists: ${targetFile}\n`));
        process.exit(1);
    }

    const sourceContent = fs.readFileSync(sourcePath, 'utf8');
    const normalizedContent = sourceContent
        .replace(/^ENV=.*\r?\n?/m, '')
        .replace(/^\s*\r?\n/, '');

    fs.writeFileSync(targetPath, `ENV=${envName}\n${normalizedContent}`);

    console.log();
    console.log(chalk.bold.cyan('  Creating env file') + chalk.gray(` → ${targetFile}`));
    console.log(chalk.gray(`    copy ${path.basename(sourceFile)} -> ${targetFile}`));
    console.log(chalk.gray(`    set  ENV=${envName}`));
    console.log();
}