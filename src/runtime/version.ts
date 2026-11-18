import { version } from "../../package.json";
import { buildId } from './build-id.json';

export const RELEASE_CODENAME = 'Sengoku Nadeko';

export interface RuntimeInfo {
  version: string;
  protocolVersion: number;
  buildId: string;
}

// Use the bundled version, not getManifest(): an old worker can still be
// running after its manifest and UI files have been replaced on disk.
export const runtimeInfo: RuntimeInfo = { version, protocolVersion: 1, buildId };
