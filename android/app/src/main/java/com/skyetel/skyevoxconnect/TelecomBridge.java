package com.skyetel.skyevoxconnect;

import android.content.ComponentName;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

/**
 * Engine -> Android Telecom direction: announces liblinphone calls to the system as
 * self-managed connections so audio focus, Bluetooth routing, and cellular-call arbitration
 * behave like a first-class dialer. Every step is best-effort: a Telecom refusal never
 * blocks the SIP call.
 */
final class TelecomBridge {
    static final String PHONE_ACCOUNT_ID = "skyevox-connect";
    static final String EXTRA_CALL_ID = "com.skyetel.skyevoxconnect.CALL_ID";
    static final String EXTRA_REMOTE_NAME = "com.skyetel.skyevoxconnect.REMOTE_NAME";

    private static final String TAG = "SkyeVoxTelecom";

    private TelecomBridge() {}

    static PhoneAccountHandle handle(Context context) {
        return new PhoneAccountHandle(new ComponentName(context, SkyeVoxConnectionService.class), PHONE_ACCOUNT_ID);
    }

    static void ensurePhoneAccount(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        TelecomManager telecomManager = context.getSystemService(TelecomManager.class);
        if (telecomManager == null) return;
        try {
            PhoneAccount account = PhoneAccount.builder(handle(context), "SkyeVox Connect")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .addSupportedUriScheme(PhoneAccount.SCHEME_TEL)
                .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
                .build();
            telecomManager.registerPhoneAccount(account);
        } catch (RuntimeException error) {
            Log.w(TAG, "Cannot register phone account", error);
        }
    }

    static void reportIncoming(Context context, String callId, String remoteNumber, String remoteName) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (SkyeVoxTelecomConnection.isBound(callId)) return;
        TelecomManager telecomManager = context.getSystemService(TelecomManager.class);
        if (telecomManager == null) return;
        PhoneAccountHandle handle = handle(context);
        try {
            if (!telecomManager.isIncomingCallPermitted(handle)) {
                Log.w(TAG, "Telecom does not permit an incoming call right now; continuing without Telecom.");
                return;
            }
            Bundle extras = new Bundle();
            extras.putString(EXTRA_CALL_ID, callId);
            extras.putString(EXTRA_REMOTE_NAME, remoteName);
            extras.putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, addressFor(remoteNumber));
            telecomManager.addNewIncomingCall(handle, extras);
        } catch (RuntimeException error) {
            Log.w(TAG, "addNewIncomingCall failed for " + callId, error);
        }
    }

    static void reportOutgoing(Context context, String callId, String remoteNumber) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (SkyeVoxTelecomConnection.isBound(callId)) return;
        TelecomManager telecomManager = context.getSystemService(TelecomManager.class);
        if (telecomManager == null) return;
        PhoneAccountHandle handle = handle(context);
        try {
            if (!telecomManager.isOutgoingCallPermitted(handle)) {
                Log.w(TAG, "Telecom does not permit an outgoing call right now; continuing without Telecom.");
                return;
            }
            Bundle callExtras = new Bundle();
            callExtras.putString(EXTRA_CALL_ID, callId);
            Bundle extras = new Bundle();
            extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle);
            extras.putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, callExtras);
            telecomManager.placeCall(addressFor(remoteNumber), extras);
        } catch (RuntimeException error) {
            Log.w(TAG, "placeCall failed for " + callId, error);
        }
    }

    static Uri addressFor(String remoteNumber) {
        String value = remoteNumber == null ? "" : remoteNumber.trim();
        if (value.isEmpty()) value = "unknown";
        return Uri.fromParts(value.matches("[+0-9*#]+") ? PhoneAccount.SCHEME_TEL : PhoneAccount.SCHEME_SIP, value, null);
    }
}
