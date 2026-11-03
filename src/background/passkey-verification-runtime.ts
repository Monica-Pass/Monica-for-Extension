import type { PasskeyRequest } from "../runtime/messages";
import { PasskeyUserVerification } from "../passkey/user-verification";
import { bytesToBase64 } from "../security/encoding";
import { VaultLockedError } from "../security/secure-vault-service";
import type { MdbxRuntime } from './mdbx-runtime';
import { PasskeyUnavailableError } from './passkey-errors';
import { PendingPasskeyRequest } from './passkey-state-types';
import { PasskeyCancelledError } from './passkey-errors';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "passkeySessionId" | "protectionModeForRuntime" | "status" | "verifyMasterPasswordForPasskey" | "windowsHelloBindingIdForRuntime">;
    windowsHelloNativeClient: Pick<MdbxRuntime["windowsHelloNativeClient"], "verifyWindowsHello" | "windowsHelloStatus">;
}
export type PasskeyVerificationRuntimeRequest = Extract<ExtensionRequest, {
    type: "PASSKEY_VERIFICATION_CONTEXT" | "PASSKEY_VERIFY_PASSWORD" | "PASSKEY_VERIFY_HELLO" | "PASSKEY_CANCEL_VERIFICATION";
}>;
export function createPasskeyVerificationRuntime(deps: Dependencies) {
    const passkeyUserVerification = new PasskeyUserVerification(password => deps.service.verifyMasterPasswordForPasskey(password));
    function passkeyRequiresUserVerification(request: PasskeyRequest): boolean {
        // WebAuthn defaults userVerification to "preferred", which an authenticator that can verify must honour.
        return request.operation === "create" ? request.userVerificationRequired !== false : request.userVerification !== "discouraged";
    }
    async function assertPasskeyUserVerificationAvailable(): Promise<string> {
        if (await deps.service.protectionModeForRuntime() === "master-password")
            return "master-password";
        const bindingId = await deps.service.windowsHelloBindingIdForRuntime();
        if (!bindingId)
            throw new PasskeyUnavailableError("此网站要求用户验证，但 Monica 尚未启用 Windows Hello。");
        try {
            const status = await deps.windowsHelloNativeClient.windowsHelloStatus(bindingId);
            if (!status.available || !status.enrolled || status.reason !== "ready")
                throw new Error("Windows Hello not ready");
            return bindingId;
        }
        catch {
            throw new PasskeyUnavailableError("此网站要求用户验证，但 Windows Hello 当前不可用。");
        }
    }
    async function verifyPasskeyUserIfRequired(pending: PendingPasskeyRequest, credentialRequiresVerification = false, accountName = ""): Promise<boolean> {
        const request = pending.request;
        if (pending.unlockSessionId && pending.unlockSessionId === await deps.service.passkeySessionId())
            return true;
        if (!passkeyRequiresUserVerification(request) && !credentialRequiresVerification)
            return false;
        const bindingId = await assertPasskeyUserVerificationAvailable();
        if (bindingId === "master-password") {
            try {
                await passkeyUserVerification.request({ candidateId: pending.id, operation: request.operation, rpId: pending.rpId, origin: pending.origin, accountName: request.operation === "create" ? request.userName : accountName, expiresAt: pending.expiresAt });
                if ((await deps.service.status()) !== "unlocked")
                    throw new VaultLockedError("身份验证期间密码库状态已变化。");
                return true;
            }
            catch (error) {
                if (error instanceof VaultLockedError)
                    throw error;
                throw new PasskeyCancelledError("Passkey 身份验证未完成。");
            }
        }
        const challenge = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        try {
            const result = await deps.windowsHelloNativeClient.verifyWindowsHello(bindingId, challenge);
            if (!result.verified)
                throw new Error("Windows Hello 未确认用户身份。");
            if ((await deps.service.status()) !== "unlocked" || await deps.service.windowsHelloBindingIdForRuntime() !== bindingId) {
                throw new VaultLockedError("Windows Hello 验证期间密码库状态已变化。");
            }
            return true;
        }
        catch (error) {
            if (error instanceof VaultLockedError)
                throw error;
            throw new PasskeyCancelledError("Windows Hello 用户验证未完成。");
        }
    }
    const handlers: CommandHandlers<PasskeyVerificationRuntimeRequest> = {
        "PASSKEY_VERIFICATION_CONTEXT": async (request, sender) => {
            return passkeyUserVerification.context(request.verificationId, sender);
        },
        "PASSKEY_VERIFY_PASSWORD": async (request, sender) => {
            try {
                await passkeyUserVerification.verify(request.verificationId, request.masterPassword, sender);
                return { verified: true };
            }
            finally {
                request.masterPassword = "";
            }
        },
        "PASSKEY_VERIFY_HELLO": async (request, sender) => {
            await passkeyUserVerification.verify(request.verificationId, "", sender, "windows-hello");
            return { verified: true };
        },
        "PASSKEY_CANCEL_VERIFICATION": async (request, sender) => {
            passkeyUserVerification.cancel(request.verificationId, sender);
            return { cancelled: true };
        },
    };
    return { assertPasskeyUserVerificationAvailable, handlers, passkeyRequiresUserVerification, passkeyUserVerification, verifyPasskeyUserIfRequired };
}
export type PasskeyVerificationRuntime = ReturnType<typeof createPasskeyVerificationRuntime>;
