import SwiftUI

/// 전송 대기 중인 «파일 참조» 한 개 — 파일 전체 또는 특정 라인 범위 + 그에 대한 요구사항(첨언).
///
/// 이미지 첨부(`AttachmentDraft`)와 같은 역할이지만, 파일은 이미 세션 repo 안에 있으므로
/// 업로드가 없다. 경로(+라인 범위)만 들고 있다가 전송 시 «경로↔첨언» 매핑 프롬프트로 합성돼
/// 에이전트가 그 파일/범위를 Read 해서 작업하게 한다.
struct FileReferenceDraft: Identifiable, Equatable {
    let id = UUID()
    /// repo-relative 경로 (예: "src/foo.swift").
    var path: String
    /// 1-기반 라인 범위. nil 이면 파일 전체.
    var lineRange: ClosedRange<Int>?
    /// 이 참조에 대한 요구사항(첨언). 빈 값이면 경로/범위만 프롬프트에 들어간다.
    var instruction: String = ""
    /// 프리뷰 «화면 피드백» 참조면 진입 URL(또는 포트)을 담는다 — non-nil 이면 이 참조는
    /// 코드 파일이 아니라 폰 프리뷰 캡처본이라는 뜻. composeFileRefPrompt 가 «프리뷰 피드백…»
    /// 형태로 따로 합성하고, path 는 저장된 스크린샷 경로(저장 실패 폴백 시 빈 문자열).
    var previewURL: String? = nil
    /// 프리뷰 피드백에서 마크업이 «가리킨» DOM 요소의 식별자(selector·tag·class·텍스트·rect).
    /// 픽셀 스크린샷만으로는 어떤 요소인지 모호하던 비대칭을 메운다 — 코드 리뷰의 라인 범위처럼
    /// «정확한 좌표» 를 에이전트에 넘긴다. WKWebView 의 elementFromPoint 로 추출한 한 줄 설명.
    var previewElement: String? = nil
    /// 화면 미러(RemoteScreenView) 단발 캡처 위 마크업 참조면 true — 코드 파일도 웹 프리뷰도
    /// 아니라 Mac 실화면 캡처본이라는 뜻. 화면 미러는 웹이 아니라 DOM 요소 식별이 불가하므로
    /// previewURL/previewElement 는 둘 다 비고, composeFileRefPrompt 가 «화면 피드백…» 으로
    /// 합성한다. path 는 저장된 스크린샷 경로(저장 실패 폴백 시 빈 문자열).
    var isScreenFeedback: Bool = false
    /// 화면 미러 마크업이 «가리킨» 영역의 정규화 좌표 요약 — 웹의 previewElement(DOM 식별)에
    /// 대응하는 «네이티브» 위치 정보. 실화면은 DOM 이 없어 selector 대신 캡처 프레임 기준
    /// 0..1 좌표(중심 x,y + 크기 w,h, 좌상단 원점)로 위치를 가리킨다 — 코드 리뷰의 라인 범위처럼
    /// 에이전트에 «정확한 자리» 를 텍스트로도 넘긴다. composeFileRefPrompt 가 «[가리킨 위치: …]»
    /// 로 덧붙인다(라벨만 localize, 좌표 토큰은 비번역). 마크업이 없었으면 nil → 위치 항목 생략.
    var screenRegion: String? = nil

    /// 프롬프트/헤더에 쓰는 라벨 — "src/foo.swift" 또는 "src/foo.swift:L10-L40"
    /// (단일 라인이면 "src/foo.swift:L10").
    var label: String {
        guard let r = lineRange else { return path }
        return r.lowerBound == r.upperBound
            ? "\(path):L\(r.lowerBound)"
            : "\(path):L\(r.lowerBound)-L\(r.upperBound)"
    }

    /// 헤더에 보여줄 «파일명 + 범위» — 경로 전체 대신 마지막 segment 만 (좁은 헤더 대비).
    var shortLabel: String {
        if previewURL != nil || isScreenFeedback {
            let base = isScreenFeedback
                ? String(localized: "화면 피드백")
                : String(localized: "프리뷰 피드백")
            let name = path.split(separator: "/").last.map(String.init)
            return name.map { "\(base) · \($0)" } ?? base
        }
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let r = lineRange else { return name }
        return r.lowerBound == r.upperBound
            ? "\(name):L\(r.lowerBound)"
            : "\(name):L\(r.lowerBound)-L\(r.upperBound)"
    }
}

/// 파일 참조 뷰어/편집 시트. 각 참조의 경로/범위 헤더 + 참조별 요구사항(첨언) 입력 + 전송.
/// 이미지 첨부 시트(`AttachmentSheet`)와 동일한 형태 — 업로드가 없는 점만 다르다.
struct FileReferenceSheet: View {
    @Binding var refs: [FileReferenceDraft]
    /// 전송 진행 중 — 버튼 비활성.
    let isSending: Bool
    /// 전송 트리거 (프롬프트 합성 → 전송 → 시트 닫기 까지 ChatView 가 수행).
    let onSend: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                ForEach($refs) { $item in
                    Section {
                        VoiceInputField("이 파일에 대한 요구사항…", text: $item.instruction, lineLimit: 1...5)
                    } header: {
                        HStack {
                            Text(verbatim: item.shortLabel)
                                .textCase(nil)
                            Spacer()
                            Button(role: .destructive) {
                                refs.removeAll { $0.id == item.id }
                            } label: {
                                Image(systemName: "trash")
                            }
                            .accessibilityLabel("참조 삭제")
                        }
                    } footer: {
                        // 전체 경로는 footer 에 작게 — 헤더는 파일명+범위만 짧게 보여줬으므로.
                        if item.path != item.shortLabel {
                            Text(verbatim: item.path)
                        }
                    }
                }
            }
            .navigationTitle("파일 참조 첨언")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                        .disabled(isSending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSending {
                        ProgressView()
                    } else {
                        Button("보내기") { onSend() }
                            .disabled(refs.isEmpty)
                    }
                }
            }
        }
    }
}
