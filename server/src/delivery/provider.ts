export interface SubmitRequest {
  deliveryId: string;
  idempotencyKey: string;
  attempt: number;
  recipientName: string;
  recipientAddress: string;
  filename: string;
  documentSha256: string;
}

export type SubmitResult =
  | { kind: 'accepted'; providerRef: string }
  | { kind: 'transient'; error: string }
  | { kind: 'permanent'; error: string }
  | { kind: 'ambiguous'; error: string };

export type ProviderStatus = { state: 'pending' | 'delivered' | 'failed'; detail?: string };

export interface DeliveryProvider {
  name: string;
  /** True for providers that do not transmit anything to the outside world. */
  simulated: boolean;
  submit(req: SubmitRequest): Promise<SubmitResult>;
  getStatus(providerRef: string): Promise<ProviderStatus>;
}

/**
 * Scripted provider. It never contacts anything. Behaviour is chosen by a token in the recipient address:
 *   busy      first 2 attempts fail transiently, then accepted
 *   down      every attempt fails transiently (exhausts retries)
 *   reject    permanent failure
 *   ambiguous first attempt times out after "sending"; the retry with the same key is not transmitted twice
 *   slow      accepted, acknowledgement arrives after 2 status polls
 * Anything else is accepted and acknowledged on the first poll.
 */
export class SimulatedProvider implements DeliveryProvider {
  name = 'simulated';
  simulated = true;
  /** Idempotency keys that were actually "transmitted"; used to prove no duplicate transmission. */
  transmitted = new Map<string, number>();
  private polls = new Map<string, number>();

  async submit(r: SubmitRequest): Promise<SubmitResult> {
    const a = r.recipientAddress.toLowerCase();
    if (a.includes('reject')) return { kind: 'permanent', error: 'Simulated: recipient number rejected' };
    if (a.includes('down')) return { kind: 'transient', error: 'Simulated: line busy' };
    if (a.includes('busy') && r.attempt <= 2) return { kind: 'transient', error: 'Simulated: line busy' };
    const ref = `SIM-${r.deliveryId.slice(0, 8)}`;
    if (a.includes('ambiguous') && r.attempt === 1) {
      this.transmit(r.idempotencyKey);
      return { kind: 'ambiguous', error: 'Simulated: timeout after sending, outcome unknown' };
    }
    if (!this.transmitted.has(r.idempotencyKey)) this.transmit(r.idempotencyKey);
    return { kind: 'accepted', providerRef: a.includes('slow') ? `${ref}-slow` : ref };
  }

  private transmit(key: string) {
    this.transmitted.set(key, (this.transmitted.get(key) ?? 0) + 1);
  }

  async getStatus(ref: string): Promise<ProviderStatus> {
    const n = (this.polls.get(ref) ?? 0) + 1;
    this.polls.set(ref, n);
    if (ref.endsWith('-slow') && n < 3) return { state: 'pending' };
    return { state: 'delivered', detail: 'Simulated acknowledgement' };
  }
}
