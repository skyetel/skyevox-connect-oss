package com.skyetel.skyevoxconnect;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.telecom.Connection;
import android.telecom.DisconnectCause;
import android.util.Log;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Android Telecom connection bound to one liblinphone call, identified by its SIP Call-ID.
 * System actions (answer/reject/disconnect/hold/unhold) go to the engine; engine state
 * changes flow back through {@link #onEngineCallState}.
 */
public class SkyeVoxTelecomConnection extends Connection {
    private static final String TAG = "SkyeVoxTelecom";
    private static final Map<String, SkyeVoxTelecomConnection> BOUND = new ConcurrentHashMap<>();

    private final Context context;
    private final LinphoneEngine engine;
    private String callId = "";

    public SkyeVoxTelecomConnection(Context context, LinphoneEngine engine) {
        this.context = context.getApplicationContext();
        this.engine = engine;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            setConnectionProperties(PROPERTY_SELF_MANAGED);
        }
        setConnectionCapabilities(CAPABILITY_HOLD | CAPABILITY_SUPPORT_HOLD | CAPABILITY_MUTE);
        setAudioModeIsVoip(true);
    }

    static boolean isBound(String callId) {
        return callId != null && BOUND.containsKey(callId);
    }

    public void setCallId(String callId) {
        String id = callId == null ? "" : callId.trim();
        if (!this.callId.isEmpty()) BOUND.remove(this.callId);
        this.callId = id;
        if (!id.isEmpty()) BOUND.put(id, this);
    }

    /** Engine -> Telecom state mirror. Runs on the main thread from the liblinphone listener. */
    static void onEngineCallState(String callId, String state, String error) {
        SkyeVoxTelecomConnection connection = BOUND.get(callId);
        if (connection == null) return;
        switch (state) {
            case "incoming":
                connection.setRinging();
                break;
            case "dialing":
            case "ringing":
                connection.setDialing();
                break;
            case "active":
                connection.setActive();
                break;
            case "held":
                connection.setOnHold();
                break;
            case "failed":
                connection.finish(new DisconnectCause(DisconnectCause.ERROR, error));
                break;
            case "ended":
                connection.finish(new DisconnectCause(DisconnectCause.REMOTE));
                break;
            default:
                break;
        }
    }

    @Override
    public void onAnswer() {
        try {
            if (engine != null && !callId.isEmpty()) {
                engine.answer(callId);
            }
            setActive();
        } catch (Exception error) {
            finish(new DisconnectCause(DisconnectCause.ERROR, error.getMessage()));
        }
    }

    @Override
    public void onReject() {
        try {
            if (engine != null && !callId.isEmpty()) {
                engine.reject(callId);
            }
        } catch (Exception ignored) {
            // Telecom already has the user's reject action; keep teardown moving.
        }
        finish(new DisconnectCause(DisconnectCause.REJECTED));
    }

    @Override
    public void onDisconnect() {
        try {
            if (engine != null && !callId.isEmpty()) {
                engine.hangup(callId);
            }
        } catch (Exception ignored) {
            // A remote hangup can race local teardown.
        }
        finish(new DisconnectCause(DisconnectCause.LOCAL));
    }

    @Override
    public void onAbort() {
        onDisconnect();
    }

    @Override
    public void onHold() {
        try {
            if (engine != null && !callId.isEmpty()) {
                engine.hold(callId);
            }
            setOnHold();
        } catch (Exception error) {
            Log.w(TAG, "hold failed for " + callId, error);
        }
    }

    @Override
    public void onUnhold() {
        try {
            if (engine != null && !callId.isEmpty()) {
                engine.unhold(callId);
            }
            setActive();
        } catch (Exception error) {
            Log.w(TAG, "unhold failed for " + callId, error);
        }
    }

    @Override
    public void onPlayDtmfTone(char digit) {
        try {
            if (engine != null && !callId.isEmpty()) {
                engine.sendDtmf(callId, String.valueOf(digit));
            }
        } catch (Exception error) {
            Log.w(TAG, "dtmf failed for " + callId, error);
        }
    }

    @Override
    public void onShowIncomingCallUi() {
        // Self-managed accounts draw their own incoming UI: bring the WebView to the front.
        Intent intent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        try {
            context.startActivity(intent);
        } catch (RuntimeException error) {
            Log.w(TAG, "Cannot raise incoming call UI", error);
        }
    }

    private void finish(DisconnectCause cause) {
        if (!callId.isEmpty()) BOUND.remove(callId);
        setDisconnected(cause);
        destroy();
    }
}
