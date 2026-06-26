/**
 * 비밀값 마스킹 — 크래시 로그·진단 번들이 «밖으로 나갈 수 있는» 텍스트(스택·메시지·
 * unified.log tail)에서 토큰·키·웹훅 URL 을 가린다.
 *
 * 두 갈래로 가린다:
 *  1) «아는» 비밀의 literal 치환 — config(0600) 에서 실제 값을 읽어 그 문자열을 통째로
 *     `***` 로 바꾼다(가장 강한 마스킹). 짧은 값은 본문을 오염시키므로 길이 ≥ 8 만.
 *  2) 패턴 기반 — config 에 없거나 형태만 비밀스러운 것(Discord webhook 토큰·Bearer·
 *     PEM 개인키 본문·`token:"…"` 같은 secret-keyed kv)을 정규식으로 가린다.
 *
 * 스택 프레임(`at fn (/path/file.ts:10:5)`)처럼 «비밀이 아닌» 줄은 건드리지 않는다 —
 * 크래시 핸들러는 «풀스택 보존» 과 «비밀 마스킹» 을 동시에 만족해야 하기 때문.
 */

import { readConfig } from "../config.js";

/** literal 치환 대상으로 삼을 비밀의 최소 길이 — 너무 짧으면 본문을 오염시킨다. */
const MIN_SECRET_LEN = 8;

const REDACTED = "***";

/**
 * `text` 에서 비밀을 가린 새 문자열을 돌려준다. 입력이 비-string 이면 그대로 String() 화.
 *
 * @param text         가릴 원문.
 * @param knownSecrets literal 로 통째 치환할 «아는» 비밀들(config 등). 비우면 패턴만 적용.
 */
export function maskSecrets(text: unknown, knownSecrets: string[] = []): string {
  let out = typeof text === "string" ? text : String(text);

  // 1) 아는 비밀 literal 치환 — 정규식 이스케이프 불필요한 split/join 으로.
  //    긴 값부터 치환해 «토큰이 다른 토큰의 부분문자열» 인 경우의 누락을 막는다.
  const literals = [...new Set(knownSecrets)]
    .filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LEN)
    .sort((a, b) => b.length - a.length);
  for (const secret of literals) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }

  // 2) 패턴 기반.
  // Discord(app) webhook — `…/api/webhooks/<id>/<token>` 의 token 만 가린다(id 는 식별 보조).
  out = out.replace(
    /(discord(?:app)?\.com\/api\/webhooks\/\d+)\/[A-Za-z0-9_.-]+/gi,
    `$1/${REDACTED}`,
  );
  // PEM 개인키 본문 — BEGIN/END 머리·꼬리는 남기고 본문만 통째 가린다.
  out = out.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    `$1${REDACTED}$2`,
  );
  // Authorization: Bearer <token>
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{6,}/gi, `$1${REDACTED}`);
  // secret-keyed kv — JSON `"token":"…"` / 객체 `token: '…'` / env `token=…`.
  const SECRET_KEYS =
    "token|tokenhash|localadminsecret|privatekeypem|webhookurl|secret|password|passwd|apikey|api_key|access_token|refresh_token|authorization|clientauthpriv|sshclientprivbase64|privatekey|privbase64|publickey";
  // 따옴표로 감싼 값.
  out = out.replace(
    new RegExp(`("?(?:${SECRET_KEYS})"?\\s*[:=]\\s*)"[^"]*"`, "gi"),
    `$1"${REDACTED}"`,
  );
  // 따옴표 없는 값(쿼리스트링·env). 구분자(&, 공백, 따옴표, 콤마)까지.
  out = out.replace(
    new RegExp(`\\b(${SECRET_KEYS})=[^&\\s"',]+`, "gi"),
    `$1=${REDACTED}`,
  );
  // `secret.` 접두가 붙은 JSON 키 일반 — server.ts 가 공인 IP·onion 주소를
  // `"secret.external_ipv4"`·`"secret.onion.address"` 키로 unified.log(JSON Lines)에 남기지만
  // 위 SECRET_KEYS 목록엔 없어 누락됐다. 접두만으로 값 전체를 가린다(프라이버시: 집 공인 IP·서버 신원).
  out = out.replace(/("secret\.[^"]*"\s*:\s*)"[^"]*"/gi, `$1"${REDACTED}"`);

  return out;
}

/**
 * config(0600) 에서 «아는» 비밀값들을 모아 돌려준다 — 크래시 로그/진단 번들 마스킹의
 * literal 치환 입력. 토큰·키·웹훅 URL 등 실제 값만 담고, 읽기 실패엔 빈 배열(방어).
 * 길이 필터는 maskSecrets 가 처리하므로 여기선 존재하는 값만 긁어 모은다.
 */
export function knownConfigSecrets(): string[] {
  const out: string[] = [];
  try {
    const cfg = readConfig();
    if (!cfg) return out;
    if (cfg.token) out.push(cfg.token);
    if (cfg.tokenHash) out.push(cfg.tokenHash);
    if (cfg.localAdminSecret) out.push(cfg.localAdminSecret);
    if (cfg.asc?.privateKeyPem) out.push(cfg.asc.privateKeyPem);
    if (cfg.asc?.keyId) out.push(cfg.asc.keyId);
    if (cfg.asc?.issuerId) out.push(cfg.asc.issuerId);
    if (cfg.notify?.discord?.webhookUrl) out.push(cfg.notify.discord.webhookUrl);
    if (cfg.attestPublicKey) out.push(cfg.attestPublicKey);
    for (const d of cfg.attestDevices ?? []) {
      if (d.publicKey) out.push(d.publicKey);
    }
  } catch {
    /* config 읽기 실패 — 패턴 마스킹만으로 폴백. */
  }
  return out;
}
