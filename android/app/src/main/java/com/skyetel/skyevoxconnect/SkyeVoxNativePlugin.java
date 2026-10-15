package com.skyetel.skyevoxconnect;

import android.Manifest;
import android.app.role.RoleManager;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.telecom.TelecomManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Capacitor bridge over {@link LinphoneEngine}.
 *
 * Microphone: liblinphone captures through AudioRecord, which silently yields empty frames when
 * RECORD_AUDIO has not been granted at runtime (one-way audio). register/call/answer therefore
 * request the permission first and continue in {@link #microphonePermissionCallback}.
 */
@CapacitorPlugin(
    name = "SkyeVoxNative",
    permissions = {
        @Permission(alias = SkyeVoxNativePlugin.MIC_ALIAS, strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class SkyeVoxNativePlugin extends Plugin implements LinphoneEngine.Listener {
    static final String MIC_ALIAS = "microphone";

    private LinphoneEngine engine;

    private boolean hasMicrophone() {
        return getPermissionState(MIC_ALIAS) == PermissionState.GRANTED;
    }

    /** Runs {@code action} now if the microphone is granted, otherwise after the permission prompt. */
    private void withMicrophone(PluginCall call, String action) {
        if (hasMicrophone()) {
            dispatch(call, action);
            return;
        }
        call.setKeepAlive(true);
        requestPermissionForAlias(MIC_ALIAS, call, "microphonePermissionCallback");
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        String action = call.getString("__skyevoxAction", "");
        if (!hasMicrophone()) {
            // Registration may proceed without a microphone (inbound presence still works);
            // calls must not, or the far end hears silence.
            if ("register".equals(action)) {
                dispatch(call, action);
            } else {
                call.reject("Microphone permission denied");
            }
            return;
        }
        dispatch(call, action);
    }

    private void dispatch(PluginCall call, String action) {
        switch (action) {
            case "register": doRegister(call); break;
            case "call": doCall(call); break;
            case "answer": doAnswer(call); break;
            default: call.reject("Unknown action " + action);
        }
    }

    private static PluginCall tagged(PluginCall call, String action) {
        call.getData().put("__skyevoxAction", action);
        return call;
    }


    @Override
    public void load() {
        engine = LinphoneEngine.obtain(getContext());
        engine.setListener(this);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        try {
            engine.configure(call.getObject("config"));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void register(PluginCall call) {
        withMicrophone(tagged(call, "register"), "register");
    }

    private void doRegister(PluginCall call) {
        try {
            TelecomBridge.ensurePhoneAccount(getContext());
            engine.register();

            JSObject state = new JSObject();
            state.put("state", "registering");
            call.resolve(state);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        try {
            engine.unregister();
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void call(PluginCall call) {
        withMicrophone(tagged(call, "call"), "call");
    }

    private void doCall(PluginCall call) {
        String target = call.getString("destination", call.getString("target", ""));
        try {
            String callId = engine.call(target);
            JSObject result = new JSObject();
            result.put("callId", callId);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void answer(PluginCall call) {
        withMicrophone(tagged(call, "answer"), "answer");
    }

    private void doAnswer(PluginCall call) {
        try {
            engine.answer(requiredCallId(call));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void reject(PluginCall call) {
        try {
            engine.reject(requiredCallId(call));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void hangup(PluginCall call) {
        try {
            engine.hangup(requiredCallId(call));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void hold(PluginCall call) {
        try {
            engine.hold(requiredCallId(call));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void unhold(PluginCall call) {
        try {
            engine.unhold(requiredCallId(call));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void mute(PluginCall call) {
        try {
            engine.mute(call.getString("callId", ""), Boolean.TRUE.equals(call.getBoolean("muted", false)));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void sendDtmf(PluginCall call) {
        try {
            engine.sendDtmf(requiredCallId(call), call.getString("digit", ""));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void transfer(PluginCall call) {
        try {
            boolean attended = Boolean.TRUE.equals(call.getBoolean("attended", false));
            engine.transfer(requiredCallId(call), call.getString("destination", ""), attended);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void getDefaultCallingStatus(PluginCall call) {
        boolean enabled = false;
        boolean eligible = true;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            RoleManager roleManager = getContext().getSystemService(RoleManager.class);
            if (roleManager != null) {
                eligible = roleManager.isRoleAvailable(RoleManager.ROLE_DIALER);
                enabled = roleManager.isRoleHeld(RoleManager.ROLE_DIALER);
            }
        }

        JSObject result = new JSObject();
        result.put("supported", true);
        result.put("eligible", eligible);
        result.put("enabled", enabled);
        result.put("reason", enabled
            ? "SkyeVox Connect is the default dialer role holder."
            : "Android Telecom and the native liblinphone engine are present. User must grant the default dialer role.");
        call.resolve(result);
    }

    @PluginMethod
    public void openDefaultCallingSettings(PluginCall call) {
        Intent intent;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            RoleManager roleManager = getContext().getSystemService(RoleManager.class);
            if (roleManager != null && roleManager.isRoleAvailable(RoleManager.ROLE_DIALER)) {
                intent = roleManager.createRequestRoleIntent(RoleManager.ROLE_DIALER);
            } else {
                intent = new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS);
            }
        } else {
            intent = new Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER);
            intent.putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, getContext().getPackageName());
        }

        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    private String requiredCallId(PluginCall call) {
        String callId = call.getString("callId", "");
        if (callId == null || callId.isEmpty()) {
            throw new IllegalArgumentException("Missing callId.");
        }
        return callId;
    }

    @Override
    public void onRegistrationChanged(String state, String accountId, String error) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        if (!accountId.isEmpty()) payload.put("accountId", accountId);
        if (!error.isEmpty()) payload.put("error", error);
        notifyListeners("registrationChanged", payload, true);
    }

    @Override
    public void onCallChanged(String callId, String state, String direction, String remoteNumber, String remoteName, String error) {
        JSObject payload = new JSObject();
        payload.put("callId", callId);
        payload.put("state", state);
        if (!direction.isEmpty()) payload.put("direction", direction);
        if (!remoteNumber.isEmpty()) payload.put("remoteNumber", remoteNumber);
        if (!remoteName.isEmpty()) payload.put("remoteName", remoteName);
        if (!error.isEmpty()) payload.put("error", error);
        notifyListeners("callChanged", payload, true);
    }

    @Override
    public void onPushTokenChanged(String token) {
        JSObject payload = new JSObject();
        payload.put("platform", "android");
        payload.put("token", token);
        payload.put("bundleId", getContext().getPackageName());
        notifyListeners("pushTokenChanged", payload, true);
    }
}
