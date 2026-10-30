export class PaymentUnavailableError extends Error {}
export class PaymentProviderError extends Error {}
export class PaymentIdempotencyError extends PaymentProviderError {}
export class PaymentCaptureDeclinedError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
