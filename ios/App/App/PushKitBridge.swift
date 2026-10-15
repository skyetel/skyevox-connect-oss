import Foundation
import PushKit

/// PushKit twin of `android/.../SkyeVoxMessagingService.java`.
///
/// Owns the VoIP `PKPushRegistry`: the token is handed to `LinphoneEngine` for the RFC 8599
/// pn-prid Contact param (and surfaced to JS as `pushTokenChanged`), and every VoIP push wakes the
/// engine and is reported to CallKit before the handler returns, as iOS 13+ requires.
///
/// Flexisip's VoIP payload carries `call-id`, `from-uri` and `display-name` at the top level
/// (older gateways nest them under `aps`); the SkyeVox push webhook uses the same keys as the
/// Android data message (`call-id`/`callId`/`call_id`, `from`, `callerName`).
final class PushKitBridge: NSObject, PKPushRegistryDelegate {
    static let shared = PushKitBridge()

    private var registry: PKPushRegistry?

    private override init() {
        super.init()
    }

    func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
        if let token = registry.pushToken(for: .voIP) {
            LinphoneEngine.shared.updatePushToken(PushKitBridge.hex(token))
        }
    }

    // MARK: - PKPushRegistryDelegate

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        LinphoneEngine.shared.updatePushToken(PushKitBridge.hex(pushCredentials.token))
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        LinphoneEngine.shared.updatePushToken("")
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else {
            completion()
            return
        }
        let data = payload.dictionaryPayload
        let aps = data["aps"] as? [AnyHashable: Any] ?? [:]
        let alert = aps["alert"] as? [AnyHashable: Any] ?? [:]

        let callId = PushKitBridge.first(data, aps, alert, keys: ["call-id", "callId", "call_id"])
        let fromUri = PushKitBridge.first(data, aps, alert, keys: ["from-uri", "from", "caller"])
        var remoteName = PushKitBridge.first(data, aps, alert, keys: ["display-name", "callerName", "caller-name"])
        if remoteName.isEmpty, let args = alert["loc-args"] as? [Any], let firstArg = args.first as? String {
            remoteName = firstArg
        }
        let remoteNumber = PushKitBridge.username(of: fromUri)
        NSLog("[SkyeVoxPushKit] VoIP push for Call-ID [%@] from [%@]", callId, remoteNumber)

        let engine = LinphoneEngine.shared
        engine.onPushWake(callId: callId)
        let placeholderId = callId.isEmpty ? "push-\(UUID().uuidString)" : callId
        // Every VoIP push must reach CallKit before this handler returns or iOS terminates the app.
        CallKitBridge.shared.reportPushIncoming(callId: placeholderId, remoteNumber: remoteNumber, remoteName: remoteName, completion: completion)
    }

    // MARK: - Helpers

    private static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    private static func first(_ dicts: [AnyHashable: Any]..., keys: [String]) -> String {
        for dict in dicts {
            for key in keys {
                if let value = dict[key] as? String {
                    let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !cleaned.isEmpty { return cleaned }
                } else if let value = dict[key] as? NSNumber {
                    return value.stringValue
                }
            }
        }
        return ""
    }

    /// "sip:+15551234567@domain;user=phone" / "+15551234567" -> "+15551234567".
    private static func username(of uri: String) -> String {
        var value = uri.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("<"), let close = value.firstIndex(of: ">") {
            value = String(value[value.index(after: value.startIndex)..<close])
        }
        for scheme in ["sips:", "sip:", "tel:"] where value.lowercased().hasPrefix(scheme) {
            value = String(value.dropFirst(scheme.count))
            break
        }
        if let at = value.firstIndex(of: "@") {
            value = String(value[..<at])
        }
        if let semicolon = value.firstIndex(of: ";") {
            value = String(value[..<semicolon])
        }
        return value
    }
}
