import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';

const PACKAGE_NAME = 'morphis';
const CHECK_TIMEOUT_MS = 3000;
const CACHE_DIR = path.join(os.homedir(), '.morphis');
const CACHE_FILE = path.join(CACHE_DIR, 'cli-update-check.json');
const PACKAGE_JSON_PATH = path.join(import.meta.dirname, '..', '..', 'package.json');

type UpdateLevel = 'patch' | 'minor' | 'major';

interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
}

interface SessionCacheEntry {
    day: string;
    checkedAt?: string;
    installedVersion?: string;
    lastCheckedVersion?: string;
    lastPromptedVersion?: string;
}

interface UpdateCache {
    sessions?: Record<string, SessionCacheEntry>;
}

function normalizeVersion(version: string): string {
    return version.trim().replace(/^v/i, '').replace(/^"|"$/g, '');
}

function parseVersion(version: string): ParsedVersion | null {
    const normalized = normalizeVersion(version);
    const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) return null;

    return {
        major: Number(match[1] ?? 0),
        minor: Number(match[2] ?? 0),
        patch: Number(match[3] ?? 0),
    };
}

export function compareVersions(left: string, right: string): number {
    const leftParsed = parseVersion(left);
    const rightParsed = parseVersion(right);
    if (!leftParsed || !rightParsed) return normalizeVersion(left).localeCompare(normalizeVersion(right));

    if (leftParsed.major !== rightParsed.major) {
        return leftParsed.major - rightParsed.major;
    }
    if (leftParsed.minor !== rightParsed.minor) {
        return leftParsed.minor - rightParsed.minor;
    }
    return leftParsed.patch - rightParsed.patch;
}

export function classifyUpdate(installedVersion: string, latestVersion: string): UpdateLevel | null {
    const installed = parseVersion(installedVersion);
    const latest = parseVersion(latestVersion);
    if (!installed || !latest) return null;
    if (compareVersions(latestVersion, installedVersion) <= 0) return null;
    if (latest.major > installed.major) return 'major';
    if (latest.minor > installed.minor) return 'minor';
    return 'patch';
}

function readInstalledVersion(): string {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { version?: string };
    return normalizeVersion(pkg.version ?? '0.0.0');
}

function runCommand(command: string, args: string[]): string {
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: CHECK_TIMEOUT_MS,
            windowsHide: true,
        }).trim();
    } catch {
        return '';
    }
}

function fetchLatestPublishedVersion(): string {
    const attempts: Array<[string, string[]]> = [
        ['npm', ['view', `${PACKAGE_NAME}@latest`, 'version']],
        ['bunx', ['npm@latest', 'view', `${PACKAGE_NAME}@latest`, 'version']],
    ];

    for (const [command, args] of attempts) {
        const output = normalizeVersion(runCommand(command, args));
        if (parseVersion(output)) return output;
    }

    return '';
}

function todayStamp(): string {
    return new Date().toISOString().slice(0, 10);
}

function getSessionKey(): string {
    return [
        process.env.MORPHIS_SESSION_ID,
        process.env.TERM_SESSION_ID,
        process.env.WT_SESSION,
        process.env.TMUX,
        process.env.KONSOLE_VERSION ? `konsole:${process.ppid}` : undefined,
        `ppid:${process.ppid}`,
    ].find(Boolean) ?? `ppid:${process.ppid}`;
}

function loadCache(): UpdateCache {
    if (!fs.existsSync(CACHE_FILE)) return {};

    try {
        const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as UpdateCache;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveCache(cache: UpdateCache) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function shouldSkipUpdateCheck(): boolean {
    return process.env.MORPHIS_SKIP_UPDATE_CHECK === '1' || process.env.CI === 'true';
}

function getUpgradeCommand(): string {
    return 'bun install -g morphis@latest';
}

function printUpdateNotice(installedVersion: string, latestVersion: string, level: UpdateLevel | null) {
    const updateCommand = getUpgradeCommand();

    console.log();
    console.log(chalk.yellow(`  A newer ${PACKAGE_NAME} CLI version is available: ${chalk.bold(installedVersion)} -> ${chalk.bold(latestVersion)}`));

    if (level === 'major' || level === 'minor') {
        console.log(chalk.gray('  Review CHANGELOG.md before updating because this release may contain breaking changes.'));
    }

    console.log(chalk.gray(`  Update with: ${updateCommand}`));
    console.log();
}

export async function maybeCheckCliUpdate() {
    if (shouldSkipUpdateCheck()) return;

    const installedVersion = readInstalledVersion();
    const latestVersion = fetchLatestPublishedVersion();
    if (!latestVersion || compareVersions(latestVersion, installedVersion) <= 0) return;

    const sessionKey = getSessionKey();
    const day = todayStamp();
    const cache = loadCache();
    const sessions = cache.sessions ?? {};
    const entry = sessions[sessionKey];
    const sessionEntry: SessionCacheEntry = !entry || entry.day !== day
        ? { day }
        : { ...entry };

    sessionEntry.day = day;
    sessionEntry.checkedAt = new Date().toISOString();
    sessionEntry.installedVersion = installedVersion;
    sessionEntry.lastCheckedVersion = latestVersion;

    const lastPromptedVersion = sessionEntry.lastPromptedVersion;
    const alreadyPrompted = lastPromptedVersion && compareVersions(lastPromptedVersion, latestVersion) >= 0;

    if (!alreadyPrompted) {
        const level = classifyUpdate(installedVersion, latestVersion);
        printUpdateNotice(installedVersion, latestVersion, level);
        sessionEntry.lastPromptedVersion = latestVersion;
    }

    sessions[sessionKey] = sessionEntry;
    cache.sessions = sessions;
    saveCache(cache);
}