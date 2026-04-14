import { describe, expect, test } from 'bun:test';
import { Validator } from './Validator';

type Payload = {
    content?: string;
};

class RequiredContentValidator extends Validator<Payload> {
    override getSimpleRules() {
        const { Required } = this.rules;
        return {
            content: [Required],
        };
    }
}

describe('Validator', () => {
    test('reports a required-field error when the value is missing', async () => {
        const result = await new RequiredContentValidator().validate({});

        expect(result.valid).toBe(false);
        expect(result.errors).toEqual({
            content: ['content is required'],
        });
    });

    test('reports a required-field error when the whole payload is undefined', async () => {
        const result = await new RequiredContentValidator().validate(undefined as unknown as Payload);

        expect(result.valid).toBe(false);
        expect(result.errors).toEqual({
            content: ['content is required'],
        });
    });
});
