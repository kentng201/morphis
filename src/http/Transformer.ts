/**
 * Abstract base class for all transformers.
 * Subclasses implement `transform()` to convert input data into a desired output shape.
 *
 * @example
 * class OrderResponseTransformer extends Transformer<Order, OrderDto> {
 *     transform(data: Order): OrderDto {
 *         return { id: data.id, total: data.total };
 *     }
 * }
 */
export abstract class Transformer<TIn = unknown, TOut = unknown> {
    /**
     * Transform the given input data into the desired output shape.
     * May return a value or a Promise.
     */
    abstract transform(data: TIn): TOut | Promise<TOut>;
}
