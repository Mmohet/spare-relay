import AppKit
import ApplicationServices
import Foundation
import Darwin

struct Message: Codable {
    let role: String
    let text: String
}

struct Snapshot: Codable {
    let id: String
    let name: String
    let messages: [Message]
    let writable: Bool
    let status: String
}

struct ChatError: Error {
    let reason: String
    init(_ reason: String) { self.reason = reason }
}

func value(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &result) == .success else { return nil }
    return result
}

func attributeElement(_ element: AXUIElement, _ key: String) -> AXUIElement? {
    guard let result = value(element, key), CFGetTypeID(result) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(result, to: AXUIElement.self)
}

func string(_ element: AXUIElement, _ key: String) -> String {
    value(element, key) as? String ?? ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    value(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func descendants(_ element: AXUIElement, limit: Int = 2500, skipping skipped: AXUIElement? = nil) -> [AXUIElement] {
    var stack = [element]
    var result: [AXUIElement] = []
    while let next = stack.popLast(), result.count < limit {
        result.append(next)
        // A long transcript can use up the whole budget before the composer, which comes after it.
        if let skipped, CFEqual(next, skipped) { continue }
        stack.append(contentsOf: children(next).reversed())
    }
    return result
}

func role(_ element: AXUIElement) -> String { string(element, kAXRoleAttribute) }

func label(_ element: AXUIElement) -> String {
    let description = string(element, kAXDescriptionAttribute)
    return description.isEmpty ? string(element, kAXTitleAttribute) : description
}

func settable(_ element: AXUIElement) -> Bool {
    var writable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success
        && writable.boolValue
}

func aSingle(_ elements: [AXUIElement]) -> AXUIElement? { elements.count == 1 ? elements[0] : nil }

func names(_ element: AXUIElement) -> Set<String> {
    Set([kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"].map { string(element, $0) }.filter { !$0.isEmpty })
}

func webURL(_ element: AXUIElement) -> URL? {
    let raw = value(element, kAXURLAttribute)
    if let url = raw as? URL { return url }
    return (raw as? String).flatMap { URL(string: $0) }
}

func webParent(_ element: AXUIElement) -> AXUIElement? {
    var parent = attributeElement(element, kAXParentAttribute)
    for _ in 0..<30 {
        guard let current = parent else { break }
        if role(current) == "AXWebArea" { return current }
        parent = attributeElement(current, kAXParentAttribute)
    }
    return nil
}

func focus(_ element: AXUIElement, app: AXUIElement) -> Bool {
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard let actual = attributeElement(app, kAXFocusedUIElementAttribute) else { return false }
    return CFEqual(actual, element)
}

func staticText(_ node: AXUIElement) -> String {
    let description = string(node, kAXDescriptionAttribute)
    let raw = string(node, kAXValueAttribute)
    return raw.isEmpty ? description : raw
}

func readMuse(_ transcript: AXUIElement) -> [Message] {
    var output: [Message] = []
    for entry in children(transcript) {
        let nodes = descendants(entry, limit: 120)
        let fragments = nodes.filter { role($0) == kAXStaticTextRole }.map(staticText)
        let speakers = [("User message: ", "user"), ("You: ", "user"), ("Assistant message: ", "assistant")]
        let labeled = fragments.compactMap { fragment -> Message? in
            for (prefix, speaker) in speakers where fragment.hasPrefix(prefix) {
                return Message(role: speaker, text: String(fragment.dropFirst(prefix.count).prefix(12000)))
            }
            return nil
        }
        if !labeled.isEmpty { output.append(contentsOf: labeled); continue }
        let buttons = Set(nodes.filter { role($0) == kAXButtonRole }.map(label))
        if buttons.contains("React"), buttons.contains("Reply"), !fragments.isEmpty {
            output.append(Message(role: "assistant", text: String(fragments.joined(separator: "\n").prefix(12000))))
        }
    }
    return Array(output.suffix(50))
}

func readGrok(_ transcript: AXUIElement, name: String) -> [Message] {
    let nodes = descendants(transcript)
    var output: [Message] = []
    for node in nodes where role(node) == kAXGroupRole {
        let content = label(node)
        for (prefix, speaker) in [("You ", "user"), ("你 ", "user"), (name + " ", "assistant")]
            where content.hasPrefix(prefix) {
            let remainder = String(content.dropFirst(prefix.count))
            if remainder.range(of: #"^\d{1,2}:\d\d(:\d\d)?$"#, options: .regularExpression) != nil { continue }
            // "Grok Bot 的附件" and "Grok Bot 的消息 … 的消息操作" label parts of a message, not message text.
            if remainder.hasPrefix("的") || remainder.hasPrefix("'s ") { break }
            if !remainder.isEmpty {
                output.append(Message(role: speaker, text: String(remainder.prefix(12000))))
            }
            break
        }
    }
    return Array(output.suffix(50))
}

struct Chat {
    let running: NSRunningApplication
    let app: AXUIElement
    let snapshot: Snapshot
    let composer: AXUIElement?
    let send: AXUIElement?
}

func inspect(_ agent: String) throws -> Chat {
    let bundle = agent == "muse" ? "com.meta.endo" : "com.anysphere.sand"
    let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
    guard matches.count == 1 else { throw ChatError("application-not-open") }
    let running = matches[0]
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 1.5)
    let windows = value(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    guard let window = aSingle(windows.filter({
        string($0, kAXTitleAttribute) == (agent == "muse" ? "Muse" : "Grok Bot")
    })) else { throw ChatError("chat-window-unavailable") }
    let isMuse = agent == "muse"
    let transcriptLabels: Set<String> = isMuse ? ["Chat messages"] : ["Conversation history", "对话记录"]
    func findTranscript() -> AXUIElement? {
        aSingle(descendants(window).filter { !transcriptLabels.isDisjoint(with: names($0)) })
    }
    var found = findTranscript()
    if found == nil && !isMuse {
        // Chromium lazily exposes the renderer's accessibility tree.
        _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 0.2)
        found = findTranscript()
    }
    guard let transcript = found else { throw ChatError("transcript-unavailable") }
    guard let web = webParent(transcript) else { throw ChatError("chat-view-ambiguous") }
    let nodes = descendants(web, skipping: transcript)
    let url = webURL(web)
    let name = isMuse ? "Muse" : "Grok Bot"
    let id = isMuse ? "muse-main" : "grok-main"
    if isMuse {
        guard url?.host == "muse.ai", url?.path.isEmpty == true || url?.path == "/" else {
            throw ChatError("muse-main-url-unconfirmed")
        }
        // Older Muse labels the header "Main chat"; newer builds use "Chats" (open chat and side chats). The URL check above pins the main chat.
        guard nodes.contains(where: { node in
            role(node) == kAXButtonRole && names(node).contains { $0 == "Main chat" || $0.hasPrefix("Chats") }
        }) else {
            throw ChatError("main-chat-not-selected")
        }
    } else {
        guard aSingle(nodes.filter({
            role($0) == "AXHeading" && names($0).contains("Grok Bot")
        })) != nil else { throw ChatError("main-bot-not-selected") }
    }

    func editorsIn(_ nodes: [AXUIElement]) -> [AXUIElement] {
        var editorNodes = nodes
        if let focused = attributeElement(app, kAXFocusedUIElementAttribute),
           !nodes.contains(where: { CFEqual($0, focused) }) { editorNodes.append(focused) }
        return editorNodes.filter { node in
            let type = role(node)
            guard type == kAXTextFieldRole || type == "AXTextArea", settable(node) else { return false }
            let placeholder = string(node, kAXPlaceholderValueAttribute)
            let labels = names(node)
            if isMuse { return placeholder == "Message" || labels.contains("Message") }
            return !labels.isDisjoint(with: ["Prompt", "提示词"])
                && (placeholder.contains(name) || placeholder.isEmpty)
        }
    }
    let editors = editorsIn(nodes)
    let sendLabels: Set<String> = ["Send", "Send message", "发送", "发送消息"]
    let send = aSingle(nodes.filter { role($0) == kAXButtonRole && sendLabels.contains(label($0)) })
    let composer = aSingle(editors)
    let messages = isMuse ? readMuse(transcript) : readGrok(transcript, name: name)
    let active = nodes.contains {
        role($0) == kAXButtonRole && ["Stop generating", "Stop response", "停止生成", "停止回复"].contains(label($0))
    }
    let snapshot = Snapshot(id: id, name: name, messages: messages, writable: composer != nil,
                            status: active ? "running" : "unknown")
    return Chat(running: running, app: app, snapshot: snapshot, composer: composer, send: send)
}

func writeMessage(_ agent: String, session: String, text: String) throws {
    let first = try inspect(agent)
    guard first.snapshot.id == session, let input = first.composer else { throw ChatError("session-not-writable") }
    guard first.snapshot.status != "running" else { throw ChatError("session-working") }
    let draft = string(input, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
    guard draft.isEmpty else { throw ChatError("existing-draft") }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != first.running.processIdentifier {
        // Background first: write the composer and press its Send button without raising the app.
        if try sendInBackground(agent, session: session, input: input, text: text) { return }
        guard ProcessInfo.processInfo.environment["PANEL_MAC_ALLOW_ACTIVATION"] == "1"
            || CommandLine.arguments.contains("--allow-activation") else {
            throw ChatError("bring-target-app-to-front")
        }
        _ = first.running.activate(options: [])
        Thread.sleep(forTimeInterval: 0.6)
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == first.running.processIdentifier else {
        throw ChatError("bring-target-app-to-front")
    }
    _ = focus(input, app: first.app) // Chromium may report a different focused node; the value check below decides.
    guard AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFString) == .success else {
        throw ChatError("composer-write-failed")
    }
    Thread.sleep(forTimeInterval: 0.2)
    let verified = try inspect(agent)
    guard verified.snapshot.id == session, let editor = verified.composer, CFEqual(input, editor),
          string(editor, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines) == text else {
        throw ChatError("composer-verification-failed")
    }
    if let button = verified.send, (value(button, kAXEnabledAttribute) as? Bool) == true {
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
            throw ChatError("send-not-confirmed")
        }
        return
    }
    // Restrict the keyboard fallback to the same verified editor and process.
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == verified.running.processIdentifier,
          focus(editor, app: verified.app),
          let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) else {
        throw ChatError("send-not-confirmed")
    }
    down.postToPid(verified.running.processIdentifier)
    up.postToPid(verified.running.processIdentifier)
}

/// Writes the composer and presses Send while the app stays in the background.
/// Returns false, with the composer cleared again, when the app does not accept the text that way.
func sendInBackground(_ agent: String, session: String, input: AXUIElement, text: String) throws -> Bool {
    guard AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFString) == .success else {
        return false
    }
    Thread.sleep(forTimeInterval: 0.3)
    let written = try inspect(agent)
    if written.snapshot.id == session, let editor = written.composer, CFEqual(input, editor),
       string(editor, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines) == text,
       let button = written.send, (value(button, kAXEnabledAttribute) as? Bool) == true,
       AXUIElementPerformAction(button, kAXPressAction as CFString) == .success {
        Thread.sleep(forTimeInterval: 0.5)
        let after = try inspect(agent)
        let left = after.composer.map { string($0, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        if left.isEmpty { return true }
        // Send was pressed but the text stayed: never retry in the foreground, that could send it twice.
        _ = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, "" as CFString)
        throw ChatError("send-not-confirmed")
    }
    _ = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, "" as CFString)
    return false
}

/// Describes the chat window's controls, skipping the transcript, so a changed layout can be diagnosed.
func probe(_ agent: String) throws -> Data {
    let bundle = agent == "muse" ? "com.meta.endo" : "com.anysphere.sand"
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first(where: { !$0.isTerminated })
    else { throw ChatError("application-not-open") }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 1.5)
    func describe(_ node: AXUIElement, _ depth: Int) -> String {
        var actions: CFArray?
        AXUIElementCopyActionNames(node, &actions)
        var focusable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(node, kAXFocusedAttribute as CFString, &focusable)
        let fields = [role(node), string(node, kAXSubroleAttribute), "names=" + names(node).sorted().joined(separator: "|"),
                      "ph=" + string(node, kAXPlaceholderValueAttribute), "settable=\(settable(node))",
                      "focusable=\(focusable.boolValue)", "actions=" + ((actions as? [String]) ?? []).joined(separator: ","),
                      "kids=\(children(node).count)"]
        return String(repeating: " ", count: min(depth, 30)) + fields.joined(separator: " ")
    }
    var lines: [String] = []
    if let focused = attributeElement(app, kAXFocusedUIElementAttribute) { lines.append("focused " + describe(focused, 0)) }
    var stack = (value(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).map { ($0, 0) }
    while let (node, depth) = stack.popLast(), lines.count < 3000 {
        lines.append(describe(node, depth))
        if !names(node).isDisjoint(with: ["Chat messages", "Conversation history", "对话记录"]) { continue }
        stack.append(contentsOf: children(node).reversed().map { ($0, depth + 1) })
    }
    return try JSONEncoder().encode(lines)
}

struct Outgoing: Decodable {
    let session: String
    let text: String
}

struct Job: Decodable {
    let agent: String
    let method: String
    let expiresAt: Double
    let input: Outgoing?
}

func execute(agent: String, method: String, input: Outgoing?) throws -> Data {
    guard ["muse", "grok"].contains(agent), ["status", "send", "probe"].contains(method) else {
        throw ChatError("invalid-job")
    }
    guard AXIsProcessTrusted() else { throw ChatError("accessibility-permission-required") }
    if method == "probe" { return try probe(agent) }
    if method == "status" { return try JSONEncoder().encode(inspect(agent).snapshot) }
    guard let input else { throw ChatError("invalid-message") }
    let text = input.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.count <= 12000 else { throw ChatError("invalid-message") }
    try writeMessage(agent, session: input.session, text: text)
    return Data("{\"dispatched\":true}".utf8)
}

func serve(directory: String) throws {
    let manager = FileManager.default
    let dir = URL(fileURLWithPath: directory, isDirectory: true)
    let attributes = try manager.attributesOfItem(atPath: dir.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700 else {
        throw ChatError("bridge-directory-must-be-private")
    }
    let health = dir.appendingPathComponent("helper-ready")
    try Data("ready".utf8).write(to: health, options: [.atomic])
    let poll = DispatchSource.makeTimerSource(queue: .main)
    poll.schedule(deadline: .now(), repeating: .milliseconds(600))
    poll.setEventHandler {
        guard let files = try? manager.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isRegularFileKey]) else { return }
        for file in files {
            let name = file.deletingPathExtension().lastPathComponent
            guard file.pathExtension == "request", UUID(uuidString: name) != nil,
                  let attrs = try? manager.attributesOfItem(atPath: file.path),
                  attrs[.type] as? FileAttributeType == .typeRegular,
                  (attrs[.size] as? NSNumber)?.intValue ?? 999999 < 65536,
                  let data = try? Data(contentsOf: file) else { continue }
            try? manager.removeItem(at: file)
            guard let job = try? JSONDecoder().decode(Job.self, from: data),
                  job.expiresAt >= Date().timeIntervalSince1970 * 1000 else { continue }
            let output: Data
            do {
                let payload = try execute(agent: job.agent, method: job.method, input: job.input)
                output = Data("{\"ok\":true,\"value\":".utf8) + payload + Data("}".utf8)
            } catch {
                let reason = (error as? ChatError)?.reason ?? "chat-access-failed"
                output = (try? JSONSerialization.data(withJSONObject: ["ok": false, "error": reason])) ?? Data()
            }
            if job.expiresAt >= Date().timeIntervalSince1970 * 1000 {
                let response = dir.appendingPathComponent(name + ".response")
                try? output.write(to: response, options: [.atomic])
                try? manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: response.path)
            }
        }
    }
    poll.resume()
    withExtendedLifetime(poll) { dispatchMain() }
}

do {
    let args = CommandLine.arguments
    if (args.count == 3 || args.count == 4 && args[3] == "--allow-activation"), args[1] == "serve" {
        try serve(directory: args[2])
    } else if args.count == 3 {
        let input = args[2] == "send"
            ? try JSONDecoder().decode(Outgoing.self, from: FileHandle.standardInput.readDataToEndOfFile()) : nil
        let result = try execute(agent: args[1], method: args[2], input: input)
        print(String(decoding: result, as: UTF8.self))
    } else {
        throw ChatError("usage: chat-access muse|grok status|send")
    }
} catch {
    FileHandle.standardError.write(Data(((error as? ChatError)?.reason ?? "chat-access-failed").utf8))
    exit(1)
}
