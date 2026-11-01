# Android 1.0.324 nearby protocol alignment

Extension version remains 1.0.103; these changes belong to the next unreleased notes. Native Messaging remains optional, and ordinary browser MDBX continues to use the bundled engine.

## Implementation

The local, frozen Android Rust protocol is recorded in `native/mdbx2-host/LAN-PROVENANCE.json`, with the original upstream pin and previous extension overlays retained. The new reversible `extension-lan-android324.patch` preserves the extension's lossless JSON number and marker-key adaptation. It adds paired incremental records, independent missing assets and authenticated ciphertext resume. Pairing-only and receive-only snapshots do not advertise a usable record inventory; old peers use full encrypted transfer.

The native owner advertises capabilities and controls a leased resume directory. A retry uses the same immutable snapshot and a fresh Noise handshake, restricted to pre-application connection/transfer failures. Cache cleanup rejects links/reparse points and suspicious owner hard links, respects live leases, bounds traversal and preserves unknown layouts. Caches contain ciphertext, without Wi-Fi credentials or content/handshake keys.

The browser parses bounded Android `monica-hotspot:1:` invitations, shows manual system Wi-Fi instructions and retains credentials only in the current page's memory for at most 180 seconds. Lock, cancellation, leaving and hiding the page revoke the operation. Active progress polls at 500 ms, idle discovery at five seconds, with online events waking discovery. All seven additional messages cover the seven translated catalogs.

Received deletions use a revision-bound preview and explicit include/omit choice before application. Durable application succeeds before acknowledging the transfer. Incremental transfers may omit an unchanged attachment already held by the receiver: the coordinator rereads it only from the currently authorized source, checks source revision, exact size and SHA-256, and refuses missing or changed bytes.

## Verified

- Complete extension build, TypeScript, bundled runtime/page and supply-chain checks passed. Final browser build identity: `33ac3f221f174597e01e`.
- Full Vitest: 354 files / 4,487 tests passed in 308.08 seconds before the final retained-attachment fix. The final affected nearby selection passed 310 tests in 7.98 seconds, including retained bytes, corruption, size, source revision, absence and legacy capability rejection.
- Native protocol: 65 cases passed. Native Host full suite: 121 cases passed in 1,101.24 seconds before a Clippy-equivalent conditional simplification; all-target Clippy with warnings denied passed afterward. Release Host and bundled WASM builds passed. WASM is 6,457,089 bytes (Rust 1.97.0 / Emscripten 4.0.18).
- Real installed Edge 156.0.4314.50 transport acceptance passed in 35.1 seconds: 770,240 bytes of large records, a 600,000-byte attachment, original Passkey signature/counter, exact JSON values and browser restart. An unchanged paired third round transferred only 91 artifact bytes.
- Final real Edge coordinator/UI/runtime selection: 15 cases passed in 3.4 minutes. Includes both deletion directions and all three review choices, ephemeral hotspot expiry, optional-helper behavior, offscreen MDBX ownership/service-worker recovery, local application/restart receipts, 300-row paginated recovery and bidirectional application into the bundled MDBX database with original keys and attachment bytes verified.
- Temporary Native Messaging registration was restored; final Edge run removed its 22 isolated profiles. Evidence and failure history remain under the local task's `raw/` directory.

## Failed runs and correction

The first bridge selection failed cancellation because resume maintenance received `path` instead of `root`; all six maintenance calls were corrected. An invitation-limit test caught enlargement of the ordinary invitation bound; ordinary invitations remain capped at 512 characters, while hotspot envelopes have a separate bounded parser. Stale vendor provenance and WASM inventory checks initially rejected builds; both were regenerated before the successful complete build.

The first real Edge matrix passed 12 and failed three. One historical-deletion case lost its browser page; its cause is unconfirmed, and the same assertions passed the final run. Local restart adoption and MDBX reciprocal edits exposed a production defect: attachment lookup required bytes in the current transfer even after negotiated incremental omission. The revision/size/hash-checked local reread described above corrected both cases. Final assertions still verify actual records, original keys, signatures, attachments and restart behavior; the failed run is retained separately.

## Android and F-Droid interoperability

After the other Android task released the shared emulator, the existing public API32 x86_64 AVD was started with its original disk. A disposable guest contained both distributions and only synthetic stores. The installed main APKs matched the supplied final APK hashes; `install-existing` enabled them for this guest without replacing the main packages. Test-only Gradle builds reused the existing verified application classes and BuildConfig. All 3,440 captured production/source/APK/class-jar/BuildConfig hashes per distribution remained unchanged before and after the builds.

The extension-owned fixture at `tests/interop/android-nearby/` uses the actual Android JNI/provider, encrypted application storage and in-memory Room databases. Each distribution completed pairing plus three content rounds with the real production browser coordinator in installed Edge. Assertions check reciprocal password edits, an original Passkey loaded and signed on Android with its zero counter preserved, 200 large unchanged records retained in the browser, and transfer bytes below 4,096 for the unchanged round.

| Distribution | Main APK version | Real Edge case | Android instrumentation | First content bytes | Unchanged round bytes |
| --- | --- | --- | --- | --- | --- |
| Ordinary | 1.0.324-26110112-07 | 1 passed / 34.7 s | 1 method passed / 27.753 s | 344,185 | 182 |
| F-Droid | 1.0.324 | 1 passed / 39.1 s | 1 method passed / 30.676 s | 344,185 | 182 |

The Android instrumentation totals are one method containing the three rounds, not three separately executed tests. These are additional browser interoperability results; Android's earlier native/JVM/device suites are not counted again. Package/runtime hashes and normalized results are in [nearby-android324-20261101.json](nearby-android324-20261101.json).

To reproduce, add `tests/interop/android-nearby/src` through `tests/interop/android-app/interop.init.gradle`, set `MONICA_APP_INTEROP_REPLACE_TEST_SOURCES=1` and use the supplied `passkey-signatures-AndroidManifest.xml` as `MONICA_APP_INTEROP_TEST_MANIFEST` when building `:app:assembleDebugAndroidTest`. Install that test APK only after verifying the shared device is free and an owned disposable guest is foreground. Run `node scripts/e2e-edge.mjs tests/e2e/nearby-android.spec.ts --workers=1` with `MONICA_ANDROID_INTEROP=1`, the explicit `MONICA_ANDROID_USER`, `MONICA_ANDROID_APPLICATION_ID` and final `MONICA_E2E_NATIVE_HOST_EXECUTABLE`. The driver defaults to the extension-owned incremental fixture.

The first fixture compilation lacked the Android provider's newly required deletion-review callback. The corrected fixture fails on any unexpected deletion request; this scenario does not delete records. The initial real ordinary run failed with `transfer_timeout` in 28.8 seconds and remains recorded; its exact cause is unconfirmed. Inspection also found that the older driver assumed the browser would listen despite the production device-ID rule. Paired rounds now start an Android loopback listener, forward its port with ADB and connect the authenticated browser coordinator to that endpoint. The same data, key and byte assertions then passed for both distributions. This does not validate automatic multicast discovery.

Temporary Native Messaging registration was restored after each run and each Edge run removed its isolated profile. Both original test APKs and their build outputs were restored afterward. Only this task's disposable guest was removed; original users 0/10/11/12 and the data disk remain. The original foreground user was restored and this task's emulator launch was stopped. Raw logs, failed runs and compiled synthetic test APKs remain local, without APK delivery or images committed to the repository. The earlier approximately 4 GiB build-cache deletion remains blocked by the execution policy.

## Practical limits

These results use authenticated TCP through the emulator host gateway and ADB forwarding. Physical two-phone Wi-Fi/hotspot creation/join, radio interruption, Android multicast discovery, OEM system dialogs and real account/vault behavior remain unverified. The browser supplies manual hotspot instructions; it does not advertise automatic hotspot joining. This task used existing Debug Android APKs, without a new Android Release/R8 build or physical FIDO key acceptance.

The cross-Android driver did not deliberately interrupt a content transfer mid-stream. Resume integrity and cancellation remain covered by the native protocol suite rather than a new phone/browser interruption case.
