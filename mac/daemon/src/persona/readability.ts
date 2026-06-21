// PO 브리프 «가독성(이해 가능성)» 정적 검사 — 결정적(LLM 무관) 휴리스틱.
//
// 배경: 브리프 1(프롬프트 평이화)로 제목을 평이하게 고쳐도, 보정 앵커(과거 결정 요약,
// messages.collect 의 historyList)와 모델 드리프트로 몇 달 운영하면 제목이 다시 «빽빽» 해진다
// (파일경로·코드심볼·«—» 다중 절이 제목/problem 으로 새어 든다). ingest 검증(parseBriefDraft)은
// 필수필드·길이 cap·dedup 만 보고 «이해 가능성» 엔 자동 게이트가 없었다 — 시각 디자인(design-lint)과
// 중복(similarity)엔 게이트가 있는데 이 한 축만 비어, 사람이 매번 눈으로 잡지 않으면 회귀가 재발했다.
// 이 모듈이 그 마지막 그물이다: design-lint(시각 토큰)·similarity(중복)와 같은 톤의 «후보 표면화».
//
// SSOT 분담: 이 TS 모듈이 daemon 측(ingest 소프트 경고)의 휴리스틱 «정의» 다. scripts/
// po-brief-readability-lint.sh 의 파이썬은 이 규칙을 «미러» 한다(iOS Theme ↔ Mac Theme 미러처럼) —
// CI 는 노드/빌드 없이 파이썬으로 돌고, 런타임 ingest 는 이 TS 를 쓴다. 양쪽을 각각 테스트로 고정해
// (readability.test.ts ↔ test-po-brief-readability-lint.sh) 드리프트를 잡는다.
//
// 비-차단(soft): 이 신호는 «브리프를 버리는» 게 아니라 «로깅/표면화» 용이다 — 브리프는 그대로 INSERT
// 되고 기존 길이 cap(executor 의 str(title, 200)) 동작도 보존된다. 내용을 자동 재작성하거나 하드
// reject 하는 건 스코프 밖(그건 브리프 1 의 프롬프트 측). 디자인 토큰 검사도 아니다 — 제목·요약의
// «가독성» 규칙은 UI/비-UI(daemon·네트워크·CLI) 브리프에 동일 적용된다.

/**
 * 제목 «권고» 길이 — 프롬프트(messages.collect 의 모든 로케일 title 스키마)가 «80자 이내» 로 선언하는
 * 값과 같다. 이 상수가 그 선언의 코드측 SSOT 다. executor 의 하드 cap(str(title, 200))은 DB 안전
 * 백스톱(비정상 거대 제목 차단)이지 «선언» 이 아니다 — 둘을 혼동하지 마라(과거엔 선언 80 ↔ 코드 200 이
 * 말없이 불일치한 채 방치됐다). 가독성 게이트는 이 80 을 «권고 한계» 로 보고 초과 시 소프트 경고한다.
 * readability.test.ts 가 이 상수 == 80 이고 프롬프트도 80 을 선언함을 못박아 둘의 드리프트를 막는다.
 */
export const TITLE_ADVISORY_MAX = 80;

/** «절 2개 초과» 판정용 — 긴 대시(«—»)가 이 개수 이상이면 절이 3개 이상이라 본다(대시 N개 → 절 N+1개). */
export const MAX_TITLE_CLAUSE_DASHES = 1;

/** 가독성 신호 한 건 — design-lint 의 (코드, 발췌, 권장) 톤. 비-차단(로깅/표면화 전용). */
export type ReadabilitySignal = {
  /** R1 제목 길이 · R2 제목 코드참조/심볼 · R3 제목 «—» 다중 절 · R4 problem 첫 줄 코드시작. */
  code: "R1" | "R2" | "R3" | "R4";
  field: "title" | "problem";
  /** 사람용(로그/린트) 한 줄 설명. 디버그/로깅 — 사용자 노출 아님(번역 대상 아님). */
  message: string;
};

// ── 화이트리스트 (거짓양성 최소화) ───────────────────────────────────────────────────────
// 코드처럼 보이지만 «불가피한 고유명/약어» 는 통과시킨다. 핵심 설계: R2 의 전부-대문자 신호는
// «밑줄 있는 SCREAMING_SNAKE» 만 본다 — SSH·URL·API 같은 밑줄 없는 약어는 자연히 통과하므로 이
// 목록은 주로 R4(problem 첫 토큰이 점-멤버/호출인 경우)에서 «고유명 시작» 을 빼는 데 쓰인다.
export const READABILITY_PROPER_NOUNS: ReadonlySet<string> = new Set(
  [
    "Tor", "SSH", "SSHD", "Onion", "HTTP", "HTTPS", "URL", "URI", "API", "CLI", "GUI",
    "PTY", "QR", "LLM", "UI", "UX", "OS", "iOS", "macOS", "ID", "PO", "CI", "CD",
    "DB", "SQL", "JWT", "ASC", "JSON", "YAML", "TOML", "CSV", "TSV", "SDK", "MCP",
    "DAG", "DMG", "PR", "IP", "TCP", "UDP", "DNS", "TLS", "SSL", "NAT", "UPnP",
    "GitHub", "TestFlight", "SwiftUI", "UIKit", "Xcode", "npm", "pnpm", "Discord", "Markdown",
  ].map((s) => s.toLowerCase()),
);

// 코드 파일 확장자 — 제목/첫 줄에 «파일경로» 가 새어 든 신호(.ts/.swift/.sh 등).
const CODE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|swift|sh|bash|zsh|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|" +
  "m|mm|json|yml|yaml|toml|sql|css|scss|html|htm|md|plist|xcstrings";

// URL / 이슈번호 — 화이트리스트. 코드-형태 검사 «전» 에 공백으로 치환해 거짓양성을 없앤다
// (예: https://x.com/a.ts 의 .ts, 이슈 «#123» 의 숫자가 파일경로/심볼로 오인되지 않게).
const RE_URL = /\bhttps?:\/\/\S+/gi;
const RE_ISSUE = /#\d+\b/g;

// 파일경로 토큰: 선택적 디렉터리 + 이름.확장자 (+ 선택 :라인[-라인]).
const RE_FILEPATH = new RegExp(
  `(?:[\\w.\\-]+\\/)*[\\w.\\-]+\\.(?:${CODE_EXT})\\b(?::\\d+(?:-\\d+)?)?`,
  "i",
);
// 전부-대문자 코드 심볼 — 밑줄 ≥1 의 SCREAMING_SNAKE. 밑줄 없는 약어(SSH·URL·API)는 비대상.
const RE_SCREAMING_SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
// 긴 대시 — em-dash(U+2014)·en-dash(U+2013). ASCII 하이픈(-)은 합성어/범위라 비대상.
const RE_LONGDASH = /[—–]/g;

/** URL·이슈번호를 공백으로 치운 사본 — 코드-형태 검사 전 화이트리스트 적용. */
function stripWhitelisted(s: string): string {
  return s.replace(RE_URL, " ").replace(RE_ISSUE, " ");
}

/** 문자열의 첫 «비어있지 않은» 줄(trim). 없으면 "". */
function firstNonEmptyLine(s: string): string {
  for (const ln of s.split(/\r?\n/)) {
    const t = ln.trim();
    if (t) return t;
  }
  return "";
}

/** 제목의 «글자 수»(코드포인트). slice(0,200) 의 코드유닛 cap 과 달리 가독성은 사람이 보는 글자 수. */
export function titleLength(title: string): number {
  return [...title].length;
}

/**
 * 제목 가독성 신호 — ① 80자 초과, ② 파일경로/전부-대문자 심볼 포함, ③ «—» 로 잇는 절 2개 초과.
 * 비-차단: 결과는 로깅/린트 표면화용일 뿐 제목 자체를 바꾸지 않는다.
 */
export function analyzeTitleReadability(title: string): ReadabilitySignal[] {
  const out: ReadabilitySignal[] = [];
  const t = title.trim();
  if (!t) return out;

  // ① 길이.
  const len = titleLength(t);
  if (len > TITLE_ADVISORY_MAX) {
    out.push({ code: "R1", field: "title", message: `제목 ${len}자 (권고 ${TITLE_ADVISORY_MAX}자 초과)` });
  }

  // ②·③ 은 URL·이슈번호를 화이트리스트로 비운 사본에서 본다.
  const scrubbed = stripWhitelisted(t);

  // ② 파일경로 / 전부-대문자 심볼.
  const fp = scrubbed.match(RE_FILEPATH);
  if (fp) {
    out.push({ code: "R2", field: "title", message: `제목에 파일경로 «${fp[0]}» — 코드 참조는 evidence.ref 로` });
  } else {
    const sym = scrubbed.match(RE_SCREAMING_SNAKE);
    if (sym) {
      out.push({ code: "R2", field: "title", message: `제목에 코드 심볼 «${sym[0]}» — 평이한 말로` });
    }
  }

  // ③ «—» 다중 절 (대시 ≥ MAX+1 → 절 ≥3개).
  const dashes = (scrubbed.match(RE_LONGDASH) ?? []).length;
  if (dashes > MAX_TITLE_CLAUSE_DASHES) {
    out.push({
      code: "R3",
      field: "title",
      message: `제목 «—» 다중 절 ${dashes + 1}개 (권고 2개 이하) — 한 문장으로`,
    });
  }

  return out;
}

/**
 * problem 가독성 신호 — ④ 첫 줄이 «코드 참조/심볼» 로 시작. URL·이슈번호·고유명으로 시작하는 건
 * 화이트리스트(정당한 참조)라 제외한다(거짓양성 최소화).
 */
export function analyzeProblemReadability(problem: string): ReadabilitySignal[] {
  const out: ReadabilitySignal[] = [];
  const line = firstNonEmptyLine(problem);
  if (!line) return out;

  // 화이트리스트: URL·이슈번호로 «시작» 하면 정당한 참조 — 위반 아님.
  if (/^https?:\/\//i.test(line) || /^#\d+\b/.test(line)) return out;

  // 백틱 코드 스팬으로 시작.
  if (line.startsWith("`")) {
    out.push({ code: "R4", field: "problem", message: "problem 첫 줄이 코드 스팬(`…`)으로 시작 — 누가/언제/무엇이 불편한가로" });
    return out;
  }

  // 파일경로 / file:line 으로 시작.
  const fp = line.match(RE_FILEPATH);
  if (fp && line.indexOf(fp[0]) === 0) {
    out.push({ code: "R4", field: "problem", message: `problem 첫 줄이 파일경로 «${fp[0]}» 로 시작 — 코드 참조는 evidence.ref 로` });
    return out;
  }

  // SCREAMING_SNAKE 심볼로 시작.
  const snake = line.match(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/);
  if (snake) {
    out.push({ code: "R4", field: "problem", message: `problem 첫 줄이 코드 심볼 «${snake[0]}» 로 시작 — 평이한 말로` });
    return out;
  }

  // 점-멤버 접근(Theme.Spacing.m) 또는 함수 호출(parseBriefDraft())로 시작 — 단, 첫 segment 가
  // 화이트리스트 고유명(API.x · Tor.y)이면 제외.
  const member = line.match(/^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+|\s*\()/);
  if (member && !READABILITY_PROPER_NOUNS.has(member[1].toLowerCase())) {
    out.push({ code: "R4", field: "problem", message: `problem 첫 줄이 코드 참조/심볼 «${member[0].trim()}» 로 시작 — 평이한 말로` });
    return out;
  }

  return out;
}

/** 제목 + problem 가독성 신호 전부. ingest 소프트 경고와 린트가 공유한다. */
export function analyzeBriefReadability(brief: { title: string; problem: string }): ReadabilitySignal[] {
  return [...analyzeTitleReadability(brief.title), ...analyzeProblemReadability(brief.problem)];
}

/** 신호 목록 → 로그 한 줄 («R1 …; R3 …»). 신호가 없으면 "". */
export function formatReadabilitySignals(signals: readonly ReadabilitySignal[]): string {
  return signals.map((s) => `${s.code} ${s.message}`).join("; ");
}
