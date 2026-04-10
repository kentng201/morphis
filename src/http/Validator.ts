import type { DotNotationType } from '../types/DotNotation';
import type {
    SchemaScalarType,
    ValidateMap,
    ValidationCriterion,
    ValidationFieldMetadata,
    ValidationSource,
    ValidationSourceMetadata,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// SimpleRules — declarative per-field validation enum
// ═══════════════════════════════════════════════════════════════════════════════

export const SimpleRules = {
    // Simple (no-param) rules — PascalCase key, camelCase string value
    Positive: 'positive' as const,
    Negative: 'negative' as const,
    Required: 'required' as const,
    Optional: 'optional' as const,
    Nullable: 'nullable' as const,
    Nullish: 'nullish' as const,
    Email: 'email' as const,
    Alphanumeric: 'alphanumeric' as const,
    Numeric: 'numeric' as const,
    Uppercase: 'uppercase' as const,
    Lowercase: 'lowercase' as const,
    NoSpecialCharacters: 'noSpecialCharacters' as const,
    Date: 'date' as const,
    Boolean: 'boolean' as const,
    // Parameterized rules — PascalCase key, factory function returning tagged object
    Max: (value: number) => ({ type: 'max' as const, value }),
    Min: (value: number) => ({ type: 'min' as const, value }),
    Regex: (pattern: RegExp) => ({ type: 'regex' as const, pattern }),
    In: (...values: unknown[]) => ({ type: 'in' as const, values }),
    Between: (min: number, max: number) => ({ type: 'between' as const, min, max }),
    Decimals: (max: number, min: number = 0) => ({ type: 'decimals' as const, max, min }),
    GreaterThan: (value: number) => ({ type: 'greaterThan' as const, value }),
    GreaterThanOrEqual: (value: number) => ({ type: 'greaterThanOrEqual' as const, value }),
    LessThan: (value: number) => ({ type: 'lessThan' as const, value }),
    LessThanOrEqual: (value: number) => ({ type: 'lessThanOrEqual' as const, value }),
    Length: (max: number, min: number = 0) => ({ type: 'length' as const, max, min }),
    Size: (max: number, min: number = 0) => ({ type: 'size' as const, max, min }),
    Enum: (enumObj: Record<string, unknown>) => ({ type: 'enum' as const, enumObj }),
};

type SimpleStringRule = Extract<typeof SimpleRules[keyof typeof SimpleRules], string>;
type ParameterizedRule =
    | ReturnType<typeof SimpleRules.Max>
    | ReturnType<typeof SimpleRules.Min>
    | ReturnType<typeof SimpleRules.Regex>
    | ReturnType<typeof SimpleRules.In>
    | ReturnType<typeof SimpleRules.Between>
    | ReturnType<typeof SimpleRules.Decimals>
    | ReturnType<typeof SimpleRules.GreaterThan>
    | ReturnType<typeof SimpleRules.GreaterThanOrEqual>
    | ReturnType<typeof SimpleRules.LessThan>
    | ReturnType<typeof SimpleRules.LessThanOrEqual>
    | ReturnType<typeof SimpleRules.Length>
    | ReturnType<typeof SimpleRules.Size>
    | ReturnType<typeof SimpleRules.Enum>;
type AnySimpleRule = SimpleStringRule | ParameterizedRule;
type SimpleRuleValue = AnySimpleRule | Array<AnySimpleRule | ValidationRule<any>>;
type NestedSimpleRuleMap = { [singleSegmentKey: string]: SimpleRuleValue };
export type SimpleValidationRuleMap<T> = { [dotKey: string]: SimpleRuleValue | NestedSimpleRuleMap | ValidationRule<T> };

export type ValidateOptions = {
    fieldNames?: Record<string, string>;
    /**
     * When true (default), all $field tokens in the message each get their own error entry.
     * When false, only the first referenced $field gets the error.
     */
    duplicateError?: boolean;
}

// ── type helpers ─────────────────────────────────────────────────────────────

type UnwrapArray<T> = T extends (infer U)[] ? U : T;

// Generate valid 2-level dot-notation keys from T
type DirectKeys<T> = keyof T & string;

type NestedKeys<T, K extends DirectKeys<T>> =
    T[K] extends (infer U)[]
    ? U extends object ? `${K}.${keyof U & string}` : never
    : NonNullable<T[K]> extends object ? `${K}.${keyof NonNullable<T[K]> & string}` : never;

type DotKeys<T> =
    | DirectKeys<T>
    | { [K in DirectKeys<T>]: NestedKeys<T, K> }[DirectKeys<T>];

// ── rule types ────────────────────────────────────────────────────────────────

type ObjectRule<T> = {
    key?: undefined;
    rule: (obj: T) => boolean | Promise<boolean>;
    message: string;
}

// Distributed union: each member has a literal `key` so TypeScript contextually
// types the `rule` callback to the correct item type at that dot-notation path.
type KeyedRuleUnion<T> = {
    [K in DotKeys<T>]: {
        key: K;
        rule: (item: UnwrapArray<NonNullable<DotNotationType<T, K>>>, index: number) => boolean | Promise<boolean>;
        message: string;
    }
}[DotKeys<T>];

export type ValidationRule<T> = ObjectRule<T> | KeyedRuleUnion<T>;

export type ValidationResult<T> = {
    valid: boolean;
    output?: T;
    errors: Record<string, string[]>;
}

// ── path traversal (runtime) ──────────────────────────────────────────────────

type Resolved = { value: unknown; keyPath: string };

function resolvePath(root: unknown, segments: string[]): Resolved[] {
    if (segments.length === 0) return [{ value: root, keyPath: '' }];

    // Can't traverse into null/undefined — skip this branch entirely
    if (root == null) return [];

    const [head, ...rest] = segments;
    const child = (root as any)[head];

    if (Array.isArray(child)) {
        if (rest.length === 0) {
            return child.map((item, i) => ({ value: item, keyPath: `${head}.${i}` }));
        }
        return child.flatMap((item, i) =>
            resolvePath(item, rest).map(n => ({
                value: n.value,
                keyPath: `${head}.${i}${n.keyPath ? '.' + n.keyPath : ''}`,
            }))
        );
    }

    if (rest.length === 0) return [{ value: child, keyPath: head }];

    return resolvePath(child, rest).map(n => ({
        value: n.value,
        keyPath: `${head}${n.keyPath ? '.' + n.keyPath : ''}`,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core engine — shared by Validator class and standalone validate()
// ═══════════════════════════════════════════════════════════════════════════════

async function runValidation<T>(
    object: T,
    rules: ValidationRule<T>[],
    fieldNames: Record<string, string>,
    duplicateError: boolean,
): Promise<ValidationResult<T>> {
    const errors: Record<string, string[]> = {};

    const addError = (key: string, msg: string) => {
        if (!errors[key]) errors[key] = [];
        errors[key].push(msg);
    };

    const substituteMessage = (msg: string) =>
        msg.replace(/\$(\w+)/g, (_, name: string) => {
            if (fieldNames[name] !== undefined) return fieldNames[name];
            const matchingKey = Object.keys(fieldNames).find(k => k.split('.').pop() === name);
            return matchingKey ? fieldNames[matchingKey] : name;
        });

    for (const entry of rules) {
        if (entry.key === undefined) {
            if (!(await (entry as ObjectRule<T>).rule(object))) {
                const msg = substituteMessage(entry.message);
                const tokens = [...entry.message.matchAll(/\$(\w+)/g)].map(m => m[1]);
                const tokensToReport = !duplicateError ? tokens.slice(0, 1) : tokens;
                if (tokensToReport.length > 0) {
                    for (const token of tokensToReport) {
                        addError(token, msg);
                    }
                } else {
                    addError('_', msg);
                }
            }
        } else {
            const segments = (entry.key as string).split('.');
            const resolved = resolvePath(object, segments);
            const ruleFn = (entry as any).rule as (item: unknown, index: number) => boolean | Promise<boolean>;

            const allTokens = [...entry.message.matchAll(/\$(\w+)/g)].map(m => m[1]);
            const tokensToReport = !duplicateError ? allTokens.slice(0, 1) : allTokens;

            for (const [index, { value, keyPath }] of resolved.entries()) {
                const nullBehavior: NullBehavior | undefined = (entry as any)._nullBehavior;
                // Default: skip both null and undefined (engine ignores absent/null fields).
                // Nullable: let null through (predicate handles it); skip undefined.
                // Nullish:  let both null and undefined through (predicate handles them).
                if (!nullBehavior && value == null) continue;
                if (nullBehavior === 'nullable' && value === undefined) continue;
                if (!(await ruleFn(value, index))) {
                    const msg = substituteMessage(entry.message);
                    if (tokensToReport.length > 0) {
                        for (const token of tokensToReport) {
                            // If the token is already the last segment of keyPath (self-referential
                            // simple rule like key:'gst', message:'$gst...'), use keyPath directly
                            // to avoid duplicate segments like 'gst.gst' or 'items.0.price.price'.
                            const lastSegment = keyPath.split('.').pop();
                            const errorKey = token === lastSegment ? keyPath : `${keyPath}.${token}`;
                            addError(errorKey, msg);
                        }
                    } else {
                        addError(keyPath, msg);
                    }
                }
            }
        }
    }

    return { valid: Object.keys(errors).length === 0, errors, output: Object.keys(errors).length === 0 ? object : undefined };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SimpleRules internal tables & expandSimpleRules helper
// ═══════════════════════════════════════════════════════════════════════════════

// Known parameterized rule type tags — used to distinguish from NestedSimpleRuleMap objects.
const PARAMETERIZED_RULE_TYPES = new Set([
    'max', 'min', 'regex', 'in', 'between', 'decimals',
    'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'length', 'size', 'enum',
]);

const SIMPLE_RULE_PREDICATES: Record<string, (value: unknown, params: any) => boolean> = {
    positive: (v) => typeof v === 'number' && v > 0,
    negative: (v) => typeof v === 'number' && v < 0,
    required: (v) => v !== null && v !== undefined && v !== '' && (!Array.isArray(v) || v.length > 0),
    optional: () => true,
    nullable: () => true,
    nullish: () => true,
    email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    alphanumeric: (v) => typeof v === 'string' && /^[a-zA-Z0-9]+$/.test(v),
    numeric: (v) => typeof v === 'number' && !isNaN(v),
    uppercase: (v) => typeof v === 'string' && v.length > 0 && v === v.toUpperCase(),
    lowercase: (v) => typeof v === 'string' && v.length > 0 && v === v.toLowerCase(),
    noSpecialCharacters: (v) => typeof v === 'string' && /^[a-zA-Z0-9\s]*$/.test(v),
    date: (v) => v instanceof Date || (typeof v === 'string' && !isNaN(Date.parse(v))),
    boolean: (v) => typeof v === 'boolean',
    max: (v, p) => (typeof v === 'number' && v <= p.value) || (typeof v === 'string' && v.length <= p.value) || (Array.isArray(v) && v.length <= p.value),
    min: (v, p) => (typeof v === 'number' && v >= p.value) || (typeof v === 'string' && v.length >= p.value) || (Array.isArray(v) && v.length >= p.value),
    regex: (v, p) => typeof v === 'string' && (p.pattern as RegExp).test(v),
    in: (v, p) => (p.values as unknown[]).includes(v),
    between: (v, p) => typeof v === 'number' && v >= p.min && v <= p.max,
    decimals: (v, p) => { const d = (String(v).split('.')[1] ?? '').length; return d >= p.min && d <= p.max; },
    greaterThan: (v, p) => typeof v === 'number' && v > p.value,
    greaterThanOrEqual: (v, p) => typeof v === 'number' && v >= p.value,
    lessThan: (v, p) => typeof v === 'number' && v < p.value,
    lessThanOrEqual: (v, p) => typeof v === 'number' && v <= p.value,
    length: (v, p) => typeof v === 'string' && v.length >= p.min && v.length <= p.max,
    size: (v, p) => Array.isArray(v) && v.length >= p.min && v.length <= p.max,
    enum: (v, p) => Object.values(p.enumObj as Record<string, unknown>).includes(v),
};

const SIMPLE_RULE_MESSAGES: Record<string, string | ((params: any) => string)> = {
    positive: 'must be a positive number',
    negative: 'must be a negative number',
    required: 'is required',
    optional: '',
    nullable: '',
    nullish: '',
    email: 'must be a valid email address',
    alphanumeric: 'must only contain numbers and alphabets',
    numeric: 'must be a valid number',
    uppercase: 'must be in uppercase',
    lowercase: 'must be in lowercase',
    noSpecialCharacters: 'must not contain special characters',
    date: 'must be a valid date',
    boolean: 'must be a boolean value',
    max: (p) => `must be at most ${p.value}`,
    min: (p) => `must be at least ${p.value}`,
    regex: (p) => `must match the required pattern ${p.value}`,
    in: (p) => `must be one of: ${(p.values as unknown[]).join(', ')}`,
    between: (p) => `must be between ${p.min} and ${p.max}`,
    decimals: (p) => p.min === 0 ? `must have at most ${p.max} decimal places` : `must have between ${p.min} and ${p.max} decimal places`,
    greaterThan: (p) => `must be greater than ${p.value}`,
    greaterThanOrEqual: (p) => `must be greater than or equal to ${p.value}`,
    lessThan: (p) => `must be less than ${p.value}`,
    lessThanOrEqual: (p) => `must be less than or equal to ${p.value}`,
    length: (p) => p.min === 0 ? `must have at most ${p.max} characters` : `must have between ${p.min} and ${p.max} characters`,
    size: (p) => p.min === 0 ? `must have at most ${p.max} items` : `must have between ${p.min} and ${p.max} items`,
    enum: 'must be a valid enum value',
};

function isValidationRule(value: unknown): value is ValidationRule<any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof (value as any).rule === 'function'
        && typeof (value as any).message === 'string';
}

function isParameterizedRule(value: unknown): value is ParameterizedRule {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && !isValidationRule(value)
        && typeof (value as any).type === 'string'
        && PARAMETERIZED_RULE_TYPES.has((value as any).type);
}

function isNestedSimpleRuleMap(value: unknown): value is NestedSimpleRuleMap {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && !isValidationRule(value)
        && !isParameterizedRule(value);
}

type NullBehavior = 'nullable' | 'nullish';

/**
 * Builds ValidationRule entries for a single field.
 *
 * Nullable / Nullish act as modifiers:
 *   - Nullable  → null passes, undefined fails; other rules only run on real values.
 *   - Nullish   → null OR undefined passes; other rules only run on real values.
 * When present alongside other rules, each other rule's predicate is wrapped so that
 * null (Nullable) or null|undefined (Nullish) automatically passes, and the rule is
 * tagged with _nullBehavior so runValidation knows not to short-circuit it.
 */
function buildFieldRules<T>(fullKey: string, token: string, rawValues: Array<AnySimpleRule | ValidationRule<any>>): ValidationRule<T>[] {
    const inlineRules = rawValues.filter(isValidationRule) as ValidationRule<T>[];
    const simpleValues = rawValues.filter((v): v is AnySimpleRule => !isValidationRule(v));

    const getType = (v: AnySimpleRule): string => typeof v === 'string' ? v : (v as ParameterizedRule).type;
    const getParams = (v: AnySimpleRule): any => typeof v === 'string' ? null : v;

    const hasNullable = simpleValues.some(v => getType(v) === 'nullable');
    const hasNullish = simpleValues.some(v => getType(v) === 'nullish');
    const nullBehavior: NullBehavior | undefined = hasNullish ? 'nullish' : hasNullable ? 'nullable' : undefined;

    const activeValues = simpleValues.filter(v => {
        const t = getType(v);
        return t !== 'optional' && t !== 'nullable' && t !== 'nullish';
    });

    const rules: ValidationRule<T>[] = [];

    for (const simpleValue of activeValues) {
        const type = getType(simpleValue);
        const params = getParams(simpleValue);
        const basePredFn = SIMPLE_RULE_PREDICATES[type];
        if (!basePredFn) continue;

        const base = (v: unknown) => basePredFn(v, params);
        const predicate = hasNullish
            ? (v: unknown) => v == null || base(v)
            : hasNullable
                ? (v: unknown) => v === null || base(v)
                : base;

        const msgTemplate = SIMPLE_RULE_MESSAGES[type];
        const msgText = typeof msgTemplate === 'function' ? msgTemplate(params) : msgTemplate;

        const rule: any = {
            key: fullKey,
            rule: (item: unknown) => predicate(item),
            message: `$${token} ${msgText}`,
        };
        if (nullBehavior) rule._nullBehavior = nullBehavior;
        rules.push(rule as ValidationRule<T>);
    }

    // Nullable alone (no other enum rules, no inline rules): presence check — null OK, undefined not.
    if (activeValues.length === 0 && inlineRules.length === 0 && hasNullable) {
        const rule: any = {
            key: fullKey,
            rule: (v: unknown) => v !== undefined,
            message: `$${token} must be present (null is allowed, but undefined is not)`,
            _nullBehavior: 'nullable' as NullBehavior,
        };
        rules.push(rule as ValidationRule<T>);
    }
    // Nullish alone: no rule — field is completely optional.

    rules.push(...inlineRules);
    return rules;
}

function toRawValues(mapValue: SimpleRuleValue): Array<AnySimpleRule | ValidationRule<any>> {
    if (Array.isArray(mapValue)) return mapValue as Array<AnySimpleRule | ValidationRule<any>>;
    return [mapValue as AnySimpleRule];
}

function inferSchemaType(criteria: ValidationCriterion[]): SchemaScalarType | undefined {
    const types = new Set<SchemaScalarType>();

    for (const criterion of criteria) {
        switch (criterion.type) {
            case 'email':
            case 'alphanumeric':
            case 'uppercase':
            case 'lowercase':
            case 'noSpecialCharacters':
            case 'regex':
            case 'length':
            case 'date':
                types.add('string');
                break;
            case 'numeric':
            case 'positive':
            case 'negative':
            case 'max':
            case 'min':
            case 'between':
            case 'decimals':
            case 'greaterThan':
            case 'greaterThanOrEqual':
            case 'lessThan':
            case 'lessThanOrEqual':
                types.add('number');
                break;
            case 'boolean':
                types.add('boolean');
                break;
            case 'size':
                types.add('array');
                break;
            case 'in':
            case 'enum': {
                const values = criterion.values ?? [];
                if (values.length === 0) break;
                const primitiveTypes = new Set(values.map(value => Array.isArray(value) ? 'array' : typeof value));
                if (primitiveTypes.size === 1) {
                    const [primitiveType] = [...primitiveTypes];
                    if (primitiveType === 'string' || primitiveType === 'number' || primitiveType === 'boolean') {
                        types.add(primitiveType);
                    }
                }
                break;
            }
        }
    }

    return types.size === 1 ? [...types][0] : undefined;
}

function toCriterion(rule: AnySimpleRule): ValidationCriterion {
    if (typeof rule === 'string') {
        return { type: rule };
    }

    switch (rule.type) {
        case 'regex':
            return { type: rule.type, pattern: rule.pattern.source };
        case 'in':
            return { type: rule.type, values: [...rule.values] };
        case 'between':
        case 'decimals':
        case 'length':
        case 'size':
            return { type: rule.type, min: rule.min, max: rule.max };
        case 'enum':
            return { type: rule.type, values: Object.values(rule.enumObj) };
        case 'max':
        case 'min':
        case 'greaterThan':
        case 'greaterThanOrEqual':
        case 'lessThan':
        case 'lessThanOrEqual':
            return { type: rule.type, value: rule.value };
    }

    const unreachableRule: never = rule;
    return { type: String(unreachableRule) };
}

function buildFieldMetadata(path: string, rawValues: Array<AnySimpleRule | ValidationRule<any>>): ValidationFieldMetadata {
    const criteria = rawValues.filter((value): value is AnySimpleRule => !isValidationRule(value)).map(toCriterion);
    const criterionTypes = new Set(criteria.map(criterion => criterion.type));

    return {
        path,
        type: inferSchemaType(criteria),
        required: criterionTypes.has('required'),
        optional: criterionTypes.has('optional') || criterionTypes.has('nullish'),
        nullable: criterionTypes.has('nullable') || criterionTypes.has('nullish'),
        nullish: criterionTypes.has('nullish'),
        criteria,
        unsupportedRules: rawValues.filter(isValidationRule).map(rule => rule.message),
    };
}

function inspectSimpleRuleMap<T>(
    map: SimpleValidationRuleMap<T>,
    prefix = '',
    fields: ValidationFieldMetadata[] = [],
): ValidationFieldMetadata[] {
    for (const [mapKey, mapValue] of Object.entries(map)) {
        const fullKey = prefix ? `${prefix}.${mapKey}` : mapKey;
        if (isValidationRule(mapValue)) {
            fields.push({
                path: fullKey,
                type: undefined,
                required: false,
                optional: false,
                nullable: false,
                nullish: false,
                criteria: [],
                unsupportedRules: [mapValue.message],
            });
            continue;
        }

        if (isNestedSimpleRuleMap(mapValue)) {
            inspectSimpleRuleMap(mapValue as SimpleValidationRuleMap<T>, fullKey, fields);
            continue;
        }

        fields.push(buildFieldMetadata(fullKey, toRawValues(mapValue as SimpleRuleValue)));
    }

    return fields;
}

export async function inspectValidator<T>(
    ValidatorClass: new () => Validator<T>,
    source: ValidationSource,
): Promise<ValidationSourceMetadata> {
    const instance = new ValidatorClass();
    const fields = inspectSimpleRuleMap(instance.getSimpleRules()).sort((left, right) => left.path.localeCompare(right.path));
    const customRules = await Promise.resolve(instance.getRules());

    return {
        source,
        validatorName: ValidatorClass.name || 'AnonymousValidator',
        strictCheck: instance.strictCheck,
        duplicateError: instance.duplicateError,
        customRuleCount: customRules.length,
        hasObjectRules: customRules.some(rule => rule.key === undefined),
        fields,
    };
}

export async function inspectValidateMap(
    map?: ValidateMap,
): Promise<Partial<Record<ValidationSource, ValidationSourceMetadata>>> {
    if (!map) return {};

    const entries = await Promise.all(
        (Object.entries(map) as Array<[ValidationSource, ValidateMap[ValidationSource]]>)
            .filter(([, ValidatorClass]) => Boolean(ValidatorClass))
            .map(async ([source, ValidatorClass]) => {
                const metadata = await inspectValidator(ValidatorClass as new () => Validator<any>, source);
                return [source, metadata] as const;
            }),
    );

    return Object.fromEntries(entries);
}

function expandSimpleRules<T>(map: SimpleValidationRuleMap<T>): ValidationRule<T>[] {
    const rules: ValidationRule<T>[] = [];
    for (const [mapKey, mapValue] of Object.entries(map)) {
        if (isValidationRule(mapValue)) {
            // Raw ValidationRule<T> — push directly.
            rules.push(mapValue as ValidationRule<T>);
        } else if (isNestedSimpleRuleMap(mapValue)) {
            // Nested: mapKey is the parent path (e.g. 'items', 'items.category').
            for (const [subKey, subValue] of Object.entries(mapValue)) {
                const fullKey = `${mapKey}.${subKey}`;
                const token = subKey.split('.').pop()!;
                rules.push(...buildFieldRules<T>(fullKey, token, toRawValues(subValue)));
            }
        } else {
            // Flat: mapKey is the exact field path (e.g. 'gst', 'subtotal').
            const token = mapKey.split('.').pop()!;
            rules.push(...buildFieldRules<T>(mapKey, token, toRawValues(mapValue as SimpleRuleValue)));
        }
    }
    return rules;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validator<T> — abstract base class; extend to define rules per model
// ═══════════════════════════════════════════════════════════════════════════════

export abstract class Validator<T> {
    /** Override to false in a subclass to report only the first $field per rule. */
    readonly duplicateError: boolean = true;

    /** When true, top-level keys in the validated object not declared in getSimpleRules() are flagged as errors. */
    readonly strictCheck: boolean = false;

    /** Access to predefined simple rules for convenience. */
    readonly rules = SimpleRules;

    /** Override to declare complex rules with custom predicates. Supports async for DB/external lookups. */
    getRules(): ValidationRule<T>[] | Promise<ValidationRule<T>[]> {
        return [];
    }

    /** Override to declare simple per-field rules declaratively. */
    getSimpleRules(): SimpleValidationRuleMap<T> {
        return {};
    }

    /** Override to provide human-readable field name mappings. */
    getFieldNames(): Record<string, string> {
        return {};
    }

    async validate(object: T): Promise<ValidationResult<T>> {
        const simpleRules = expandSimpleRules<T>(this.getSimpleRules());
        const customRules = await Promise.resolve(this.getRules());
        const result = await runValidation(object, [...simpleRules, ...customRules], this.getFieldNames(), this.duplicateError);

        if (this.strictCheck) {
            const declaredKeys = new Set(
                Object.keys(this.getSimpleRules()).map(k => k.split('.')[0])
            );
            const sanitized = { ...object as Record<string, unknown> };
            for (const key of Object.keys(object as Record<string, unknown>)) {
                if (!declaredKeys.has(key)) {
                    if (!result.errors[key]) result.errors[key] = [];
                    result.errors[key].push(`${key} is not an accepted field`);
                    delete sanitized[key];
                }
            }
            result.valid = Object.keys(result.errors).length === 0;
            // Always expose the stripped object so callers can safely persist it.
            result.output = sanitized as T;
        }

        return result;
    }
}