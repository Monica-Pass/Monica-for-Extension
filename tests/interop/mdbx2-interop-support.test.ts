import { describe, expect, it, vi } from "vitest";
import {
  acquireAndroidInteropPrerequisites,
  clearAndroidFixture,
  stopAndroidEnvironment,
  type AndroidEnvironment
} from "./mdbx2-interop-support";

const environment: AndroidEnvironment = {
  adb: "adb",
  adbServerPort: 5047,
  emulator: "emulator",
  serial: "emulator-5580",
  startedAdbServer: true,
  startedEmulator: true
};

describe("MDBX2 Android interoperability prerequisite ownership", () => {
  it("releases an environment that finishes starting after the fixture build fails", async () => {
    const buildError = new Error("fixture build failed");
    let resolveEnvironment!: (value: AndroidEnvironment) => void;
    const environmentPromise = new Promise<AndroidEnvironment>((resolve) => {
      resolveEnvironment = resolve;
    });
    const stopEnvironment = vi.fn(async () => undefined);

    const acquisition = acquireAndroidInteropPrerequisites(
      async () => { throw buildError; },
      async () => await environmentPromise,
      stopEnvironment
    );
    resolveEnvironment(environment);

    await expect(acquisition).rejects.toBe(buildError);
    expect(stopEnvironment).toHaveBeenCalledOnce();
    expect(stopEnvironment).toHaveBeenCalledWith(environment);
  });

  it("transfers a successful environment to the caller without releasing it", async () => {
    const stopEnvironment = vi.fn(async () => undefined);

    await expect(acquireAndroidInteropPrerequisites(
      async () => "fixture.apk",
      async () => environment,
      stopEnvironment
    )).resolves.toEqual({ apk: "fixture.apk", environment });
    expect(stopEnvironment).not.toHaveBeenCalled();
  });

  it("closes the test emulator and its dedicated ADB server", async () => {
    const commandRunner = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }));

    await stopAndroidEnvironment(environment, commandRunner);

    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(commandRunner).toHaveBeenNthCalledWith(
      1,
      "adb",
      ["-s", "emulator-5580", "emu", "kill"],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_ADB_SERVER_PORT: "5047" }) })
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      2,
      "adb",
      ["kill-server"],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_ADB_SERVER_PORT: "5047" }) })
    );
  });

  it("closes a dedicated ADB server even when the caller selected an existing device", async () => {
    const commandRunner = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }));

    await stopAndroidEnvironment({ ...environment, startedEmulator: false }, commandRunner);

    expect(commandRunner).toHaveBeenCalledOnce();
    expect(commandRunner).toHaveBeenCalledWith(
      "adb",
      ["kill-server"],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_ADB_SERVER_PORT: "5047" }) })
    );
  });

  it("retries a bounded package-manager clear after an Android broken pipe", async () => {
    const commandRunner = vi.fn()
      .mockRejectedValueOnce(new Error("Failure calling service package: Broken pipe (32)"))
      .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 });
    const pause = vi.fn(async () => undefined);

    await clearAndroidFixture(environment, commandRunner, pause);

    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledWith(1_500);
  });

  it("does not retry a permanent package-manager error", async () => {
    const permanentError = new Error("Unknown package: takagi.ru.monica.mdbx.engine.test");
    const commandRunner = vi.fn().mockRejectedValue(permanentError);
    const pause = vi.fn(async () => undefined);

    await expect(clearAndroidFixture(environment, commandRunner, pause)).rejects.toBe(permanentError);
    expect(commandRunner).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
  });
});
