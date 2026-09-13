import { version } from "../../package.json";

export interface RuntimeInfo {
  version: string;
  protocolVersion: number;
}

// Use the bundled version, not getManifest(): an old worker can still be
// running after its manifest and UI files have been replaced on disk.
export const runtimeInfo: RuntimeInfo = { version, protocolVersion: 1 };
