package com.skyetel.skyevoxconnect;

import android.util.Log;

import androidx.annotation.NonNull;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * FCM entry point. Declared with a higher intent-filter priority than the Capacitor
 * push plugin's service so call wake-ups reach the SIP engine even when the WebView is dead.
 *
 * Call pushes come from the Flexisip Push Gateway as high-priority data messages carrying
 * only routing metadata (call id, domain, extension, caller display, expiry); never credentials.
 * Every message is also forwarded to the Capacitor plugin so JS-side handling (SMS/MMS
 * notifications, token refresh) keeps working unchanged.
 *
 * Requires google-services.json for Firebase to initialise; without it this service is never
 * invoked but the app still builds and runs.
 */
public class SkyeVoxMessagingService extends FirebaseMessagingService {
    private static final String TAG = "SkyeVoxFcm";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Map<String, String> data = remoteMessage.getData();
        String callId = first(data, "call-id", "callId", "call_id");
        boolean callWake = !callId.isEmpty() || "call".equals(first(data, "type", "event"));

        if (callWake) {
            Log.i(TAG, "Call wake-up push for Call-ID [" + callId + "]");
            new CallForegroundService.Controller(this).startForWake();
            try {
                LinphoneEngine.obtain(this).onPushWake(callId);
            } catch (RuntimeException error) {
                Log.e(TAG, "Engine wake failed", error);
            }
        }

        PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        LinphoneEngine engine = LinphoneEngine.getActiveEngine();
        if (engine != null) {
            engine.updatePushToken(token);
        }
        PushNotificationsPlugin.onNewToken(token);
    }

    private static String first(Map<String, String> data, String... keys) {
        for (String key : keys) {
            String value = data.get(key);
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return "";
    }
}
