import UIKit
import Capacitor

// The scene-based life cycle Apple requires for apps built with the iOS 27 SDK
// (without it the app is killed at launch: "UIScene life cycle is required").
// The window and the Capacitor bridge view controller still come from
// Main.storyboard (Info.plist: UIApplicationSceneManifest > UISceneStoryboardFile),
// so UIKit creates `window` for us. URL opens and Universal Links no longer
// reach AppDelegate in a scene-based app; they arrive here and are handed to
// Capacitor's proxy exactly as AppDelegate used to, so the App plugin's
// `appUrlOpen` event and `getLaunchUrl()` (the albayan:// login callback)
// keep working.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard scene is UIWindowScene else { return }
        // A cold start from a URL or a Universal Link delivers it here, not to
        // scene(_:openURLContexts:).
        for context in connectionOptions.urlContexts {
            forward(url: context.url, options: context.options)
        }
        for activity in connectionOptions.userActivities {
            forward(userActivity: activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            forward(url: context.url, options: context.options)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        forward(userActivity: userActivity)
    }

    private func forward(url: URL, options: UIScene.OpenURLOptions) {
        var appOptions: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: options.openInPlace]
        if let sourceApplication = options.sourceApplication {
            appOptions[.sourceApplication] = sourceApplication
        }
        if let annotation = options.annotation {
            appOptions[.annotation] = annotation
        }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: appOptions)
    }

    private func forward(userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
