import Foundation
import UIKit
import linphonesw

/// Events surfaced to the Capacitor plugin. State strings match `src/native/SkyeVoxNative.ts`.
protocol LinphoneEngineListener: AnyObject {
    func engineRegistrationChanged(state: String, accountId: String, error: String)
    func engineCallChanged(callId: String, state: String, direction: String, remoteNumber: String, remoteName: String, error: String)
    func enginePushTokenChanged(token: String)
}

struct EngineError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// liblinphone-backed SIP engine behind the `SkyeVoxNative` Capacitor plugin; the iOS twin of
/// `android/.../LinphoneEngine.java`.
///
/// One `Core` per process, created lazily on the main thread by `configure` and by the PushKit
/// wake path, and released by `unregister` so the WebView owns the audio session whenever the
/// SIP.js engine is in use. Account, auth and push parameters are persisted by liblinphone in
/// the app-private rc file, so a process started by a VoIP push re-registers with the last
/// provisioned identity before any JS exists.
///
/// liblinphone is not thread-safe: every method here must run on the main queue.
final class LinphoneEngine {
    static let shared = LinphoneEngine()

    private static let tag = "SkyeVoxLinphone"
    private static let caBundleResource = "skyevox-ca-bundle"
    private static let rcFile = "skyevox-linphonerc"
    private static let defaultBundleId = "com.skyetel.skyevoxconnect"
    /// Provisioning mobile.pushRegisterExpiresSeconds default; see applyPushParams.
    private static let defaultPushRegisterExpires = 86400
    private static let minPushRegisterExpires = 600
    private static let preferredCodecs = ["opus", "PCMU", "PCMA"]
    /// Belledonne's APNs provider names: "apns.dev" for the sandbox gateway, "apns" for production.
    #if DEBUG
    private static let pushProvider = "apns.dev"
    #else
    private static let pushProvider = "apns"
    #endif

    weak var listener: LinphoneEngineListener?

    private var core: Core?
    private var coreDelegate: CoreDelegateStub?
    private var configured = false
    private var registerRequested = false
    private var pushToken = ""
    private var pushParam = ""
    private var pushTeamId = ""
    private var pushEnabled = true
    private var registerInterval = 120
    private var pushRegisterExpires = defaultPushRegisterExpires

    private init() {}

    var isConfigured: Bool {
        configured || core?.defaultAccount != nil
    }

    // MARK: - Configuration

    func configure(_ config: [String: Any]) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let core = try ensureCore()
        try applyConfig(config, core: core)
    }

    private func applyConfig(_ config: [String: Any], core: Core) throws {
        let mobile = config["mobile"] as? [String: Any]
        var sipServer = string(config, "sipServer")
        var sipDomain = string(config, "sipDomain")
        if sipDomain.isEmpty { sipDomain = sipServer }
        if sipServer.isEmpty { sipServer = sipDomain }
        let username = string(config, "username")
        let password = (config["password"] as? String) ?? ""
        var displayName = string(config, "displayName")
        if displayName.isEmpty { displayName = username }
        registerInterval = max(60, int(config, "registerInterval") ?? 120)

        if sipDomain.isEmpty || username.isEmpty {
            throw EngineError("SIP config requires sipDomain/sipServer and username.")
        }

        var transport = string(config, "sipTransport")
        var srtp = string(config, "srtp")
        pushEnabled = true
        pushRegisterExpires = LinphoneEngine.defaultPushRegisterExpires
        pushTeamId = ""
        var bundleId = LinphoneEngine.defaultBundleId
        if let mobile = mobile {
            if transport.isEmpty { transport = string(mobile, "transport") }
            let mobileSrtp = string(mobile, "srtp")
            if !mobileSrtp.isEmpty { srtp = mobileSrtp }
            pushEnabled = bool(mobile, "pushEnabled") ?? true
            pushRegisterExpires = max(LinphoneEngine.minPushRegisterExpires,
                                      int(mobile, "pushRegisterExpiresSeconds") ?? LinphoneEngine.defaultPushRegisterExpires)
            let mobileBundle = string(mobile, "pushBundleId")
            if !mobileBundle.isEmpty { bundleId = mobileBundle }
            pushTeamId = string(mobile, "pushTeamId")
            let param = string(mobile, "pushParam")
            if !param.isEmpty { pushParam = param }
        }
        if transport.isEmpty { transport = "tls" }

        // JS may hand a PushKit token back through configure (pushProvider 'apns-voip'); the token
        // PushKit delivered to this process wins because it is the only one APNs will accept.
        let token = string(config, "pushToken")
        let provider = string(config, "pushProvider").lowercased()
        if pushToken.isEmpty && !token.isEmpty && (provider.isEmpty || provider == "apns-voip" || provider == "apns") {
            pushToken = token
        }

        let srtpMandatory = srtp.caseInsensitiveCompare("mandatory") == .orderedSame
        try core.setMediaencryption(newValue: .SRTP)
        core.mediaEncryptionMandatory = srtpMandatory

        try applyNatPolicy(config, core: core)

        let transportType = LinphoneEngine.transportType(transport)
        guard let identity = core.interpretUrl(url: "sip:\(username)@\(sipDomain)", applyInternationalPrefix: false) else {
            throw EngineError("Invalid SIP identity for \(username)@\(sipDomain)")
        }
        try identity.setDisplayname(newValue: displayName)

        guard let server = core.interpretUrl(url: "sip:\(sipServer)", applyInternationalPrefix: false) else {
            throw EngineError("Invalid SIP server \(sipServer)")
        }
        try server.setTransport(newValue: transportType)

        core.clearAllAuthInfo()
        let authInfo = try Factory.Instance.createAuthInfo(username: username, userid: nil, passwd: password, ha1: nil, realm: nil, domain: sipDomain)
        core.addAuthInfo(info: authInfo)
        try addTurnAuthInfo(config, core: core)

        let existing = core.defaultAccount
        let params = try existing?.params?.clone() ?? core.createAccountParams()
        try params.setIdentityaddress(newValue: identity)
        try params.setServeraddress(newValue: server)
        params.outboundProxyEnabled = true
        params.transport = transportType
        params.avpfMode = .Disabled
        params.publishEnabled = false
        params.unregisterAtStopEnabled = false
        params.registerEnabled = existing?.params?.registerEnabled ?? registerRequested
        let pushReady = applyPushParams(params, bundleId: bundleId)

        if let account = existing {
            account.params = params
        } else {
            let account = try core.createAccount(params: params)
            try core.addAccount(account: account)
            core.defaultAccount = account
        }

        configured = true
        log("Configured account \(identity.asStringUriOnly()) via \(server.asStringUriOnly()) srtp=\(srtpMandatory ? "mandatory" : "opportunistic") push=\(pushReady) expires=\(params.expires)")
    }

    /// Applies the RFC 8599 pn-* Contact params and the matching REGISTER expiry. Flexisip never
    /// pushes for an expired binding, so a push-capable contact must outlive any suspend: it
    /// registers with the long provisioning expiry (mobile.pushRegisterExpiresSeconds) and lets a
    /// dead TLS connection, not expiry, trigger the push. A Contact without pn-* params keeps the
    /// short registerInterval refresh. Returns whether the Contact carries push params.
    ///
    /// pn-param for APNs is `<TeamID>.<BundleID>.voip`; mobile.pushParam overrides it verbatim.
    @discardableResult
    private func applyPushParams(_ params: AccountParams, bundleId: String) -> Bool {
        let param = pushParam.isEmpty ? (pushTeamId.isEmpty ? "" : "\(pushTeamId).\(bundleId).voip") : pushParam
        let ready = pushEnabled && !pushToken.isEmpty && !param.isEmpty
        params.pushNotificationAllowed = ready
        params.remotePushNotificationAllowed = false
        params.expires = ready ? pushRegisterExpires : registerInterval
        guard ready else {
            params.contactUriParameters = ""
            if pushEnabled && pushToken.isEmpty {
                log("Push enabled but no PushKit token yet; Contact will not carry pn-* params until a token arrives.")
            } else if pushEnabled && param.isEmpty {
                log("Push enabled but mobile.pushTeamId/pushParam missing; Contact will not carry pn-* params.")
            }
            return false
        }
        guard let push = params.pushNotificationConfig else { return false }
        push.provider = LinphoneEngine.pushProvider
        push.prid = pushToken
        push.param = param
        push.bundleIdentifier = bundleId
        push.teamId = pushTeamId
        push.voipToken = pushToken
        // Core-level push is deliberately disabled (PushKitBridge owns the token), which
        // also stops liblinphone from decorating the Contact. The registrar keys the wake
        // path on these RFC 8599 params, so write them onto the Contact URI directly.
        params.contactUriParameters = "pn-provider=\(LinphoneEngine.pushProvider);pn-prid=\(pushToken);pn-param=\(param)"
        return true
    }

    private func applyNatPolicy(_ config: [String: Any], core: Core) throws {
        let turnServer = string(config, "turnServer")
        let creds = config["turnCredentials"] as? [String: Any]
        let turnUser = creds.map { string($0, "username") } ?? ""

        let policy = try core.createNatPolicy()
        policy.iceEnabled = true
        let hostPort = LinphoneEngine.turnHostPort(turnServer)
        if !hostPort.isEmpty {
            policy.stunEnabled = true
            policy.stunServer = hostPort
            let turn = !turnUser.isEmpty
            policy.turnEnabled = turn
            if turn {
                policy.stunServerUsername = turnUser
                policy.udpTurnTransportEnabled = true
                policy.tcpTurnTransportEnabled = true
            }
        }
        core.natPolicy = policy
    }

    private func addTurnAuthInfo(_ config: [String: Any], core: Core) throws {
        guard let creds = config["turnCredentials"] as? [String: Any] else { return }
        let user = string(creds, "username")
        let credential = (creds["credential"] as? String) ?? ""
        if user.isEmpty || credential.isEmpty { return }
        core.addAuthInfo(info: try Factory.Instance.createAuthInfo(username: user, userid: nil, passwd: credential, ha1: nil, realm: nil, domain: nil))
    }

    // MARK: - Registration

    func register() throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let core = try requireConfigured()
        registerRequested = true
        setRegisterEnabled(true, core: core)
        core.refreshRegisters()
        // A call answered from CallKit before the WebView existed (push wake) is otherwise
        // invisible to JS; replay live calls so NativeSipClient can adopt them.
        for call in core.calls {
            notifyCallState(call, state: call.state, message: "")
        }
    }

    /// Disables registration and releases the Core so the audio session returns to the WebView.
    func unregister() {
        dispatchPrecondition(condition: .onQueue(.main))
        registerRequested = false
        guard let core = core else { return }
        if core.defaultAccount != nil {
            setRegisterEnabled(false, core: core)
        }
        releaseCore()
    }

    private func releaseCore() {
        guard let core = core else { return }
        if let delegate = coreDelegate {
            core.removeDelegate(delegate: delegate)
        }
        core.stop()
        self.core = nil
        coreDelegate = nil
        configured = false
        log("liblinphone core released")
    }

    private func setRegisterEnabled(_ enabled: Bool, core: Core) {
        guard let account = core.defaultAccount, let params = account.params?.clone() else { return }
        params.registerEnabled = enabled
        account.params = params
    }

    /// Called from the PushKit path. Ensures the Core is running, tells liblinphone which call the
    /// push announces, and forces a REGISTER refresh so the gateway can late-fork the held INVITE.
    func onPushWake(callId: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        do {
            let core = try ensureCore()
            guard core.defaultAccount != nil else {
                log("Push wake with no persisted account; ignoring.")
                return
            }
            setRegisterEnabled(true, core: core)
            registerRequested = true
            core.refreshRegisters()
            core.processPushNotification(callId: callId.isEmpty ? nil : callId)
        } catch {
            log("Push wake failed: \(error.localizedDescription)")
        }
    }

    /// PushKit token (hex). An empty token means PushKit invalidated it: the Contact drops its pn-* params.
    func updatePushToken(_ token: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        let cleaned = token.trimmingCharacters(in: .whitespacesAndNewlines)
        pushToken = cleaned
        if let core = core, let account = core.defaultAccount, let params = account.params?.clone() {
            let bundleId = params.pushNotificationConfig?.bundleIdentifier ?? ""
            applyPushParams(params, bundleId: bundleId.isEmpty ? LinphoneEngine.defaultBundleId : bundleId)
            account.params = params
            if params.registerEnabled {
                core.refreshRegisters()
            }
        }
        if !cleaned.isEmpty {
            listener?.enginePushTokenChanged(token: cleaned)
        }
    }

    // MARK: - Calls

    /// Places the INVITE. CallKit's CXStartCallAction drives this through `CallKitBridge`.
    func call(_ destination: String) throws -> String {
        dispatchPrecondition(condition: .onQueue(.main))
        let target = clean(destination)
        if target.isEmpty { throw EngineError("Missing destination.") }
        let core = try requireConfigured()
        guard let address = core.interpretUrl(url: target, applyInternationalPrefix: true) else {
            throw EngineError("Cannot dial \(target)")
        }
        let params = try core.createCallParams(call: nil)
        params.videoEnabled = false
        params.audioEnabled = true
        core.configureAudioSession()
        guard let call = core.inviteAddressWithParams(addr: address, params: params) else {
            throw EngineError("liblinphone refused to start the call.")
        }
        return LinphoneEngine.callId(of: call)
    }

    func answer(_ callId: String) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let call = try requireCall(callId)
        guard let core = core else { throw EngineError("SkyeVox native engine is not configured.") }
        let params = try core.createCallParams(call: call)
        params.videoEnabled = false
        params.audioEnabled = true
        core.configureAudioSession()
        try check({ try call.acceptWithParams(params: params) }, "answer")
    }

    func reject(_ callId: String) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let call = try requireCall(callId)
        if LinphoneEngine.isIncoming(call.state) {
            try check({ try call.decline(reason: .Declined) }, "reject")
        } else {
            try check({ try call.terminate() }, "reject")
        }
    }

    func decline(_ callId: String, reason: Reason) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let call = findCall(callId) else { return }
        try? call.decline(reason: reason)
    }

    func hangup(_ callId: String) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let call = findCall(callId) else { return }
        try check({ try call.terminate() }, "hangup")
    }

    func terminateAll() {
        dispatchPrecondition(condition: .onQueue(.main))
        try? core?.terminateAllCalls()
    }

    func hold(_ callId: String) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let call = try requireCall(callId)
        try check({ try call.pause() }, "hold")
    }

    func unhold(_ callId: String) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let call = try requireCall(callId)
        try check({ try call.resume() }, "unhold")
    }

    func mute(_ callId: String, muted: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        if let call = findCall(callId) {
            call.microphoneMuted = muted
        } else if let core = core {
            core.micEnabled = !muted
        }
    }

    func sendDtmf(_ callId: String, digit: String) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let cleaned = clean(digit)
        if cleaned.isEmpty { return }
        let call = try requireCall(callId)
        try check({ try call.sendDtmfs(dtmfs: cleaned) }, "sendDtmf")
    }

    func transfer(_ callId: String, destination: String, attended: Bool) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let target = clean(destination)
        let call = try requireCall(callId)
        if attended {
            var other = target.isEmpty ? otherCall(than: call) : findCall(target)
            if other == nil { other = otherCall(than: call) }
            guard let dest = other else {
                throw EngineError("Attended transfer needs a second active call.")
            }
            try check({ try call.transferToAnother(dest: dest) }, "transfer")
            return
        }
        if target.isEmpty { throw EngineError("Missing transfer destination.") }
        guard let core = core, let address = core.interpretUrl(url: target, applyInternationalPrefix: true) else {
            throw EngineError("Cannot transfer to \(target)")
        }
        try check({ try call.transferTo(referTo: address) }, "transfer")
    }

    /// CallKit audio session handshake (`core.callkitEnabled`): the provider's didActivate /
    /// didDeactivate callbacks own the AVAudioSession; liblinphone must not start audio before.
    func audioSessionActivated(_ activated: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        core?.activateAudioSession(activated: activated)
    }

    /// Call currently known to the Core for the given id, or nil. Main thread only.
    func findCall(_ callId: String) -> Call? {
        let id = clean(callId)
        guard !id.isEmpty, let core = core else { return nil }
        if let call = core.getCallByCallid(callId: id) { return call }
        return core.calls.first { LinphoneEngine.callId(of: $0) == id }
    }

    private func requireCall(_ callId: String) throws -> Call {
        guard let call = findCall(callId) else { throw EngineError("Unknown call \(callId)") }
        return call
    }

    private func otherCall(than call: Call) -> Call? {
        core?.calls.first { candidate in
            candidate.getCobject != call.getCobject
                && candidate.state != .End && candidate.state != .Released
        }
    }

    // MARK: - Core lifecycle

    private func ensureCore() throws -> Core {
        if let core = core { return core }
        let created = try createCore()
        core = created
        return created
    }

    private func createCore() throws -> Core {
        let factory = Factory.Instance
        #if DEBUG
        LoggingService.Instance.logLevel = LogLevel.Message
        #else
        LoggingService.Instance.logLevel = LogLevel.Warning
        #endif
        let rc = (factory.getConfigDir(context: nil) as NSString).appendingPathComponent(LinphoneEngine.rcFile)
        let created = try factory.createCore(configPath: rc, factoryConfigPath: nil, systemContext: nil)

        created.setUserAgent(name: "SkyeVoxConnect", version: LinphoneEngine.appVersion())
        created.autoIterateEnabled = true
        created.keepAliveEnabled = true
        created.ipv6Enabled = true
        // PushKitBridge owns the PKPushRegistry and hands the VoIP token to applyPushParams, the same
        // manual pn-* path Android uses; letting liblinphone register its own PushKit delegate would
        // deliver every VoIP push twice.
        created.pushNotificationEnabled = false
        // CallKitBridge owns the CXProvider; liblinphone defers audio start to activateAudioSession.
        created.callkitEnabled = true
        created.videoCaptureEnabled = false
        created.videoDisplayEnabled = false
        created.echoCancellationEnabled = true
        created.nativeRingingEnabled = false

        let caBundle = try LinphoneEngine.caBundlePath()
        created.rootCa = caBundle
        created.verifyServerCertificates(yesno: true)
        created.verifyServerCn(yesno: true)

        LinphoneEngine.applyCodecPolicy(created)

        let delegate = CoreDelegateStub(
            onCallStateChanged: { [weak self] _, call, state, message in
                self?.notifyCallState(call, state: state, message: message)
            },
            onCallIdUpdated: { _, previousCallId, currentCallId in
                CallKitBridge.shared.callIdUpdated(previous: previousCallId, current: currentCallId)
            },
            onAccountRegistrationStateChanged: { [weak self] _, account, state, message in
                self?.notifyRegistrationState(account, state: state, message: message)
            }
        )
        created.addDelegate(delegate: delegate)
        coreDelegate = delegate
        try created.start()
        log("liblinphone core started, rc=\(rc), rootca=\(caBundle)")
        return created
    }

    private static func applyCodecPolicy(_ core: Core) {
        for type in core.audioPayloadTypes {
            let keep = preferredCodecs.contains { $0.caseInsensitiveCompare(type.mimeType) == .orderedSame }
            _ = type.enable(enabled: keep)
        }
    }

    /// The bundled Mozilla root store (same file as android/app/src/main/assets); liblinphone
    /// reads it in place from the app bundle.
    private static func caBundlePath() throws -> String {
        guard let path = Bundle.main.path(forResource: caBundleResource, ofType: "pem") else {
            throw EngineError("Cannot find CA bundle \(caBundleResource).pem in the app bundle")
        }
        return path
    }

    // MARK: - Core events

    private func notifyRegistrationState(_ account: Account, state: RegistrationState, message: String) {
        let mapped: String
        switch state {
        case .Progress, .Refreshing: mapped = "registering"
        case .Ok: mapped = "registered"
        case .Cleared: mapped = "unregistered"
        case .Failed: mapped = "failed"
        case .None: mapped = "idle"
        }
        let accountId = clean(account.params?.identityAddress?.asStringUriOnly() ?? "")
        let error = state == .Failed ? LinphoneEngine.describe(account.errorInfo, fallback: message) : ""
        log("Registration \(state) for \(accountId)\(error.isEmpty ? "" : ": \(error)")")
        listener?.engineRegistrationChanged(state: mapped, accountId: accountId, error: error)
    }

    private func notifyCallState(_ call: Call, state: Call.State, message: String) {
        guard let mapped = LinphoneEngine.mapCallState(state) else { return }
        let callId = LinphoneEngine.callId(of: call)
        let direction = call.dir == .Incoming ? "inbound" : "outbound"
        let remote = call.remoteAddress
        let remoteNumber = clean(remote?.username ?? "")
        let remoteName = clean(remote?.displayName ?? "")
        let error = state == .Error ? LinphoneEngine.describe(call.errorInfo, fallback: message) : ""

        log("Call \(callId) \(state) -> \(mapped)")
        CallKitBridge.shared.coreCallChanged(callId: callId, state: state, direction: direction,
                                             remoteNumber: remoteNumber, remoteName: remoteName,
                                             reason: call.errorInfo?.reason ?? .None)
        listener?.engineCallChanged(callId: callId, state: mapped, direction: direction,
                                    remoteNumber: remoteNumber, remoteName: remoteName, error: error)
    }

    // MARK: - Helpers

    static func mapCallState(_ state: Call.State) -> String? {
        switch state {
        case .IncomingReceived, .PushIncomingReceived, .IncomingEarlyMedia:
            return "incoming"
        case .OutgoingInit, .OutgoingProgress:
            return "dialing"
        case .OutgoingRinging, .OutgoingEarlyMedia:
            return "ringing"
        case .Connected, .StreamsRunning, .Resuming, .Updating, .UpdatedByRemote, .EarlyUpdating, .EarlyUpdatedByRemote:
            return "active"
        case .Pausing, .Paused, .PausedByRemote:
            return "held"
        case .Error:
            return "failed"
        case .End:
            return "ended"
        case .Idle:
            return "idle"
        case .Referred, .Released:
            return nil
        }
    }

    static func isIncoming(_ state: Call.State) -> Bool {
        state == .IncomingReceived || state == .IncomingEarlyMedia || state == .PushIncomingReceived
    }

    static func callId(of call: Call) -> String {
        let id = (call.callLog?.callId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !id.isEmpty { return id }
        let pointer = UInt(bitPattern: call.getCobject)
        return "lp-" + String(pointer, radix: 16)
    }

    private static func describe(_ info: ErrorInfo?, fallback: String) -> String {
        guard let info = info else { return fallback.trimmingCharacters(in: .whitespacesAndNewlines) }
        let phrase = (info.phrase ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let code = info.protocolCode
        if code > 0 {
            return phrase.isEmpty ? "\(code)" : "\(code) \(phrase)"
        }
        if !phrase.isEmpty { return phrase }
        return info.reason != .None ? "\(info.reason)" : fallback.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func appVersion() -> String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "unknown"
    }

    private static func transportType(_ transport: String) -> TransportType {
        switch transport.lowercased() {
        case "udp": return .Udp
        case "tcp": return .Tcp
        default: return .Tls
        }
    }

    /// "turn:host:3478?transport=udp" / "turns:host" / "host:port" -> "host:port".
    private static func turnHostPort(_ value: String) -> String {
        var v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { return "" }
        let lower = v.lowercased()
        for scheme in ["turns:", "turn:", "stuns:", "stun:"] where lower.hasPrefix(scheme) {
            v = String(v.dropFirst(scheme.count))
            break
        }
        if let query = v.firstIndex(of: "?") {
            v = String(v[..<query])
        }
        return v.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func requireConfigured() throws -> Core {
        guard let core = core, configured || core.defaultAccount != nil else {
            throw EngineError("SkyeVox native engine is not configured.")
        }
        return core
    }

    private func check(_ work: () throws -> Void, _ action: String) throws {
        do {
            try work()
        } catch {
            throw EngineError("liblinphone \(action) failed (\(error))")
        }
    }

    private func clean(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func string(_ dict: [String: Any], _ key: String) -> String {
        guard let raw = dict[key] else { return "" }
        if let s = raw as? String { return clean(s) }
        if let n = raw as? NSNumber { return n.stringValue }
        return ""
    }

    private func int(_ dict: [String: Any], _ key: String) -> Int? {
        if let n = dict[key] as? NSNumber { return n.intValue }
        if let s = dict[key] as? String { return Int(s.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    private func bool(_ dict: [String: Any], _ key: String) -> Bool? {
        if let b = dict[key] as? Bool { return b }
        if let n = dict[key] as? NSNumber { return n.boolValue }
        return nil
    }

    private func log(_ message: String) {
        NSLog("[%@] %@", LinphoneEngine.tag, message)
    }
}
