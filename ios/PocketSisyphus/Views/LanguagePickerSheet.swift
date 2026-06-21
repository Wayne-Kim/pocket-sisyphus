import SwiftUI

/// 앱 내 언어 변경 UI.
///
/// iOS 자체는 LocalizedStringKey 가 SwiftUI Text init 시점에 한 번 해석되고 끝이라
/// 런타임에 즉시 갈아끼울 수 없다 (Bundle.main.localizedString 결과를 다시 안 읽는다).
/// 그래서 사용자가 언어를 고르면 `AppleLanguages` UserDefaults 에 override 를 박고
/// 앱을 재시작 (exit(0)) 시켜 다음 부팅에 그 언어로 모든 카탈로그를 다시 로드시킨다.
///
/// 시스템 언어로 되돌리기: AppleLanguages 키 자체를 제거 → 다음 부팅부터 iOS 가
/// 시스템 preferredLanguages 로 자동 선택.
///
/// 언어명은 항상 자기 모국어 표기로 보여준다 — 사용자가 모르는 언어로 빠져버려도
/// 자기 언어 줄을 보고 돌아올 수 있어야 하니까.
struct LanguagePickerSheet: View {
    /// nil = 시스템 언어로 되돌리기. non-nil = 그 언어로 고정.
    let onSelect: (String?) -> Void

    @Environment(\.dismiss) private var dismiss

    /// (BCP-47 코드, 자기 모국어 표기). knownRegions 와 정확히 1:1.
    private let languages: [(code: String, name: String)] = [
        ("ko",      "한국어"),
        ("en",      "English"),
        ("zh-Hans", "简体中文"),
        ("ja",      "日本語"),
        ("es",      "Español"),
        ("fr",      "Français"),
        ("hi",      "हिन्दी"),
        ("ar",      "العربية"),
        ("pt-BR",   "Português (Brasil)"),
        ("ru",      "Русский"),
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        onSelect(nil)
                        dismiss()
                    } label: {
                        HStack {
                            Image(systemName: "gearshape")
                                .foregroundStyle(.secondary)
                                .frame(width: 24)
                            Text("시스템 언어 사용")
                                .foregroundStyle(.primary)
                            Spacer()
                            if currentOverride == nil {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Theme.accent)
                            }
                        }
                    }
                }

                Section {
                    ForEach(languages, id: \.code) { lang in
                        Button {
                            onSelect(lang.code)
                            dismiss()
                        } label: {
                            HStack {
                                // 모국어 표기를 항상 LTR 로 두지 않고 SwiftUI 의 자연스러운
                                // RTL 흐름에 맡긴다 — 아랍어 줄은 우측 정렬로 떨어진다.
                                Text(lang.name)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if currentOverride == lang.code {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Theme.accent)
                                }
                            }
                        }
                    }
                } header: {
                    Text("앱 언어 선택")
                }
            }
            .navigationTitle("언어")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }

    /// AppleLanguages override 의 첫 항목 — 현재 앱이 고정 사용 중인 언어 코드.
    /// nil 이면 override 없음 (시스템 언어 그대로 사용 중).
    private var currentOverride: String? {
        // iOS 가 미리 채워둔 시스템 priority 리스트도 같은 키를 공유하므로,
        // 우리가 명시적으로 박은 single-item override 와 구분이 필요하다.
        // 단일 코드만 있을 때 = 우리가 박은 것으로 판단. 여러 개면 시스템 기본.
        guard let arr = UserDefaults.standard.array(forKey: "AppleLanguages") as? [String],
              arr.count == 1 else {
            return nil
        }
        return arr.first
    }
}
