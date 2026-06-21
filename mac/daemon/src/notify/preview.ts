/**
 * PTY 출력에서 «에이전트가 방금 한 말» 한~두 줄을 뽑아 알림 본문 미리보기로 쓴다.
 *
 * # 왜 필요한가
 *
 * turn_complete / still_waiting 알림은 제목에 repo·세션 제목만 싣고 본문은 정적 안내문
 * 한 줄("끝났거나, 질문이거나, 승인 요청")뿐이라, 사용자는 «그냥 끝남(볼 것 없음)» 인지
 * «2초면 답할 yes/no» 인지 구분하려면 매번 앱을 열어 transcript 를 봐야 한다. 마지막
 * 의미있는 출력 한 줄을 본문에 더하면 폰을 열지 않고 결재 가치를 판단할 수 있다.
 *
 * # 입력 / 출력
 *
 * 입력은 raw PTY tail (ANSI escape · 박스 차트 · 진행바 · 입력 프롬프트가 섞인 터미널 바이트).
 * 출력은 그 안의 «마지막 의미있는 텍스트 한~두 줄» — ANSI 제거 + 박스/프롬프트/푸터 chrome
 * 제외 + grapheme 단위 ~200자 truncate. 의미있는 줄이 하나도 없으면(빌드 로그/diff/순수
 * 진행바뿐) null 을 돌려 호출부가 정적 안내문으로 폴백한다.
 *
 * # 프라이버시
 *
 * 이 함수가 만든 미리보기는 외부 Discord 로 나간다. 추출 자체는 늘 가능하지만 «실어 보낼지»
 * 는 config.notify.discord.includePreview 옵트인(기본 OFF)이 dispatch 시점에 가린다 —
 * 이 모듈은 그 게이트를 모른다 (순수 함수).
 */

/** 미리보기 최대 길이 (grapheme). 푸시 미리보기에 적당하고 transcript 통째 노출은 막는 선. */
export const PREVIEW_MAX_GRAPHEMES = 200;

/** 비밀로 의심되는 구간을 가린 자리 표식. */
export const PREVIEW_REDACTION_MASK = "[••• 마스킹됨]";

/** 미리보기 전체가 비밀이라 통째로 가려졌을 때의 폴백 본문. */
export const PREVIEW_ALL_REDACTED = "(민감 출력 가려짐)";

/**
 * «외부로 나가는» 미리보기에서 흔한 비밀 패턴을 마스킹하는 best-effort 1패스 (순수 함수).
 *
 * # 왜
 *
 * 코드 에이전트 세션은 env 값·API 키·`gh auth` 토큰·`.env` 내용·access token 을 PTY 로
 * 흘리기 쉽다. 미리보기를 켜면 그 한~두 줄이 제3자 채널(Discord)로 평문 전송돼 채널
 * 로그/캐시에 남으면 회수가 어렵다. 사용자에게 «주의하세요» 로 떠넘기는 대신, 송신
 * «직전» 에 고신뢰 비밀 패턴을 한 번 가린다.
 *
 * # 한계 (거짓 안전감 방지)
 *
 * **완벽한 DLP 가 아니다 — 휴리스틱이다.** 흔한 토큰 prefix·할당 키워드·PEM·긴 고엔트로피
 * 런이라는 «앵커» 가 있는 비밀만 잡는다. 앵커 없는 비밀(평범한 단어 같은 비밀번호, 새로운
 * 토큰 포맷)은 통과할 수 있다. 그래서 UI 는 «완벽하지 않으니 민감 세션엔 끄세요» 라고
 * 명시하고, 임계값/앵커는 정상 산문·코드를 오탐하지 않게 보수적으로 잡았다.
 *
 * # 적용 위치
 *
 * 오직 외부 송신 경로(notify/index.ts 의 Discord dispatch)에서만 호출한다. 터미널 렌더·
 * 채팅·세션 목록의 대기 미리보기(in-app)·DB 저장 경로엔 적용하지 않는다 — 그쪽은 사용자
 * 자기 기기라 같은 신뢰 경계다. extractAgentPreview 자체는 이 두 경로가 «공유» 하므로
 * 마스킹을 그 안에 넣지 않고 송신 직전에 건다.
 */
export function redactSecretsForPreview(text: string): string {
  if (!text) return text;
  const M = PREVIEW_REDACTION_MASK;
  let out = text;

  // 1) PEM 블록 (BEGIN … END, 미리보기에선 줄바꿈이 공백으로 합쳐졌을 수 있음).
  out = out.replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, M);

  // 2) 잘 알려진 토큰 prefix — 길이 하한으로 「sk-」 같은 짧은 식별자 오탐 방지.
  out = out
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, M) // GitHub PAT / OAuth
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, M) // GitHub fine-grained PAT
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, M) // OpenAI / Anthropic
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, M) // AWS access key id
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, M) // Slack
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, M); // Google API key

  // 3) Bearer 토큰 — 「Bearer」 라벨은 남기고 토큰만 가린다.
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${M}`);

  // 4) key=value / key: value — 키 이름이 비밀류일 때 값만 가린다. 값이 토큰스러울 때만
  //    (숫자 포함 또는 16자+) 발사해 「token = useToken」 같은 평범한 코드/식별자는 통과.
  out = out.replace(
    /\b([\w-]*(?:passwords?|passwd|pwd|secrets?|tokens?|api[_-]?keys?|access[_-]?keys?|client[_-]?secret|auth[_-]?token)[\w-]*)(\s*[:=]\s*)(["']?)([A-Za-z0-9_\-./+=]{6,})\3/gi,
    (m, key, sep, q, val) => {
      if (/[0-9]/.test(val) || val.length >= 16) return `${key}${sep}${q}${M}${q}`;
      return m;
    },
  );

  // 5) 긴 고엔트로피 base64 런 (대문자+소문자+숫자 혼합, 40자+). 소문자 hex 인 git SHA 는
  //    대문자 요구 때문에 걸리지 않아 평범한 커밋 해시 오탐을 피한다.
  out = out.replace(
    /\b(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}\b/g,
    M,
  );

  // 6) 긴 hex 런 (64자+ — 40자 git SHA 보다 길어 다이제스트/시크릿에 한정).
  out = out.replace(/\b[0-9a-fA-F]{64,}\b/g, M);

  return out;
}

/**
 * 마스킹 후 남은 게 마스크 표식·구두점·공백뿐이면(=의미있는 본문이 통째로 가려짐) true.
 * 호출부가 «(민감 출력 가려짐)» 폴백으로 바꾸게 한다.
 */
export function isFullyRedacted(redacted: string): boolean {
  const stripped = redacted.split(PREVIEW_REDACTION_MASK).join("");
  return !HAS_WORD.test(stripped);
}

/**
 * ANSI/VT escape 시퀀스 매칭. CSI(`ESC [ … 종결바이트`), OSC(`ESC ] … BEL|ST`), 그리고
 * 2바이트 escape(`ESC <단일문자>`)를 모두 걷어낸다. npm `ansi-regex` 와 같은 계열의 패턴.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** 라인 양끝에서 박스 차트(U+2500–U+257F: ─│╭╮╰╯┌┐└┘ 등)·공백을 깎는다. */
const BORDER_EDGE = /^[\s─-╿]+|[\s─-╿]+$/gu;

/** «의미있는» 줄의 정의 — 글자(어느 문자체계든) 또는 숫자가 하나라도 있어야 한다. */
const HAS_WORD = /[\p{L}\p{N}]/u;

/** 박스 «상단» 경계로 시작하는 줄 — 입력 프롬프트 박스의 시작. 이 줄부터 끝까지 버린다. */
const BOX_TOP = /^[┌┍┎┏╒╓╔╭]/u;

/**
 * 출력이 아니라 REPL chrome(상태/단축키 안내)인 줄 — 의미있어 보여도(글자 포함) 미리보기에서
 * 제외한다. 대부분의 chrome 은 입력 박스 «아래» 라 BOX_TOP 절단으로 이미 사라지지만, 박스를
 * 안 쓰는 에이전트(또는 박스 미검출 시)를 위한 보강.
 */
const CHROME_PATTERNS: RegExp[] = [
  /^\? for shortcuts/i,
  /^(esc|ctrl)[\s+-].*(interrupt|undo|exit|quit|clear)/i,
  /^(press )?(enter|return) to /i,
  /accept edits (on|off)/i,
  /auto-?accept/i,
  /bypassing permissions/i,
  /shift\s*\+\s*tab/i,
  /^tokens?\b.*\b(used|left|remaining)/i,
  /context (left|remaining|window)/i,
];

/** 코드펜스(``` 또는 ~~~) — 본문 식별엔 의미 없는 구분선이라 제외. */
const CODE_FENCE = /^(?:```|~~~)/;

/** ANSI escape 제거. */
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/**
 * 한 raw 라인을 «렌더된» 텍스트로 정규화:
 *  - lone CR(`\r`)로 같은 줄을 덮어쓴 진행바(`…\r…\r…`)는 마지막 «비지 않은» 세그먼트가
 *    최종 표시 상태에 가깝다. 줄 끝의 빈 \r 세그먼트(커서만 col 0 으로)는 무시한다.
 *  - 박스 경계·양끝 공백 제거.
 */
function renderLine(raw: string): string {
  const segs = raw.split("\r");
  let visible = "";
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].trim() !== "") {
      visible = segs[i];
      break;
    }
  }
  return visible.replace(BORDER_EDGE, "");
}

/** chrome(상태/단축키) 줄인가. */
function isChrome(line: string): boolean {
  if (CODE_FENCE.test(line)) return true;
  return CHROME_PATTERNS.some((re) => re.test(line));
}

/** 의미있는 본문 줄인가 — 글자/숫자 포함 + chrome 아님. */
function isMeaningful(line: string): boolean {
  return HAS_WORD.test(line) && !isChrome(line);
}

/** grapheme 단위 truncate — CJK·이모지가 중간에 깨지지 않게. */
function truncateGraphemes(s: string, max: number): string {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = Array.from(seg.segment(s), (g) => g.segment);
  if (graphemes.length <= max) return s;
  return graphemes.slice(0, max).join("").trimEnd() + "…";
}

/**
 * raw PTY tail 에서 마지막 의미있는 출력 한~두 줄을 추출. 못 찾으면 null.
 *
 * 절차:
 *  1) ANSI 제거 → 줄 단위 분해(각 줄은 CR 덮어쓰기 최종 상태로 렌더, 박스 경계 제거).
 *  2) 입력 프롬프트 박스(마지막 BOX_TOP)부터 끝까지 절단 — 그 아래 chrome(단축키/모드/토큰)도 함께 사라진다.
 *  3) 밑에서부터 의미있는 줄을 모은다(최대 2줄, 연속만 — 빈 줄/chrome 을 만나면 멈춤).
 *  4) 원래 순서로 합쳐 공백 정규화 + grapheme truncate.
 */
export function extractAgentPreview(
  raw: string,
  maxGraphemes: number = PREVIEW_MAX_GRAPHEMES,
): string | null {
  if (!raw) return null;
  // CRLF 줄바꿈을 먼저 LF 로 정규화 — 안 그러면 renderLine 이 줄 끝 \r 를 진행바 덮어쓰기로
  // 오인해 «\r 뒤(=빈 문자열)» 만 남긴다. 정규화 후 줄 «안» 에 남은 lone \r 만 진행바로 처리.
  let lines = stripAnsi(raw).replace(/\r\n/g, "\n").split("\n").map(renderLine);

  // 입력 프롬프트 박스(가장 마지막 박스 상단)부터 끝까지 버린다 — 그 아래는 전부 chrome.
  let lastBoxTop = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_TOP.test(lines[i])) {
      lastBoxTop = i;
      break;
    }
  }
  if (lastBoxTop >= 0) lines = lines.slice(0, lastBoxTop);

  // 밑에서부터 연속한 의미있는 줄 수집 (최대 2). 일단 한 줄이라도 모은 뒤 빈 줄/chrome 을
  // 만나면 멈춰, 본문과 떨어진 위쪽 잡음을 끌어오지 않는다.
  const collected: string[] = [];
  let started = false;
  for (let i = lines.length - 1; i >= 0 && collected.length < 2; i--) {
    const line = lines[i];
    if (isMeaningful(line)) {
      collected.push(line);
      started = true;
    } else if (started) {
      break; // 본문 블록의 위쪽 경계
    }
  }
  if (collected.length === 0) return null;

  // collected 는 아래→위 순서라 뒤집어 원래 순서로. 줄 내부 연속 공백은 1칸으로 정규화.
  const text = collected.reverse().join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return truncateGraphemes(text, maxGraphemes);
}
