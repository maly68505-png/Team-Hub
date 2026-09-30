// Autocut.app — a native window around the local Autocut engine.
//
// Starts the engine (Resources/bin/autocut serve --app) unless one is already
// running, waits for it, and shows its UI in a WKWebView: no browser involved.
// Folder / file pickers are native (NSOpenPanel) through the "autocut"
// message handler; the page detects it and uses it instead of the engine's
// AppleScript dialogs.
import Cocoa
import WebKit

final class Flag { var value = false }

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler,
                         WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!

    let resources = Bundle.main.resourceURL!

    var home: URL {
        if let h = ProcessInfo.processInfo.environment["AUTOCUT_HOME"], !h.isEmpty {
            return URL(fileURLWithPath: h)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Autocut")
    }

    var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Autocut.log")
    }

    // MARK: - launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "autocut")
        cfg.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 860), configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Autocut"
        window.minSize = NSSize(width: 520, height: 480)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("AutocutMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showMessage("Starting Autocut…", "The first start on a new Mac can take up to a minute.")
        DispatchQueue.global(qos: .userInitiated).async { self.startEngine() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func showMessage(_ title: String, _ detail: String, error: Bool = false) {
        let esc = { (s: String) in
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        }
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:#1d1d1f;color:#e8e8ea;
          font:14px/1.6 -apple-system,sans-serif;display:flex;align-items:center;justify-content:center}
        div{max-width:560px;padding:24px;text-align:center}
        h2{font-weight:600;color:\(error ? "#ff6b6b" : "#e8e8ea")} p{color:#a1a1a6;white-space:pre-wrap}
        </style></head><body><div><h2>\(esc(title))</h2><p>\(esc(detail))</p></div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - engine

    func readServer() -> (port: Int, token: String)? {
        guard let data = try? Data(contentsOf: home.appendingPathComponent("server.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = (obj["port"] as? NSNumber)?.intValue,
              let token = obj["token"] as? String else { return nil }
        return (port, token)
    }

    func alive(_ port: Int, _ token: String) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/ping") else { return false }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        req.setValue(token, forHTTPHeaderField: "X-Autocut-Token")
        let done = DispatchSemaphore(value: 0)
        let result = Flag()
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            result.value = (resp as? HTTPURLResponse)?.statusCode == 200
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2.5)
        return result.value
    }

    func launchEngine() throws {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()
        let p = Process()
        p.executableURL = resources.appendingPathComponent("bin/autocut")
        p.arguments = ["serve", "--app"]
        p.standardOutput = log
        p.standardError = log
        try p.run()
    }

    func startEngine() {
        if let s = readServer(), alive(s.port, s.token) { return showUI(s.port, s.token) }
        do {
            try launchEngine()
        } catch {
            return fail("Could not start the Autocut engine:\n\(error.localizedDescription)")
        }
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            if let s = readServer(), alive(s.port, s.token) { return showUI(s.port, s.token) }
        }
        fail("The Autocut engine did not start.\nDetails are in \(logURL.path)")
    }

    func showUI(_ port: Int, _ token: String) {
        DispatchQueue.main.async {
            let tok = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
            if let url = URL(string: "http://127.0.0.1:\(port)/?host=app&t=\(tok)") {
                self.web.load(URLRequest(url: url))
            }
        }
    }

    func fail(_ text: String) {
        DispatchQueue.main.async { self.showMessage("Autocut could not start", text, error: true) }
    }

    // MARK: - page -> app: native pickers

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], (m["type"] as? String) == "choose" else { return }
        let id = (m["id"] as? NSNumber)?.intValue ?? 0
        let folder = (m["kind"] as? String ?? "folder") == "folder"
        let panel = NSOpenPanel()
        panel.canChooseDirectories = folder
        panel.canChooseFiles = !folder
        panel.allowsMultipleSelection = false
        panel.message = m["prompt"] as? String ?? ""
        if !folder { panel.allowedFileTypes = ["zip"] }
        panel.beginSheetModal(for: window) { resp in
            var payload: [String: Any] = ["type": "autocut-choose-result", "id": id, "path": NSNull()]
            if resp == .OK, let u = panel.url { payload["path"] = u.path }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.web.evaluateJavaScript("window.postMessage(\(json), '*')", completionHandler: nil)
        }
    }

    // links that leave the local engine open in the default browser
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, let scheme = url.scheme,
           scheme == "http" || scheme == "https", url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: - menu (Edit is what makes copy / paste work in the page's fields)

    @objc func reloadPage(_ sender: Any?) {
        if web.url?.host == "127.0.0.1" {
            web.reload()
        } else {
            showMessage("Starting Autocut…", "")
            DispatchQueue.global(qos: .userInitiated).async { self.startEngine() }
        }
    }

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Autocut",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Autocut", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Autocut", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        main.addItem(appItem)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = edit
        main.addItem(editItem)

        let view = NSMenu(title: "View")
        let reload = view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        let viewItem = NSMenuItem()
        viewItem.submenu = view
        main.addItem(viewItem)

        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let winItem = NSMenuItem()
        winItem.submenu = win
        main.addItem(winItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
