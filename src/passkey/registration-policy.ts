export type PasskeyRegistrationAlgorithm = -7 | -257;

/** Honor the RP preference order within the selected store's supported formats. */
export function selectPasskeyRegistrationAlgorithm(algorithms: readonly number[], source: string = "local"): PasskeyRegistrationAlgorithm | undefined {
  if (!["local", "mdbx2", "keepass", "bitwarden"].includes(source)) return undefined;
  return algorithms.find((algorithm): algorithm is PasskeyRegistrationAlgorithm =>
    algorithm === -7 || algorithm === -257 && source !== "bitwarden");
}
