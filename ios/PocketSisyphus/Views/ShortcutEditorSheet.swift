import SwiftUI

/// 커스텀 단축키 한 개 — 키 + 수정자 + 아이콘. helper 의 hotkey 명령으로 전송된다(예: ⌘C).
struct MirrorShortcut: Codable, Equatable {
    var key: String          // "c", "v", "return", "space", ...
    var mods: [String]       // "command","shift","option","control"
    var icon: String         // SF Symbol 이름

    /// 표시 문자열 — macOS 순서 ⌃⌥⇧⌘ + 키 글리프 (예: ⌘⇧Z).
    var combo: String {
        var s = ""
        if mods.contains("control") { s += "⌃" }
        if mods.contains("option") { s += "⌥" }
        if mods.contains("shift") { s += "⇧" }
        if mods.contains("command") { s += "⌘" }
        return s + Self.keyGlyph(key)
    }

    static func keyGlyph(_ key: String) -> String {
        switch key.lowercased() {
        case "return", "enter": return "↩"
        case "space": return "␣"
        case "tab": return "⇥"
        case "escape", "esc": return "⎋"
        case "delete", "backspace": return "⌫"
        case "left": return "←"
        case "right": return "→"
        case "up": return "↑"
        case "down": return "↓"
        default: return key.uppercased()
        }
    }

    /// 자주 쓰는 단축키 프리셋 — 생성 시트에서 한 번에 채운다.
    static let presets: [(name: LocalizedStringKey, sc: MirrorShortcut)] = [
        ("복사", .init(key: "c", mods: ["command"], icon: "doc.on.doc")),
        ("붙여넣기", .init(key: "v", mods: ["command"], icon: "doc.on.clipboard")),
        ("잘라내기", .init(key: "x", mods: ["command"], icon: "scissors")),
        ("실행 취소", .init(key: "z", mods: ["command"], icon: "arrow.uturn.backward")),
        ("다시 실행", .init(key: "z", mods: ["command", "shift"], icon: "arrow.uturn.forward")),
        ("전체 선택", .init(key: "a", mods: ["command"], icon: "checklist")),
        ("저장", .init(key: "s", mods: ["command"], icon: "square.and.arrow.down")),
        ("찾기", .init(key: "f", mods: ["command"], icon: "magnifyingglass")),
        ("새로 만들기", .init(key: "n", mods: ["command"], icon: "plus.square")),
        ("새 탭", .init(key: "t", mods: ["command"], icon: "plus.rectangle.on.rectangle")),
    ]

    /// 아이콘 선택지.
    static let iconOptions = [
        "command", "doc.on.doc", "doc.on.clipboard", "scissors", "arrow.uturn.backward",
        "arrow.uturn.forward", "checklist", "square.and.arrow.down", "square.and.arrow.up",
        "magnifyingglass", "plus.square", "xmark.square", "plus.rectangle.on.rectangle",
        "trash", "arrow.clockwise", "bolt.fill", "star.fill", "bookmark.fill",
        "keyboard", "textformat", "paintbrush.fill", "gearshape.fill",
    ]

    /// 특수키 선택지(글자 대신) — 표시 글리프 + 키 이름.
    static let specialKeys: [(glyph: String, key: String)] = [
        ("↩", "return"), ("␣", "space"), ("⇥", "tab"), ("⎋", "escape"), ("⌫", "delete"),
        ("←", "left"), ("→", "right"), ("↑", "up"), ("↓", "down"),
    ]
}

/// 단축키 생성/편집 바텀시트 — 프리셋·수정자·키·아이콘 선택 후 저장. 편집 시 삭제 가능.
struct ShortcutEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (MirrorShortcut) -> Void
    let onDelete: (() -> Void)?

    @State private var key: String
    @State private var command: Bool
    @State private var shift: Bool
    @State private var option: Bool
    @State private var control: Bool
    @State private var icon: String

    init(initial: MirrorShortcut?, onSave: @escaping (MirrorShortcut) -> Void, onDelete: (() -> Void)?) {
        self.onSave = onSave
        self.onDelete = onDelete
        _key = State(initialValue: initial?.key ?? "")
        _command = State(initialValue: initial?.mods.contains("command") ?? true)
        _shift = State(initialValue: initial?.mods.contains("shift") ?? false)
        _option = State(initialValue: initial?.mods.contains("option") ?? false)
        _control = State(initialValue: initial?.mods.contains("control") ?? false)
        _icon = State(initialValue: initial?.icon ?? "command")
    }

    private var mods: [String] {
        var m: [String] = []
        if command { m.append("command") }
        if shift { m.append("shift") }
        if option { m.append("option") }
        if control { m.append("control") }
        return m
    }
    private var current: MirrorShortcut { MirrorShortcut(key: key, mods: mods, icon: icon) }
    private var canSave: Bool { !key.isEmpty }

    private let iconGrid = [GridItem(.adaptive(minimum: 44), spacing: 10)]

    var body: some View {
        NavigationStack {
            Form {
                // 미리보기 — 아이콘 + 조합.
                Section {
                    HStack(spacing: Theme.Spacing.l) {
                        Image(systemName: icon.isEmpty ? "command" : icon)
                            .font(.title2)
                            .frame(width: 40, height: 40)
                            .background(Theme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                        Text(canSave ? current.combo : String(localized: "키를 선택하세요"))
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(canSave ? .primary : .secondary)
                    }
                }

                Section("프리셋") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(MirrorShortcut.presets.indices, id: \.self) { i in
                                let p = MirrorShortcut.presets[i]
                                Button {
                                    applyPreset(p.sc)
                                } label: {
                                    VStack(spacing: 4) {
                                        Image(systemName: p.sc.icon).font(.title3)
                                        Text(p.name).font(.caption2)
                                    }
                                    .frame(width: 64, height: 56)
                                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                Section("수정자") {
                    Toggle("⌘ Command", isOn: $command)
                    Toggle("⇧ Shift", isOn: $shift)
                    Toggle("⌥ Option", isOn: $option)
                    Toggle("⌃ Control", isOn: $control)
                }

                Section("키") {
                    TextField(String(localized: "글자 키 (예: C)"), text: $key)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onChange(of: key) { _, newValue in
                            // 한 글자만 — 특수키 이름(여러 글자)이 아니면 마지막 한 글자로.
                            if !MirrorShortcut.specialKeys.contains(where: { $0.key == newValue }), newValue.count > 1 {
                                key = String(newValue.suffix(1))
                            }
                        }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(MirrorShortcut.specialKeys.indices, id: \.self) { i in
                                let sk = MirrorShortcut.specialKeys[i]
                                Button(sk.glyph) { key = sk.key }
                                    .font(.body)
                                    .frame(width: 40, height: 36)
                                    .background(key == sk.key ? Theme.accent.opacity(0.25) : Color.secondary.opacity(0.15),
                                                in: RoundedRectangle(cornerRadius: 8))
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                Section("아이콘") {
                    LazyVGrid(columns: iconGrid, spacing: 10) {
                        ForEach(MirrorShortcut.iconOptions, id: \.self) { name in
                            Button {
                                icon = name
                            } label: {
                                Image(systemName: name)
                                    .font(.title3)
                                    .frame(width: 44, height: 44)
                                    .background(icon == name ? Theme.accent.opacity(0.25) : Color.secondary.opacity(0.15),
                                                in: RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text("아이콘 \(name)"))
                            .accessibilityAddTraits(icon == name ? .isSelected : [])
                        }
                    }
                }

                if let onDelete {
                    Section {
                        Button(role: .destructive) {
                            onDelete()
                            dismiss()
                        } label: {
                            Label("단축키 삭제", systemImage: "trash")
                        }
                    }
                }
            }
            .navigationTitle(onDelete == nil ? Text("단축키 만들기") : Text("단축키 편집"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("저장") {
                        onSave(current)
                        dismiss()
                    }
                    .disabled(!canSave)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func applyPreset(_ sc: MirrorShortcut) {
        key = sc.key
        command = sc.mods.contains("command")
        shift = sc.mods.contains("shift")
        option = sc.mods.contains("option")
        control = sc.mods.contains("control")
        icon = sc.icon
    }
}
