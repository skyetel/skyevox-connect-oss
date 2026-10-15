import Foundation
import Capacitor
import UIKit

/// Capacitor bridge over `LinphoneEngine` + `CallKitBridge`; iOS twin of
/// `android/.../SkyeVoxNativePlugin.java`. Contract: `src/native/SkyeVoxNative.ts`.
///
/// Capacitor invokes plugin methods off the main thread; liblinphone and CallKit are main-queue
/// only, so every method hops to the main queue and resolves from there. The plugin is registered
/// by `SkyeVoxBridgeViewController.capacitorDidLoad` (Capacitor 6 only auto-registers npm plugins
/// listed in capacitor.config.json's packageClassList).
@objc(SkyeVoxNativePlugin)
public class SkyeVoxNativePlugin: CAPPlugin, CAPBridgedPlugin, LinphoneEngineListener {
    public let identifier = "SkyeVoxNativePlugin"
    public let jsName = "SkyeVoxNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "answer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reject", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hangup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hold", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unhold", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendDtmf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transfer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDefaultCallingStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openDefaultCallingSettings", returnType: CAPPluginReturnPromise)
    ]

    private let engine = LinphoneEngine.shared
    private let callKit = CallKitBridge.shared

    public override func load() {
        engine.listener = self
    }

    // MARK: - Configuration / registration

    @objc func configure(_ call: CAPPluginCall) {
        guard let config = call.getObject("config") else {
            call.reject("Missing SIP config.")
            return
        }
        onMain(call) { try self.engine.configure(config) }
    }

    @objc func register(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try self.engine.register()
                call.resolve(["state": "registering"])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func unregister(_ call: CAPPluginCall) {
        onMain(call) { self.engine.unregister() }
    }

    // MARK: - Calls

    @objc func call(_ call: CAPPluginCall) {
        let destination = call.getString("destination") ?? call.getString("target") ?? ""
        let displayName = call.getString("displayName") ?? ""
        DispatchQueue.main.async {
            self.callKit.startCall(destination: destination, displayName: displayName) { result in
                switch result {
                case .success(let callId):
                    call.resolve(["callId": callId])
                case .failure(let error):
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    @objc func answer(_ call: CAPPluginCall) {
        guard let callId = requiredCallId(call) else { return }
        DispatchQueue.main.async {
            self.callKit.answer(callId: callId) { error in self.finish(call, error) }
        }
    }

    @objc func reject(_ call: CAPPluginCall) {
        guard let callId = requiredCallId(call) else { return }
        DispatchQueue.main.async {
            self.callKit.end(callId: callId) { error in self.finish(call, error) }
        }
    }

    @objc func hangup(_ call: CAPPluginCall) {
        guard let callId = requiredCallId(call) else { return }
        DispatchQueue.main.async {
            guard self.engine.findCall(callId) != nil else {
                // Android's hangup is a no-op for unknown calls.
                call.resolve()
                return
            }
            self.callKit.end(callId: callId) { error in self.finish(call, error) }
        }
    }

    @objc func hold(_ call: CAPPluginCall) {
        guard let callId = requiredCallId(call) else { return }
        DispatchQueue.main.async {
            self.callKit.setHeld(callId: callId, onHold: true) { error in self.finish(call, error) }
        }
    }

    @objc func unhold(_ call: CAPPluginCall) {
        guard let callId = requiredCallId(call) else { return }
        DispatchQueue.main.async {
            self.callKit.setHeld(callId: callId, onHold: false) { error in self.finish(call, error) }
        }
    }

    @objc func mute(_ call: CAPPluginCall) {
        let callId = call.getString("callId") ?? ""
        let muted = call.getBool("muted") ?? false
        DispatchQueue.main.async {
            self.callKit.setMuted(callId: callId, muted: muted) { error in self.finish(call, error) }
        }
    }

    @objc func sendDtmf(_ call: CAPPluginCall) {
        guard let callId = requiredCallId(call) else { return }
        let digit = call.getString("digit") ?? ""
        onMain(call) { try self.engine.sendDtmf(callId, digit: digit) }
    }

    @objc func transfer(_ call: CAPPluginCall) {
        guard let callId = requiredCallId(call) else { return }
        let destination = call.getString("destination") ?? ""
        let attended = call.getBool("attended") ?? false
        onMain(call) { try self.engine.transfer(callId, destination: destination, attended: attended) }
    }

    // MARK: - Default calling (FR-16: iOS 18.2 default dialer needs the LiveCommunicationKit entitlement)

    @objc func getDefaultCallingStatus(_ call: CAPPluginCall) {
        call.resolve([
            "supported": false,
            "eligible": false,
            "enabled": false,
            "reason": "Default calling entitlement pending"
        ])
    }

    @objc func openDefaultCallingSettings(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.resolve()
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { _ in
                call.resolve()
            }
        }
    }

    // MARK: - LinphoneEngineListener

    func engineRegistrationChanged(state: String, accountId: String, error: String) {
        var payload: [String: Any] = ["state": state]
        if !accountId.isEmpty { payload["accountId"] = accountId }
        if !error.isEmpty { payload["error"] = error }
        notifyListeners("registrationChanged", data: payload, retainUntilConsumed: true)
    }

    func engineCallChanged(callId: String, state: String, direction: String, remoteNumber: String, remoteName: String, error: String) {
        var payload: [String: Any] = ["callId": callId, "state": state]
        if !direction.isEmpty { payload["direction"] = direction }
        if !remoteNumber.isEmpty { payload["remoteNumber"] = remoteNumber }
        if !remoteName.isEmpty { payload["remoteName"] = remoteName }
        if !error.isEmpty { payload["error"] = error }
        notifyListeners("callChanged", data: payload, retainUntilConsumed: true)
    }

    func enginePushTokenChanged(token: String) {
        notifyListeners("pushTokenChanged", data: [
            "platform": "ios",
            "token": token,
            "bundleId": Bundle.main.bundleIdentifier ?? "com.skyetel.skyevoxconnect"
        ], retainUntilConsumed: true)
    }

    // MARK: - Helpers

    private func requiredCallId(_ call: CAPPluginCall) -> String? {
        let callId = (call.getString("callId") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if callId.isEmpty {
            call.reject("Missing callId.")
            return nil
        }
        return callId
    }

    private func onMain(_ call: CAPPluginCall, _ work: @escaping () throws -> Void) {
        DispatchQueue.main.async {
            do {
                try work()
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    private func finish(_ call: CAPPluginCall, _ error: Error?) {
        if let error = error {
            call.reject(error.localizedDescription)
        } else {
            call.resolve()
        }
    }
}
