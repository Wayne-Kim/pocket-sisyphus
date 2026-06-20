// App Store Connect 커넥터 — PO 수집의 «스토어 리뷰» 신호 소스.
//
// 레포 내부(이슈·TODO)와 웹 리서치만으로는 «출시된 앱의 진짜 사용자 불만» 이 백로그에
// 들어오지 못한다 — 스토어 리뷰가 그 구멍을 메운다. ASC JWT 의
// ES256 서명을 node:crypto 로 수행한다 (외부서버 0 원칙 — daemon 이 직접 outbound 호출,
// 키는 config.json(0600) 에만 산다).

import { createPrivateKey, sign } from "node:crypto";
import type { AscConfig } from "../config.js";
import { guardNonLanEgress } from "../egress.js";

const ASC_BASE = "https://api.appstoreconnect.apple.com";

/** 수집 프롬프트에 첨부할 리뷰 한 건 — JSON 파일 원소이자 evidence ref 의 원천. */
export type AscReview = {
  id: string;
  rating: number;
  title: string;
  body: string;
  reviewerNickname: string;
  /** ISO 3166 territory (예: KOR, USA) — evidence ref 의 «로케일». */
  territory: string;
  createdDate: string;
};

/** ES256 (ECDSA P-256 + SHA-256, raw r||s) — ASC API 의 15분 만료 JWT. */
export function makeAscJwt(cfg: AscConfig, nowMs = Date.now()): string {
  const b64 = (b: Buffer): string => b.toString("base64url");
  const now = Math.floor(nowMs / 1000);
  const header = { alg: "ES256", kid: cfg.keyId, typ: "JWT" };
  const payload = { iss: cfg.issuerId, iat: now, exp: now + 900, aud: "appstoreconnect-v1" };
  const signingInput = `${b64(Buffer.from(JSON.stringify(header)))}.${b64(
    Buffer.from(JSON.stringify(payload)),
  )}`;
  const key = createPrivateKey(cfg.privateKeyPem);
  // JWT 는 DER 이 아니라 raw 64바이트(r||s) 서명 — ieee-p1363 인코딩이 그것.
  const sig = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64(sig)}`;
}

/** 키 저장 전 형식 검증 — PEM 이 EC P-256 비밀키로 파싱되는가. 에러 메시지 반환(정상이면 null). */
export function validateAscKey(cfg: AscConfig): string | null {
  if (!cfg.keyId.trim() || !cfg.issuerId.trim()) return "keyId/issuerId 누락";
  try {
    const key = createPrivateKey(cfg.privateKeyPem);
    if (key.asymmetricKeyType !== "ec") return `EC 키가 아님 (${key.asymmetricKeyType})`;
    return null;
  } catch (e) {
    return `p8 파싱 실패: ${(e as Error).message}`;
  }
}

/** ASC GET — 공통 전송 계층. crash.ts(Analytics 보고서)도 이 한 군데를 쓴다. */
export async function ascGet(cfg: AscConfig, pathAndQuery: string): Promise<unknown> {
  // LAN 전용 모드와 충돌 — ASC 는 비-LAN outbound 라 차단. 호출자(executor)는 throw 를 잡아
  // 해당 신호 섹션만 생략한다(수집 자체는 안 죽음).
  if (guardNonLanEgress("ASC GET")) {
    throw new Error("LAN 전용 모드와 충돌 — App Store Connect outbound 차단됨");
  }
  const res = await fetch(`${ASC_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${makeAscJwt(cfg)}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw ascHttpError(res.status, pathAndQuery, text);
  }
  return res.json();
}

/** ASC HTTP 실패 → Error + `.status` 부착 (signals.classifyAscFailure 가 코드로 분류). */
function ascHttpError(status: number, pathAndQuery: string, text: string): Error {
  const err = new Error(`ASC ${status} ${pathAndQuery.split("?")[0]}: ${text.slice(0, 300)}`);
  (err as Error & { status: number }).status = status;
  return err;
}

/** ASC POST (JSON:API) — Analytics 보고서 요청(ONGOING) 생성 등 쓰기 호출용. */
export async function ascPost(
  cfg: AscConfig,
  pathAndQuery: string,
  body: unknown,
): Promise<unknown> {
  if (guardNonLanEgress("ASC POST")) {
    throw new Error("LAN 전용 모드와 충돌 — App Store Connect outbound 차단됨");
  }
  const res = await fetch(`${ASC_BASE}${pathAndQuery}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${makeAscJwt(cfg)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw ascHttpError(res.status, pathAndQuery, text);
  }
  return res.json();
}

/**
 * 앱 식별자 해석 — 숫자면 ASC 앱 ID 그대로, 아니면 번들 ID 로 조회해 ID 로 바꾼다.
 * (사용자는 번들 ID 가 더 익숙하다 — 둘 다 받는다.)
 */
export async function resolveAscAppId(
  cfg: AscConfig,
  appIdOrBundleId: string,
): Promise<{ id: string; name: string }> {
  const raw = appIdOrBundleId.trim();
  if (/^\d+$/.test(raw)) {
    const data = (await ascGet(cfg, `/v1/apps/${raw}?fields[apps]=name`)) as {
      data?: { id: string; attributes?: { name?: string } };
    };
    if (!data.data) throw new Error(`앱 없음: ${raw}`);
    return { id: data.data.id, name: data.data.attributes?.name ?? raw };
  }
  const q = encodeURIComponent(raw);
  const data = (await ascGet(
    cfg,
    `/v1/apps?filter[bundleId]=${q}&fields[apps]=name,bundleId&limit=1`,
  )) as { data?: Array<{ id: string; attributes?: { name?: string } }> };
  const app = data.data?.[0];
  if (!app) throw new Error(`번들 ID 로 앱을 찾지 못함: ${raw}`);
  return { id: app.id, name: app.attributes?.name ?? raw };
}

/** 최근 고객 리뷰 — 최신순 최대 `limit` 건. 리뷰 0건이면 빈 배열 (정상). */
export async function fetchCustomerReviews(
  cfg: AscConfig,
  appIdOrBundleId: string,
  limit = 50,
): Promise<AscReview[]> {
  const app = await resolveAscAppId(cfg, appIdOrBundleId);
  const data = (await ascGet(
    cfg,
    `/v1/apps/${app.id}/customerReviews?sort=-createdDate&limit=${Math.min(limit, 200)}`,
  )) as {
    data?: Array<{
      id: string;
      attributes?: {
        rating?: number;
        title?: string;
        body?: string;
        reviewerNickname?: string;
        territory?: string;
        createdDate?: string;
      };
    }>;
  };
  return (data.data ?? []).map((r) => ({
    id: r.id,
    rating: r.attributes?.rating ?? 0,
    title: r.attributes?.title ?? "",
    body: r.attributes?.body ?? "",
    reviewerNickname: r.attributes?.reviewerNickname ?? "",
    territory: r.attributes?.territory ?? "",
    createdDate: r.attributes?.createdDate ?? "",
  }));
}

/**
 * 설정 화면의 «검증» — 키로 실제 호출이 되는지(만료·권한 부족을 저장 시점에 즉시 피드백).
 * appIdOrBundleId 가 있으면 그 앱의 리뷰 읽기까지 확인한다.
 */
export async function verifyAscConnection(
  cfg: AscConfig,
  appIdOrBundleId?: string,
): Promise<{ ok: true; appName?: string; reviewCount?: number }> {
  if (appIdOrBundleId?.trim()) {
    const app = await resolveAscAppId(cfg, appIdOrBundleId);
    const reviews = (await ascGet(
      cfg,
      `/v1/apps/${app.id}/customerReviews?limit=1`,
    )) as { meta?: { paging?: { total?: number } } };
    return { ok: true, appName: app.name, reviewCount: reviews.meta?.paging?.total ?? 0 };
  }
  await ascGet(cfg, `/v1/apps?limit=1&fields[apps]=name`);
  return { ok: true };
}
