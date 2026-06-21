import SwiftUI
import UIKit
import ImageIO

/// 전송 대기 중인 첨부 이미지 한 개 — 다운스케일/압축까지 끝난 업로드용 데이터 + 미리보기 +
/// 이미지별 요구사항 텍스트를 들고 있다. 사진을 고르면 ChatView 가 `make(fromOriginal:)` 로
/// 만들어 배열에 쌓고, 전송 시 각 항목의 `data` 를 업로드한 뒤 저장 경로↔`instruction` 을 매핑한다.
struct AttachmentDraft: Identifiable {
    let id = UUID()
    /// 미리보기용 (다운스케일된) 이미지.
    var image: UIImage
    /// 업로드할 바이트 (JPEG). 원본이 아니라 다운스케일/압축본.
    var data: Data
    /// 서버에 제안할 파일명 (충돌 시 서버가 -n 접미).
    var suggestedName: String
    /// 이 이미지에 대한 요구사항 (선택). 빈 값이면 경로만 프롬프트에 들어간다.
    var instruction: String = ""
    /// 주석(펜 획 + 블러 영역) — 비어 있지 않으면 `image`/`data` 는 베이스에 주석을 합성한
    /// 결과다. 에디터(AttachmentAnnotationEditor)가 다시 열 때 이어서 편집/되돌리기 할 수
    /// 있게 원본을 보관. 미리보기 썸네일(`image`)에도 블러가 그대로 반영돼 사용자가 가려진
    /// 상태를 확인하고 보낼 수 있다.
    var annotations: [AnnotationItem] = []
    /// 주석 합성 «전» 베이스 — 주석을 모두 지우면 이것으로 복원한다. 주석 없으면 nil.
    var baseImage: UIImage?
    var baseData: Data?

    /// 원본 이미지 데이터를 다운스케일(최대 1568px) + JPEG 압축해 업로드용 draft 를 만든다.
    /// Tor 대역폭상 원본 그대로 올리는 건 비현실적이라 항상 줄여서 올린다. Claude 의 권장
    /// 장변(~1568px) 에 맞춰 화질 손실 없이 토큰/대역폭을 아낀다.
    ///
    /// 메모리: 반드시 ImageIO 다운샘플(CGImageSource thumbnail)로 «축소본만» 디코드한다.
    /// `UIImage(data:)` 로 풀해상도를 먼저 디코드하면 Retina/5K~6K Mac 의 미러링 원샷
    /// 한 장이 수십 MB 비트맵이 되고, 녹화 종료 시 8장을 메인에서 연달아 디코드하면
    /// 오토릴리즈 비트맵이 누적돼 jetsam 으로 앱이 죽었다 (실측 크래시). 썸네일 경로는
    /// 전체 비트맵을 메모리에 올리지 않으므로 피크가 수십 배 낮다. 호출부는 항상
    /// autoreleasepool 안에서 부른다(루프 누적 방지).
    static func make(fromOriginal data: Data) -> AttachmentDraft? {
        let maxDim: CGFloat = 1568
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, // EXIF 회전을 픽셀에 반영
            kCGImageSourceShouldCacheImmediately: true,
            // maxPixelSize 보다 원본이 작으면 ImageIO 가 업스케일 없이 원본 크기를 낸다
            // (기존 scale=1 규약과 동일 — image.size 는 픽셀 크기, UIImage scale=1).
            kCGImageSourceThumbnailMaxPixelSize: maxDim,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let rendered = UIImage(cgImage: cg)
        guard let jpeg = rendered.jpegData(compressionQuality: 0.8) else { return nil }
        let short = UUID().uuidString.prefix(8).lowercased()
        return AttachmentDraft(image: rendered, data: jpeg, suggestedName: "img-\(short).jpg")
    }
}

/// 첨부 이미지 뷰어/편집 시트. 각 이미지 썸네일 + 이미지별 요구사항 입력, 저장 경로(기본
/// attachments) 편집, 전송. 실제 업로드+프롬프트 전송은 ChatView 의 onSend 클로저가 한다.
struct AttachmentSheet: View {
    @Binding var attachments: [AttachmentDraft]
    /// 저장 위치 (세션 루트 기준 상대경로). 비우면 서버가 attachments 로 처리.
    @Binding var dir: String
    /// 업로드/전송 진행 중 — 버튼 비활성 + 스피너.
    let isUploading: Bool
    /// «전체 요청» 입력란 노출 — 미러링 캡처/녹화로 모인 첨부일 때만 true. 사진첩 첨부는
    /// 이미지별 요구사항으로 충분하지만, 녹화 단계 이미지는 «참고 자료» 라 이 자료로 무엇을
    /// 시킬지(버그 수정 등) 적는 자리가 따로 필요하다 (사용자 피드백 2026-06-11).
    var showOverallInstruction: Bool = false
    /// 전체 요청 본문 — ChatView 가 프롬프트 맨 앞에 싣는다.
    var overallInstruction: Binding<String> = .constant("")
    /// 전송 트리거 (업로드 → 프롬프트 합성 → 전송 → 시트 닫기 까지 ChatView 가 수행).
    let onSend: () -> Void

    @Environment(\.dismiss) private var dismiss
    /// 주석 에디터에 띄울 첨부 — 썸네일 탭으로 진입. 사진첩·캡처·녹화 프레임(rec-stepNN)
    /// 구분 없이 AttachmentDraft 단위로 동작한다.
    @State private var annotating: AttachmentDraft?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("attachments", text: $dir)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("저장 위치")
                } footer: {
                    Text("세션 루트 기준 상대경로. 비우면 attachments 폴더에 저장됩니다.")
                }

                if showOverallInstruction {
                    Section {
                        VoiceInputField("이 이미지들로 무엇을 할지 입력…", text: overallInstruction, lineLimit: 2...6)
                    } header: {
                        Text("요청")
                    } footer: {
                        Text("캡처/녹화 이미지는 참고 자료로 함께 전달돼요. 여기에 적은 요청이 프롬프트의 본문이 됩니다.")
                    }
                }

                ForEach($attachments) { $item in
                    Section {
                        Image(uiImage: item.image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity)
                            .frame(maxHeight: 220)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: "pencil.tip.crop.circle")
                                    .font(.title3)
                                    .symbolVariant(item.annotations.isEmpty ? .none : .fill)
                                    .foregroundStyle(item.annotations.isEmpty ? Color.secondary : Theme.accent)
                                    .padding(6)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { annotating = item }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityLabel("주석 달기")
                        VoiceInputField("이 이미지에 대한 요구사항…", text: $item.instruction, lineLimit: 1...5)
                    } header: {
                        HStack {
                            Text("이미지 \(indexLabel(item))")
                            Spacer()
                            Button(role: .destructive) {
                                attachments.removeAll { $0.id == item.id }
                            } label: {
                                Image(systemName: "trash")
                            }
                            .accessibilityLabel("이미지 삭제")
                        }
                    }
                }
            }
            .navigationTitle("이미지 첨부")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                        .disabled(isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isUploading {
                        ProgressView()
                    } else {
                        Button("보내기") { onSend() }
                            .disabled(attachments.isEmpty)
                    }
                }
            }
            .fullScreenCover(item: $annotating) { target in
                AttachmentAnnotationEditor(draft: target) { updated in
                    // 에디터가 닫히기 전 배열의 항목을 교체 — instruction 은 에디터가 건드리지
                    // 않으므로 녹화 프레임의 시점 설명도 그대로 유지된다.
                    if let i = attachments.firstIndex(where: { $0.id == updated.id }) {
                        attachments[i] = updated
                    }
                }
            }
        }
    }

    /// 헤더의 "이미지 N" 번호 — 현재 배열에서의 1-기반 위치.
    private func indexLabel(_ item: AttachmentDraft) -> Int {
        (attachments.firstIndex { $0.id == item.id } ?? 0) + 1
    }
}
