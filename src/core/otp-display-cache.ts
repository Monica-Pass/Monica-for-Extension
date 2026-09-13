import { generateOtpWithParameters, otpSecondsRemaining, type TotpParameters } from "./totp";

/** A single mounted display keeps only its current code, never a global secret cache. */
export function createOtpDisplayCache(generate = generateOtpWithParameters) {
  let key = "";
  let pending: Promise<string> | undefined;
  return {
    get(parameters: TotpParameters, now: number): Promise<string> {
      const period = parameters.otpType === "HOTP" ? parameters.counter || 0 : Math.floor(now / 1000) + otpSecondsRemaining(parameters, now);
      const next = `${JSON.stringify(parameters)}:${period}`;
      if (next !== key || !pending) {
        key = next;
        const request = generate(parameters, now).catch((error) => {
          if (pending === request) pending = undefined;
          throw error;
        });
        pending = request;
      }
      return pending;
    },
    clear() { key = ""; pending = undefined; }
  };
}
