import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { runDockerBuild, generateDockerfile } from './dockerBuild';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProjectName(cwd: string, server: string): string {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
        } catch { /* ignore */ }
    }
    return server;
}

function getImageName(cwd: string, server: string): string {
    const project = getProjectName(cwd, server);
    return `${project}-${server}`;
}

function spawnCmd(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args, {
            stdio: 'inherit',
            cwd,
            shell: process.platform === 'win32',
        });
        proc.on('exit', (code) => {
            if (code !== 0) process.exit(code ?? 1);
            resolve();
        });
        proc.on('error', (err) => {
            console.error(chalk.red(`  Command "${cmd}" failed: ${err.message}`));
            process.exit(1);
        });
    });
}

function tryExec(cmd: string): string {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
        return '';
    }
}

/**
 * Returns [cmd, ...prefixArgs] for invoking wrangler.
 * Prefers a globally installed wrangler, falls back to `bunx wrangler`
 * so users don't need to install wrangler globally.
 */
function resolveWrangler(): [string, string[]] {
    const found = tryExec(process.platform === 'win32' ? 'where wrangler' : 'which wrangler');
    if (found) return ['wrangler', []];
    return ['bunx', ['wrangler']];
}

// ---------------------------------------------------------------------------
// AWS Lambda (container image via ECR)
// ---------------------------------------------------------------------------

async function deployAws(opts: {
    cwd: string;
    server: string;
    imageName: string;
    localTag: string;
    version: string;
    region: string;
    functionName: string;
}) {
    const { cwd, server, imageName, localTag, version, region, functionName } = opts;

    // Resolve AWS account ID
    const accountId = tryExec('aws sts get-caller-identity --query Account --output text');
    if (!accountId) {
        console.error(chalk.red('\n  Could not resolve AWS account ID.'));
        console.error(chalk.gray('  Ensure the AWS CLI is installed and credentials are configured.\n'));
        process.exit(1);
    }

    const ecrBase = `${accountId}.dkr.ecr.${region}.amazonaws.com`;
    const ecrRepo = `${ecrBase}/${imageName}`;
    const remoteTag = `${ecrRepo}:${version}`;

    console.log(chalk.cyan(`\n  [deploy:aws] Logging in to ECR (${region}) ...\n`));
    // Login via docker
    const loginPassword = tryExec(`aws ecr get-login-password --region ${region}`);
    if (!loginPassword) {
        console.error(chalk.red('  Failed to obtain ECR login password.\n'));
        process.exit(1);
    }

    // Create ECR repo if it doesn't exist (ignore error if already exists)
    tryExec(`aws ecr create-repository --repository-name ${imageName} --region ${region} 2>/dev/null`);

    await spawnCmd('docker', [
        'login', '--username', 'AWS', '--password-stdin', ecrBase,
    ], cwd).catch(() => { /* handled inside */ });

    // Write password via stdin using a sub-process
    await new Promise<void>((resolve) => {
        const proc = spawn(
            'docker', ['login', '--username', 'AWS', '--password-stdin', ecrBase],
            { cwd, shell: process.platform === 'win32', stdio: ['pipe', 'inherit', 'inherit'] },
        );
        proc.stdin.write(loginPassword);
        proc.stdin.end();
        proc.on('exit', (code) => {
            if (code !== 0) process.exit(code ?? 1);
            resolve();
        });
        proc.on('error', (err) => {
            console.error(chalk.red(`  docker login failed: ${err.message}`));
            process.exit(1);
        });
    });

    console.log(chalk.cyan(`\n  [deploy:aws] Tagging ${localTag} → ${remoteTag} ...\n`));
    await spawnCmd('docker', ['tag', localTag, remoteTag], cwd);

    console.log(chalk.cyan(`\n  [deploy:aws] Pushing ${remoteTag} ...\n`));
    await spawnCmd('docker', ['push', remoteTag], cwd);

    // Deploy / update Lambda
    console.log(chalk.cyan(`\n  [deploy:aws] Deploying to Lambda function "${functionName}" ...\n`));

    // Check if function exists
    const fnExists = tryExec(
        `aws lambda get-function --function-name ${functionName} --region ${region} --query "Configuration.FunctionName" --output text 2>/dev/null`,
    ) === functionName;

    if (fnExists) {
        await spawnCmd('aws', [
            'lambda', 'update-function-code',
            '--function-name', functionName,
            '--image-uri', remoteTag,
            '--region', region,
        ], cwd);
    } else {
        console.log(chalk.yellow(
            `\n  Lambda function "${functionName}" does not exist.\n` +
            `  Create it manually via the AWS Console or AWS CLI, then re-run deploy.\n\n` +
            `  aws lambda create-function \\\n` +
            `    --function-name ${functionName} \\\n` +
            `    --package-type Image \\\n` +
            `    --code ImageUri=${remoteTag} \\\n` +
            `    --role arn:aws:iam::${accountId}:role/lambda-execution-role \\\n` +
            `    --region ${region}\n`,
        ));
        process.exit(1);
    }

    console.log(chalk.green(`\n  [deploy:aws] Deployed to Lambda: ${chalk.bold(functionName)}\n`));
}

// ---------------------------------------------------------------------------
// Google Cloud Run (container image via Artifact Registry)
// ---------------------------------------------------------------------------

async function deployGcloud(opts: {
    cwd: string;
    server: string;
    imageName: string;
    localTag: string;
    version: string;
    region: string;
    gcpProject: string;
    serviceName: string;
}) {
    const { cwd, server, imageName, localTag, version, region, gcpProject, serviceName } = opts;

    const arHost = `${region}-docker.pkg.dev`;
    const arRepo = `${arHost}/${gcpProject}/${imageName}`;
    const remoteTag = `${arRepo}/${server}:${version}`;

    console.log(chalk.cyan(`\n  [deploy:gcloud] Configuring Docker auth for ${arHost} ...\n`));
    await spawnCmd('gcloud', ['auth', 'configure-docker', arHost, '--quiet'], cwd);

    // Ensure Artifact Registry repository exists
    tryExec(
        `gcloud artifacts repositories create ${imageName} --repository-format=docker ` +
        `--location=${region} --project=${gcpProject} --quiet 2>/dev/null`,
    );

    console.log(chalk.cyan(`\n  [deploy:gcloud] Tagging ${localTag} → ${remoteTag} ...\n`));
    await spawnCmd('docker', ['tag', localTag, remoteTag], cwd);

    console.log(chalk.cyan(`\n  [deploy:gcloud] Pushing ${remoteTag} ...\n`));
    await spawnCmd('docker', ['push', remoteTag], cwd);

    console.log(chalk.cyan(`\n  [deploy:gcloud] Deploying Cloud Run service "${serviceName}" ...\n`));
    await spawnCmd('gcloud', [
        'run', 'deploy', serviceName,
        `--image=${remoteTag}`,
        `--region=${region}`,
        `--project=${gcpProject}`,
        '--platform=managed',
        '--allow-unauthenticated',
        '--quiet',
    ], cwd);

    const url = tryExec(
        `gcloud run services describe ${serviceName} --region=${region} --project=${gcpProject} ` +
        `--format="value(status.url)" 2>/dev/null`,
    );

    console.log(chalk.green(`\n  [deploy:gcloud] Deployed Cloud Run service: ${chalk.bold(serviceName)}`));
    if (url) console.log(chalk.green(`  URL: ${chalk.underline(url)}`));
    console.log();
}

// ---------------------------------------------------------------------------
// Cloudflare Containers (Docker image via Wrangler + Durable Objects)
// https://developers.cloudflare.com/containers/get-started/
// ---------------------------------------------------------------------------

/** Convert a kebab/snake server name to PascalCase for a Durable Object class name. */
function toPascalCase(name: string): string {
    return name
        .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
        .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

async function deployCloudflare(opts: {
    cwd: string;
    server: string;
    version: string;
    workerName: string;
    maxInstances: number;
    port: number;
    sleepAfter: string;
    noBuild: boolean;
}) {
    const { cwd, server, version, workerName, maxInstances, port, sleepAfter, noBuild } = opts;

    const className = `${toPascalCase(server)}Container`;
    const bindingName = `${server.toUpperCase().replace(/-/g, '_')}_CONTAINER`;
    const date = new Date().toISOString().slice(0, 10);

    // All temp files are cleaned up in the finally block
    const dockerfileName = `.Dockerfile.morphis.${server}`;
    const workerEntryName = `_morphis_cf_entry_${server}.ts`;
    const wranglerConfigName = `wrangler.morphis.${server}.toml`;
    const tempFiles = [dockerfileName, workerEntryName, wranglerConfigName];

    const cleanup = () => {
        for (const f of tempFiles) {
            const abs = path.join(cwd, f);
            try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
        }
    };

    try {
        // Step 0: Ensure @cloudflare/containers is installed in the project
        const pkgPath = path.join(cwd, 'package.json');
        let cfContainersInstalled = false;
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                cfContainersInstalled = '@cloudflare/containers' in deps;
            } catch { /* ignore */ }
        }
        if (!cfContainersInstalled) {
            console.log(chalk.cyan(`\n  [deploy:cloudflare] Installing @cloudflare/containers ...\n`));
            await spawnCmd('bun', ['add', '-d', '@cloudflare/containers'], cwd);
        }

        // Step 0b: Ensure Docker Buildx is available with a docker-container driver builder.
        // Wrangler uses `docker build --load` which requires BuildKit.
        // The default `docker` driver (used by Colima and legacy setups) does NOT support --load;
        // a dedicated `docker-container` driver builder is required.
        const buildxAvailable = tryExec('docker buildx version') !== '';
        if (!buildxAvailable) {
            console.error(chalk.red('\n  Docker Buildx is not installed. Wrangler requires BuildKit to build container images.'));
            console.error(chalk.gray('\n  Choose one of the following to install Docker + Buildx:\n'));
            console.error(chalk.gray('  • Docker Desktop:  https://docs.docker.com/desktop/'));
            if (process.platform === 'darwin') {
                console.error(chalk.gray('  • Colima (macOS):  brew install colima docker docker-buildx kubectl'));
                console.error(chalk.gray('                     colima start --network-address'));
                console.error(chalk.gray('                     mkdir -p ~/.docker/cli-plugins'));
                console.error(chalk.gray('                     ln -sfn $(brew --prefix)/opt/docker-buildx/bin/docker-buildx ~/.docker/cli-plugins/docker-buildx'));
            }
            console.error(chalk.gray('\n  Buildx plugin:     https://docs.docker.com/go/buildx/\n'));
            process.exit(1);
        }

        // Create a persistent morphis-builder using the docker-container driver.
        // This is necessary for Colima and any setup where the default builder
        // uses the legacy `docker` driver (which does not support --load).
        const morphisBuilder = 'morphis-builder';
        const existingBuilders = tryExec('docker buildx ls');
        if (!existingBuilders.includes(morphisBuilder)) {
            console.log(chalk.gray(`  [deploy:cloudflare] Creating Docker buildx builder "${morphisBuilder}" (docker-container driver) ...\n`));
            await spawnCmd('docker', ['buildx', 'create', '--name', morphisBuilder, '--driver', 'docker-container', '--use'], cwd);
        } else {
            tryExec(`docker buildx use ${morphisBuilder}`);
        }
        // Replace the `docker build` shim so wrangler resolves to buildx
        tryExec('docker buildx install 2>&1');

        // Step 1: Build the Bun bundle
        if (!noBuild) {
            const scriptsDir = import.meta.dirname;
            console.log(chalk.cyan(`\n  [deploy:cloudflare] Building "${server}" bundle ...\n`));
            await new Promise<void>((resolve) => {
                const proc = spawn('bun', [path.join(scriptsDir, 'build.ts'), `--server=${server}`], {
                    stdio: 'inherit',
                    cwd,
                    shell: process.platform === 'win32',
                });
                proc.on('exit', (code) => {
                    if (code !== 0) process.exit(code ?? 1);
                    resolve();
                });
                proc.on('error', (err) => {
                    console.error(chalk.red(`  Build failed: ${err.message}`));
                    process.exit(1);
                });
            });
        }

        const distEntry = path.join(cwd, 'dist', server, 'index.js');
        if (!fs.existsSync(distEntry)) {
            console.error(chalk.red(`\n  Bundle not found: dist/${server}/index.js`));
            console.error(chalk.gray(`  Run: morphis build --server=${server}\n`));
            process.exit(1);
        }

        // Step 2: Write a Dockerfile that packages the Bun bundle
        fs.writeFileSync(path.join(cwd, dockerfileName), generateDockerfile(server), 'utf8');

        // Step 3: Write a Worker entry that routes all requests into the container.
        //   Uses @cloudflare/containers which wraps Durable Objects boilerplate.
        fs.writeFileSync(
            path.join(cwd, workerEntryName),
            [
                `import { Container, getRandom } from '@cloudflare/containers';`,
                ``,
                `export class ${className} extends Container {`,
                `    defaultPort = ${port};`,
                `    sleepAfter = '${sleepAfter}';`,
                `}`,
                ``,
                `export interface Env {`,
                `    ${bindingName}: DurableObjectNamespace<${className}>;`,
                `}`,
                ``,
                `export default {`,
                `    async fetch(request: Request, env: Env): Promise<Response> {`,
                `        const container = await getRandom(env.${bindingName}, ${maxInstances});`,
                `        return container.fetch(request);`,
                `    },`,
                `} satisfies ExportedHandler<Env>;`,
                ``,
            ].join('\n'),
            'utf8',
        );

        // Step 4: Write a dedicated wrangler config; avoids touching the user's own wrangler.toml
        fs.writeFileSync(
            path.join(cwd, wranglerConfigName),
            [
                `name = "${workerName}"`,
                `main = "${workerEntryName}"`,
                `compatibility_date = "${date}"`,
                ``,
                `[[containers]]`,
                `class_name = "${className}"`,
                `image = "${dockerfileName}"`,
                `max_instances = ${maxInstances}`,
                ``,
                `[[durable_objects.bindings]]`,
                `name = "${bindingName}"`,
                `class_name = "${className}"`,
                ``,
                `[[migrations]]`,
                `tag = "v1"`,
                `new_sqlite_classes = ["${className}"]`,
                ``,
            ].join('\n'),
            'utf8',
        );

        // Step 5: wrangler deploy — Wrangler builds the Docker image, pushes it to the
        //   Cloudflare Container Registry, and deploys your Worker + Container in one step.
        console.log(chalk.cyan(`\n  [deploy:cloudflare] Deploying Cloudflare Container "${workerName}" (version: ${version}) via Wrangler ...\n`));
        console.log(chalk.gray(`  Wrangler will use Docker to build the image and push it to the Cloudflare Container Registry.\n`));

        const [wranglerCmd, wranglerPrefix] = resolveWrangler();

        // Pre-flight: verify Wrangler auth before attempting deploy.
        // An expired or missing token causes a cryptic "Unauthorized" error during image push.
        const whoami = tryExec(`${wranglerCmd} ${[...wranglerPrefix, 'whoami'].join(' ')}`);
        if (!whoami || whoami.toLowerCase().includes('not authenticated') || whoami.toLowerCase().includes('error')) {
            console.error(chalk.red('\n  Wrangler is not authenticated with Cloudflare.'));
            console.error(chalk.gray(`  Run the following command and log in via your browser, then retry:\n`));
            console.error(chalk.cyan(`    ${wranglerCmd} ${[...wranglerPrefix, 'login'].join(' ')}\n`));
            process.exit(1);
        }

        // Pass the project's .env.<server> file to Wrangler so its variables are available.
        const envFilePath = path.join(cwd, `.env.${server}`);
        const envFileArgs = fs.existsSync(envFilePath) ? ['--env-file', `.env.${server}`] : [];

        await new Promise<void>((resolve) => {
            const proc = spawn(
                wranglerCmd,
                [...wranglerPrefix, 'deploy', '--config', wranglerConfigName, ...envFileArgs],
                { stdio: 'inherit', cwd, shell: process.platform === 'win32' },
            );
            proc.on('exit', (code) => {
                if (code !== 0) {
                    console.error(chalk.red('\n  [deploy:cloudflare] Wrangler deploy failed.'));
                    console.error(chalk.yellow('\n  If the error is "Unauthorized" during image push (buildAndMaybePush):'));
                    console.error(chalk.gray('  This means your Cloudflare account does not have access to the Containers beta,'));
                    console.error(chalk.gray('  or your API token is missing the "Cloudflare Containers: Edit" permission.\n'));
                    console.error(chalk.gray('  To fix:'));
                    console.error(chalk.gray('  1. Join / verify beta access:  https://developers.cloudflare.com/containers/beta-info/'));
                    console.error(chalk.gray('  2. Re-authenticate with a token that has the Containers permission:'));
                    console.error(chalk.cyan(`       ${wranglerCmd} ${[...wranglerPrefix, 'login'].join(' ')}\n`));
                    process.exit(code ?? 1);
                }
                resolve();
            });
            proc.on('error', (err) => {
                console.error(chalk.red(`  wrangler deploy failed: ${err.message}`));
                process.exit(1);
            });
        });

        console.log(chalk.green(`\n  [deploy:cloudflare] Container Worker deployed: ${chalk.bold(workerName)}`));
        console.log(chalk.gray(`  Note: containers take a few minutes to provision on first deploy.\n`));
    } finally {
        cleanup();
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runDeploy(args: string[]) {
    const serverArg = args.find(a => a.startsWith('--server='));
    const targetArg = args.find(a => a.startsWith('--target='));
    const versionArg = args.find(a => a.startsWith('--version='));
    const regionArg = args.find(a => a.startsWith('--region='));
    const projectArg = args.find(a => a.startsWith('--gcp-project='));
    const functionArg = args.find(a => a.startsWith('--function='));
    const serviceArg = args.find(a => a.startsWith('--service='));
    const workerArg = args.find(a => a.startsWith('--worker='));
    const maxInstancesArg = args.find(a => a.startsWith('--max-instances='));
    const portArg = args.find(a => a.startsWith('--port='));
    const sleepAfterArg = args.find(a => a.startsWith('--sleep-after='));
    const noBuild = args.includes('--no-build');
    const noBuildDocker = args.includes('--no-docker-build');

    const server = serverArg?.split('=')[1];
    const target = targetArg?.split('=')[1];
    const version = versionArg?.split('=')[1] ?? 'latest';

    if (!server) {
        console.error(chalk.red('\n  Missing required option: --server=<name>\n'));
        process.exit(1);
    }

    const validTargets = ['aws', 'gcloud', 'cloudflare'];
    if (!target || !validTargets.includes(target)) {
        console.error(chalk.red(`\n  Missing or invalid --target. Choose one of: ${validTargets.join(', ')}\n`));
        process.exit(1);
    }

    const cwd = process.cwd();
    const imageName = getImageName(cwd, server);

    if (target === 'cloudflare') {
        const workerName = workerArg?.split('=')[1] ?? imageName;
        const maxInstances = Number(maxInstancesArg?.split('=')[1] ?? '3');
        const port = Number(portArg?.split('=')[1] ?? '3000');
        const sleepAfter = sleepAfterArg?.split('=')[1] ?? '2m';
        await deployCloudflare({ cwd, server, version, workerName, maxInstances, port, sleepAfter, noBuild });
        return;
    }

    // For aws / gcloud — build Docker image first
    const localTag = noBuildDocker
        ? `${imageName}:${version}`
        : await runDockerBuild([`--server=${server}`, `--version=${version}`, ...(noBuild ? ['--no-build'] : [])]);

    if (target === 'aws') {
        const region = regionArg?.split('=')[1] ?? process.env.AWS_DEFAULT_REGION ?? 'ap-southeast-1';
        const functionName = functionArg?.split('=')[1] ?? imageName;
        await deployAws({ cwd, server, imageName, localTag, version, region, functionName });
    }

    if (target === 'gcloud') {
        const region = regionArg?.split('=')[1] ?? 'asia-east1';
        const gcpProject = projectArg?.split('=')[1] ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
        if (!gcpProject) {
            console.error(chalk.red('\n  Missing --gcp-project=<id> or GCLOUD_PROJECT env var for Google Cloud Run deployment.\n'));
            process.exit(1);
        }
        const serviceName = serviceArg?.split('=')[1] ?? imageName;
        await deployGcloud({ cwd, server, imageName, localTag, version, region, gcpProject, serviceName });
    }
}
