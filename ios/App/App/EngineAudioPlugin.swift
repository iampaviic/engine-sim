import AVFoundation
import Capacitor
import UIKit

/// Audio session, interruptions and screen keep-awake for the engine sound.
/// The sound itself is Web Audio inside the web view. This plugin sets the
/// session up so it plays with the ring/silent switch on, and tells the page
/// when to pause and resume (calls, Siri, headphones unplugged).
@objc(EngineAudioPlugin)
public class EngineAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EngineAudioPlugin"
    public let jsName = "EngineAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise)
    ]

    private var mixWithOthers = false
    private var active = false

    override public func load() {
        let session = AVAudioSession.sharedInstance()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: session)
        center.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: session)
        center.addObserver(self, selector: #selector(servicesReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: session)
        applyCategory()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// Playback ignores the silent switch and pauses other apps' audio.
    /// Mixing keeps the listener's music going under the engine.
    private func applyCategory() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: mixWithOthers ? [.mixWithOthers] : [])
            if active {
                try session.setActive(true)
            }
        } catch {
            CAPLog.print("EngineAudio: could not set the audio session:", error.localizedDescription)
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        mixWithOthers = call.getBool("mixWithOthers", false)
        applyCategory()
        call.resolve()
    }

    @objc func setActive(_ call: CAPPluginCall) {
        active = call.getBool("on", false)
        let session = AVAudioSession.sharedInstance()
        do {
            if active {
                try session.setCategory(.playback, mode: .default, options: mixWithOthers ? [.mixWithOthers] : [])
                try session.setActive(true)
            } else {
                try session.setActive(false, options: .notifyOthersOnDeactivation)
            }
        } catch {
            CAPLog.print("EngineAudio: could not change the audio session:", error.localizedDescription)
        }
        call.resolve()
    }

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on", false)
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    @objc private func interrupted(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            notifyListeners("interruption", data: ["state": "began"])
        case .ended:
            let options = (info[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            if active {
                try? AVAudioSession.sharedInstance().setActive(true)
            }
            notifyListeners("interruption", data: ["state": "ended", "shouldResume": options.contains(.shouldResume)])
        @unknown default:
            break
        }
    }

    @objc private func routeChanged(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        if reason == .oldDeviceUnavailable {
            notifyListeners("route", data: ["reason": "deviceLost"])
        }
    }

    @objc private func servicesReset(_ note: Notification) {
        applyCategory()
        notifyListeners("interruption", data: ["state": "ended", "shouldResume": true])
    }
}
