package com.skyetel.skyevoxconnect;

import android.os.Bundle;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

/**
 * Android Telecom entry point for the liblinphone engine.
 *
 * Outgoing connections arrive either from the engine itself (extras carry the SIP Call-ID of a
 * call already in progress) or from the system dialer / {@code tel:} handoff, in which case the
 * engine places the call here.
 */
public class SkyeVoxConnectionService extends ConnectionService {
    private static final String TAG = "SkyeVoxTelecom";

    @Override
    public Connection onCreateOutgoingConnection(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        LinphoneEngine engine = LinphoneEngine.obtain(this);
        SkyeVoxTelecomConnection connection = new SkyeVoxTelecomConnection(this, engine);
        connection.setAddress(request.getAddress(), TelecomManager.PRESENTATION_ALLOWED);

        String existingCallId = callIdFrom(request.getExtras() != null
            ? request.getExtras().getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS)
            : null);
        if (existingCallId.isEmpty()) {
            existingCallId = callIdFrom(request.getExtras());
        }
        if (!existingCallId.isEmpty()) {
            connection.setCallId(existingCallId);
            connection.setDialing();
            return connection;
        }

        if (!engine.isConfigured()) {
            connection.setDisconnected(new DisconnectCause(DisconnectCause.ERROR, "SkyeVox is not registered."));
            connection.destroy();
            return connection;
        }

        try {
            String callId = engine.call(request.getAddress().getSchemeSpecificPart());
            connection.setCallId(callId);
        } catch (Exception error) {
            connection.setDisconnected(new DisconnectCause(DisconnectCause.ERROR, error.getMessage()));
            connection.destroy();
            return connection;
        }

        connection.setDialing();
        return connection;
    }

    @Override
    public Connection onCreateIncomingConnection(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        LinphoneEngine engine = LinphoneEngine.getActiveEngine();
        SkyeVoxTelecomConnection connection = new SkyeVoxTelecomConnection(this, engine);
        Bundle extras = request.getExtras() != null ? request.getExtras().getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS) : null;
        if (extras == null) extras = request.getExtras();
        connection.setAddress(request.getAddress(), TelecomManager.PRESENTATION_ALLOWED);
        if (extras != null) {
            String name = extras.getString(TelecomBridge.EXTRA_REMOTE_NAME, "");
            if (!name.isEmpty()) connection.setCallerDisplayName(name, TelecomManager.PRESENTATION_ALLOWED);
        }
        connection.setCallId(callIdFrom(extras));
        connection.setRinging();
        return connection;
    }

    @Override
    public void onCreateIncomingConnectionFailed(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Log.w(TAG, "Telecom rejected incoming connection; the SIP call continues without Telecom.");
    }

    @Override
    public void onCreateOutgoingConnectionFailed(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Log.w(TAG, "Telecom rejected outgoing connection; the SIP call continues without Telecom.");
    }

    private static String callIdFrom(Bundle extras) {
        if (extras == null) return "";
        String id = extras.getString(TelecomBridge.EXTRA_CALL_ID, "");
        return id == null ? "" : id.trim();
    }
}
