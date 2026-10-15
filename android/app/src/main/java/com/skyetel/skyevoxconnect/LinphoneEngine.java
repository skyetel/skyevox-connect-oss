package com.skyetel.skyevoxconnect;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;

import org.json.JSONObject;
import org.linphone.core.AVPFMode;
import org.linphone.core.Account;
import org.linphone.core.AccountParams;
import org.linphone.core.Address;
import org.linphone.core.AuthInfo;
import org.linphone.core.Call;
import org.linphone.core.CallParams;
import org.linphone.core.Core;
import org.linphone.core.CoreListenerStub;
import org.linphone.core.ErrorInfo;
import org.linphone.core.LogLevel;
import org.linphone.core.Factory;
import org.linphone.core.MediaEncryption;
import org.linphone.core.NatPolicy;
import org.linphone.core.PayloadType;
import org.linphone.core.PushNotificationConfig;
import org.linphone.core.Reason;
import org.linphone.core.RegistrationState;
import org.linphone.core.TransportType;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * liblinphone-backed SIP engine behind the {@code SkyeVoxNative} Capacitor plugin.
 *
 * One {@link Core} per process, created lazily on the main thread and kept alive across the
 * WebView lifecycle so an FCM wake-up can restart registration before the JS layer exists.
 * Account, auth, and push parameters are persisted by liblinphone in the app-private rc file,
 * so a process started by {@link SkyeVoxMessagingService} re-registers with the last
 * provisioned identity without any JS involvement.
 */
public final class LinphoneEngine {
    interface Listener {
        void onRegistrationChanged(String state, String accountId, String error);
        void onCallChanged(String callId, String state, String direction, String remoteNumber, String remoteName, String error);
        void onPushTokenChanged(String token);
    }

    private static final String TAG = "SkyeVoxLinphone";
    private static final String CA_BUNDLE_ASSET = "skyevox-ca-bundle.pem";
    private static final String RC_FILE = "skyevox-linphonerc";
    private static final String PUSH_PROVIDER_FCM = "fcm";
    private static final String BUNDLE_ID = "com.skyetel.skyevoxconnect";
    /** Provisioning mobile.pushRegisterExpiresSeconds default; see applyPushParams. */
    private static final int DEFAULT_PUSH_REGISTER_EXPIRES = 86400;
    private static final int MIN_PUSH_REGISTER_EXPIRES = 600;
    private static final String[] PREFERRED_CODECS = {"opus", "PCMU", "PCMA"};
    private static final long MAIN_THREAD_TIMEOUT_SECONDS = 10;

    private static LinphoneEngine activeEngine;

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Core core;
    private Listener listener;
    private boolean configured;
    private boolean registerRequested;
    private String pushToken = "";
    private String pushParam = "";
    private boolean pushEnabled = true;
    private int registerInterval = 120;
    private int pushRegisterExpires = DEFAULT_PUSH_REGISTER_EXPIRES;
    private final CallForegroundService.Controller foregroundController;

    private LinphoneEngine(Context context) {
        this.context = context.getApplicationContext();
        this.foregroundController = new CallForegroundService.Controller(this.context);
    }

    /**
     * Returns the process-wide engine. The liblinphone Core is NOT created here: a running Core
     * takes over Android audio (mode/focus/routing) and silences the WebView's WebRTC playback
     * when the SIP.js engine is in use. The Core is created lazily by {@link #configure} and by
     * the FCM wake path, and released by {@link #unregister}.
     */
    public static LinphoneEngine obtain(Context context) {
        synchronized (LinphoneEngine.class) {
            if (activeEngine == null) {
                activeEngine = new LinphoneEngine(context);
            }
            return activeEngine;
        }
    }

    /** Returns the engine only if one already exists in this process. */
    public static LinphoneEngine getActiveEngine() {
        synchronized (LinphoneEngine.class) {
            return activeEngine;
        }
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    boolean isConfigured() {
        return configured || hasPersistedAccount();
    }

    // ---------------------------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------------------------

    void configure(JSObject config) {
        if (config == null) {
            throw new IllegalArgumentException("Missing SIP config.");
        }
        runOnMain(() -> {
            if (core == null) core = createCore();
            applyConfig(config);
            return null;
        });
    }

    private void applyConfig(JSONObject config) {
        JSONObject mobile = config.optJSONObject("mobile");
        String sipServer = clean(config.optString("sipServer", ""));
        String sipDomain = clean(config.optString("sipDomain", sipServer));
        if (sipDomain.isEmpty()) sipDomain = sipServer;
        if (sipServer.isEmpty()) sipServer = sipDomain;
        String username = clean(config.optString("username", ""));
        String password = config.optString("password", "");
        String displayName = clean(config.optString("displayName", username));
        registerInterval = Math.max(60, config.optInt("registerInterval", 120));

        if (sipDomain.isEmpty() || username.isEmpty()) {
            throw new IllegalArgumentException("SIP config requires sipDomain/sipServer and username.");
        }

        String transport = clean(config.optString("sipTransport", ""));
        String srtp = clean(config.optString("srtp", ""));
        pushEnabled = true;
        pushRegisterExpires = DEFAULT_PUSH_REGISTER_EXPIRES;
        String bundleId = BUNDLE_ID;
        if (mobile != null) {
            if (transport.isEmpty()) transport = clean(mobile.optString("transport", ""));
            String mobileSrtp = clean(mobile.optString("srtp", ""));
            if (!mobileSrtp.isEmpty()) srtp = mobileSrtp;
            pushEnabled = mobile.optBoolean("pushEnabled", true);
            pushRegisterExpires = Math.max(MIN_PUSH_REGISTER_EXPIRES,
                mobile.optInt("pushRegisterExpiresSeconds", DEFAULT_PUSH_REGISTER_EXPIRES));
            bundleId = clean(mobile.optString("pushBundleId", BUNDLE_ID));
            String param = clean(mobile.optString("pushParam", ""));
            if (!param.isEmpty()) pushParam = param;
        }
        if (transport.isEmpty()) transport = "tls";
        if (bundleId.isEmpty()) bundleId = BUNDLE_ID;

        String token = clean(config.optString("pushToken", ""));
        String provider = clean(config.optString("pushProvider", "")).toLowerCase(Locale.ROOT);
        if (!token.isEmpty() && (provider.isEmpty() || PUSH_PROVIDER_FCM.equals(provider))) {
            pushToken = token;
        }

        boolean srtpMandatory = "mandatory".equalsIgnoreCase(srtp);
        core.setMediaEncryption(MediaEncryption.SRTP);
        core.setMediaEncryptionMandatory(srtpMandatory);

        applyNatPolicy(config);

        TransportType transportType = transportType(transport);
        Address identity = core.interpretUrl("sip:" + username + "@" + sipDomain, false);
        if (identity == null) {
            throw new IllegalArgumentException("Invalid SIP identity for " + username + "@" + sipDomain);
        }
        identity.setDisplayName(displayName);

        Address server = core.interpretUrl("sip:" + sipServer, false);
        if (server == null) {
            throw new IllegalArgumentException("Invalid SIP server " + sipServer);
        }
        server.setTransport(transportType);

        core.clearAllAuthInfo();
        AuthInfo authInfo = Factory.instance().createAuthInfo(username, null, password, null, null, sipDomain);
        core.addAuthInfo(authInfo);
        addTurnAuthInfo(config);

        Account account = core.getDefaultAccount();
        AccountParams params = account != null ? account.getParams().clone() : core.createAccountParams();
        params.setIdentityAddress(identity);
        params.setServerAddress(server);
        params.setOutboundProxyEnabled(true);
        params.setTransport(transportType);
        params.setAvpfMode(AVPFMode.Disabled);
        params.setPublishEnabled(false);
        params.setUnregisterAtStopEnabled(false);
        params.setRegisterEnabled(account != null ? account.getParams().isRegisterEnabled() : registerRequested);
        boolean pushReady = applyPushParams(params, bundleId);

        if (account == null) {
            account = core.createAccount(params);
            core.addAccount(account);
            core.setDefaultAccount(account);
        } else {
            account.setParams(params);
        }

        configured = true;
        Log.i(TAG, "Configured account " + identity.asStringUriOnly() + " via " + server.asStringUriOnly()
            + " srtp=" + (srtpMandatory ? "mandatory" : "opportunistic") + " push=" + pushReady
            + " expires=" + params.getExpires());
    }

    /**
     * Applies the RFC 8599 pn-* Contact params and the matching REGISTER expiry. Flexisip never
     * pushes for an expired binding, so a push-capable contact must outlive any suspend: it
     * registers with the long provisioning expiry (mobile.pushRegisterExpiresSeconds) and lets a
     * dead TCP/TLS connection, not expiry, trigger the push. A Contact without pn-* params keeps
     * the short registerInterval refresh. Returns whether the Contact carries push params.
     */
    private boolean applyPushParams(AccountParams params, String bundleId) {
        String param = pushParam.isEmpty() ? firebaseSenderId() : pushParam;
        boolean ready = pushEnabled && !pushToken.isEmpty() && !param.isEmpty();
        params.setPushNotificationAllowed(ready);
        params.setRemotePushNotificationAllowed(false);
        params.setExpires(ready ? pushRegisterExpires : registerInterval);
        if (!ready) {
            if (pushEnabled && pushToken.isEmpty()) {
                Log.w(TAG, "Push enabled but no FCM token yet; Contact will not carry pn-* params until a token arrives.");
            }
            return false;
        }
        PushNotificationConfig push = params.getPushNotificationConfig();
        push.setProvider(PUSH_PROVIDER_FCM);
        push.setPrid(pushToken);
        push.setParam(param);
        push.setBundleIdentifier(bundleId);
        return true;
    }

    private void applyNatPolicy(JSONObject config) {
        String turnServer = clean(config.optString("turnServer", ""));
        JSONObject creds = config.optJSONObject("turnCredentials");
        String turnUser = creds != null ? clean(creds.optString("username", "")) : "";

        NatPolicy policy = core.createNatPolicy();
        policy.setIceEnabled(true);
        String hostPort = turnHostPort(turnServer);
        if (!hostPort.isEmpty()) {
            policy.setStunEnabled(true);
            policy.setStunServer(hostPort);
            boolean turn = !turnUser.isEmpty();
            policy.setTurnEnabled(turn);
            if (turn) {
                policy.setStunServerUsername(turnUser);
                policy.setUdpTurnTransportEnabled(true);
                policy.setTcpTurnTransportEnabled(true);
            }
        }
        core.setNatPolicy(policy);
    }

    private void addTurnAuthInfo(JSONObject config) {
        JSONObject creds = config.optJSONObject("turnCredentials");
        if (creds == null) return;
        String user = clean(creds.optString("username", ""));
        String credential = creds.optString("credential", "");
        if (user.isEmpty() || credential.isEmpty()) return;
        core.addAuthInfo(Factory.instance().createAuthInfo(user, null, credential, null, null, null));
    }

    // ---------------------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------------------

    void register() {
        runOnMain(() -> {
            requireConfigured();
            registerRequested = true;
            setRegisterEnabled(true);
            core.refreshRegisters();
            return null;
        });
    }

    /** Disables registration and releases the Core so Android audio returns to the WebView. */
    void unregister() {
        runOnMain(() -> {
            registerRequested = false;
            if (core == null) return null;
            if (core.getDefaultAccount() != null) {
                setRegisterEnabled(false);
            }
            releaseCore();
            return null;
        });
    }

    private void releaseCore() {
        if (core == null) return;
        try {
            core.removeListener(coreListener);
            core.stop();
        } catch (RuntimeException error) {
            Log.w(TAG, "liblinphone core stop failed", error);
        }
        core = null;
        configured = false;
        foregroundController.stop();
        Log.i(TAG, "liblinphone core released");
    }

    private void setRegisterEnabled(boolean enabled) {
        Account account = core.getDefaultAccount();
        if (account == null) return;
        AccountParams params = account.getParams().clone();
        params.setRegisterEnabled(enabled);
        account.setParams(params);
    }

    /**
     * Called from the FCM path. Ensures the Core is running, tells liblinphone which call the push
     * announces, and forces a REGISTER refresh so the gateway can late-fork the held INVITE.
     */
    void onPushWake(String callId) {
        runOnMain(() -> {
            if (core == null) core = createCore();
            if (core.getDefaultAccount() == null) {
                Log.w(TAG, "Push wake with no persisted account; ignoring.");
                return null;
            }
            setRegisterEnabled(true);
            registerRequested = true;
            core.refreshRegisters();
            if (!callId.isEmpty()) {
                core.processPushNotification(callId);
            }
            return null;
        });
    }

    void updatePushToken(String token) {
        String cleaned = clean(token);
        if (cleaned.isEmpty()) return;
        runOnMain(() -> {
            pushToken = cleaned;
            Account account = core != null ? core.getDefaultAccount() : null;
            if (account != null) {
                AccountParams params = account.getParams().clone();
                String bundleId = params.getPushNotificationConfig().getBundleIdentifier();
                applyPushParams(params, bundleId == null || bundleId.isEmpty() ? BUNDLE_ID : bundleId);
                account.setParams(params);
                if (params.isRegisterEnabled()) {
                    core.refreshRegisters();
                }
            }
            if (listener != null) listener.onPushTokenChanged(cleaned);
            return null;
        });
    }

    // ---------------------------------------------------------------------------------------
    // Calls
    // ---------------------------------------------------------------------------------------

    String call(String destination) {
        String target = clean(destination);
        if (target.isEmpty()) {
            throw new IllegalArgumentException("Missing destination.");
        }
        return runOnMain(() -> {
            requireConfigured();
            Address address = core.interpretUrl(target, true);
            if (address == null) {
                throw new IllegalArgumentException("Cannot dial " + target);
            }
            CallParams params = core.createCallParams(null);
            params.setVideoEnabled(false);
            params.setAudioEnabled(true);
            Call call = core.inviteAddressWithParams(address, params);
            if (call == null) {
                throw new IllegalStateException("liblinphone refused to start the call.");
            }
            return callIdOf(call);
        });
    }

    void answer(String callId) {
        runOnMain(() -> {
            Call call = requireCall(callId);
            CallParams params = core.createCallParams(call);
            params.setVideoEnabled(false);
            params.setAudioEnabled(true);
            check(call.acceptWithParams(params), "answer");
            return null;
        });
    }

    void reject(String callId) {
        runOnMain(() -> {
            Call call = requireCall(callId);
            if (call.getState() == Call.State.IncomingReceived || call.getState() == Call.State.IncomingEarlyMedia
                || call.getState() == Call.State.PushIncomingReceived) {
                check(call.decline(Reason.Declined), "reject");
            } else {
                check(call.terminate(), "reject");
            }
            return null;
        });
    }

    void hangup(String callId) {
        runOnMain(() -> {
            Call call = findCall(callId);
            if (call != null) {
                check(call.terminate(), "hangup");
            }
            return null;
        });
    }

    void hold(String callId) {
        runOnMain(() -> {
            check(requireCall(callId).pause(), "hold");
            return null;
        });
    }

    void unhold(String callId) {
        runOnMain(() -> {
            check(requireCall(callId).resume(), "unhold");
            return null;
        });
    }

    void mute(String callId, boolean muted) {
        runOnMain(() -> {
            Call call = findCall(callId);
            if (call != null) {
                call.setMicrophoneMuted(muted);
            } else if (core != null) {
                core.setMicEnabled(!muted);
            }
            return null;
        });
    }

    void sendDtmf(String callId, String digit) {
        String cleaned = clean(digit);
        if (cleaned.isEmpty()) return;
        runOnMain(() -> {
            check(requireCall(callId).sendDtmfs(cleaned), "sendDtmf");
            return null;
        });
    }

    void transfer(String callId, String destination, boolean attended) {
        String target = clean(destination);
        runOnMain(() -> {
            Call call = requireCall(callId);
            if (attended) {
                Call other = target.isEmpty() ? otherCall(call) : findCall(target);
                if (other == null) other = otherCall(call);
                if (other == null) {
                    throw new IllegalStateException("Attended transfer needs a second active call.");
                }
                check(call.transferToAnother(other), "transfer");
                return null;
            }
            if (target.isEmpty()) {
                throw new IllegalArgumentException("Missing transfer destination.");
            }
            Address address = core.interpretUrl(target, true);
            if (address == null) {
                throw new IllegalArgumentException("Cannot transfer to " + target);
            }
            check(call.transferTo(address), "transfer");
            return null;
        });
    }

    /** Call currently in a live state for the given id, or null. Main thread only. */
    Call findCall(String callId) {
        String id = clean(callId);
        if (id.isEmpty() || core == null) return null;
        Call call = core.getCallByCallid(id);
        if (call != null) return call;
        for (Call candidate : core.getCalls()) {
            if (id.equals(callIdOf(candidate))) return candidate;
        }
        return null;
    }

    private Call requireCall(String callId) {
        Call call = findCall(callId);
        if (call == null) {
            throw new IllegalStateException("Unknown call " + callId);
        }
        return call;
    }

    private Call otherCall(Call call) {
        for (Call candidate : core.getCalls()) {
            if (candidate != call && candidate.getState() != Call.State.End && candidate.getState() != Call.State.Released) {
                return candidate;
            }
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------
    // Core lifecycle
    // ---------------------------------------------------------------------------------------

    private void ensureCore() {
        runOnMain(() -> {
            if (core == null) {
                core = createCore();
            }
            return null;
        });
    }

    private Core createCore() {
        Factory factory = Factory.instance();
        boolean debuggable = (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        factory.setLoggerDomain(TAG);
        factory.enableLogcatLogs(true);
        factory.getLoggingService().setLogLevel(debuggable ? LogLevel.Message : LogLevel.Warning);
        File rc = new File(context.getFilesDir(), RC_FILE);
        Core created = factory.createCore(rc.getAbsolutePath(), null, context);

        created.setUserAgent("SkyeVoxConnect", appVersionName());
        created.setAutoIterateEnabled(true);
        created.setKeepAliveEnabled(true);
        created.setIpv6Enabled(true);
        created.setPushNotificationEnabled(true);
        created.setVideoCaptureEnabled(false);
        created.setVideoDisplayEnabled(false);
        created.setEchoCancellationEnabled(true);
        created.setNativeRingingEnabled(false);

        String caBundle = installCaBundle();
        created.setRootCa(caBundle);
        created.verifyServerCertificates(true);
        created.verifyServerCn(true);

        applyCodecPolicy(created);
        created.addListener(coreListener);
        int status = created.start();
        if (status != 0) {
            throw new IllegalStateException("liblinphone Core failed to start (" + status + ")");
        }
        TelecomBridge.ensurePhoneAccount(context);
        Log.i(TAG, "liblinphone core started, rc=" + rc.getAbsolutePath() + ", rootca=" + caBundle);
        return created;
    }

    private void applyCodecPolicy(Core target) {
        PayloadType[] audio = target.getAudioPayloadTypes();
        for (PayloadType type : audio) {
            boolean keep = false;
            for (String preferred : PREFERRED_CODECS) {
                if (preferred.equalsIgnoreCase(type.getMimeType())) {
                    keep = true;
                    break;
                }
            }
            type.enable(keep);
        }
    }

    /** Copies the bundled Mozilla root store into app-private storage and returns its path. */
    private String installCaBundle() {
        File target = new File(context.getFilesDir(), CA_BUNDLE_ASSET);
        try (InputStream in = context.getAssets().open(CA_BUNDLE_ASSET); OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        } catch (IOException error) {
            throw new IllegalStateException("Cannot install CA bundle " + CA_BUNDLE_ASSET, error);
        }
        return target.getAbsolutePath();
    }

    private boolean hasPersistedAccount() {
        if (core == null) return false;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return core.getDefaultAccount() != null;
        }
        return runOnMain(() -> core.getDefaultAccount() != null);
    }

    private final CoreListenerStub coreListener = new CoreListenerStub() {
        @Override
        public void onAccountRegistrationStateChanged(Core lc, Account account, RegistrationState state, String message) {
            String mapped;
            switch (state) {
                case Progress:
                case Refreshing:
                    mapped = "registering";
                    break;
                case Ok:
                    mapped = "registered";
                    break;
                case Cleared:
                    mapped = "unregistered";
                    break;
                case Failed:
                    mapped = "failed";
                    break;
                case None:
                default:
                    mapped = "idle";
                    break;
            }
            String accountId = "";
            Address identity = account.getParams().getIdentityAddress();
            if (identity != null) accountId = clean(identity.asStringUriOnly());
            String error = state == RegistrationState.Failed ? describeError(account.getErrorInfo(), message) : "";
            Log.i(TAG, "Registration " + state + " for " + accountId + (error.isEmpty() ? "" : ": " + error));
            if (listener != null) listener.onRegistrationChanged(mapped, accountId, error);
        }

        @Override
        public void onCallStateChanged(Core lc, Call call, Call.State state, String message) {
            String mapped = mapCallState(state);
            if (mapped == null) return;
            String callId = callIdOf(call);
            String direction = call.getDir() == Call.Dir.Incoming ? "inbound" : "outbound";
            Address remote = call.getRemoteAddress();
            String remoteNumber = remote != null ? clean(remote.getUsername()) : "";
            String remoteName = remote != null ? clean(remote.getDisplayName()) : "";
            String error = state == Call.State.Error ? describeError(call.getErrorInfo(), message) : "";

            Log.i(TAG, "Call " + callId + " " + state + " -> " + mapped);
            if (state == Call.State.IncomingReceived || state == Call.State.PushIncomingReceived) {
                TelecomBridge.reportIncoming(context, callId, remoteNumber, remoteName);
            } else if (state == Call.State.OutgoingInit) {
                TelecomBridge.reportOutgoing(context, callId, remoteNumber);
            }
            SkyeVoxTelecomConnection.onEngineCallState(callId, mapped, error);
            updateForegroundService(state);
            if (listener != null) listener.onCallChanged(callId, mapped, direction, remoteNumber, remoteName, error);
        }
    };

    private void updateForegroundService(Call.State state) {
        int live = 0;
        boolean streaming = false;
        for (Call call : core.getCalls()) {
            Call.State s = call.getState();
            if (s == Call.State.End || s == Call.State.Released || s == Call.State.Error) continue;
            live++;
            if (s == Call.State.StreamsRunning || s == Call.State.Connected) streaming = true;
        }
        if (live == 0) {
            foregroundController.stop();
        } else if (streaming) {
            foregroundController.startForCall();
        } else if (state == Call.State.IncomingReceived || state == Call.State.PushIncomingReceived || state == Call.State.OutgoingInit) {
            foregroundController.startForSignaling();
        }
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    static String mapCallState(Call.State state) {
        switch (state) {
            case IncomingReceived:
            case PushIncomingReceived:
            case IncomingEarlyMedia:
                return "incoming";
            case OutgoingInit:
            case OutgoingProgress:
                return "dialing";
            case OutgoingRinging:
            case OutgoingEarlyMedia:
                return "ringing";
            case Connected:
            case StreamsRunning:
            case Resuming:
            case Updating:
            case UpdatedByRemote:
            case EarlyUpdating:
            case EarlyUpdatedByRemote:
                return "active";
            case Pausing:
            case Paused:
            case PausedByRemote:
                return "held";
            case Error:
                return "failed";
            case End:
                return "ended";
            case Idle:
                return "idle";
            case Referred:
            case Released:
            default:
                return null;
        }
    }

    static String callIdOf(Call call) {
        String id = call.getCallLog() != null ? clean(call.getCallLog().getCallId()) : "";
        return id.isEmpty() ? "lp-" + Long.toHexString(call.getNativePointer()) : id;
    }

    private static String describeError(ErrorInfo info, String fallback) {
        if (info == null) return clean(fallback);
        String phrase = clean(info.getPhrase());
        int code = info.getProtocolCode();
        if (code > 0) {
            return code + (phrase.isEmpty() ? "" : " " + phrase);
        }
        Reason reason = info.getReason();
        if (!phrase.isEmpty()) return phrase;
        return reason != null && reason != Reason.None ? reason.toString() : clean(fallback);
    }

    private String appVersionName() {
        try {
            String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return name == null ? "unknown" : name;
        } catch (PackageManager.NameNotFoundException error) {
            return "unknown";
        }
    }

    private static TransportType transportType(String transport) {
        switch (transport.toLowerCase(Locale.ROOT)) {
            case "udp":
                return TransportType.Udp;
            case "tcp":
                return TransportType.Tcp;
            default:
                return TransportType.Tls;
        }
    }

    /** "turn:host:3478?transport=udp" / "turns:host" / "host:port" -> "host:port". */
    private static String turnHostPort(String value) {
        String v = clean(value);
        if (v.isEmpty()) return "";
        int scheme = v.indexOf(':');
        String lower = v.toLowerCase(Locale.ROOT);
        if (lower.startsWith("turn:") || lower.startsWith("turns:") || lower.startsWith("stun:") || lower.startsWith("stuns:")) {
            v = v.substring(scheme + 1);
        }
        int query = v.indexOf('?');
        if (query >= 0) v = v.substring(0, query);
        return v.trim();
    }

    private String firebaseSenderId() {
        Resources resources = context.getResources();
        int id = resources.getIdentifier("gcm_defaultSenderId", "string", context.getPackageName());
        if (id == 0) return "";
        try {
            return clean(resources.getString(id));
        } catch (Resources.NotFoundException error) {
            return "";
        }
    }

    private void requireConfigured() {
        if (core == null || (!configured && core.getDefaultAccount() == null)) {
            throw new IllegalStateException("SkyeVox native engine is not configured.");
        }
    }

    private static void check(int status, String action) {
        if (status != 0) {
            throw new IllegalStateException("liblinphone " + action + " failed (" + status + ")");
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    /** Runs work on the main looper (liblinphone's thread) and waits for the result. */
    private <T> T runOnMain(Callable<T> work) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try {
                return work.call();
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<T> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        mainHandler.post(() -> {
            try {
                result.set(work.call());
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                latch.countDown();
            }
        });
        try {
            if (!latch.await(MAIN_THREAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new IllegalStateException("Timed out waiting for the SIP engine.");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted waiting for the SIP engine.", error);
        }
        Throwable error = failure.get();
        if (error instanceof RuntimeException) throw (RuntimeException) error;
        if (error != null) throw new IllegalStateException(error);
        return result.get();
    }
}
