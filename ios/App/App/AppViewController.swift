import Capacitor
import UIKit

/// The app's web view controller. Registers the plugins that live in this
/// app target instead of an npm package.
class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(EngineAudioPlugin())
    }
}
