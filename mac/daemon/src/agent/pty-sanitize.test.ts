/**
 * pty-sanitize 단위 테스트 — replay 정화가 «응답 유발 질의» 만 제거하고 화면 상태/렌더
 * 시퀀스는 보존하는지 회귀 차단.
 *
 * 핵심:
 *  - 사용자 보고의 실제 입력창 오염을 만드는 질의(DA1/kitty/OSC11/DSR)는 제거.
 *  - 모드 설정(bracketed paste, alt screen, 커서 가시성), kitty push/set, 색 «설정»,
 *    일반 텍스트/SGR/한글 multi-byte 는 그대로 — 지우면 replay 화면이 깨진다.
 */
import { describe, it, expect } from "vitest";
import {
  stripTerminalQueries,
  stripTerminalQueryResponses,
  sanitizePtyChunkPayload,
  sanitizeLivePtyOutput,
  MAX_REP_COUNT,
} from "./pty-sanitize.js";

const ESC = "\x1b";
const BEL = "\x07";
const strip = (s: string) => stripTerminalQueries(Buffer.from(s, "latin1")).toString("latin1");
const stripResp = (s: string) =>
  stripTerminalQueryResponses(Buffer.from(s, "latin1")).toString("latin1");
const live = (s: string) => sanitizeLivePtyOutput(Buffer.from(s, "latin1")).toString("latin1");

describe("stripTerminalQueries — 질의 제거", () => {
  it("DA1 질의 CSI c / CSI 0 c", () => {
    expect(strip(`${ESC}[c`)).toBe("");
    expect(strip(`${ESC}[0c`)).toBe("");
  });

  it("DA2 질의 CSI > c / CSI > 0 c", () => {
    expect(strip(`${ESC}[>c`)).toBe("");
    expect(strip(`${ESC}[>0c`)).toBe("");
  });

  it("Kitty keyboard 플래그 질의 CSI ? u", () => {
    expect(strip(`${ESC}[?u`)).toBe("");
  });

  it("DSR 커서 위치 질의 CSI 6 n / CSI 5 n / CSI ? 6 n", () => {
    expect(strip(`${ESC}[6n`)).toBe("");
    expect(strip(`${ESC}[5n`)).toBe("");
    expect(strip(`${ESC}[?6n`)).toBe("");
  });

  it("OSC 10/11/12 색상 질의 (BEL / ST 종결)", () => {
    expect(strip(`${ESC}]11;?\x07`)).toBe("");
    expect(strip(`${ESC}]11;?${ESC}\\`)).toBe("");
    expect(strip(`${ESC}]10;?\x07`)).toBe("");
    expect(strip(`${ESC}]12;?\x07`)).toBe("");
  });

  it("사용자 보고 오염의 «원인» — 에이전트 부팅 질의 burst 를 전부 제거", () => {
    // replay 버퍼에 들어 있는 건 에이전트가 «출력» 한 질의(kitty CSI?u + DA1 CSI c +
    // OSC11 질의)다. 이걸 지워야 SwiftTerm 이 응답(CSI?...u / CSI?...c / OSC11;rgb:...)을
    // 돌려보내지 않아 입력창 오염(사용자 보고)이 애초에 안 생긴다.
    const queryBurst = `${ESC}[?u${ESC}[c${ESC}]11;?\x07`;
    expect(strip(queryBurst)).toBe("");
  });

  it("응답 형태 CSI ? ... c 는 출력 스트림에 없으므로 의도적으로 미매칭(보존)", () => {
    // 이 형태는 터미널→PTY(입력) 방향에서만 나오고 pty_chunk(출력)엔 안 담긴다. 방어적으로
    // 보존해 둔다 — '[' 다음 '?' 라 DA 질의 패턴이 잡지 않는다.
    const da1Response = `${ESC}[?65;4;1;2;6;21;22;17;28c`;
    expect(strip(da1Response)).toBe(da1Response);
  });

  it("질의 사이에 낀 본문 텍스트는 보존", () => {
    expect(strip(`hi${ESC}[c there`)).toBe("hi there");
  });
});

describe("stripTerminalQueries — 보존(절대 건드리면 안 되는 것)", () => {
  it("bracketed paste / alt screen / 커서 가시성 모드 설정", () => {
    expect(strip(`${ESC}[?2004h`)).toBe(`${ESC}[?2004h`);
    expect(strip(`${ESC}[?2004l`)).toBe(`${ESC}[?2004l`);
    expect(strip(`${ESC}[?1049h`)).toBe(`${ESC}[?1049h`);
    expect(strip(`${ESC}[?25l`)).toBe(`${ESC}[?25l`);
  });

  it("Kitty push CSI > u / pop CSI < u / set CSI = ... u 는 질의가 아니라 보존", () => {
    expect(strip(`${ESC}[>1u`)).toBe(`${ESC}[>1u`);
    expect(strip(`${ESC}[<u`)).toBe(`${ESC}[<u`);
    expect(strip(`${ESC}[=1;1u`)).toBe(`${ESC}[=1;1u`);
  });

  it("OSC 11 색 «설정» (rgb 값) 은 질의(?) 가 아니라 보존", () => {
    const setBg = `${ESC}]11;rgb:0000/0000/0000\x07`;
    expect(strip(setBg)).toBe(setBg);
  });

  it("SGR 컬러 / 커서 이동 등 일반 렌더 시퀀스 보존", () => {
    expect(strip(`${ESC}[31mred${ESC}[0m`)).toBe(`${ESC}[31mred${ESC}[0m`);
    expect(strip(`${ESC}[2J${ESC}[H`)).toBe(`${ESC}[2J${ESC}[H`);
  });

  it("한글 multi-byte 본문은 byte 보존 (latin1 왕복)", () => {
    const hangul = Buffer.from("아 다음 주", "utf8");
    const out = stripTerminalQueries(hangul);
    expect(out.equals(hangul)).toBe(true);
  });

  it("ESC 없는 평문은 동일 버퍼 반환 (no-op 빠른 경로)", () => {
    const buf = Buffer.from("plain text", "utf8");
    expect(stripTerminalQueries(buf)).toBe(buf);
  });
});

describe("stripTerminalQueryResponses — 입력 방향 응답 제거", () => {
  it("사용자 보고 버그 — SwiftTerm 자동 응답 burst 를 통째 제거", () => {
    // 입력창에 박히던 그 문자열(kitty 응답 + DA1 응답 + OSC11 응답). stdin 에서 사라져야.
    const respBurst = `${ESC}[?0u${ESC}[?65;4;1;2;6;21;22;17;28c${ESC}]11;rgb:0000/0000/0000\x07`;
    expect(stripResp(respBurst)).toBe("");
  });

  it("kitty 플래그 응답 / DA1·DA2 응답 / OSC 색상 응답 개별 제거", () => {
    expect(stripResp(`${ESC}[?0u`)).toBe("");
    expect(stripResp(`${ESC}[?65;1c`)).toBe("");
    expect(stripResp(`${ESC}[>0;276;0c`)).toBe("");
    expect(stripResp(`${ESC}]10;rgb:ffff/ffff/ffff\x07`)).toBe("");
    expect(stripResp(`${ESC}]11;rgb:0000/0000/0000${ESC}\\`)).toBe(""); // ST 종결
  });

  it("사용자 입력은 보존 — 텍스트 / 화살표 / Ctrl-C / Enter", () => {
    expect(stripResp("hello world")).toBe("hello world");
    expect(stripResp(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toBe(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`);
    expect(stripResp("\x03")).toBe("\x03"); // Ctrl-C
    expect(stripResp("yes\r")).toBe("yes\r");
  });

  it("kitty «키» 인코딩(CSI <code> u, '?' 없음) 은 응답이 아니라 보존", () => {
    expect(stripResp(`${ESC}[97u`)).toBe(`${ESC}[97u`); // 'a' kitty 인코딩
    expect(stripResp(`${ESC}[97;5u`)).toBe(`${ESC}[97;5u`); // Ctrl+a
  });

  it("커서 위치 응답(CSI ... R) / 상태(CSI 0 n) 는 건드리지 않음", () => {
    expect(stripResp(`${ESC}[24;80R`)).toBe(`${ESC}[24;80R`);
    expect(stripResp(`${ESC}[0n`)).toBe(`${ESC}[0n`);
  });

  it("응답에 낀 본문은 살리고 응답만 제거", () => {
    expect(stripResp(`ab${ESC}[?0ucd`)).toBe("abcd");
  });
});

describe("sanitizeLivePtyOutput — 라이브 위험 시퀀스 중화 (차단)", () => {
  it("OSC 52 클립보드 set 차단 (BEL / ST 종결)", () => {
    // base64("evil") 클립보드 주입 — 통째 사라져야.
    expect(live(`${ESC}]52;c;ZXZpbA==${BEL}`)).toBe("");
    expect(live(`${ESC}]52;c;ZXZpbA==${ESC}\\`)).toBe("");
    // 선택 지정자(p/q 등) 변형도 차단.
    expect(live(`${ESC}]52;p;Zm9v${BEL}`)).toBe("");
  });

  it("OSC 0/1/2 제목 변조 차단 (BEL / ST 종결)", () => {
    expect(live(`${ESC}]0;가짜제목${BEL}`)).toBe("");
    expect(live(`${ESC}]1;icon${BEL}`)).toBe("");
    expect(live(`${ESC}]2;window title${ESC}\\`)).toBe("");
  });

  it("위험 시퀀스 사이/주위 본문은 보존하고 시퀀스만 제거", () => {
    expect(live(`before${ESC}]52;c;ZXZpbA==${BEL}after`)).toBe("beforeafter");
    expect(live(`hi${ESC}]0;t${BEL}there`)).toBe("hithere");
  });

  it("REP(CSI Ps b) 과도 반복은 MAX_REP_COUNT 로 클램프 (multiplier DoS 방어)", () => {
    expect(live(`X${ESC}[99999999b`)).toBe(`X${ESC}[${MAX_REP_COUNT}b`);
    // 상한 이하의 정상 REP 는 그대로.
    expect(live(`X${ESC}[40b`)).toBe(`X${ESC}[40b`);
    expect(live(`X${ESC}[${MAX_REP_COUNT}b`)).toBe(`X${ESC}[${MAX_REP_COUNT}b`);
  });

  it("부팅 출력에 섞인 클립보드+제목+REP 폭탄을 한 번에 중화", () => {
    const attack = `welcome${ESC}]2;HACKED${BEL}${ESC}]52;c;cm0gLXJm${BEL}${ESC}[10000000b!`;
    expect(live(attack)).toBe(`welcome${ESC}[${MAX_REP_COUNT}b!`);
  });
});

describe("sanitizeLivePtyOutput — 보존(정상 렌더는 절대 안 건드림)", () => {
  it("SGR 색 / 커서 이동 / 화면 지우기 보존", () => {
    expect(live(`${ESC}[31mred${ESC}[0m`)).toBe(`${ESC}[31mred${ESC}[0m`);
    expect(live(`${ESC}[2J${ESC}[H`)).toBe(`${ESC}[2J${ESC}[H`);
    expect(live(`${ESC}[10;5H`)).toBe(`${ESC}[10;5H`); // 커서 위치 — 'H' 라 REP 'b' 와 무관
  });

  it("alt screen / bracketed paste / 커서 가시성 모드 설정 보존", () => {
    expect(live(`${ESC}[?1049h`)).toBe(`${ESC}[?1049h`);
    expect(live(`${ESC}[?2004h`)).toBe(`${ESC}[?2004h`);
    expect(live(`${ESC}[?25l`)).toBe(`${ESC}[?25l`);
  });

  it("OSC 10/11/12 색상 질의/설정은 제목(0/1/2)과 달리 보존", () => {
    expect(live(`${ESC}]11;?${BEL}`)).toBe(`${ESC}]11;?${BEL}`);
    expect(live(`${ESC}]10;rgb:ffff/ffff/ffff${BEL}`)).toBe(`${ESC}]10;rgb:ffff/ffff/ffff${BEL}`);
  });

  it("파라미터 없는 CSI b(=1회 반복)는 무해해 보존", () => {
    expect(live(`X${ESC}[b`)).toBe(`X${ESC}[b`);
  });

  it("한글 multi-byte 본문은 byte 보존 (latin1 왕복)", () => {
    const hangul = Buffer.from("아 다음 주", "utf8");
    expect(sanitizeLivePtyOutput(hangul).equals(hangul)).toBe(true);
  });

  it("ESC 없는 평문은 동일 버퍼 반환 (no-op 빠른 경로)", () => {
    const buf = Buffer.from("plain text", "utf8");
    expect(sanitizeLivePtyOutput(buf)).toBe(buf);
  });
});

describe("sanitizePtyChunkPayload", () => {
  it("bytes_b64 안의 질의를 제거하고 한글 본문은 byte 보존해 재인코딩", () => {
    // ESC[c (DA1 질의) + 한글 UTF-8 바이트. 질의만 빠지고 한글은 byte 그대로 살아야 한다.
    const polluted = Buffer.concat([
      Buffer.from(`${ESC}[c`, "latin1"),
      Buffer.from("세션", "utf8"),
    ]);
    const payload = JSON.stringify({ bytes_b64: polluted.toString("base64") });
    const out = JSON.parse(sanitizePtyChunkPayload(payload)) as { bytes_b64: string };
    expect(Buffer.from(out.bytes_b64, "base64").toString("utf8")).toBe("세션");
  });

  it("변경이 없으면 원본 payload 문자열을 그대로 반환", () => {
    const payload = JSON.stringify({ bytes_b64: Buffer.from("clean").toString("base64") });
    expect(sanitizePtyChunkPayload(payload)).toBe(payload);
  });

  it("손상된/무관한 payload 는 그대로 통과", () => {
    expect(sanitizePtyChunkPayload("not json")).toBe("not json");
    expect(sanitizePtyChunkPayload("{}")).toBe("{}");
  });
});
