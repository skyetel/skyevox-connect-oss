import UIKit
import Capacitor

/// Registers the app-local `SkyeVoxNative` plugin. Capacitor 6 auto-registers only the npm plugin
/// classes `cap sync` writes to capacitor.config.json's packageClassList, so app-target plugins
/// must be added here (Main.storyboard instantiates this controller).
final class SkyeVoxBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SkyeVoxNativePlugin())
    }
}
