/** Serialize source writes without letting a failed operation poison later retries. */
export class ProviderOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(providerId: string, execute: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(providerId) || Promise.resolve()).then(execute);
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(providerId, settled);
    void settled.then(() => { if (this.tails.get(providerId) === settled) this.tails.delete(providerId); });
    return result;
  }
}
