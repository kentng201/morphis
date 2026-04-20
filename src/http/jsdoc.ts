import fs from 'fs';
import path from 'path';
import type { RouteDocs } from './types';

export interface SourceLocation {
    filePath: string;
    line: number;
    column: number;
}

interface ParsedDocBlock {
    summary?: string;
    description?: string;
    deprecated?: boolean;
    tags: string[];
    params: Record<string, string>;
    requestBodyDescription?: string;
    responses: Record<string, string>;
    requestExamples: Record<string, unknown>;
    responseExamples: Record<string, Record<string, unknown>>;
}

const routeDocsCache = new Map<string, RouteDocs | undefined>();
const inlineDocsCache = new Map<string, RouteDocs | undefined>();
const sourceCache = new Map<string, string>();

function extractSourceLocation(stackLine: string): SourceLocation | null {
    const match = stackLine.match(/\(?((?:[A-Za-z]:)?\/[^():]+):(\d+):(\d+)\)?$/);
    if (!match) return null;

    return {
        filePath: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
    };
}

function isMorphisFrame(filePath: string): boolean {
    return filePath.includes('/node_modules/morphis/')
        || filePath.includes('/morphis/src/')
        || filePath.includes('/morphis/dist/')
        || filePath.includes('/morphis/scripts/');
}

export function captureDecoratorSourceFile(): string | undefined {
    return captureSourceLocation()?.filePath;
}

export function captureSourceLocation(): SourceLocation | undefined {
    const stack = new Error().stack?.split('\n') ?? [];

    for (const line of stack) {
        const location = extractSourceLocation(line.trim());
        if (!location || isMorphisFrame(location.filePath)) continue;
        if (fs.existsSync(location.filePath)) return location;
    }

    return undefined;
}

function getSource(filePath: string): string | null {
    if (sourceCache.has(filePath)) {
        return sourceCache.get(filePath) ?? null;
    }

    try {
        const source = fs.readFileSync(filePath, 'utf8');
        sourceCache.set(filePath, source);
        return source;
    } catch {
        sourceCache.set(filePath, '');
        return null;
    }
}

function normalizeDocLines(block: string): string[] {
    return block
        .replace(/^\s*\/\*\*/, '')
        .replace(/\*\/\s*$/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, '').trimEnd());
}

function parseDocBlock(block: string): ParsedDocBlock {
    const lines = normalizeDocLines(block);
    const descriptionLines: string[] = [];
    const tags: Array<{ name: string; value: string }> = [];
    let currentTag: { name: string; value: string } | null = null;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('@')) {
            const [, name = '', value = ''] = trimmed.match(/^@(\S+)\s*(.*)$/) ?? [];
            currentTag = { name, value: value.trim() };
            tags.push(currentTag);
            continue;
        }

        if (currentTag) {
            currentTag.value = currentTag.value
                ? `${currentTag.value}\n${trimmed}`.trim()
                : trimmed;
            continue;
        }

        descriptionLines.push(trimmed);
    }

    const paragraphs = descriptionLines
        .join('\n')
        .split(/\n\s*\n/)
        .map(part => part.replace(/\n/g, ' ').trim())
        .filter(Boolean);

    const summaryTag = tags.find(tag => tag.name === 'summary')?.value;
    const descriptionTag = tags.find(tag => tag.name === 'description' || tag.name === 'remarks')?.value;
    const summary = summaryTag || paragraphs[0];
    const remainingDescription = descriptionTag
        ?? paragraphs.slice(summary ? 1 : 0).join('\n\n')
        ?? undefined;

    const params: Record<string, string> = {};
    const responses: Record<string, string> = {};
    const requestExamples: Record<string, unknown> = {};
    const responseExamples: Record<string, Record<string, unknown>> = {};
    let requestBodyDescription: string | undefined;
    const openApiTags: string[] = [];
    let deprecated = false;

    for (const tag of tags) {
        switch (tag.name) {
            case 'param': {
                const [, name = '', description = ''] = tag.value.match(/^(\S+)\s*(.*)$/s) ?? [];
                if (name) params[name] = description.trim();
                break;
            }
            case 'body':
            case 'requestBody':
                requestBodyDescription = tag.value.trim();
                break;
            case 'requestExample':
            case 'exampleRequest': {
                const { mediaType, example } = parseRequestExampleTag(tag.value);
                if (example !== undefined) requestExamples[mediaType] = example;
                break;
            }
            case 'returns':
            case 'return':
                if (tag.value.trim()) responses['200'] = tag.value.trim();
                break;
            case 'response':
            case 'returnsResponse': {
                const [, code = '', description = ''] = tag.value.match(/^(\d{3})\s*(.*)$/s) ?? [];
                if (code) responses[code] = description.trim() || 'Response';
                break;
            }
            case 'responseExample':
            case 'exampleResponse': {
                const parsed = parseResponseExampleTag(tag.value);
                if (parsed?.example !== undefined) {
                    const mediaExamples = responseExamples[parsed.status] ?? {};
                    mediaExamples[parsed.mediaType] = parsed.example;
                    responseExamples[parsed.status] = mediaExamples;
                }
                break;
            }
            case 'tag':
                if (tag.value.trim()) openApiTags.push(tag.value.trim());
                break;
            case 'deprecated':
                deprecated = true;
                break;
        }
    }

    return {
        summary: summary?.trim() || undefined,
        description: remainingDescription?.trim() || undefined,
        deprecated,
        tags: openApiTags,
        params,
        requestBodyDescription,
        responses,
        requestExamples,
        responseExamples,
    };
}

function parseExampleLiteral(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
    const content = (fenced?.[1] ?? trimmed).trim();
    if (!content) return undefined;

    try {
        return JSON.parse(content);
    } catch {
        return content;
    }
}

function parseRequestExampleTag(raw: string): { mediaType: string; example: unknown } {
    const trimmed = raw.trim();
    const mediaTypeMatch = trimmed.match(/^(application\/[a-zA-Z0-9.+-]+|text\/[a-zA-Z0-9.+-]+)\s*([\s\S]*)$/);
    if (!mediaTypeMatch) {
        return {
            mediaType: 'application/json',
            example: parseExampleLiteral(trimmed),
        };
    }

    return {
        mediaType: mediaTypeMatch[1],
        example: parseExampleLiteral(mediaTypeMatch[2]),
    };
}

function parseResponseExampleTag(raw: string): { status: string; mediaType: string; example: unknown } | undefined {
    const trimmed = raw.trim();
    const statusMatch = trimmed.match(/^(\d{3})\s*([\s\S]*)$/);
    if (!statusMatch) return undefined;

    const status = statusMatch[1];
    const rest = statusMatch[2].trim();
    const mediaTypeMatch = rest.match(/^(application\/[a-zA-Z0-9.+-]+|text\/[a-zA-Z0-9.+-]+)\s*([\s\S]*)$/);

    return {
        status,
        mediaType: mediaTypeMatch?.[1] ?? 'application/json',
        example: parseExampleLiteral(mediaTypeMatch?.[2] ?? rest),
    };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findDeclarationIndex(source: string, pattern: RegExp): number {
    const match = pattern.exec(source);
    return match?.index ?? -1;
}

function walkBackOverDecorators(source: string, index: number): number {
    let cursor = index;

    while (cursor > 0) {
        while (cursor > 0 && /\s/.test(source[cursor - 1])) {
            cursor--;
        }

        const lineStart = source.lastIndexOf('\n', cursor - 1) + 1;
        const line = source.slice(lineStart, cursor).trim();
        if (!line) {
            cursor = lineStart;
            continue;
        }

        if (line.startsWith('@')) {
            cursor = lineStart;
            continue;
        }

        break;
    }

    return cursor;
}

function findNearestDocBlock(source: string, declarationIndex: number): string | undefined {
    if (declarationIndex < 0) return undefined;

    const cursor = walkBackOverDecorators(source, declarationIndex);
    const end = source.lastIndexOf('*/', cursor);
    if (end < 0) return undefined;

    const gap = source.slice(end + 2, cursor).trim();
    if (gap) return undefined;

    const start = source.lastIndexOf('/**', end);
    if (start < 0) return undefined;

    return source.slice(start, end + 2);
}

function lineOffset(source: string, lineNumber: number): number {
    if (lineNumber <= 1) return 0;

    let line = 1;
    for (let index = 0; index < source.length; index++) {
        if (line === lineNumber) return index;
        if (source[index] === '\n') line++;
    }

    return source.length;
}

function findClassDoc(source: string, className: string): ParsedDocBlock | undefined {
    const declarationIndex = findDeclarationIndex(
        source,
        new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapeRegExp(className)}\\b`),
    );
    const block = findNearestDocBlock(source, declarationIndex);
    return block ? parseDocBlock(block) : undefined;
}

function findMethodDoc(source: string, handlerKey: string): ParsedDocBlock | undefined {
    const declarationIndex = findDeclarationIndex(
        source,
        new RegExp(`(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|readonly\\s+|override\\s+|abstract\\s+)*${escapeRegExp(handlerKey)}\\s*\\(`),
    );
    const block = findNearestDocBlock(source, declarationIndex);
    return block ? parseDocBlock(block) : undefined;
}

export function resolveRouteDocs(filePath: string | undefined, className: string, handlerKey: string): RouteDocs | undefined {
    if (!filePath) return undefined;

    const cacheKey = `${path.resolve(filePath)}::${className}::${handlerKey}`;
    if (routeDocsCache.has(cacheKey)) {
        return routeDocsCache.get(cacheKey);
    }

    const source = getSource(filePath);
    if (!source) {
        routeDocsCache.set(cacheKey, undefined);
        return undefined;
    }

    const classDoc = findClassDoc(source, className);
    const methodDoc = findMethodDoc(source, handlerKey);
    if (!classDoc && !methodDoc) {
        routeDocsCache.set(cacheKey, undefined);
        return undefined;
    }

    const docs: RouteDocs = {
        summary: methodDoc?.summary,
        description: methodDoc?.description,
        deprecated: methodDoc?.deprecated,
        tags: [...new Set([...(classDoc?.tags ?? []), ...(methodDoc?.tags ?? [])])],
        params: {
            ...(classDoc?.params ?? {}),
            ...(methodDoc?.params ?? {}),
        },
        requestBodyDescription: methodDoc?.requestBodyDescription,
        responses: {
            ...(classDoc?.responses ?? {}),
            ...(methodDoc?.responses ?? {}),
        },
        requestExamples: {
            ...(methodDoc?.requestExamples ?? {}),
        },
        responseExamples: {
            ...(methodDoc?.responseExamples ?? {}),
        },
        controllerSummary: classDoc?.summary,
        controllerDescription: classDoc?.description ?? classDoc?.summary,
    };

    routeDocsCache.set(cacheKey, docs);
    return docs;
}

export function resolveInlineRouteDocs(location: SourceLocation | undefined): RouteDocs | undefined {
    if (!location) return undefined;

    const cacheKey = `${path.resolve(location.filePath)}:${location.line}:${location.column}`;
    if (inlineDocsCache.has(cacheKey)) {
        return inlineDocsCache.get(cacheKey);
    }

    const source = getSource(location.filePath);
    if (!source) {
        inlineDocsCache.set(cacheKey, undefined);
        return undefined;
    }

    const block = findNearestDocBlock(source, lineOffset(source, location.line));
    if (!block) {
        inlineDocsCache.set(cacheKey, undefined);
        return undefined;
    }

    const parsed = parseDocBlock(block);
    const docs: RouteDocs = {
        summary: parsed.summary,
        description: parsed.description,
        deprecated: parsed.deprecated,
        tags: parsed.tags,
        params: parsed.params,
        requestBodyDescription: parsed.requestBodyDescription,
        responses: parsed.responses,
        requestExamples: parsed.requestExamples,
        responseExamples: parsed.responseExamples,
    };

    inlineDocsCache.set(cacheKey, docs);
    return docs;
}