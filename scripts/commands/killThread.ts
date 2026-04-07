import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function getCmdline(pid: number): string {
    try {
        if (process.platform === 'win32') {
            const out = execSync(
                `wmic process where ProcessId=${pid} get CommandLine /value`,
                { encoding: 'utf8' },
            );
            const match = out.match(/CommandLine=(.*)/);
            return match ? match[1].trim() : '';
        }
        return execSync(`ps -p ${pid} -o args=`, { encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

export function runKillThread(rest: string[]) {
    const serverArg = rest.find(a => a.startsWith('--server='));
    const envArg = rest.find(a => a.startsWith('--env=') || a.startsWith('--env-file='));
    const projectArg = rest.find(a => a.startsWith('--project='));

    const project = projectArg ? projectArg.split('=')[1] : null;

    let server: string | null = null;

    if (serverArg) {
        server = serverArg.split('=')[1];
    } else if (envArg) {
        const envPath = envArg.split('=')[1];
        const basename = path.basename(envPath);
        const match = basename.match(/^\.env\.(.+)$/);
        if (match) server = match[1];
    }

    if (!server) {
        console.error(chalk.red('\n  Missing required option: --server=<name> or --env=.env.<name>'));
        process.exit(1);
    }

    const envFile = path.join(process.cwd(), `.env.${server}`);
    if (!fs.existsSync(envFile)) {
        console.error(chalk.red(`\n  Env file not found: .env.${server}\n`));
        process.exit(1);
    }

    const content = fs.readFileSync(envFile, 'utf8');
    const portMatch = content.match(/^PORT=(\d+)/m);
    if (!portMatch) {
        console.error(chalk.red(`\n  No PORT defined in .env.${server}\n`));
        process.exit(1);
    }

    const port = Number(portMatch[1]);

    console.log();
    const projectLabel = project ? `, project=${project}` : '';
    console.log(chalk.bold.cyan(`  Killing threads`) + chalk.gray(` → server=${server}, port=${port}${projectLabel}`));
    console.log();

    let pids: number[] = [];

    if (process.platform === 'win32') {
        try {
            const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf8' });
            const lines = out.trim().split('\n');
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const localAddr = parts[1] ?? '';
                if (!localAddr.endsWith(`:${port}`)) continue;
                const pid = Number(parts[parts.length - 1]);
                if (pid && !isNaN(pid) && !pids.includes(pid)) pids.push(pid);
            }
        } catch {
            // findstr exits non-zero when no match — treat as no processes found
        }
    } else {
        try {
            const out = execSync(`lsof -ti TCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
            pids = out.trim().split('\n').map(Number).filter(n => !isNaN(n) && n > 0);
        } catch {
            // lsof exits non-zero when no match — treat as no processes found
        }
    }

    // Filter by --project if provided: only kill processes whose command line
    // includes --project=<name>, so processes from other projects on the same
    // port are left untouched.
    if (project) {
        pids = pids.filter(pid => getCmdline(pid).includes(`--project=${project}`));
    }

    if (pids.length === 0) {
        console.log(chalk.gray(`  No matching processes found on port ${port}.`));
        console.log();
        return;
    }

    for (const pid of pids) {
        try {
            if (process.platform === 'win32') {
                execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
            } else {
                process.kill(pid, 'SIGTERM');
            }
            console.log(chalk.green(`    killed PID ${pid}`));
        } catch {
            console.error(chalk.red(`    failed to kill PID ${pid}`));
        }
    }

    console.log();
}
