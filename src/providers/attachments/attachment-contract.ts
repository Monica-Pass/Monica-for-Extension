export const PROVIDER_ATTACHMENT_CHUNK_BYTES = 256 * 1024;
export const PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS = 4;
export const PROVIDER_ATTACHMENT_UPLOAD_TTL_MS = 5 * 60_000;
export const PROVIDER_ATTACHMENT_MAX_PAGE_SIZE = 50;
export const PROVIDER_ATTACHMENT_MAX_CURSOR_BYTES = 4096;
export const PROVIDER_ATTACHMENT_MAX_NAME_BYTES = 4096;
export const PROVIDER_ATTACHMENT_MAX_MEDIA_TYPE_BYTES = 512;
export const KEEPASS_ATTACHMENT_MAX_BYTES = 256 * 1024 * 1024;
export const BITWARDEN_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const MDBX2_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;

export type ProviderAttachmentKind = "keepass" | "bitwarden" | "mdbx2" | "monica-webdav";

export interface ProviderAttachmentSummary {
  attachmentId: string;
  providerKind: ProviderAttachmentKind;
  fileName: string;
  sizeBytes: number;
  protected: boolean;
  mediaType?: string;
}

export interface ProviderAttachmentPage {
  items: ProviderAttachmentSummary[];
  nextCursor?: string;
}

export interface ProviderAttachmentReadBeginResult extends ProviderAttachmentSummary {
  readHandle: string;
  maxChunkBytes: typeof PROVIDER_ATTACHMENT_CHUNK_BYTES;
}

export interface ProviderAttachmentReadChunk {
  readHandle: string;
  attachmentId: string;
  fileName: string;
  sizeBytes: number;
  offset: number;
  nextOffset: number;
  dataBase64: string;
  eof: boolean;
}

export interface ProviderAttachmentUploadIntent {
  providerId: string;
  itemId: string;
  providerKind: ProviderAttachmentKind;
  fileName: string;
  mediaType?: string;
  sizeBytes: number;
  sha256?: string;
  replaceExisting: boolean;
  operationId?: string;
  attachmentId?: string;
}

export interface ProviderAttachmentUploadBeginResult {
  transferId: string;
  nextOffset: number;
  maxChunkBytes: typeof PROVIDER_ATTACHMENT_CHUNK_BYTES;
  expiresAt: number;
  operationId?: string;
  attachmentId?: string;
}

export interface ProviderAttachmentUploadChunkResult {
  transferId: string;
  nextOffset: number;
  acceptedBytes: number;
  repeated: boolean;
}

export interface ProviderAttachmentMutationResult {
  changed: boolean;
  attachment?: ProviderAttachmentSummary;
}

export class ProviderAttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProviderAttachmentError";
  }
}
