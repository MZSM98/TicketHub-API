export class PaymentUnavailableError extends Error {}
export class PaymentProviderError extends Error {}
export class PaymentIdempotencyError extends PaymentProviderError {}
