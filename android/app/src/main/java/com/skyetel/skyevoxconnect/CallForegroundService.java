package com.skyetel.skyevoxconnect;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Foreground service that keeps the process and the liblinphone Core alive while a call is
 * signaling or streaming, and while an FCM wake-up is waiting for the held INVITE.
 */
public class CallForegroundService extends Service {

    static final String EXTRA_MODE = "mode";
    static final String MODE_WAKE = "wake";
    static final String MODE_SIGNALING = "signaling";
    static final String MODE_CALL = "call";

    private static final String TAG = "SkyeVoxCallService";
    private static final String CHANNEL_ID = "skyevox_call_channel";
    private static final int NOTIFICATION_ID = 1001;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String mode = intent != null && intent.getStringExtra(EXTRA_MODE) != null ? intent.getStringExtra(EXTRA_MODE) : MODE_CALL;
        Notification notification = buildNotification(mode);

        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL;
        if (MODE_CALL.equals(mode)) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        } catch (RuntimeException error) {
            // Android 14 refuses the microphone type when the app is not visible; fall back to
            // the phoneCall type so the process still survives until the user opens the call UI.
            Log.w(TAG, "startForeground(" + mode + ") rejected, retrying as phoneCall only", error);
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
        }

        if (MODE_WAKE.equals(mode)) {
            // Keep the Core registered while the push gateway late-forks the held INVITE.
            LinphoneEngine.obtain(this);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification(String mode) {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        notificationIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String text;
        switch (mode) {
            case MODE_WAKE:
                text = "Connecting incoming call";
                break;
            case MODE_SIGNALING:
                text = "Incoming call";
                break;
            default:
                text = "Call in progress";
                break;
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("SkyeVox Connect")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentIntent(pendingIntent)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true);
        if (MODE_SIGNALING.equals(mode)) {
            builder.setPriority(NotificationCompat.PRIORITY_HIGH).setFullScreenIntent(pendingIntent, true);
        }
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Active Calls",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Shows notification during active and incoming calls");
            channel.setSound(null, null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    /** Start/stop helper used by the engine and the FCM service. Never throws. */
    static final class Controller {
        private final Context context;
        private String currentMode = "";

        Controller(Context context) {
            this.context = context.getApplicationContext();
        }

        void startForWake() {
            start(MODE_WAKE);
        }

        void startForSignaling() {
            start(MODE_SIGNALING);
        }

        void startForCall() {
            start(MODE_CALL);
        }

        void stop() {
            currentMode = "";
            context.stopService(new Intent(context, CallForegroundService.class));
        }

        private void start(String mode) {
            if (mode.equals(currentMode)) return;
            Intent intent = new Intent(context, CallForegroundService.class).putExtra(EXTRA_MODE, mode);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent);
                } else {
                    context.startService(intent);
                }
                currentMode = mode;
            } catch (RuntimeException error) {
                // Background start restrictions (API 31+) when no FCM/visibility exemption applies.
                Log.w(TAG, "Cannot start foreground service in mode " + mode, error);
            }
        }
    }
}
