import SwiftUI

/// 예약 빈도 프리셋. 「고급」 은 5필드 cron 식을 직접 입력 — 크론탭 전체 표현력 확보.
enum CronFrequency: String, CaseIterable, Identifiable {
    case hourly, daily, weekdays, weekly, monthly, advanced
    var id: String { rawValue }

    var label: LocalizedStringKey {
        switch self {
        case .hourly: return "매시간"
        case .daily: return "매일"
        case .weekdays: return "평일"
        case .weekly: return "매주"
        case .monthly: return "매월"
        case .advanced: return "고급"
        }
    }
}

/// 프리셋으로 5필드 cron 식을 «쉽게» 만들고, 「고급」 에서는 raw cron 을 직접 입력하게 하는
/// 빌더. 결과 식을 `schedule` 바인딩으로 부모(CronEditorSheet)에 흘린다. 부모가 그 값으로
/// daemon 미리보기(다음 실행)를 호출한다.
///
/// 편집 모드 진입 시 기존 식을 프리셋으로 «역파싱» 한다 — 우리가 생성하는 패턴과 일치하면
/// 그 프리셋으로, 아니면 advanced(raw) 로 떨어진다.
struct ScheduleBuilder: View {
    @Binding var schedule: String

    @State private var freq: CronFrequency = .daily
    @State private var minute: Int = 0
    @State private var hour: Int = 9
    /// cron dow 0=일 … 6=토.
    @State private var weekdays: Set<Int> = [1, 2, 3, 4, 5]
    @State private var dayOfMonth: Int = 1
    @State private var raw: String = ""
    /// 역파싱/초기화 중에는 onChange 재컴파일을 막는다 (무한 루프/덮어쓰기 방지).
    @State private var hydrating = true

    private let weekdaySymbols = Calendar.current.shortWeekdaySymbols // index 0 = 일요일

    var body: some View {
        Group {
            Picker("빈도", selection: $freq) {
                ForEach(CronFrequency.allCases) { f in
                    Text(f.label).tag(f)
                }
            }
            .pickerStyle(.segmented)

            switch freq {
            case .hourly:
                Picker("분", selection: $minute) {
                    ForEach(0..<60, id: \.self) { m in
                        Text("\(m)분").tag(m)
                    }
                }
                Text("매시 \(minute)분에 실행돼요.")
                    .font(.caption2).foregroundStyle(.secondary)
            case .daily, .weekdays:
                timePicker
            case .weekly:
                timePicker
                weekdayPicker
            case .monthly:
                timePicker
                Picker("날짜", selection: $dayOfMonth) {
                    ForEach(1..<32, id: \.self) { d in
                        Text("\(d)일").tag(d)
                    }
                }
            case .advanced:
                TextField("0 9 * * 1-5", text: $raw)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text("분 시 일 월 요일 — 5필드 cron 식. 예: `0 9 * * 1-5` (평일 09:00)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .onAppear { hydrateFromSchedule() }
        .onChange(of: freq) { _ in recompile() }
        .onChange(of: minute) { _ in recompile() }
        .onChange(of: hour) { _ in recompile() }
        .onChange(of: weekdays) { _ in recompile() }
        .onChange(of: dayOfMonth) { _ in recompile() }
        .onChange(of: raw) { _ in recompile() }
    }

    private var timePicker: some View {
        DatePicker(
            "시각",
            selection: Binding(
                get: {
                    var c = DateComponents()
                    c.hour = hour
                    c.minute = minute
                    return Calendar.current.date(from: c) ?? Date()
                },
                set: { newDate in
                    let c = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                    hour = c.hour ?? 0
                    minute = c.minute ?? 0
                }
            ),
            displayedComponents: .hourAndMinute
        )
    }

    private var weekdayPicker: some View {
        HStack(spacing: 6) {
            ForEach(0..<7, id: \.self) { d in
                let on = weekdays.contains(d)
                Button {
                    if on { weekdays.remove(d) } else { weekdays.insert(d) }
                } label: {
                    Text(weekdaySymbols[d])
                        .font(.caption)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(on ? Color.accentColor : Color.secondary.opacity(0.15))
                        .foregroundStyle(on ? Theme.onAccent : .primary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - cron 식 생성 / 역파싱

    /// 현재 빌더 상태 → cron 식. weekly 에서 요일 미선택이면 매일(* )로 폴백.
    private func compiledSchedule() -> String {
        switch freq {
        case .hourly:
            return "\(minute) * * * *"
        case .daily:
            return "\(minute) \(hour) * * *"
        case .weekdays:
            return "\(minute) \(hour) * * 1-5"
        case .weekly:
            let days = weekdays.sorted().map(String.init).joined(separator: ",")
            return "\(minute) \(hour) * * \(days.isEmpty ? "*" : days)"
        case .monthly:
            return "\(minute) \(hour) \(dayOfMonth) * *"
        case .advanced:
            return raw.trimmingCharacters(in: .whitespaces)
        }
    }

    private func recompile() {
        guard !hydrating else { return }
        schedule = compiledSchedule()
    }

    /// 기존 schedule 을 빌더 상태로 역파싱. 우리가 만드는 패턴과 일치하면 그 프리셋으로,
    /// 아니면 advanced(raw) 로.
    private func hydrateFromSchedule() {
        hydrating = true
        defer {
            hydrating = false
            // 빈 초기값이면 기본 프리셋(daily 09:00)의 식을 즉시 부모로 내려보낸다.
            if schedule.trimmingCharacters(in: .whitespaces).isEmpty {
                schedule = compiledSchedule()
            }
        }
        let expr = schedule.trimmingCharacters(in: .whitespaces)
        guard !expr.isEmpty else { freq = .daily; return }
        let f = expr.split(separator: " ").map(String.init)
        guard f.count == 5, let mi = Int(f[0]) else {
            freq = .advanced
            raw = expr
            return
        }
        let (fMin, fHour, fDom, fMon, fDow) = (f[0], f[1], f[2], f[3], f[4])
        // 매시간: "M * * * *"
        if fHour == "*", fDom == "*", fMon == "*", fDow == "*" {
            freq = .hourly; minute = mi; return
        }
        guard let hr = Int(fHour) else { freq = .advanced; raw = expr; return }
        // 매일: "M H * * *"
        if fDom == "*", fMon == "*", fDow == "*" {
            freq = .daily; minute = mi; hour = hr; return
        }
        // 매월: "M H D * *"
        if fMon == "*", fDow == "*", let dom = Int(fDom) {
            freq = .monthly; minute = mi; hour = hr; dayOfMonth = dom; return
        }
        // 평일 / 매주: "M H * * <dow>"
        if fDom == "*", fMon == "*" {
            if fDow == "1-5" {
                freq = .weekdays; minute = mi; hour = hr; return
            }
            let days = fDow.split(separator: ",").compactMap { Int($0) }
            if !days.isEmpty, days.allSatisfy({ (0...6).contains($0) }), String(fMin) == f[0] {
                freq = .weekly; minute = mi; hour = hr; weekdays = Set(days); return
            }
        }
        freq = .advanced
        raw = expr
    }
}
