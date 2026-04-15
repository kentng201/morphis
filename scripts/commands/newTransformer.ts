import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

export function runNewTransformer(rest: string[]) {
    const cwd = process.cwd();

    const transformerName = rest.find(arg => !arg.startsWith('-'));
    if (!transformerName) {
        console.error(chalk.red('\n  Missing required argument: <TransformerName>'));
        console.error(chalk.gray('  Example: morphis new:transformer PostResponseTransformer\n'));
        process.exit(1);
    }
    if (!/^[A-Z][A-Za-z0-9]*Transformer$/.test(transformerName)) {
        console.error(chalk.red('\n  Transformer name must be PascalCase and end with "Transformer"'));
        console.error(chalk.gray('  Example: PostBodyTransformer, OrderResponseTransformer\n'));
        process.exit(1);
    }

    if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        console.error(chalk.red('\n  Not in a project directory — package.json not found\n'));
        process.exit(1);
    }

    const transformersDir = path.join(cwd, 'src', 'transformers');
    fs.mkdirSync(transformersDir, { recursive: true });

    const transformerFile = path.join(transformersDir, `${transformerName}.ts`);
    if (fs.existsSync(transformerFile)) {
        console.error(chalk.red(`\n  src/transformers/${transformerName}.ts already exists — aborting\n`));
        process.exit(1);
    }

    const transformerContent = [
        `import { Transformer } from 'morphis';`,
        ``,
        `export class ${transformerName} extends Transformer<any, any> {`,
        `    transform(data: any) {`,
        `        return data;`,
        `    }`,
        `}`,
        ``,
    ].join('\n');

    fs.writeFileSync(transformerFile, transformerContent);

    console.log();
    console.log(chalk.gray(`    create src/transformers/${transformerName}.ts`));
    console.log();
    console.log(chalk.bold('  Transformer created: ') + chalk.cyan(`src/transformers/${transformerName}.ts`));
    console.log();
}