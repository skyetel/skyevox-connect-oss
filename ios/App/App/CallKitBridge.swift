import Foundation
import AVFoundation
import CallKit
import linphonesw

/// CallKit twin of `android/.../TelecomBridge.java` + `SkyeVoxTelecomConnection`.
///
/// Every liblinphone call is mirrored as a CXProvider call: inbound calls are reported (from the
/// PushKit payload first, then updated from the INVITE), outbound calls start through a
/// CXStartCallAction, and JS-initiated answer/end/hold/mute go through CXCallController
/// transactions so the system UI, lock screen and Bluetooth controls stay coherent. The
/// provider delegate applies each action to the `LinphoneEngine`, which owns the Core; the
/// engine reports Core state back through `coreCallChanged`.
///
/// Main queue only (same rule as the engine).
final class CallKitBridge: NSObject, CXProviderDelegate {
    static let shared = CallKitBridge()

    /// How long a push-announced call may wait for its INVITE before CallKit shows it as missed.
    private static let inviteTimeout: TimeInterval = 30

    private final class TrackedCall {
        let uuid: UUID
        var callId: String
        let outbound: Bool
        var connectingReported = false
        var connected = false
        var endedLocally = false
        var inviteTimer: DispatchWorkItem?

        init(uuid: UUID, callId: String, outbound: Bool) {
            self.uuid = uuid
            self.callId = callId
            self.outbound = outbound
        }
    }

    private let provider: CXProvider
    private let controller = CXCallController(queue: .main)
    private let engine = LinphoneEngine.shared
    private var calls: [UUID: TrackedCall] = [:]
    private var pendingStarts: [UUID: (destination: String, completion: (Result<String, Error>) -> Void)] = [:]
    /// Answer tapped on the CallKit UI before the INVITE arrived (push placeholder).
    private var pendingAnswer: String?

    private override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 2
        configuration.supportedHandleTypes = [.phoneNumber, .generic]
        configuration.includesCallsInRecents = true
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    /// Creates the provider early so CallKit is ready before the first push arrives.
    func start() {}

    // MARK: - Reporting from the engine / push path

    /// Reports (or updates) an inbound call. Safe to call twice for the same call id: the push
    /// placeholder is updated in place once the INVITE reveals the real caller.
    func reportIncoming(callId: String, remoteNumber: String, remoteName: String, completion: ((Error?) -> Void)? = nil) {
        dispatchPrecondition(condition: .onQueue(.main))
        let update = CXCallUpdate()
        update.remoteHandle = CallKitBridge.handle(for: remoteNumber)
        update.localizedCallerName = remoteName.isEmpty ? remoteNumber : remoteName
        update.hasVideo = false
        update.supportsHolding = true
        update.supportsDTMF = true
        update.supportsGrouping = false
        update.supportsUngrouping = false

        // A push without a call-id was reported under a synthetic id; the first INVITE claims it.
        let existing = trackedCall(callId: callId)
            ?? calls.values.first { !$0.outbound && $0.callId.hasPrefix("push-") && engine.findCall($0.callId) == nil }
        if let tracked = existing {
            tracked.callId = callId
            provider.reportCall(with: tracked.uuid, updated: update)
            completion?(nil)
            return
        }
        let tracked = TrackedCall(uuid: UUID(), callId: callId, outbound: false)
        calls[tracked.uuid] = tracked
        provider.reportNewIncomingCall(with: tracked.uuid, update: update) { [weak self] error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    NSLog("[SkyeVoxCallKit] reportNewIncomingCall %@ failed: %@", callId, error.localizedDescription)
                    self.calls.removeValue(forKey: tracked.uuid)
                    // CallKit refused (Do Not Disturb, blocked caller): the far end must not ring forever.
                    self.engine.decline(callId, reason: .Busy)
                }
                completion?(error)
            }
        }
    }

    /// Push placeholder: CallKit shows the call now; the INVITE must follow within `inviteTimeout`.
    func reportPushIncoming(callId: String, remoteNumber: String, remoteName: String, completion: @escaping () -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        reportIncoming(callId: callId, remoteNumber: remoteNumber, remoteName: remoteName) { [weak self] _ in
            self?.armInviteTimer(callId: callId)
            completion()
        }
    }

    private func armInviteTimer(callId: String) {
        guard let tracked = trackedCall(callId: callId), engine.findCall(callId) == nil else { return }
        tracked.inviteTimer?.cancel()
        let timer = DispatchWorkItem { [weak self, weak tracked] in
            guard let self = self, let tracked = tracked, self.calls[tracked.uuid] != nil,
                  self.engine.findCall(tracked.callId) == nil else { return }
            NSLog("[SkyeVoxCallKit] no INVITE for pushed call %@; reporting missed", tracked.callId)
            self.provider.reportCall(with: tracked.uuid, endedAt: Date(), reason: .unanswered)
            self.calls.removeValue(forKey: tracked.uuid)
        }
        tracked.inviteTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + CallKitBridge.inviteTimeout, execute: timer)
    }

    /// Mirror of `SkyeVoxTelecomConnection.onEngineCallState`: keeps CallKit in sync with the Core.
    func coreCallChanged(callId: String, state: Call.State, direction: String, remoteNumber: String, remoteName: String, reason: Reason) {
        dispatchPrecondition(condition: .onQueue(.main))
        switch state {
        case .IncomingReceived, .PushIncomingReceived:
            reportIncoming(callId: callId, remoteNumber: remoteNumber, remoteName: remoteName)
            if let tracked = trackedCall(callId: callId) {
                tracked.inviteTimer?.cancel()
                tracked.inviteTimer = nil
            }
            if state == .IncomingReceived, pendingAnswer == callId {
                pendingAnswer = nil
                try? engine.answer(callId)
            }
        case .OutgoingInit:
            // inviteAddressWithParams fires OutgoingInit synchronously, before the start action
            // handler learns the call id: adopt the tracked call it registered with an empty id.
            if trackedCall(callId: callId) == nil {
                if let placed = calls.values.first(where: { $0.outbound && $0.callId.isEmpty }) {
                    placed.callId = callId
                } else {
                    // Placed outside a CXStartCallAction (should not happen); track it so ending works.
                    let tracked = TrackedCall(uuid: UUID(), callId: callId, outbound: true)
                    calls[tracked.uuid] = tracked
                }
            }
        case .OutgoingProgress, .OutgoingRinging, .OutgoingEarlyMedia:
            if let tracked = trackedCall(callId: callId), tracked.outbound, !tracked.connectingReported {
                tracked.connectingReported = true
                provider.reportOutgoingCall(with: tracked.uuid, startedConnectingAt: Date())
            }
        case .Connected, .StreamsRunning:
            if let tracked = trackedCall(callId: callId), !tracked.connected {
                tracked.connected = true
                if tracked.outbound {
                    provider.reportOutgoingCall(with: tracked.uuid, connectedAt: Date())
                }
            }
        case .Error:
            end(callId: callId, reason: CallKitBridge.endReason(for: reason, fallback: .failed))
        case .End:
            if let tracked = trackedCall(callId: callId) {
                let endedReason: CXCallEndedReason = tracked.connected || tracked.outbound
                    ? CallKitBridge.endReason(for: reason, fallback: .remoteEnded)
                    : .unanswered
                end(callId: callId, reason: endedReason)
            }
        case .Released:
            if let tracked = trackedCall(callId: callId) {
                calls.removeValue(forKey: tracked.uuid)
            }
        default:
            break
        }
    }

    func callIdUpdated(previous: String, current: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let tracked = trackedCall(callId: previous) else { return }
        tracked.callId = current
    }

    private func end(callId: String, reason: CXCallEndedReason) {
        guard let tracked = trackedCall(callId: callId) else { return }
        tracked.inviteTimer?.cancel()
        if !tracked.endedLocally {
            provider.reportCall(with: tracked.uuid, endedAt: Date(), reason: reason)
        }
        calls.removeValue(forKey: tracked.uuid)
    }

    // MARK: - Actions requested by JS

    func startCall(destination: String, displayName: String, completion: @escaping (Result<String, Error>) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        let uuid = UUID()
        let action = CXStartCallAction(call: uuid, handle: CallKitBridge.handle(for: destination))
        action.isVideo = false
        action.contactIdentifier = displayName.isEmpty ? nil : displayName
        pendingStarts[uuid] = (destination, completion)
        controller.request(CXTransaction(action: action)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self = self, let error = error, let pending = self.pendingStarts.removeValue(forKey: uuid) else { return }
                NSLog("[SkyeVoxCallKit] CXStartCallAction failed (%@); dialing without CallKit", error.localizedDescription)
                pending.completion(Result { try self.engine.call(pending.destination) })
            }
        }
    }

    func answer(callId: String, completion: @escaping (Error?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let tracked = trackedCall(callId: callId) else {
            completion(Result { try engine.answer(callId) }.thrownError)
            return
        }
        request(CXAnswerCallAction(call: tracked.uuid), fallback: { try self.engine.answer(callId) }, completion: completion)
    }

    /// JS hangup and reject both end the CallKit call; the engine declines still-ringing calls.
    func end(callId: String, completion: @escaping (Error?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let tracked = trackedCall(callId: callId) else {
            completion(Result { try engine.reject(callId) }.thrownError)
            return
        }
        request(CXEndCallAction(call: tracked.uuid), fallback: { try self.engine.reject(callId) }, completion: completion)
    }

    func setHeld(callId: String, onHold: Bool, completion: @escaping (Error?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        let direct: () throws -> Void = {
            if onHold { try self.engine.hold(callId) } else { try self.engine.unhold(callId) }
        }
        guard let tracked = trackedCall(callId: callId) else {
            completion(Result(catching: direct).thrownError)
            return
        }
        request(CXSetHeldCallAction(call: tracked.uuid, onHold: onHold), fallback: direct, completion: completion)
    }

    func setMuted(callId: String, muted: Bool, completion: @escaping (Error?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let tracked = trackedCall(callId: callId) else {
            engine.mute(callId, muted: muted)
            completion(nil)
            return
        }
        request(CXSetMutedCallAction(call: tracked.uuid, muted: muted), fallback: { self.engine.mute(callId, muted: muted) }, completion: completion)
    }

    private func request(_ action: CXAction, fallback: @escaping () throws -> Void, completion: @escaping (Error?) -> Void) {
        controller.request(CXTransaction(action: action)) { error in
            DispatchQueue.main.async {
                guard let error = error else {
                    completion(nil)
                    return
                }
                NSLog("[SkyeVoxCallKit] %@ failed (%@); applying directly", String(describing: type(of: action)), error.localizedDescription)
                completion(Result(catching: fallback).thrownError)
            }
        }
    }

    // MARK: - CXProviderDelegate

    func providerDidReset(_ provider: CXProvider) {
        for tracked in calls.values { tracked.inviteTimer?.cancel() }
        calls.removeAll()
        pendingStarts.removeAll()
        pendingAnswer = nil
        engine.terminateAll()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let pending = pendingStarts.removeValue(forKey: action.callUUID) else {
            action.fail()
            return
        }
        let tracked = TrackedCall(uuid: action.callUUID, callId: "", outbound: true)
        calls[action.callUUID] = tracked
        do {
            let callId = try engine.call(pending.destination)
            tracked.callId = callId
            action.fulfill()
            pending.completion(.success(callId))
        } catch {
            calls.removeValue(forKey: action.callUUID)
            action.fail()
            pending.completion(.failure(error))
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let tracked = calls[action.callUUID] else {
            action.fail()
            return
        }
        if engine.findCall(tracked.callId) == nil {
            // Answered from the lock screen before the INVITE arrived: accept it on arrival.
            pendingAnswer = tracked.callId
            action.fulfill()
            return
        }
        do {
            try engine.answer(tracked.callId)
            action.fulfill()
        } catch {
            action.fail()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard let tracked = calls[action.callUUID] else {
            action.fail()
            return
        }
        tracked.endedLocally = true
        tracked.inviteTimer?.cancel()
        if pendingAnswer == tracked.callId { pendingAnswer = nil }
        if engine.findCall(tracked.callId) == nil {
            // Push placeholder with no INVITE yet: nothing to terminate in the Core.
            calls.removeValue(forKey: tracked.uuid)
            action.fulfill()
            return
        }
        do {
            try engine.reject(tracked.callId)
            action.fulfill()
        } catch {
            action.fail()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        guard let tracked = calls[action.callUUID] else {
            action.fail()
            return
        }
        do {
            if action.isOnHold {
                try engine.hold(tracked.callId)
            } else {
                try engine.unhold(tracked.callId)
            }
            action.fulfill()
        } catch {
            action.fail()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard let tracked = calls[action.callUUID] else {
            action.fail()
            return
        }
        engine.mute(tracked.callId, muted: action.isMuted)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        guard let tracked = calls[action.callUUID] else {
            action.fail()
            return
        }
        do {
            try engine.sendDtmf(tracked.callId, digit: action.digits)
            action.fulfill()
        } catch {
            action.fail()
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        engine.audioSessionActivated(true)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        engine.audioSessionActivated(false)
    }

    // MARK: - Helpers

    private func trackedCall(callId: String) -> TrackedCall? {
        calls.values.first { $0.callId == callId }
    }

    private static func handle(for value: String) -> CXHandle {
        let digits = CharacterSet(charactersIn: "+0123456789*#")
        let phoneLike = !value.isEmpty && value.unicodeScalars.allSatisfy { digits.contains($0) }
        return CXHandle(type: phoneLike ? .phoneNumber : .generic, value: value.isEmpty ? "unknown" : value)
    }

    private static func endReason(for reason: Reason, fallback: CXCallEndedReason) -> CXCallEndedReason {
        switch reason {
        case .NotAnswered: return .unanswered
        case .Busy, .Declined, .DoNotDisturb: return .remoteEnded
        case .None: return fallback
        default: return fallback == .remoteEnded ? .remoteEnded : .failed
        }
    }
}

private extension Result where Success == Void {
    var thrownError: Error? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
