import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getEnvFileName, resolveEnvTarget } from '../utils/env';

const COMPILED_BINARY_TARGET = 'bun-linux-x64';
const LOCAL_SQLITE_TARGET_DIR = '/app/.morphis-data';
const MORPHIS_VENDOR_DIR = '.morphis-docker-vendor';
const MORPHIS_VENDOR_PACKAGE_DIR = `${MORPHIS_VENDOR_DIR}/morphis`;

interface DockerfileOptions {
    envFile?: string;
    lambdaAdapter?: boolean;
    port?: number;
    entryFile?: string;
    binaryName?: string;
    compileTarget?: string;
    minify?: boolean;
    obfuscate?: boolean;
}

interface SqliteMountPlan {
    sourceDir: string;
    targetDir: string;
    targetStoragePath: string;
}

function getPackageName(cwd: string): string | null {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (typeof pkg.name === 'string' && pkg.name) {
                return pkg.name;
            }
        } catch { /* ignore */ }
    }
    return null;
}

function getImageName(cwd: string, server: string, envName?: string | null): string {
    const packageName = getPackageName(cwd);
    if (packageName) {
        const envSuffix = envName ? `-${envName}` : '';
        return `${packageName}-${server}${envSuffix}`;
    }
    return envName ? `${server}-${envName}` : server;
}

function getDockerEntryFileName(server: string): string {
    return `.morphis.docker-entry.${server}.ts`;
}

function getMorphisPackageRoot(): string {
    return path.resolve(import.meta.dirname, '..', '..');
}

function hasProjectDatabaseConfig(cwd: string): boolean {
    return fs.existsSync(path.join(cwd, 'src', 'config', 'database.ts'))
        || fs.existsSync(path.join(cwd, 'src', 'config', 'database.js'));
}

function prepareMorphisVendor(cwd: string): string | null {
    const morphisRoot = getMorphisPackageRoot();
    const packageJsonPath = path.join(morphisRoot, 'package.json');

    if (!fs.existsSync(packageJsonPath)) return null;

    let packageName = '';
    try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
        packageName = typeof pkg.name === 'string' ? pkg.name : '';
    } catch {
        return null;
    }

    if (packageName !== 'morphis') return null;

    const vendorRoot = path.join(cwd, MORPHIS_VENDOR_DIR);
    const vendorPackageDir = path.join(cwd, MORPHIS_VENDOR_PACKAGE_DIR);
    fs.rmSync(vendorRoot, { recursive: true, force: true });
    fs.mkdirSync(vendorPackageDir, { recursive: true });

    for (const name of ['package.json', 'tsconfig.json']) {
        const sourcePath = path.join(morphisRoot, name);
        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, path.join(vendorPackageDir, name));
        }
    }

    for (const dirName of ['src', 'scripts']) {
        const sourceDir = path.join(morphisRoot, dirName);
        if (fs.existsSync(sourceDir)) {
            fs.cpSync(sourceDir, path.join(vendorPackageDir, dirName), { recursive: true });
        }
    }

    return vendorRoot;
}

function readEnvFileValues(filePath: string): Record<string, string> {
    if (!fs.existsSync(filePath)) return {};

    const out: Record<string, string> = {};
    const content = fs.readFileSync(filePath, 'utf8');

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
        const separatorIndex = normalized.indexOf('=');
        if (separatorIndex <= 0) continue;

        const key = normalized.slice(0, separatorIndex).trim();
        let value = normalized.slice(separatorIndex + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        out[key] = value;
    }

    return out;
}

function resolveRuntimePort(args: string[], envValues: Record<string, string>): number {
    const portArg = args.find(arg => arg.startsWith('--port='));
    const portValue = portArg?.split('=')[1] ?? envValues.PORT ?? '3000';
    const port = Number(portValue);
    return Number.isFinite(port) && port > 0 ? port : 3000;
}

function planSqliteMount(cwd: string, envValues: Record<string, string>): SqliteMountPlan | null {
    const storage = envValues.DB_STORAGE?.trim();
    if (!storage || storage === ':memory:') return null;
    if (/^(https?:|libsql:|file::memory:)/i.test(storage)) return null;
    if (!/(\.sqlite3?|\.db)$/i.test(storage)) return null;

    const sourcePath = path.isAbsolute(storage)
        ? storage
        : path.resolve(cwd, storage);
    const sourceDir = path.dirname(sourcePath);

    if (!fs.existsSync(sourceDir)) return null;

    const fileName = path.basename(sourcePath);
    return {
        sourceDir,
        targetDir: LOCAL_SQLITE_TARGET_DIR,
        targetStoragePath: `${LOCAL_SQLITE_TARGET_DIR}/${fileName}`,
    };
}

function shouldRewriteDbHost(envValues: Record<string, string>): boolean {
    const host = envValues.DB_HOST?.trim().toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0';
}

function sanitizeContainerName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function resolveDockerRuntime(server: string, args: string[], cwd: string, envFilePath: string, envName?: string | null) {
    const envValues = readEnvFileValues(envFilePath);
    const port = resolveRuntimePort(args, envValues);
    const versionArg = args.find(arg => arg.startsWith('--version='));
    const nameArg = args.find(arg => arg.startsWith('--name='));
    const imageName = getImageName(cwd, server, envName);
    const version = versionArg?.split('=')[1] ?? 'latest';

    return {
        envValues,
        fullTag: `${imageName}:${version}`,
        port,
        containerName: sanitizeContainerName(nameArg?.split('=')[1] ?? `${imageName}-local`),
        sqliteMount: planSqliteMount(cwd, envValues),
        rewriteDbHost: shouldRewriteDbHost(envValues),
    };
}

function createDockerEntrySource(server: string, envFile: string, includeDatabaseConfig: boolean): string {
    return `
const envFilePath = '${envFile}';
const envResource = Bun.file(envFilePath);

if (await envResource.exists()) {
    const envContent = await envResource.text();
    for (const rawLine of envContent.split(/\\r?\\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
        const separatorIndex = normalized.indexOf('=');
        if (separatorIndex <= 0) continue;

        const key = normalized.slice(0, separatorIndex).trim();
        if (!key || process.env[key] !== undefined) continue;

        const rawValue = normalized.slice(separatorIndex + 1).trim();
        const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
        process.env[key] = quoted ? rawValue.slice(1, -1) : rawValue;
    }
}

${includeDatabaseConfig
            ? `const [{ default: databases }, { default: router }] = await Promise.all([
    import('./src/config/database'),
    import('./src/routes/${server}'),
]);
const globalScope = globalThis as Record<string, unknown>;
globalScope.__morphisDatabases = databases;
globalScope.__morphisDatabaseConfig = databases;

function applyMorphisDatabases() {
    globalScope.__morphisDatabases = databases;
    globalScope.__morphisDatabaseConfig = databases;
}
`
            : `const { default: router } = await import('./src/routes/${server}');
`}

const port = Number(process.env.PORT ?? 3000);
Bun.serve({
    port,
    reusePort: process.env.MULTI_THREAD === 'true',
    fetch(request) {
${includeDatabaseConfig ? '        applyMorphisDatabases();\n' : ''}        return router.handle(request);
    },
});
console.log(\`Service running on http://localhost:\${port}\`);
`;
}

function createDockerBuildCommand(entryFile: string, binaryName: string, compileTarget: string, minify = false, obfuscate = false): string {
    const needsBundleArtifact = minify || obfuscate;
    const bundledFile = `.morphis.bundle.${binaryName}.js`;
    const obfuscatedFile = `.morphis.bundle.${binaryName}.obf.js`;
    const minifyFlag = minify ? ' --minify' : '';

    const commands: string[] = [];

    if (needsBundleArtifact) {
        commands.push(`bun build --target=bun ./${entryFile}${minifyFlag} --outfile ./${bundledFile}`);
    }

    if (obfuscate) {
        commands.push('bun add javascript-obfuscator');
        commands.push([
            `./node_modules/.bin/javascript-obfuscator ./${bundledFile}`,
            `--output ./${obfuscatedFile}`,
            '--compact true',
            '--identifier-names-generator hexadecimal',
            '--rename-globals false',
            '--simplify true',
            '--split-strings false',
            '--string-array true',
            '--string-array-encoding base64',
            '--string-array-threshold 0.75',
            '--transform-object-keys false',
            '--unicode-escape-sequence false',
        ].join(' '));
    }

    const compileInput = obfuscate
        ? obfuscatedFile
        : needsBundleArtifact
            ? bundledFile
            : entryFile;
    const compileMinifyFlag = needsBundleArtifact || !minify ? '' : ' --minify';
    commands.push(`bun build --compile --target=${compileTarget}${compileMinifyFlag} ./${compileInput} --outfile ./${binaryName}`);

    return commands.join(' && \\\n    ');
}

export function generateDockerfile(server: string, opts?: DockerfileOptions): string {
    const adapterStage = opts?.lambdaAdapter
        ? `FROM public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 AS adapter\n\n`
        : '';
    const adapterCopy = opts?.lambdaAdapter
        ? `COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter\n\n`
        : '';
    const adapterEnv = opts?.lambdaAdapter ? `ENV AWS_LAMBDA_EXEC_WRAPPER=""\n` : '';
    const port = opts?.port ?? 8080;
    const envFile = opts?.envFile ?? getEnvFileName(server);
    const entryFile = opts?.entryFile ?? getDockerEntryFileName(server);
    const binaryName = opts?.binaryName ?? server;
    const compileTarget = opts?.compileTarget ?? COMPILED_BINARY_TARGET;
    const minify = opts?.minify ?? false;
    const obfuscate = opts?.obfuscate ?? false;

    return `# Generated by morphis docker:build — do not commit this file directly.
${adapterStage}FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies before copying the rest of the project for better layer reuse
COPY package.json bun.lockb* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

# Copy the project and compile the selected server into a single binary
COPY . .
RUN if [ -d ./${MORPHIS_VENDOR_PACKAGE_DIR} ]; then \
        rm -rf ./node_modules/morphis && \
        mkdir -p ./node_modules && \
        cp -R ./${MORPHIS_VENDOR_PACKAGE_DIR} ./node_modules/morphis; \
    fi && \
    ${createDockerBuildCommand(entryFile, binaryName, compileTarget, minify, obfuscate)}

FROM gcr.io/distroless/cc-debian12 AS release

${adapterCopy}WORKDIR /app

# Copy the compiled binary and runtime config only
COPY --from=builder /app/${binaryName} ./${binaryName}
COPY --from=builder /app/${envFile} ./${envFile}

ENV PORT=${port}
${adapterEnv}
EXPOSE ${port}

ENTRYPOINT ["/app/${binaryName}"]
`;
}

function validateDockerTarget(args: string[], cwd: string) {
    const target = resolveEnvTarget(args, cwd);

    if (!target) {
        console.error(chalk.red('\n  Missing required option: --server=<name>, --env=<name>, or --env-file=.env.<name>\n'));
        process.exit(1);
    }

    if ((args.some(arg => arg.startsWith('--env=')) || args.some(arg => arg.startsWith('--env-file='))) && !fs.existsSync(target.envFilePath)) {
        console.error(chalk.red(`\n  Env file not found: ${target.envFile}\n`));
        process.exit(1);
    }

    const routesFile = path.join(cwd, 'src', 'routes', `${target.server}.ts`);
    if (!fs.existsSync(routesFile)) {
        console.error(chalk.red(`\n  Routes file not found: src/routes/${target.server}.ts`));
        console.error(chalk.gray(`  Create src/routes/${target.server}.ts and export a default Router.\n`));
        process.exit(1);
    }

    return target;
}

export function printDockerfile(args: string[]): void {
    const cwd = process.cwd();
    const target = validateDockerTarget(args, cwd);
    const port = resolveRuntimePort(args, readEnvFileValues(target.envFilePath));
    const entryFile = getDockerEntryFileName(target.server);
    const minify = args.includes('--minify');
    const obfuscate = args.includes('--obfuscate');
    console.log(generateDockerfile(target.server, {
        envFile: target.envFile,
        port,
        entryFile,
        compileTarget: COMPILED_BINARY_TARGET,
        minify,
        obfuscate,
    }));
}

export async function runDockerLocal(args: string[]): Promise<void> {
    const cwd = process.cwd();
    const target = validateDockerTarget(args, cwd);
    const runtime = resolveDockerRuntime(target.server, args, cwd, target.envFilePath, target.envName);
    const detach = args.includes('--detach');
    const noBuild = args.includes('--no-build');

    if (!noBuild) {
        await runDockerBuild([
            ...args.filter(arg =>
                arg.startsWith('--server=')
                || arg.startsWith('--env=')
                || arg.startsWith('--env-file=')
                || arg.startsWith('--version=')
                || arg === '--minify'
                || arg === '--obfuscate'
            ),
        ]);
    }

    const dockerArgs = ['run'];
    if (!detach) dockerArgs.push('--rm');
    if (detach) dockerArgs.push('-d');
    if (process.stdin.isTTY && process.stdout.isTTY && !detach) dockerArgs.push('-it');

    dockerArgs.push('--name', runtime.containerName);
    dockerArgs.push('-p', `${runtime.port}:${runtime.port}`);
    dockerArgs.push('--env-file', target.envFilePath);
    dockerArgs.push('-e', `PORT=${runtime.port}`);

    if (runtime.rewriteDbHost) {
        dockerArgs.push('-e', 'DB_HOST=host.docker.internal');
        if (process.platform === 'linux') {
            dockerArgs.push('--add-host', 'host.docker.internal:host-gateway');
        }
    }

    if (runtime.sqliteMount) {
        dockerArgs.push('--mount', `type=bind,source=${runtime.sqliteMount.sourceDir},target=${runtime.sqliteMount.targetDir}`);
        dockerArgs.push('-e', `DB_STORAGE=${runtime.sqliteMount.targetStoragePath}`);
    }

    dockerArgs.push(runtime.fullTag);

    console.log(chalk.cyan(`\n  [docker:run] Starting ${chalk.bold(runtime.fullTag)} on http://localhost:${runtime.port} ...\n`));
    if (runtime.rewriteDbHost) {
        console.log(chalk.gray('  Rewriting DB_HOST to host.docker.internal for container-to-host database access.'));
    }
    if (runtime.sqliteMount) {
        console.log(chalk.gray(`  Mounting local SQLite directory: ${runtime.sqliteMount.sourceDir} -> ${runtime.sqliteMount.targetDir}`));
    }
    console.log();

    await new Promise<void>((resolve) => {
        const proc = spawn('docker', dockerArgs, {
            stdio: 'inherit',
            cwd,
            shell: process.platform === 'win32',
        });
        proc.on('exit', (code) => {
            if (code !== 0) process.exit(code ?? 1);
            resolve();
        });
        proc.on('error', (err) => {
            console.error(chalk.red(`  docker run failed: ${err.message}`));
            console.error(chalk.gray('  Ensure Docker is installed and running.'));
            process.exit(1);
        });
    });
}

export async function runDockerBuild(args: string[]): Promise<string> {
    const versionArg = args.find(a => a.startsWith('--version='));
    const noBuild = args.includes('--no-build');
    const lambdaAdapter = args.includes('--lambda');
    const version = versionArg?.split('=')[1] ?? 'latest';
    const minify = args.includes('--minify');
    const obfuscate = args.includes('--obfuscate');
    const cwd = process.cwd();
    const target = validateDockerTarget(args, cwd);

    const { envFile, envName, server } = target;
    const imageName = getImageName(cwd, server, envName);
    const fullTag = `${imageName}:${version}`;
    const dockerfilePath = path.join(cwd, `.Dockerfile.morphis.${server}`);
    const entryFile = getDockerEntryFileName(server);
    const entryFilePath = path.join(cwd, entryFile);
    const port = resolveRuntimePort(args, readEnvFileValues(target.envFilePath));
    const vendorRoot = prepareMorphisVendor(cwd);
    const includeDatabaseConfig = hasProjectDatabaseConfig(cwd);

    if (!noBuild) {
        console.log(chalk.cyan(`\n  [docker:build] Preparing single-binary build for "${server}"...\n`));
    }

    fs.writeFileSync(entryFilePath, createDockerEntrySource(server, envFile, includeDatabaseConfig), 'utf8');

    if (lambdaAdapter) {
        console.log(chalk.cyan(`\n  [docker:build] Authenticating to public ECR for Lambda Web Adapter ...\n`));
        const { execSync } = await import('child_process');
        let token = '';
        try {
            token = execSync('aws ecr-public get-login-password --region us-east-1', {
                encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch {
            console.error(chalk.red('  Failed to get public ECR token.'));
            console.error(chalk.gray('  Ensure the AWS CLI is configured and you have ecr-public:GetAuthorizationToken permission.\n'));
            process.exit(1);
        }
        await new Promise<void>((resolve) => {
            const login = spawn('docker', ['login', '--username', 'AWS', '--password-stdin', 'public.ecr.aws'], {
                stdio: ['pipe', 'inherit', 'inherit'], cwd, shell: process.platform === 'win32',
            });
            login.stdin.write(token);
            login.stdin.end();
            login.on('exit', (code) => {
                if (code !== 0) { console.error(chalk.red('  docker login to public ECR failed.\n')); process.exit(1); }
                resolve();
            });
            login.on('error', (err) => {
                console.error(chalk.red(`  docker login failed: ${err.message}\n`));
                process.exit(1);
            });
        });
    }

    fs.writeFileSync(dockerfilePath, generateDockerfile(server, {
        envFile,
        lambdaAdapter,
        port,
        entryFile,
        compileTarget: COMPILED_BINARY_TARGET,
        minify,
        obfuscate,
    }), 'utf8');

    console.log(chalk.cyan(`\n  [docker:build] Building image ${chalk.bold(fullTag)} ...\n`));
    await new Promise<void>((resolve) => {
        const proc = spawn('docker', ['build', '--platform=linux/amd64', '--sbom=false', '--provenance=false', '--load', '-f', dockerfilePath, '-t', fullTag, '.'], {
            stdio: 'inherit',
            cwd,
            shell: process.platform === 'win32',
        });
        proc.on('exit', (code) => {
            fs.existsSync(dockerfilePath) && fs.unlinkSync(dockerfilePath);
            fs.existsSync(entryFilePath) && fs.unlinkSync(entryFilePath);
            vendorRoot && fs.existsSync(vendorRoot) && fs.rmSync(vendorRoot, { recursive: true, force: true });
            if (code !== 0) process.exit(code ?? 1);
            resolve();
        });
        proc.on('error', (err) => {
            fs.existsSync(dockerfilePath) && fs.unlinkSync(dockerfilePath);
            fs.existsSync(entryFilePath) && fs.unlinkSync(entryFilePath);
            vendorRoot && fs.existsSync(vendorRoot) && fs.rmSync(vendorRoot, { recursive: true, force: true });
            console.error(chalk.red(`  docker build failed: ${err.message}`));
            console.error(chalk.gray('  Ensure Docker is installed and running.'));
            process.exit(1);
        });
    });

    console.log(chalk.green(`\n  [docker:build] Image ready: ${chalk.bold(fullTag)}\n`));
    return fullTag;
}
