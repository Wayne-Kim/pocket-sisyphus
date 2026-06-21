import SwiftUI

/// 빈 / 로딩 / 에러 — 화면이 «데이터가 없을 때» 보여 주는 세 가지 상태의 공용 표면.
///
/// ## 왜 공용인가
/// 이 세 상태는 화면마다 따로 재구현되며 모양이 어긋나거나 누락되기 쉽다(특히 «로딩 중인데
/// 비어 있음» 을 띄워 사용자가 콘텐츠를 못 보고 떠나는 함정). `ArtifactsView`(빈/에러)·
/// `SessionsView`(스켈레톤)·`AppRoot.ErrorView`(에러+재시도)에 정착해 있던 패턴을 SSOT 로 삼아
/// 하나로 묶는다 — 새 표면은 이 세 뷰를 조립하기만 하면 같은 모양·색·접근성을 공짜로 얻는다.
///
/// ## 불변식 — 「로딩 중 빈-상태 금지」
/// 데이터를 받는 중에는 «비어 있음/결과 없음» 을 띄우지 않는다. 호출부는 반드시
/// `loading && items.isEmpty → LoadingStateView`, `!loading && items.isEmpty → EmptyStateView`
/// 순서로 갈라, 로딩→빈 전이가 또렷하게 보이도록 한다.
///
/// ## 색·간격 정책 (DesignTokens 의 약속을 그대로 따른다)
/// - 아이콘·본문은 `.secondary`(테마 자동 적응) — 빈/로딩은 «강조» 가 아니다.
/// - 에러 신호 아이콘만 의미색을 쓴다: 기본 `Theme.danger`(빨강). 재시도로 풀리는 «일시적»
///   실패는 호출부가 `tint: Theme.warning` 으로 낮춰도 된다(ErrorView 의 분류 약속과 동일 —
///   복구 가능=warning, 막다른 길=danger). 장식·강조에 status 색을 빌리지 않는다.
/// - 주요 액션(CTA·재시도)만 accent(보라). `.borderedProminent` + `.tint(Theme.accent)` 로
///   명시한다(일부 시뮬레이터에서 prominent 가 AccentColor 에셋을 안 타고 파래지는 것 차단 —
///   SessionsView·PaywallView 와 같은 관례).
/// - 간격·아이콘 크기는 4pt 그리드 토큰(`Theme.Spacing`/`Theme.IconSize`)만 쓴다.

// MARK: - 빈 상태 (Empty)

/// 빈 상태 — placeholder 아이콘(IconSize.l) + 헤드라인 + 설명 + 선택적 CTA.
///
/// CTA 가 없으면 `EmptyStateView(title:systemImage:message:)` 한 줄(편의 init)로 끝난다.
/// CTA 가 필요하면 trailing closure 로 «이미 틴트를 단» 버튼을 넣는다(SessionsView 의 「새 세션
/// 만들기」 처럼) — 컨테이너가 전역 tint 를 걸지 않으므로 버튼은 자기 색을 직접 책임진다.
struct EmptyStateView<CTA: View>: View {
    let title: LocalizedStringKey
    let systemImage: String
    let message: LocalizedStringKey
    @ViewBuilder var cta: CTA

    init(
        title: LocalizedStringKey,
        systemImage: String,
        message: LocalizedStringKey,
        @ViewBuilder cta: () -> CTA,
    ) {
        self.title = title
        self.systemImage = systemImage
        self.message = message
        self.cta = cta()
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: systemImage)
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(.secondary)
                // 장식 아이콘 — 의미는 아래 헤드라인/설명이 전달하므로 VoiceOver 에서 숨긴다.
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xxxl)
            cta
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension EmptyStateView where CTA == EmptyView {
    /// CTA 없는 빈 상태 — 기존 `DiffEmptyState`/`FileViewerEmptyState` 등과 동일 시그니처.
    init(title: LocalizedStringKey, systemImage: String, message: LocalizedStringKey) {
        self.init(title: title, systemImage: systemImage, message: message) { EmptyView() }
    }
}

// MARK: - 로딩 상태 (Loading)

/// 로딩 상태 — 가운데 ProgressView + (선택적) 맥락 라벨. 「로딩 중 빈-상태 금지」 불변식의
/// 표준 표면: 데이터가 아직 없을 때 «비어 있음» 대신 이걸 띄운다. 라벨은 «무엇을» 불러오는지
/// 한 줄로 알려 무한 스피너의 «멈췄나?» 인상을 줄인다(특히 Tor 위 느린 첫 호출).
struct LoadingStateView: View {
    var message: LocalizedStringKey?

    init(message: LocalizedStringKey? = nil) {
        self.message = message
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.l) {
            ProgressView()
            if let message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Theme.Spacing.xxxl)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // 스피너 + 라벨을 한 접근성 요소로 묶어 «불러오는 중» 으로 읽히게 한다.
        .accessibilityElement(children: .combine)
    }
}

// MARK: - 에러 상태 (Error)

/// 에러 상태 — 신호 아이콘(IconSize.xl) + 헤드라인 + 메시지 + 재시도 버튼.
/// `ArtifactsView.failedState` / `AppRoot.ErrorView` 의 «무엇이 왜 실패했고 다시 시도» 패턴을
/// 한곳으로 묶는다. `message` 는 런타임 에러 문자열(서버/`String(localized:)`)이라 `String`.
///
/// `tint` 기본은 `Theme.danger`(에러=빨강). 재시도로 회복되는 «일시적» 실패에는 호출부가
/// `tint: Theme.warning` 으로 낮춘다(ErrorView 의 분류 약속 — 복구 가능=warning).
struct ErrorStateView: View {
    let title: LocalizedStringKey
    var systemImage: String = "exclamationmark.triangle"
    let message: String
    var tint: Color = Theme.danger
    var retryTitle: LocalizedStringKey = "다시 시도"
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: systemImage)
                .font(.system(size: Theme.IconSize.xl))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xxl)
            Button {
                onRetry()
            } label: {
                Label(retryTitle, systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderedProminent)
            // prominent 가 (일부 시뮬레이터에서) AccentColor 에셋을 안 타고 파래질 때가 있어 명시.
            .tint(Theme.accent)
        }
        .padding(Theme.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#if DEBUG
/// 빈/로딩/에러 세 상태를 한 화면에 세로로 쌓아 «눈검증» 하는 갤러리. #Preview 와, 시뮬레이터
/// 자가 검증(`PS_DEV_STATEVIEWS=1` → AppRoot)이 같은 뷰를 공유한다 — 한 스크린샷에서 세 상태의
/// 색·간격·다크/라이트 대비를 한눈에 확인한다.
struct StateViewsGallery: View {
    var body: some View {
        VStack(spacing: 0) {
            section("Empty") {
                EmptyStateView(
                    title: "아직 산출물이 없어요",
                    systemImage: "photo.on.rectangle.angled",
                    message: "세션이 이미지·PDF·문서 같은 파일을 만들면 여기에 모여요.",
                )
            }
            Divider()
            section("Empty + CTA") {
                EmptyStateView(
                    title: "아직 세션이 없어요",
                    systemImage: "bubble.left.and.bubble.right",
                    message: "세션은 Mac 의 코드 에이전트와 나누는 대화예요. 새 세션을 만들어 레포를 고르면 모바일에서 바로 명령을 보낼 수 있어요.",
                ) {
                    Button { } label: { Label("새 세션 만들기", systemImage: "plus") }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accent)
                }
            }
            Divider()
            section("Loading") {
                LoadingStateView(message: "산출물을 불러오는 중…")
            }
            Divider()
            section("Error + retry") {
                ErrorStateView(
                    title: "산출물을 불러올 수 없어요",
                    // 갤러리 샘플 — 실제 message 는 런타임 String(localized:) 라 로케일 따라 번역된다.
                    message: String(localized: "알 수 없는 이유로 연결에 실패했어요. 잠시 뒤 다시 시도해 주세요."),
                    tint: Theme.warning,
                ) {}
            }
        }
    }

    @ViewBuilder
    private func section<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        content()
            .overlay(alignment: .topLeading) {
                Text(verbatim: label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(Theme.Spacing.s)
            }
    }
}

#Preview("State views — empty / loading / error") {
    StateViewsGallery()
}
#endif
