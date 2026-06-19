import { describe, expect, it } from "vitest";
import {
  buildDesignContext,
  buildDesignerReviewPrompt,
  buildPoCollectPrompt,
  buildPoExecPrompt,
  buildPoResearchPrompt,
  buildPoRevisePrompt,
  buildPoWorkflowDesignPrompt,
  normalizePoLocale,
  type PoDecisionRecord,
  type PoExistingBrief,
} from "./prompt.js";
import { buildPoFallbackDef } from "./workflow-exec.js";
import {
  SECURITY_LENS_FOCUS,
  collectLensHeadmatter,
  lensPersona,
  researchLensHeadmatter,
  type PoLens,
} from "./lens.js";

/** 수집 프롬프트의 최소 필수 입력 — 나머지(이력·지시·리뷰 등)는 선택. */
const base = {
  repoPath: "/repo",
  outFile: "/tmp/out.json",
  existingBriefs: [] as PoExistingBrief[],
};

describe("buildPoCollectPrompt — 과거 결정 요약 주입 (점수 보정)", () => {
  it("이력이 0건/생략이면 섹션을 빼서 기존 동작과 동일 (회귀 없음)", () => {
    const without = buildPoCollectPrompt(base);
    const withEmpty = buildPoCollectPrompt({ ...base, decisionHistory: [] });
    expect(without).not.toContain("## 과거 결정 요약");
    expect(without).not.toContain("보정 지침");
    // 빈 배열도 섹션 없음 — 그리고 두 경로 산출이 완전히 동일해야 한다.
    expect(withEmpty).toBe(without);
  });

  it("이력이 있으면 섹션 + 보정 지침을 주입하고 건당 1줄로 요약한다", () => {
    const history: PoDecisionRecord[] = [
      { title: "A 기능", impact: 5, effort: 2, status: "verified", note: "관련 이슈 #12 닫힘" },
      { title: "B 기능", impact: 2, effort: 4, status: "rejected" },
      { title: "C 기능", impact: 3, effort: 3, status: "missed", note: "같은 불만 신호 잔존" },
      { title: "D 기능", impact: 4, effort: 1, status: "approved" },
    ];
    const out = buildPoCollectPrompt({ ...base, decisionHistory: history });

    // 섹션 + 보정 지침 존재.
    expect(out).toContain("## 과거 결정 요약");
    expect(out).toContain("보정 지침");
    // 결정/결과 라벨이 한국어로 매핑된다.
    expect(out).toContain("[검증됨] I5/E2 · A 기능 · 관련 이슈 #12 닫힘");
    expect(out).toContain("[기각] I2/E4 · B 기능");
    expect(out).toContain("[빗나감] I3/E3 · C 기능 · 같은 불만 신호 잔존");
    expect(out).toContain("[승인] I4/E1 · D 기능");
    // 기각 패턴 회피 + 검증 성공 적극 제안 지침.
    expect(out).toContain("«기각» 된 것과 비슷한 종류는 제안하지 마라");
    expect(out).toContain("«검증됨» 으로 성공한 종류는 더 적극적으로 제안");
    // 이번 회차 지시가 과거 패턴보다 우선임을 명시 (충돌 엣지).
    expect(out).toContain("이번 회차 지시가 우선");
    // 건당 정확히 1줄 — 이력 줄 수가 레코드 수와 같다.
    const lines = out.split("\n").filter((l) => /^- \[(검증됨|기각|빗나감|승인)\]/.test(l));
    expect(lines).toHaveLength(history.length);
  });

  it("사유(note)가 없는 옛 레코드는 제목+점수만으로 요약한다 (엣지)", () => {
    const out = buildPoCollectPrompt({
      ...base,
      decisionHistory: [{ title: "옛 제안", impact: 1, effort: 5, status: "rejected", note: null }],
    });
    // note 없으면 « · 근거» 꼬리 없이 줄이 끝난다.
    expect(out).toContain("- [기각] I1/E5 · 옛 제안\n");
    expect(out).not.toContain("옛 제안 · ");
  });
});

describe("buildPoCollectPrompt — GitHub 피드백 repo 분기", () => {
  it("미설정이면 현행대로 로컬 origin(`gh issue list`) 을 읽는다 (회귀 없음)", () => {
    const out = buildPoCollectPrompt(base);
    // 기본 GitHub 신호 문구 — 로컬 origin, -R 플래그 없음.
    expect(out).toContain("이 레포가 GitHub 원격이면");
    expect(out).toContain("gh issue list --limit 30");
    expect(out).not.toContain("-R ");
    expect(out).not.toContain("피드백 repo");
  });

  it("설정되면 GitHub 분기가 `gh -R <repo>` 로 그 repo 를 읽도록 지시한다", () => {
    const repo = "Wayne-Kim/pocket-sisyphus-mac";
    const out = buildPoCollectPrompt({ ...base, githubFeedbackRepo: repo });
    // 피드백 repo 를 -R 로 명시해 «로컬 origin 이 아니다» 를 분명히 한다.
    expect(out).toContain(`피드백 repo: ${repo}`);
    expect(out).toContain(`gh issue list -R ${repo} --limit 30`);
    expect(out).toContain(`gh api repos/${repo}/discussions`);
    expect(out).toContain("로컬 origin 이 아니다");
    // 코드·TODO·git·문서 신호는 여전히 로컬 레포 기준임을 한 줄로 못박는다.
    expect(out).toContain("«로컬 레포» 기준이다");
    // 기본(로컬 origin) 문구는 사라진다 — 한 대상만 읽어 중복 없음.
    expect(out).not.toContain("gh issue list --limit 30 --json");
  });

  it("앞뒤 공백은 trim 되고, 빈 문자열은 미설정과 동일하다 (엣지)", () => {
    const out = buildPoCollectPrompt({ ...base, githubFeedbackRepo: "  owner/name  " });
    expect(out).toContain("gh issue list -R owner/name --limit 30");
    const empty = buildPoCollectPrompt({ ...base, githubFeedbackRepo: "   " });
    expect(empty).toBe(buildPoCollectPrompt(base));
  });
});

describe("buildPoCollectPrompt — 기존·과거 백로그 dedup 앵커 (의미 중복 방지)", () => {
  const briefs: PoExistingBrief[] = [
    { title: "다크 모드 지원", problem: "설정에서 다크 모드를 켤 수 있어야 한다", status: "proposed" },
    { title: "PDF 내보내기", problem: "리포트를 PDF 로 저장", status: "rejected" },
    { title: "오프라인 동기화", problem: "네트워크 없이도 큐잉", status: "shipped" },
  ];

  it("제목뿐 아니라 status 라벨 + 문제(1줄)까지 렌더한다 (닫힌 결정 포함)", () => {
    const out = buildPoCollectPrompt({ ...base, existingBriefs: briefs });
    // 살아있는 제안 + 닫힌 결정(기각/출시)이 모두 status 라벨로 들어간다.
    expect(out).toContain("- [제안] 다크 모드 지원 — 설정에서 다크 모드를 켤 수 있어야 한다");
    expect(out).toContain("- [기각] PDF 내보내기 — 리포트를 PDF 로 저장");
    expect(out).toContain("- [출시] 오프라인 동기화 — 네트워크 없이도 큐잉");
    // 닫힌 결정도 «재제안 금지» 대상임을 헤더가 못박는다.
    expect(out).toContain("제목 재서술·기각·출시 포함");
  });

  it("의미-기준 중복 금지 지시 + dedup 자가분류 스키마를 산출 계약에 박는다", () => {
    const out = buildPoCollectPrompt({ ...base, existingBriefs: briefs });
    expect(out).toContain("**중복 금지 (의미 기준, 엄수)**");
    expect(out).toContain("제목 표현이 달라도");
    // 산출 스키마에 dedup 필드가 들어간다 — 에이전트가 산출 전 스스로 분류하게.
    expect(out).toContain('"dedup"');
    expect(out).toContain('"relation": "new|refinement"');
  });

  it("문제 본문은 1줄(80자)로 잘리고 개행이 공백으로 접힌다 (프롬프트 비대화 방지)", () => {
    const longProblem = "줄1\n줄2 " + "가".repeat(200);
    const out = buildPoCollectPrompt({
      ...base,
      existingBriefs: [{ title: "T", problem: longProblem, status: "proposed" }],
    });
    expect(out).toContain("- [제안] T — 줄1 줄2 " + "가".repeat(74));
    expect(out).not.toContain("줄1\n줄2");
  });

  it("0건이면 «(없음)» — 회귀 없음", () => {
    expect(buildPoCollectPrompt({ ...base, existingBriefs: [] })).toContain("(없음)");
  });

  it("missed 브리프는 «재제안 금지» 가 아니라 «재시도 후보» 로 분리 직렬화된다 (정책 분기)", () => {
    const withMissed: PoExistingBrief[] = [
      ...briefs,
      { title: "이전 메시지 더보기", problem: "messageHistory() 가 여전히 미호출", status: "missed" },
    ];
    const out = buildPoCollectPrompt({ ...base, existingBriefs: withMissed });

    // missed 는 «닫힌 결정» 헤더(재제안 금지) 아래가 아니라 별도 «재시도 후보» 섹션으로 들어간다.
    expect(out).toContain("출시됐으나 «빗나간» 기회 (재시도 후보 — 닫힌 결정 아님, 미해결 갭):");
    expect(out).toContain("- [빗나감] 이전 메시지 더보기 — messageHistory() 가 여전히 미호출");
    // 안내문 — 같은 접근 반복은 금지하되 «다른 접근» 의 새 브리프는 허용임을 명시.
    expect(out).toContain("**빗나감(missed) 재시도 규칙**");
    expect(out).toContain("다른 접근");
    expect(out).toContain("접근이 «달라야»");

    // 회귀 — 닫힌 결정/살아있는 제안은 여전히 «재제안 금지» 헤더 아래에 남는다(missed 만 분기).
    const forbiddenHeaderIdx = out.indexOf("제목 재서술·기각·출시 포함 — 재제안 금지");
    const missedHeaderIdx = out.indexOf("출시됐으나 «빗나간» 기회");
    expect(forbiddenHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("- [기각] PDF 내보내기")).toBeGreaterThan(forbiddenHeaderIdx);
    expect(out.indexOf("- [기각] PDF 내보내기")).toBeLessThan(missedHeaderIdx);
    // missed 라인은 금지 묶음 라인보다 «뒤» 의 재시도 섹션에 있다.
    expect(out.indexOf("- [빗나감] 이전 메시지 더보기")).toBeGreaterThan(missedHeaderIdx);
  });

  it("missed 가 없으면 재시도 섹션을 통째로 빼서 기존 동작과 동일 (회귀 없음)", () => {
    const out = buildPoCollectPrompt({ ...base, existingBriefs: briefs });
    expect(out).not.toContain("출시됐으나 «빗나간» 기회");
    expect(out).not.toContain("**빗나감(missed) 재시도 규칙**");
  });
});

describe("buildDesignContext — 레포-무관 디자인 컨텍스트 (선언 vs 자동 발견)", () => {
  it("designDirective 가 없으면 «자동 발견» 지시 — 특정 hue/로케일 수를 박지 않는다", () => {
    const ctx = buildDesignContext({});
    // 「디자인 제약(준수 필수)」 섹션 헤더 + 발견 지시.
    expect(ctx).toContain("## 디자인 제약(준수 필수)");
    expect(ctx).toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    // 스택-중립 후보 위치(토큰/문서/로케일)를 열거한다.
    expect(ctx).toContain("tailwind.config.*");
    expect(ctx).toContain("tokens.json");
    expect(ctx).toContain("*.xcstrings");
    expect(ctx).toContain("messages/*.json");
    expect(ctx).toContain("locales/");
    // 못 찾으면 보편 UX 기준만 — 정책 발명 금지.
    expect(ctx).toContain("못 찾으면 보편 UX 기준만 적용");
    // 레포-무관성: 이 레포(PocketSisyphus) 의 정책을 하드코딩하지 않는다.
    expect(ctx).not.toContain("보라");
    expect(ctx).not.toContain("10개");
    expect(ctx).not.toContain("accent");
    expect(ctx).not.toContain("warning");
  });

  it("designDirective 가 있으면 그 텍스트를 그대로 박는다 (레포가 선언한 최강 신호)", () => {
    const directive =
      "primary=indigo-600(브랜드/CTA), 위험=red-600. 지원 로케일: en/ja. focus ring 필수.";
    const ctx = buildDesignContext({ designDirective: directive });
    expect(ctx).toContain("## 디자인 제약(준수 필수)");
    expect(ctx).toContain("이 레포가 «선언» 한 디자인 약속이다");
    // 선언 텍스트가 토씨 그대로 들어간다.
    expect(ctx).toContain(directive);
    // 선언 모드에선 자동 발견 후보 열거는 나오지 않는다.
    expect(ctx).not.toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    expect(ctx).not.toContain("tailwind.config.*");
  });

  it("앞뒤 공백만이면 자동 발견과 동일하다 (엣지)", () => {
    expect(buildDesignContext({ designDirective: "   " })).toBe(buildDesignContext({}));
  });

  it("두 모드 모두 «UI 가 닿으면» 게이트를 둔다 (UI 무관 브리프 강요 금지)", () => {
    for (const ctx of [buildDesignContext({}), buildDesignContext({ designDirective: "x" })]) {
      expect(ctx).toContain("«UI 가 닿는» 브리프에만 적용된다");
      expect(ctx).toContain("UI 표면이 없는 일에는 디자인 기준을 강요하지 마라");
    }
  });
});

describe("buildPoCollectPrompt — 디자인 제약 주입", () => {
  it("항상 「디자인 제약」 섹션이 들어가고, 기본은 자동 발견이다 (레포-무관)", () => {
    const out = buildPoCollectPrompt(base);
    expect(out).toContain("## 디자인 제약(준수 필수)");
    expect(out).toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    // spec 산출에 «UI 가 닿는 브리프만» 디자인 수용 기준 지시가 붙는다.
    expect(out).toContain("디자인 수용 기준 (UI 가 닿는 브리프만)");
    // 하드코딩된 팔레트/로케일 수가 새지 않는다.
    expect(out).not.toContain("보라");
    expect(out).not.toContain("10개");
  });

  it("designDirective 가 있으면 그 선언이 프롬프트에 그대로 박힌다", () => {
    const directive = "color=teal 브랜드. 로케일: de/fr/it.";
    const out = buildPoCollectPrompt({ ...base, designDirective: directive });
    expect(out).toContain("이 레포가 «선언» 한 디자인 약속이다");
    expect(out).toContain(directive);
    // 자동 발견 폴백 문구는 사라진다.
    expect(out).not.toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
  });
});

describe("buildPoCollectPrompt — 전문가 관점 렌즈 (po_collect_lens_v1/v2)", () => {
  it("lens 생략/\"default\" 이면 기본 전방위 수집과 byte-identical (회귀 없음)", () => {
    const baseline = buildPoCollectPrompt(base);
    expect(buildPoCollectPrompt({ ...base, lens: "default" })).toBe(baseline);
    // 기본 경로엔 디자인/디버깅/보안 렌즈의 흔적이 없다.
    expect(baseline).not.toContain("«디자이너» 페르소나");
    expect(baseline).not.toContain("UI 표면 스캔");
    expect(baseline).not.toContain("## 수집 관점 — 디버깅·신뢰성 전문가");
    expect(baseline).not.toContain("## 수집 관점 — 보안 전문가");
    expect(baseline).toContain("## 1단계 — 신호 수집");
  });

  // qa/pm/marketing/analytics/ops/logic/ux 는 po_collect_lens_v3 로 «실제» 전문가가 됐다 — 각자
  // 페르소나(lensPersona) + 수집 머리말(collectLensHeadmatter)을 가진다. (옛 daemon 이 모르는 lens 를
  // 받아도 collectLensHeadmatter 가 빈 문자열로 떨어져 머리말 없는 default 로 안전 폴백하는 가드는
  // 그대로 — 단 페르소나는 lens.ts 가 알면 바뀐다.)
  it("lens=\"qa\" 이면 «QA 전문가» 페르소나 + 수집 머리말 (po_collect_lens_v3)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "qa" });
    expect(out).toContain("너는 이 저장소의 «QA(품질 보증) 전문가» 다");
    expect(out).not.toContain("프로덕트 오너(PO)");
    expect(out).toContain("## 수집 관점 — QA(품질 보증) 전문가");
    // 일반 수집 골격 유지 (디자인 부채 재구성이 아니다).
    expect(out).toContain("## 1단계 — 신호 수집");
    expect(out).not.toContain("## 1단계 — UI 표면 스캔");
  });

  it("lens=\"design\" 이면 «디자인 전문가» 정체성으로 UI 표면 스캔·부채 종합으로 재구성된다 (po_brief_lens_v1 — PO 가 아니라 그 전문가가 직접 쓴다)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "design" });
    // 정체성이 PO 가 아니라 «디자인 전문가» 다 (lensPersona) — 디자인을 «1급 주제» 로.
    expect(out).toContain("너는 이 저장소의 «디자인 전문가» 다");
    expect(out).not.toContain("프로덕트 오너(PO)");
    expect(out).toContain("«1급 주제»");
    // 1단계가 신호 수집이 아니라 «UI 표면 스캔(design SSOT 대비)» 으로 바뀐다.
    expect(out).toContain("## 1단계 — UI 표면 스캔 (design SSOT 대비, 가능한 것만)");
    expect(out).not.toContain("## 1단계 — 신호 수집");
    // 스캔 차원 — 토큰 드리프트·접근성·대비·패턴 불일치.
    expect(out).toContain("토큰 드리프트");
    expect(out).toContain("접근성");
    expect(out).toContain("패턴 불일치");
    // 2단계가 «디자인 부채» 종합.
    expect(out).toContain("## 2단계 — 종합: 디자인 부채 브리프 작성");
    // 「디자인 제약」 SSOT 섹션이 여전히 «측정 기준자» 로 들어간다 (재사용).
    expect(out).toContain("## 디자인 제약(준수 필수)");
    expect(out).toContain("«측정 기준자»");
  });

  it("lens=\"bug\" 이면 일반 수집 경로에 «디버깅·신뢰성» 머리말을 주입한다 (lens.ts SSOT — 리서치와 의미 일치)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "bug" });
    // 일반 수집 골격은 유지 (스키마/저장소 동일) — 디자인 부채 재구성이 아니다.
    expect(out).toContain("## 1단계 — 신호 수집");
    expect(out).not.toContain("## 1단계 — UI 표면 스캔");
    // 디버깅·신뢰성 머리말 — 크래시·실패 로그·재현·회귀를 «우선 신호» 로.
    expect(out).toContain("## 수집 관점 — 디버깅·신뢰성 전문가");
    expect(out).toContain("크래시");
    expect(out).toContain("재현");
    expect(out).toContain("회귀");
    // spec 에 재현/회귀 확인 방법을 담으라는 지시.
    expect(out).toContain("재현 방법");
    // 머리말은 「디자인 제약」 SSOT 섹션 «뒤», 1단계 «앞» 에 들어간다 (designContext 보존).
    const designIdx = out.indexOf("## 디자인 제약");
    const headIdx = out.indexOf("## 수집 관점 — 디버깅·신뢰성 전문가");
    const stageIdx = out.indexOf("## 1단계 — 신호 수집");
    expect(designIdx).toBeGreaterThanOrEqual(0);
    expect(headIdx).toBeGreaterThan(designIdx);
    expect(stageIdx).toBeGreaterThan(headIdx);
  });

  it("lens=\"security\" 이면 일반 수집 경로에 «보안» 머리말을 주입한다 (po_collect_lens_v2 — lens.ts SSOT)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "security" });
    // 일반 수집 골격 유지 (스키마/저장소 동일) — 디자인 부채 재구성이 아니다 (AC3: 같은 백로그).
    expect(out).toContain("## 1단계 — 신호 수집");
    expect(out).not.toContain("## 1단계 — UI 표면 스캔");
    // 보안 머리말 — 인증·키 취급·노출면·자격증명·위협모델 신호를 «우선 신호» 로.
    expect(out).toContain("## 수집 관점 — 보안 전문가");
    expect(out).toContain("인증");
    expect(out).toContain("키·시크릿 취급");
    expect(out).toContain("노출면");
    expect(out).toContain("자격증명 흐름");
    expect(out).toContain("위협모델");
    // spec 삼요소(위협/완화책/검증) — 리서치 security 렌즈와 같은 형으로 의미 일치.
    expect(out).toContain("위협(무엇을·누가)");
    expect(out).toContain("완화책");
    // UI 표면 없어도 동작 — daemon/CLI 전용 엣지케이스를 머리말이 명시한다.
    expect(out).toContain("코드·자격증명 흐름 신호라");
    // 보안 부채를 자동 차단하지 않는다 — 판정·결재는 사람 몫 (비-목표).
    expect(out).toContain("자동 «차단»");
    // AC3 — 산출 스키마 동일 + evidence ref 파일:라인/커밋 역추적.
    expect(out).toContain('"title"');
    expect(out).toContain('"evidence"');
    expect(out).toContain('"impact": 1-5');
    expect(out).toContain("파일:라인");
    // 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 수집 관점 — 디버깅·신뢰성 전문가");
    expect(out).not.toContain("«디자이너» 페르소나");
    // 머리말은 「디자인 제약」 «뒤», 1단계 «앞» (designContext 보존 — bug 와 동형).
    const designIdx = out.indexOf("## 디자인 제약");
    const headIdx = out.indexOf("## 수집 관점 — 보안 전문가");
    const stageIdx = out.indexOf("## 1단계 — 신호 수집");
    expect(designIdx).toBeGreaterThanOrEqual(0);
    expect(headIdx).toBeGreaterThan(designIdx);
    expect(stageIdx).toBeGreaterThan(headIdx);
  });

  it("AC1 — 수집 security 머리말이 리서치 security 렌즈와 같은 SECURITY_LENS_FOCUS 를 «공유» 한다 (중복 정의 금지 — design/designer 정합과 동형)", () => {
    const collect = collectLensHeadmatter("security");
    const research = researchLensHeadmatter("security");
    // 같은 SSOT 초점 문자열을 둘 다 «그대로» 포함 — 두 경로의 의미가 갈리지 않는다.
    expect(SECURITY_LENS_FOCUS.length).toBeGreaterThan(0);
    expect(collect).toContain(SECURITY_LENS_FOCUS);
    expect(research).toContain(SECURITY_LENS_FOCUS);
    // 수집은 «신호 수집·종합», 리서치는 «조사» 맥락이라 헤더는 다르되 초점은 같다.
    expect(collect).toContain("## 수집 관점 — 보안 전문가");
    expect(research).toContain("## 조사 관점 — 보안 전문가");
  });

  it("evidence 는 파일:라인 + 위반 토큰/패턴명을 강제하고, 산출 스키마는 기존과 동일 (design)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "design" });
    // AC2 — evidence 에 파일:라인 + 위반 토큰/패턴명.
    expect(out).toContain("파일:라인 + 위반 토큰/패턴명");
    expect(out).toContain('"ref": "파일:라인"');
    // 위반 예시(리터럴 .orange / 하드코딩 .white / 전역 .tint) — 스택-중립 «예» 로 제시.
    expect(out).toContain(".orange");
    expect(out).toContain(".white");
    expect(out).toContain(".tint");
    // AC3 — 같은 백로그 스키마(title/problem/evidence/impact/effort/scope/spec).
    expect(out).toContain('"title"');
    expect(out).toContain('"problem"');
    expect(out).toContain('"evidence"');
    expect(out).toContain('"impact": 1-5');
    expect(out).toContain('"effort": 1-5');
    expect(out).toContain('"scope"');
    expect(out).toContain('"spec"');
    // 디자인 부채 전용 evidence kind 분류.
    expect(out).toContain("design_token_drift");
    expect(out).toContain("design_a11y");
  });

  it("AC4 — 구현 후 검수(리뷰 게이트·수용 기준)와 역할 비중복을 명시한다 (design)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "design" });
    expect(out).toContain("«구현 전 발굴(discovery)»");
    expect(out).toContain("디자인 리뷰 게이트 노드");
    expect(out).toContain("디자인 수용 기준 블록");
    expect(out).toContain("역할이 겹치지 않는다");
  });

  it("레포-무관 — 이 레포(보라/10개 로케일) 정책을 하드코딩하지 않는다 (design)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "design" });
    expect(out).not.toContain("보라");
    expect(out).not.toContain("10개");
    // 위반 토큰명은 «이 레포 SSOT 의 명명» 을 따르라고 지시.
    expect(out).toContain("이 레포 SSOT 의 명명");
  });

  it("스토어 리뷰가 있으면 보강 신호 + asc_review kind 가 켜진다 (design, 엣지)", () => {
    const withReviews = buildPoCollectPrompt({
      ...base,
      lens: "design",
      storeReviews: { file: "/tmp/r.json", count: 3 },
    });
    expect(withReviews).toContain("asc_review");
    expect(withReviews).toContain("디자인 관련 불만만 골라 보강");
    // 리뷰가 없으면 asc_review kind 는 빠진다.
    const without = buildPoCollectPrompt({ ...base, lens: "design" });
    expect(without).not.toContain("asc_review");
  });
});

describe("전문가 페르소나 (po_brief_lens_v1) — PO 가 아니라 각 전문가가 «직접» 쓴다", () => {
  const researchBaseLocal = {
    repoPath: "/repo",
    topic: "음성 메모",
    reportFile: "/tmp/r.md",
    briefsFile: "/tmp/r.json",
    existingBriefs: [] as PoExistingBrief[],
  };
  // [lens, 정체성 문장에 들어갈 전문가명].
  const experts: Array<[PoLens, string]> = [
    ["bug", "«디버깅·신뢰성 전문가»"],
    ["qa", "«QA(품질 보증) 전문가»"],
    ["security", "«보안 전문가»"],
    ["pm", "«기획(PM/제품) 전문가»"],
    ["marketing", "«마케팅 전문가»"],
    ["analytics", "«분석(analytics) 전문가»"],
    ["ops", "«운영(ops) 전문가»"],
    ["logic", "«로직(도메인·정합성) 전문가»"],
    ["ux", "«UX(사용성) 전문가»"],
  ];

  it("default 수집·리서치는 PO 정체성 유지 (회귀 0)", () => {
    expect(buildPoCollectPrompt(base)).toContain("너는 이 저장소의 프로덕트 오너(PO) 에이전트다");
    expect(buildPoResearchPrompt(researchBaseLocal)).toContain(
      "너는 이 저장소의 프로덕트 오너(PO) 에이전트다",
    );
  });

  it("비-default 수집은 정체성이 그 전문가로 바뀐다 (PO 아님)", () => {
    for (const [lens, persona] of experts) {
      const out = buildPoCollectPrompt({ ...base, lens });
      expect(out).toContain(`너는 이 저장소의 ${persona} 다`);
      expect(out).not.toContain("프로덕트 오너(PO)");
    }
    // design 은 수집 전용 분기 — 정체성도 그 전문가.
    const design = buildPoCollectPrompt({ ...base, lens: "design" });
    expect(design).toContain("너는 이 저장소의 «디자인 전문가» 다");
    expect(design).not.toContain("프로덕트 오너(PO)");
  });

  it("비-default 리서치도 정체성이 그 전문가로 바뀐다 (PO 아님)", () => {
    for (const [lens, persona] of [...experts, ["design", "«디자인 전문가»"] as [PoLens, string]]) {
      const out = buildPoResearchPrompt({ ...researchBaseLocal, lens });
      expect(out).toContain(`너는 이 저장소의 ${persona} 다`);
      expect(out).not.toContain("프로덕트 오너(PO)");
    }
  });

  it("수집이 7개 신규 전문가(po_collect_lens_v3) 머리말을 깐다 (일반 수집 골격 유지)", () => {
    const headers: Array<[PoLens, string]> = [
      ["qa", "## 수집 관점 — QA(품질 보증) 전문가"],
      ["pm", "## 수집 관점 — 기획(PM/제품) 전문가"],
      ["marketing", "## 수집 관점 — 마케팅 전문가"],
      ["analytics", "## 수집 관점 — 분석(analytics) 전문가"],
      ["ops", "## 수집 관점 — 운영(ops) 전문가"],
      ["logic", "## 수집 관점 — 로직(도메인·정합성) 전문가"],
      ["ux", "## 수집 관점 — UX(사용성) 전문가"],
    ];
    for (const [lens, header] of headers) {
      const out = buildPoCollectPrompt({ ...base, lens });
      expect(out).toContain(header);
      // 디자인 부채 재구성이 아니라 일반 수집(신호 수집·종합) 골격 유지.
      expect(out).toContain("## 1단계 — 신호 수집");
      expect(out).not.toContain("## 1단계 — UI 표면 스캔");
    }
  });
});

describe("buildPoResearchPrompt — 디자인 제약 주입", () => {
  const researchBase = {
    repoPath: "/repo",
    topic: "음성 메모",
    reportFile: "/tmp/r.md",
    briefsFile: "/tmp/b.json",
    existingBriefs: [] as PoExistingBrief[],
  };

  it("기본은 자동 발견 + spec 디자인 수용 기준 지시", () => {
    const out = buildPoResearchPrompt(researchBase);
    expect(out).toContain("## 디자인 제약(준수 필수)");
    expect(out).toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    expect(out).toContain("디자인 수용 기준 (UI 가 닿는 브리프만)");
    expect(out).not.toContain("보라");
  });

  it("designDirective 선언을 그대로 박는다", () => {
    const directive = "primary=#0a7. RTL 지원(ar/he).";
    const out = buildPoResearchPrompt({ ...researchBase, designDirective: directive });
    expect(out).toContain(directive);
    expect(out).not.toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
  });
});

describe("buildPoResearchPrompt — 전문가 관점 렌즈 (po_research_lens_v1)", () => {
  const researchBase = {
    repoPath: "/repo",
    topic: "음성 메모",
    reportFile: "/tmp/r.md",
    briefsFile: "/tmp/b.json",
    existingBriefs: [] as PoExistingBrief[],
  };

  it("lens 생략/\"default\"(전방위)면 기존 리서치 프롬프트와 byte-identical (옛 클라이언트·회귀 없음)", () => {
    const baseline = buildPoResearchPrompt(researchBase);
    expect(buildPoResearchPrompt({ ...researchBase, lens: "default" })).toBe(baseline);
    // 기본 경로엔 렌즈 머리말 흔적이 없다.
    expect(baseline).not.toContain("## 조사 관점 —");
  });

  it("lens=\"design\" 이면 디자인 머리말 + 수집 designer 와 같은 렌즈 정의(DESIGN_LENS_FOCUS)를 주입", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "design" });
    expect(out).toContain("## 조사 관점 — 디자인 전문가");
    // 수집 designer 페르소나와 같은 초점 문자열을 공유한다 (중복 정의 금지 — lens.ts SSOT).
    expect(out).toContain("토큰 드리프트");
    expect(out).toContain("접근성");
    expect(out).toContain("수집의 «디자이너» 페르소나와 같은 렌즈");
    // 보고서·브리프 스키마(수집과 동일)는 그대로 유지된다.
    expect(out).toContain("스키마는 수집과 동일");
    // 레포-무관 — 특정 색을 가정하지 않는다.
    expect(out).not.toContain("보라");
  });

  it("lens=\"bug\" 이면 재현·로그·회귀 근거를 강조하는 디버깅 머리말을 주입", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "bug" });
    expect(out).toContain("## 조사 관점 — 디버깅 전문가");
    expect(out).toContain("재현 경로");
    expect(out).toContain("회귀");
    expect(out).toContain("로그");
    // 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 디자인 전문가");
    expect(out).not.toContain("## 조사 관점 — QA 전문가");
  });

  it("lens=\"qa\" 이면 테스트·수용 기준·커버리지 근거를 강조하는 QA 머리말을 주입 (po_research_lens_v2)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "qa" });
    expect(out).toContain("## 조사 관점 — QA 전문가");
    expect(out).toContain("수용 기준");
    expect(out).toContain("테스트 케이스");
    expect(out).toContain("커버리지");
    // 디버깅·보안 렌즈와 직교 — 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 디버깅 전문가");
    expect(out).not.toContain("## 조사 관점 — 보안 전문가");
  });

  it("lens=\"security\" 이면 인증·키 취급·노출면·위협모델 근거를 강조하는 보안 머리말을 주입 (po_research_lens_v3)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "security" });
    expect(out).toContain("## 조사 관점 — 보안 전문가");
    expect(out).toContain("인증");
    expect(out).toContain("키·시크릿 취급");
    expect(out).toContain("노출면");
    expect(out).toContain("자격증명 흐름");
    expect(out).toContain("위협모델");
    expect(out).toContain("신뢰 경계");
    // 웹 근거 강조엔 CVE·보안 모범 사례가 들어간다.
    expect(out).toContain("CVE");
    // 표면 없으면 빈 배열도 정답 — 엣지케이스를 머리말이 명시한다.
    expect(out).toContain("보안 브리프 0건");
    // 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 디버깅 전문가");
    expect(out).not.toContain("## 조사 관점 — QA 전문가");
  });

  it("lens=\"pm\" 이면 요구·우선순위·로드맵·트레이드오프 근거를 강조하는 기획 머리말을 주입 (po_research_lens_v4)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "pm" });
    expect(out).toContain("## 조사 관점 — 기획(PM/제품) 전문가");
    expect(out).toContain("우선순위");
    expect(out).toContain("로드맵");
    expect(out).toContain("트레이드오프");
    // 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 마케팅 전문가");
    expect(out).not.toContain("## 조사 관점 — 디자인 전문가");
  });

  it("lens=\"marketing\" 이면 메시징·포지셔닝·채널 근거를 강조하는 마케팅 머리말을 주입 (po_research_lens_v5)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "marketing" });
    expect(out).toContain("## 조사 관점 — 마케팅 전문가");
    expect(out).toContain("메시징");
    expect(out).toContain("포지셔닝");
    expect(out).toContain("채널");
    // 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 기획(PM/제품) 전문가");
    expect(out).not.toContain("## 조사 관점 — 분석(analytics) 전문가");
  });

  it("lens=\"analytics\" 이면 지표·퍼널·인사이트 근거를 강조하는 분석 머리말을 주입 (po_research_lens_v6)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "analytics" });
    expect(out).toContain("## 조사 관점 — 분석(analytics) 전문가");
    expect(out).toContain("지표");
    expect(out).toContain("퍼널");
    expect(out).toContain("인사이트");
    // 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 마케팅 전문가");
    expect(out).not.toContain("## 조사 관점 — 운영(ops) 전문가");
  });

  it("lens=\"ops\" 이면 배포·신뢰성·비용 근거를 강조하는 운영 머리말을 주입 (po_research_lens_v7)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "ops" });
    expect(out).toContain("## 조사 관점 — 운영(ops) 전문가");
    expect(out).toContain("배포");
    expect(out).toContain("신뢰성");
    expect(out).toContain("비용");
    // 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 분석(analytics) 전문가");
    expect(out).not.toContain("## 조사 관점 — 보안 전문가");
  });

  it("lens=\"logic\" 이면 정합성·불변식·중복·복잡성 근거를 강조하는 로직 머리말을 주입 (po_research_lens_v8)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "logic" });
    expect(out).toContain("## 조사 관점 — 로직(도메인·정합성) 전문가");
    expect(out).toContain("불변식");
    expect(out).toContain("중복");
    expect(out).toContain("죽은 코드");
    expect(out).toContain("정확성·단순성·유지보수성");
    // 「정상 동작하지만」 복잡·중복을 본다 — bug 렌즈(깨짐)와 직교함을 머리말이 명시한다.
    expect(out).toContain("정상 동작");
    expect(out).toContain("동작 보존");
    // 표면 없으면 빈 배열도 정답 — 엣지케이스를 머리말이 명시한다.
    expect(out).toContain("로직 브리프 0건");
    // 디버깅·운영 렌즈와 직교 — 다른 렌즈 머리말은 섞이지 않는다.
    expect(out).not.toContain("## 조사 관점 — 디버깅 전문가");
    expect(out).not.toContain("## 조사 관점 — 운영(ops) 전문가");
  });

  it("lens=\"logic\" 머리말은 보고서에 «상태머신 맵» 1절(상태·전이·불변식·트리거)을 «이해 산출물» 로 필수 요구한다", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "logic" });
    // 브리프의 #1 가치 — 제안만 내지 말고 재사용 가능한 «이해 산출물» 을 보고서에 남긴다.
    expect(out).toContain("이해 산출물");
    expect(out).toContain("상태머신 맵");
    // 상태·전이·전이 조건·불변식·트리거를 모두 명시해 표/맵으로 정리하게 한다.
    expect(out).toContain("상태");
    expect(out).toContain("전이");
    expect(out).toContain("전이 조건");
    expect(out).toContain("불변식");
    expect(out).toContain("트리거");
    expect(out).toContain("표/맵");
    // 성공 기준 — 후속 triage·개발자가 코드를 다시 reverse-engineering 하지 않고 평가.
    expect(out).toContain("reverse-engineering");
    // 스코프 비-목표 — 별도 저장소·UI 뷰어·그래프 없이 기존 보고서 마크다운 재사용.
    expect(out).toContain("기존 보고서 마크다운");
    expect(out).toContain("UI 뷰어");
  });

  it("lens=\"logic\" 머리말은 각 브리프 spec 에 동작 보존 계약(검증+blast-radius)을 «빠짐없이» 강제해 triage 가 판단하게 한다", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "logic" });
    // 동작 보존 검증 + blast-radius(영향 파일·테스트) 가 spec 계약에 명시된다 — 검증 안 된 «개선» 머지 방지.
    expect(out).toContain("동작 보존 검증");
    expect(out).toContain("회귀·테스트");
    expect(out).toContain("blast-radius(영향 받는 파일·테스트)");
    // «빠짐없이» + triage 승인/보류/기각 프레이밍으로 4필드 누락을 막는다.
    expect(out).toContain("«빠짐없이»");
    expect(out).toContain("승인/보류/기각");
    // 동작 보존을 검증할 수 없으면 브리프로 올리지 말라는 가드.
    expect(out).toContain("동작 보존을 검증할 수 없는 «개선» 은 브리프로 올리지 마라");
  });

  it("lens=\"ux\" 이면 Nielsen 10 휴리스틱·심각도·시나리오/개선안을 강조하는 UX 머리말을 주입 (po_research_lens_v9)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "ux" });
    expect(out).toContain("## 조사 관점 — UX(사용성) 전문가");
    // Nielsen 10 휴리스틱을 우선 조사 기준으로 제시한다.
    expect(out).toContain("Nielsen");
    expect(out).toContain("인식 vs 회상");
    // spec 구조 — 위반 휴리스틱 + 심각도 척도 + 사용 시나리오 / 개선안.
    expect(out).toContain("위반한 휴리스틱");
    expect(out).toContain("cosmetic·minor·major·catastrophic");
    expect(out).toContain("사용 시나리오");
    expect(out).toContain("개선안");
    // design(시각) 렌즈와의 차이를 머리말에 못박는다 — 토큰·색이 아니라 플로우 마찰·완수.
    expect(out).toContain("플로우 마찰");
    // 표면 없으면 빈 배열도 정답 — 엣지케이스를 머리말이 명시한다 (design/security/logic 과 동형).
    expect(out).toContain("UX 브리프 0건");
    // design(시각)·로직 렌즈 머리말과는 섞이지 않는다 (별개 렌즈).
    expect(out).not.toContain("## 조사 관점 — 디자인 전문가");
    expect(out).not.toContain("## 조사 관점 — 로직(도메인·정합성) 전문가");
  });

  it("lens=\"ux\" + screens=true 면 «화면 포함» 캡처·판정·화면 근거·graceful fallback 블록을 추가 (po_research_ux_screens_v1)", () => {
    const out = buildPoResearchPrompt({ ...researchBase, lens: "ux", screens: true });
    // 기본 ux 머리말은 그대로 유지된다 (블록이 «추가» 된다 — 대체가 아니다).
    expect(out).toContain("## 조사 관점 — UX(사용성) 전문가");
    expect(out).toContain("Nielsen");
    // 화면 포함 블록 — 렌더된 화면으로 판정.
    expect(out).toContain("## 화면 포함 — 렌더된 화면으로 휴리스틱 판정");
    // 레포-무관 — 이 레포의 «기존» 캡처 수단을 스스로 찾아 쓰라 (verify-ios/device·Storybook·웹 헤드리스).
    expect(out).toContain("이 레포의 «기존» 캡처 수단으로 렌더·캡처");
    expect(out).toContain("스크린샷");
    // 화면을 «눈으로» 보고 판정 — 코드 추론이 아니라.
    expect(out).toContain("화면을 «눈으로» 보고 판정");
    // 화면 근거 — evidence kind "screenshot" (ingest 자유 문자열, 스키마 변경 없음).
    expect(out).toContain("\"kind\": \"screenshot\"");
    // graceful fallback — 화면 못 얻으면 코드+웹 + 보고서에 한계 명시.
    expect(out).toContain("graceful fallback");
    expect(out).toContain("화면을 보지 못해 코드·웹 추론으로만 판정함");
  });

  it("lens=\"ux\" + screens 생략/false 면 기존 ux 머리말과 byte-identical (화면 블록 없음, 회귀 0)", () => {
    const baseline = buildPoResearchPrompt({ ...researchBase, lens: "ux" });
    const explicitFalse = buildPoResearchPrompt({ ...researchBase, lens: "ux", screens: false });
    expect(baseline).toBe(explicitFalse);
    // 화면 포함 블록이 붙지 않는다.
    expect(baseline).not.toContain("## 화면 포함 — 렌더된 화면으로 휴리스틱 판정");
    expect(baseline).not.toContain("\"kind\": \"screenshot\"");
  });

  it("screens=true 라도 ux 외 렌즈(default·design)면 화면 블록을 붙이지 않는다 (ux 전용)", () => {
    // default 는 screens 와 무관하게 머리말 없는 전방위 프롬프트와 동일.
    const def = buildPoResearchPrompt({ ...researchBase, screens: true });
    expect(def).toBe(buildPoResearchPrompt({ ...researchBase }));
    expect(def).not.toContain("## 화면 포함 — 렌더된 화면으로 휴리스틱 판정");
    // design 렌즈도 screens 를 무시한다.
    const design = buildPoResearchPrompt({ ...researchBase, lens: "design", screens: true });
    expect(design).toBe(buildPoResearchPrompt({ ...researchBase, lens: "design" }));
    expect(design).not.toContain("## 화면 포함 — 렌더된 화면으로 휴리스틱 판정");
  });
});

describe("buildPoResearchPrompt — 조사 범위(scope) 분기", () => {
  const researchBase = {
    repoPath: "/repo",
    topic: "음성 메모",
    reportFile: "/tmp/r.md",
    briefsFile: "/tmp/b.json",
    existingBriefs: [] as PoExistingBrief[],
  };

  it("기본(생략)·web_repo 는 웹 조사 핵심 + web/market 최소 1개 (회귀 없음)", () => {
    for (const out of [
      buildPoResearchPrompt(researchBase),
      buildPoResearchPrompt({ ...researchBase, scope: "web_repo" }),
    ]) {
      expect(out).toContain("웹 조사 (핵심)");
      expect(out).toContain("각 브리프는 web/market 근거를 최소 1개");
      expect(out).toContain("경쟁/대안 현황");
      expect(out).not.toContain("레포만 조사 — 웹 검색 금지");
    }
  });

  it("repo_only 는 웹 조사를 끄고 레포 근거만으로 작성하게 분기한다", () => {
    const out = buildPoResearchPrompt({ ...researchBase, scope: "repo_only" });
    // 웹 조사 단계 제거 → 레포만 조사로 치환
    expect(out).toContain("레포만 조사 — 웹 검색 금지");
    expect(out).not.toContain("웹 조사 (핵심)");
    // 보고서에 범위가 레포 한정이었음(웹 미사용)을 명시
    expect(out).toContain("조사 범위: 레포만 (웹 미사용)");
    // 브리프 근거는 repo 만으로 허용 — web/market 최소 1개 규칙 해제
    expect(out).toContain("각 브리프는 레포 근거(repo)를 최소 1개");
    expect(out).not.toContain("각 브리프는 web/market 근거를 최소 1개");
  });
});

describe("buildPoExecPrompt — 디자인 제약 주입 (기본/세션 승인 경로)", () => {
  const execBrief = { title: "T", problem: "P", scope: "S", spec: "SPEC" };

  it("브리프 본문(문제/스코프/스펙)과 검증 지시는 그대로 유지된다 (회귀 없음)", () => {
    const out = buildPoExecPrompt(execBrief);
    expect(out).toContain("승인된 기회 브리프를 구현하라.");
    expect(out).toContain("## 문제\nP");
    expect(out).toContain("## 스코프\nS");
    expect(out).toContain("## 스펙\nSPEC");
    expect(out).toContain("구현 후 가능한 수단(테스트/빌드/실행)으로 스스로 검증");
    expect(out).toContain("스코프의 비-목표는 건드리지 마라");
  });

  it("designDirective 가 없으면 「디자인 제약」 섹션 + 자동 발견 + «직접 따르라» 문구 (레포-무관)", () => {
    const out = buildPoExecPrompt(execBrief);
    expect(out).toContain("## 디자인 제약(준수 필수)");
    expect(out).toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    // 워크플로우 노드와 같은 한계 명시 — 이 세션 에이전트가 CLAUDE.md 를 자동 못 읽을 수 있다.
    expect(out).toContain("CLAUDE.md/AGENTS.md 를 자동으로 읽지 못할 수 있다");
    expect(out).toContain("위 디자인 제약을 «직접» 따르라");
    // 레포-무관: 이 레포(PocketSisyphus)의 팔레트/로케일 수가 하드코딩돼 새지 않는다.
    expect(out).not.toContain("보라");
    expect(out).not.toContain("10개");
  });

  it("designDirective 선언을 그대로 박고 자동 발견 폴백은 사라진다", () => {
    const directive = "brand=violet. locales: ko/en only. focus ring 필수.";
    const out = buildPoExecPrompt(execBrief, directive);
    expect(out).toContain("이 레포가 «선언» 한 디자인 약속이다");
    expect(out).toContain(directive);
    expect(out).not.toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    // 선언 모드에서도 «직접 따르라» 문구는 유지된다 (비-Claude 에이전트 대비).
    expect(out).toContain("위 디자인 제약을 «직접» 따르라");
  });

  it("UI 무관 브리프 강요 금지 — «UI 가 닿으면» 게이트가 섹션 안에 있다 (판단을 위임)", () => {
    // 섹션은 항상 들어가되, daemon/CLI/스키마처럼 UI 표면이 없는 브리프는 섹션 안의 게이트가
    // 거른다 — 프롬프트가 브리프 본문을 파싱하지 않고 에이전트에게 적용 여부를 위임한다.
    const out = buildPoExecPrompt(execBrief, "x");
    expect(out).toContain("«UI 가 닿는» 브리프에만 적용된다");
    expect(out).toContain("UI 표면이 없는 일에는 디자인 기준을 강요하지 마라");
  });

  it("앞뒤 공백만인 designDirective 는 자동 발견과 동일하다 (엣지)", () => {
    expect(buildPoExecPrompt(execBrief, "   ")).toBe(buildPoExecPrompt(execBrief));
  });
});

describe("buildDesignerReviewPrompt — 렌더→스크린샷→SSOT 대비 비평 (게이트 입력 evidence)", () => {
  it("캡처→비평→findings 계약 + 2회 일치 투표 + 정규화 좌표/토큰을 모두 지시한다", () => {
    const out = buildDesignerReviewPrompt({ briefTitle: "탭 색 정리" });
    // 검토 맥락(브리프 제목)이 들어간다.
    expect(out).toContain("탭 색 정리");
    // 디자인 SSOT 섹션을 재사용(buildDesignContext) — 기본은 자동 발견(레포-무관).
    expect(out).toContain("## 디자인 제약(준수 필수)");
    expect(out).toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    // AC1: 이 레포의 «기존» 캡처 수단을 스택-중립으로 «발견»해 쓴다 — 새 수단 발명 금지.
    expect(out).toContain("이 레포가 이미 가진 렌더/캡처 수단을 스스로 찾아 써라");
    expect(out).toContain("새 수단을 발명하지 마라");
    expect(out).toContain("스크린샷을 «이 노드의 결과 폴더에» 저장");
    // 레포-무관: pocket-sisyphus 전용 경로/스킬을 «예시» 로도 박지 않는다.
    expect(out).not.toContain("/verify-ios");
    expect(out).not.toContain("scripts/verify-*.sh");
    // AC2: 스크린샷을 직접 보고 SSOT 대비 비평 + 각 finding 에 무엇/어디서.
    expect(out).toContain("직접 열어");
    expect(out).toContain("정규화 좌표");
    expect(out).toContain("x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>");
    expect(out).toContain("토큰명");
    // AC4: 비결정성 완화 — 2회 일치 투표.
    expect(out).toContain("독립적으로 최소 2회");
    expect(out).toContain("confirmed");
    // 게이트 보조 역할 — 증거 전용, 코드 수정/커밋 금지(게이트 대체 아님).
    expect(out).toContain("게이트를 대체하지 않는다");
    expect(out).toContain("코드를 고치거나 커밋하지 마라");
    // UI 무관이면 빌드 없이 자가 통과 (always-두되 내부 게이트).
    expect(out).toContain("UI 표면 없음 — 디자인 리뷰 생략");
    // 레포-무관성: 특정 팔레트/로케일 수가 새지 않는다.
    expect(out).not.toContain("보라");
    expect(out).not.toContain("10개");
  });

  it("designDirective 가 있으면 그 선언이 SSOT 섹션에 그대로 박힌다", () => {
    const directive = "강조=violet, 프리미엄=orange, 경고=yellow (혼동 금지).";
    const out = buildDesignerReviewPrompt({ briefTitle: "T", designDirective: directive });
    expect(out).toContain(directive);
    expect(out).toContain("이 레포가 «선언» 한 디자인 약속이다");
    expect(out).not.toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
  });
});

describe("buildPoWorkflowDesignPrompt — 디자인 제약 주입", () => {
  const wfBase = {
    brief: { title: "T", problem: "P", scope: "S", spec: "SPEC" },
    outFile: "/tmp/wf.json",
    agentIds: ["claude_code"],
    defaultAgent: "claude_code",
  };

  it("설계 프롬프트에도 「디자인 제약」 + 노드에 직접 담으라는 지시가 들어간다", () => {
    const out = buildPoWorkflowDesignPrompt(wfBase);
    expect(out).toContain("## 디자인 제약(준수 필수)");
    expect(out).toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
    // 비-claude 노드 세션은 CLAUDE.md 를 자동 로드하지 못하므로 prompt 에 직접 담으라 명시.
    expect(out).toContain("구현 노드 prompt 에 «직접» 담아라");
    expect(out).not.toContain("보라");
  });

  it("UI 브리프엔 «디자이너 리뷰» 노드를 게이트 직전에 두라는 골격 지시가 들어간다", () => {
    const out = buildPoWorkflowDesignPrompt(wfBase);
    // 자가검증과 게이트 사이 — 게이트의 «직전» 노드로 findings 가 입력 evidence 로 흘러가게.
    expect(out).toContain("디자이너 리뷰 (UI 가 닿는 브리프만)");
    expect(out).toContain("게이트의 «직전» 노드");
    expect(out).toContain("정규화 좌표 또는 토큰명");
    expect(out).toContain("2회 이상 비평해 일치한 것만");
    // 증거 전용 — 자동 차단(fail 루프)이 아니라 사람이 결재 때 본다.
    expect(out).toContain("«실패» 간선 없음");
    // 렌더 표면 없으면 노드를 두지 않는다.
    expect(out).toContain("렌더 표면이 없는 브리프면 이 노드를 두지 마라");
  });

  it("designDirective 선언을 그대로 박는다", () => {
    const directive = "brand=violet. locales: ko/en only.";
    const out = buildPoWorkflowDesignPrompt({ ...wfBase, designDirective: directive });
    expect(out).toContain(directive);
    expect(out).not.toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
  });

  it("자가 검증 골격이 i18n 점검을 «스택-중립» 으로 연결한다 (이 레포 전용 경로 비-하드코딩)", () => {
    const out = buildPoWorkflowDesignPrompt(wfBase);
    // 노출 문자열/번역이 닿으면 «레포의» i18n 점검 수단을 돌려 리소스/카탈로그 우회 후보를
    // 표면화하라는 스택-중립 지시 — 특정 스크립트/스킬 경로를 박지 않는다.
    expect(out).toContain("번역(i18n)이 닿는 변경이면");
    expect(out).toContain("리소스/카탈로그를 우회");
    expect(out).toContain("누락 로케일 회귀");
    // 이 레포 전용 경로(스크립트·스킬)·정책이 배포 프롬프트로 새지 않는다(레포-무관 유지).
    expect(out).not.toContain("scripts/i18n-lint.sh");
    expect(out).not.toContain("scripts/design-lint.sh");
    expect(out).not.toContain("/verify-ios");
    expect(out).not.toContain("보라");
  });
});

describe("레포-무관 — pocket-sisyphus 전용 컨벤션이 사용자 레포로 새지 않는다", () => {
  // 배포되는 프롬프트(수집·리서치·구현·워크플로우 설계·fallback 템플릿)는 «프레임워크 방향» 만
  // 주고 이 프로젝트 고유의 경로/스킬(docs/todo-*.md, /verify-ios)·스택 전제(iOS 앱 + daemon)를
  // 박지 않는다 — 디자인 컨텍스트의 «보라 비-하드코딩» 가드와 같은 회귀 방지.
  const collect = buildPoCollectPrompt({ repoPath: "/repo", outFile: "/tmp/o.json", existingBriefs: [] });
  const research = buildPoResearchPrompt({
    repoPath: "/repo",
    topic: "X",
    reportFile: "/tmp/r.md",
    briefsFile: "/tmp/b.json",
    existingBriefs: [],
  });
  const exec = buildPoExecPrompt({ title: "T", problem: "P", scope: "S", spec: "SPEC" });
  const workflowDesign = buildPoWorkflowDesignPrompt({
    brief: { title: "T", problem: "P", scope: "S", spec: "SPEC" },
    outFile: "/tmp/wf.json",
    agentIds: ["claude_code"],
    defaultAgent: "claude_code",
  });
  // fallback 템플릿의 모든 노드 prompt 를 한 문자열로 펼쳐 검사.
  const fallback = JSON.stringify(
    buildPoFallbackDef(
      { id: "b1", repo_path: "/repo", title: "T", problem: "P", scope: "S", spec: "SPEC" },
      "claude_code",
    ),
  );

  for (const [name, text] of Object.entries({ collect, research, exec, workflowDesign, fallback })) {
    it(`${name}: 프로젝트 전용 경로/스킬/스택을 하드코딩하지 않는다`, () => {
      // 이 레포 고유 컨벤션 — 다른 레포엔 없는 경로/스킬이라 강요하면 안 됨.
      expect(text).not.toContain("docs/todo-*.md");
      expect(text).not.toContain("docs/todo-");
      expect(text).not.toContain("/verify-ios");
      // 색/토큰 정적 린트도 이 레포 전용 경로 — i18n-lint.sh 와 같은 가드(레포-무관 유지).
      expect(text).not.toContain("scripts/i18n-lint.sh");
      expect(text).not.toContain("scripts/design-lint.sh");
      // 스택 전제(iOS 앱 + daemon)도 «예시» 로 박지 않는다.
      expect(text).not.toContain("iOS UI 변경");
      expect(text).not.toContain("daemon/서버 변경");
      expect(text).not.toContain("daemon / iOS");
    });
  }
});

describe("normalizePoLocale — 지원 집합 경계 정규화 (po_locale_v1)", () => {
  it("지원 집합의 canonical 표기는 그대로 통과한다", () => {
    for (const c of ["ar", "en", "es", "fr", "hi", "ja", "ko", "pt-BR", "ru", "zh-Hans"]) {
      expect(normalizePoLocale(c)).toBe(c);
    }
  });

  it("대소문자/공백을 정규화한다 (canonical 로 수렴)", () => {
    expect(normalizePoLocale("EN")).toBe("en");
    expect(normalizePoLocale("  ko  ")).toBe("ko");
    expect(normalizePoLocale("pt-br")).toBe("pt-BR");
    expect(normalizePoLocale("ZH-HANS")).toBe("zh-Hans");
  });

  it("지역/스크립트 꼬리표는 베이스/canonical 로 폴백한다", () => {
    expect(normalizePoLocale("en-US")).toBe("en");
    expect(normalizePoLocale("es-419")).toBe("es");
    expect(normalizePoLocale("pt")).toBe("pt-BR"); // 지원하는 유일한 pt 변형
    expect(normalizePoLocale("pt-PT")).toBe("pt-BR");
    expect(normalizePoLocale("zh")).toBe("zh-Hans");
    expect(normalizePoLocale("zh-Hans-CN")).toBe("zh-Hans");
  });

  it("미지원/이상값/비-문자열은 undefined (한국어 폴백 신호)", () => {
    expect(normalizePoLocale("zh-Hant")).toBeUndefined(); // 번체는 지원 집합에 없다
    expect(normalizePoLocale("zh-TW")).toBeUndefined();
    expect(normalizePoLocale("de")).toBeUndefined();
    expect(normalizePoLocale("")).toBeUndefined();
    expect(normalizePoLocale("   ")).toBeUndefined();
    expect(normalizePoLocale(undefined)).toBeUndefined();
    expect(normalizePoLocale(null)).toBeUndefined();
    expect(normalizePoLocale(42)).toBeUndefined();
  });
});

describe("산출 언어 지시 (po_locale_v1) — collect/research/revise", () => {
  const reviseBase = {
    brief: {
      title: "T",
      problem: "P",
      evidence: "[]",
      impact: 3,
      effort: 2,
      scope: "S",
      spec: "SPEC",
    },
    comment: "이 부분을 더 구체적으로",
    outFile: "/tmp/rev.json",
  };
  const researchBase = {
    repoPath: "/repo",
    topic: "음성 메모",
    reportFile: "/tmp/r.md",
    briefsFile: "/tmp/b.json",
    existingBriefs: [] as PoExistingBrief[],
  };

  it("locale 누락이면 세 빌더 모두 기존과 byte-identical (옛 클라이언트 — 회귀 0)", () => {
    expect(buildPoCollectPrompt({ ...base, locale: undefined })).toBe(buildPoCollectPrompt(base));
    expect(buildPoResearchPrompt({ ...researchBase, locale: undefined })).toBe(
      buildPoResearchPrompt(researchBase),
    );
    expect(buildPoRevisePrompt({ ...reviseBase, locale: undefined })).toBe(
      buildPoRevisePrompt(reviseBase),
    );
  });

  it("locale='ko'(소스 언어) 면 byte-identical — 산출 언어 지시 없음", () => {
    expect(buildPoCollectPrompt({ ...base, locale: "ko" })).toBe(buildPoCollectPrompt(base));
    expect(buildPoResearchPrompt({ ...researchBase, locale: "ko" })).toBe(
      buildPoResearchPrompt(researchBase),
    );
    expect(buildPoRevisePrompt({ ...reviseBase, locale: "ko" })).toBe(buildPoRevisePrompt(reviseBase));
  });

  it("미지원 코드(zh-Hant·de)도 byte-identical — graceful fallback", () => {
    expect(buildPoCollectPrompt({ ...base, locale: "zh-Hant" })).toBe(buildPoCollectPrompt(base));
    expect(buildPoCollectPrompt({ ...base, locale: "de" })).toBe(buildPoCollectPrompt(base));
    expect(buildPoResearchPrompt({ ...researchBase, locale: "de" })).toBe(
      buildPoResearchPrompt(researchBase),
    );
  });

  it("비-ko 지원 로케일이면 산출 언어 지시를 «끝» 에 덧붙인다 (English)", () => {
    const out = buildPoCollectPrompt({ ...base, locale: "en" });
    expect(out).toContain("## 산출 언어 (사용자 앱 언어 — 필수)");
    expect(out).toContain("English");
    // 지시는 프롬프트 «끝» 에 붙는다 — 기존 본문(브리프 N건 작성 완료)은 그 앞에 그대로 있다.
    expect(out.indexOf("브리프 N건 작성 완료")).toBeLessThan(out.indexOf("## 산출 언어"));
  });

  it("각 로케일이 자기 언어 이름으로 들어간다 (research 보고서/브리프)", () => {
    expect(buildPoResearchPrompt({ ...researchBase, locale: "ja" })).toContain("日本語 (Japanese)");
    expect(buildPoResearchPrompt({ ...researchBase, locale: "pt-BR" })).toContain(
      "Português do Brasil",
    );
    // 지역 꼬리표 입력도 정규화돼 같은 지시를 만든다.
    expect(buildPoResearchPrompt({ ...researchBase, locale: "fr-CA" })).toContain(
      "Français (French)",
    );
  });

  it("design 렌즈 수집도 산출 언어 지시를 받는다 (디자인 부채 브리프도 앱 언어로)", () => {
    const out = buildPoCollectPrompt({ ...base, lens: "design", locale: "es" });
    expect(out).toContain("## 산출 언어 (사용자 앱 언어 — 필수)");
    expect(out).toContain("Español (Spanish)");
    // 디자인 렌즈 본문은 유지 — 지시는 그 뒤에 붙는다.
    expect(out.indexOf("디자인 부채 N건 작성 완료")).toBeLessThan(out.indexOf("## 산출 언어"));
  });

  it("revise 도 비-ko 면 갱신본을 앱 언어로 쓰라는 지시를 받는다", () => {
    const out = buildPoRevisePrompt({ ...reviseBase, locale: "ru" });
    expect(out).toContain("## 산출 언어 (사용자 앱 언어 — 필수)");
    expect(out).toContain("Русский (Russian)");
    expect(out.indexOf("재종합 완료")).toBeLessThan(out.indexOf("## 산출 언어"));
  });
});
