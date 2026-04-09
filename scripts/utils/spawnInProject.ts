import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Writes `script` as a temp `.ts` file inside `cwd` and runs it with `bun`.
 * Because the file lives in the target project's directory, Bun resolves
 * packages (e.g. pg, drizzle-orm) from that project's own node_modules.
 * The temp file is deleted on exit regardless of success or failure.
 */
export function runInProject(cwd: string, script: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const tmpFile = path.join(cwd, '.__morphis_tmp.ts');
        fs.writeFileSync(tmpFile, script);
        const proc = spawn('bun', ['run', tmpFile], {
            stdio: 'inherit',
            cwd,
            shell: process.platform === 'win32',
        });
        proc.on('exit', (code) => {
            try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
            if (code === 0) resolve();
            else reject(new Error(`Script exited with code ${code}`));
        });
        proc.on('error', (err) => {
            try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
            reject(err);
        });
    });
}
