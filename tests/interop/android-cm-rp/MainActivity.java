package com.monica.interop.rp317;

import android.app.Activity;
import android.credentials.CredentialManager;
import android.credentials.CredentialOption;
import android.credentials.GetCredentialException;
import android.credentials.GetCredentialRequest;
import android.credentials.GetCredentialResponse;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.OutcomeReceiver;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** A real, separately signed native RP. It never supplies an origin or clientDataHash. */
public final class MainActivity extends Activity {
    private TextView status;
    private CancellationSignal cancellation;
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 96, 32, 32);
        status = new TextView(this);
        status.setText("Native Credential Manager acceptance: ready");
        Button start = new Button(this);
        start.setText("Request passkey");
        start.setOnClickListener(view -> request());
        Button cancel = new Button(this);
        cancel.setText("Cancel request");
        cancel.setOnClickListener(view -> { if (cancellation != null) cancellation.cancel(); });
        layout.addView(status);
        layout.addView(start);
        layout.addView(cancel);
        setContentView(layout);
    }
    private void record(JSONObject result) {
        try {
            Files.write(new File(getFilesDir(), "result.json").toPath(), result.toString(2).getBytes(StandardCharsets.UTF_8));
            status.setText(result.has("response") ? "Credential returned" : "Credential error");
        } catch (Exception error) { status.setText("Evidence write failed: " + error.getClass().getName()); }
    }
    private void request() {
        try {
            String requestJson = new String(Files.readAllBytes(new File(getFilesDir(), "request.json").toPath()), StandardCharsets.UTF_8);
            JSONObject parsed = new JSONObject(requestJson);
            String rpId = parsed.getString("rpId");
            if (!(rpId.equals("passkey-interop.example.test") || rpId.equals("registration.example.test")
                    || rpId.equals("webdav-passkey.example.test") || rpId.equals("bitwarden-passkey.example.test")) || parsed.has("origin"))
                throw new IllegalArgumentException("Only synthetic native RP requests without origin are accepted");
            Files.deleteIfExists(new File(getFilesDir(), "result.json").toPath());
            Bundle data = new Bundle();
            data.putString("androidx.credentials.BUNDLE_KEY_SUBTYPE", "androidx.credentials.BUNDLE_VALUE_SUBTYPE_GET_PUBLIC_KEY_CREDENTIAL_OPTION");
            data.putString("androidx.credentials.BUNDLE_KEY_REQUEST_JSON", requestJson);
            data.putByteArray("androidx.credentials.BUNDLE_KEY_CLIENT_DATA_HASH", null);
            CredentialOption option = new CredentialOption.Builder("androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL", data, new Bundle(data)).build();
            GetCredentialRequest request = new GetCredentialRequest.Builder(new Bundle()).addCredentialOption(option).build();
            cancellation = new CancellationSignal();
            status.setText("Waiting for system provider and Monica authentication");
            getSystemService(CredentialManager.class).getCredential(this, request, cancellation, getMainExecutor(),
                new OutcomeReceiver<GetCredentialResponse, GetCredentialException>() {
                    @Override public void onResult(GetCredentialResponse response) {
                        try {
                            String json = response.getCredential().getData().getString("androidx.credentials.BUNDLE_KEY_AUTHENTICATION_RESPONSE_JSON");
                            record(new JSONObject().put("type", response.getCredential().getType()).put("response", new JSONObject(json)));
                        } catch (Exception error) { onFailure(error); }
                    }
                    @Override public void onError(GetCredentialException error) {
                        try { record(new JSONObject().put("error", error.getType()).put("message", error.getMessage())); }
                        catch (Exception ignored) { status.setText("Unable to serialize provider error"); }
                    }
                });
        } catch (Exception error) { onFailure(error); }
    }
    private void onFailure(Exception error) {
        try { record(new JSONObject().put("error", error.getClass().getName()).put("message", error.getMessage())); }
        catch (Exception ignored) { status.setText("Unable to serialize request error"); }
    }
}
