// 출시 앱 크래시 커넥터 — PO 수집의 «크래시» 신호 소스 (po_crash_v1).
//
// 크래시는 사용자가 리뷰로 말해주기 «전» 의 가장 빠르고 객관적인 불만 신호다 — 이게
// 빠지면 «앱이 죽는 문제» 보다 «기능 제안» 이 백로그 상위에 오는 왜곡이 생긴다.
// Xcode Organizer 가 보여주는 그 크래시 데이터의 공개 API 경로인 ASC Analytics
// Reports 의 «App Crashes» 보고서(ONGOING)를 기존 ASC 키로 내려받는다 (asc.ts 와
// 같은 외부서버 0 원칙 — daemon 직접 outbound, 앱에 서드파티 SDK 심지 않음).
//
// 보고서 파이프: 요청(ONGOING) → 보고서(App Crashes) → 인스턴스(DAILY) → 세그먼트
// (gzip CSV/TSV) 다운로드 → 버전·디바이스별 집계. 보고서는 Apple 쪽에서 비동기
// 생성되므로 첫 활성화 직후엔 비어 있을 수 있다 — 그땐 null 을 돌려주고 executor 가
// 섹션만 생략한다 (다음 수집 사이클이 다시 본다).

import { gunzipSync } from "node:zlib";
import type { AscConfig } from "../config.js";
import { ascGet, ascPost, resolveAscAppId } from "./asc.js";

/** 집계에 쓸 일별 보고서 한 행 — 세그먼트 CSV/TSV 의 파싱 결과. */
export type CrashRow = {
  date: string;
  appVersion: string;
  device: string;
  platformVersion: string;
  crashes: number;
  uniqueDevices: number;
};

/** 버전·디바이스 단위 집계 — 프롬프트 첨부 JSON 의 원소이자 evidence ref 의 원천. */
export type CrashGroup = {
  appVersion: string;
  device: string;
  platformVersion: string;
  crashes: number;
  /** 일별 합산이라 같은 기기가 여러 날 겹치면 과대집계될 수 있음 — 규모 감각용. */
  uniqueDevices: number;
};

/** 수집 프롬프트에 첨부하는 크래시 요약 — 기간 + 총량 + 상위 그룹. */
export type CrashDigest = {
  from: string;
  to: string;
  totalCrashes: number;
  groups: CrashGroup[];
};

/** 내려받을 일별 인스턴스 수 — 최근 1주 치면 추세 판단에 충분하고 호출 수를 통제. */
const MAX_CRASH_INSTANCES = 7;

/** 집계 그룹 상한 — 프롬프트 첨부 파일 크기 통제 (긴 꼬리는 totalCrashes 로만 보인다). */
const MAX_CRASH_GROUPS = 25;

/**
 * 세그먼트 CSV/TSV 파싱. Apple analytics 보고서는 탭 구분이 기본이지만 형식 변동에
 * 대비해 헤더에서 구분자를 추정하고, 컬럼은 이름으로 찾는다 (순서 의존 금지).
 * crashes 컬럼이 없으면 다른 보고서로 보고 [] (조용히 무시 — 집계만 안 될 뿐).
 */
export function parseCrashReportCsv(text: string): CrashRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(delim).map((h) => h.trim().toLowerCase());
  const col = (name: string): number => headers.indexOf(name);
  const iCrashes = col("crashes");
  if (iCrashes < 0) return [];
  const iDate = col("date");
  const iVersion = col("app version");
  const iDevice = col("device");
  const iPlatform = col("platform version");
  const iUnique = col("unique devices");

  const rows: CrashRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(delim);
    const cell = (i: number): string => (i >= 0 ? (cells[i] ?? "").trim() : "");
    const crashes = parseInt(cell(iCrashes), 10);
    if (!Number.isFinite(crashes) || crashes < 0) continue;
    rows.push({
      date: cell(iDate),
      appVersion: cell(iVersion),
      device: cell(iDevice),
      platformVersion: cell(iPlatform),
      crashes,
      uniqueDevices: Math.max(0, parseInt(cell(iUnique), 10) || 0),
    });
  }
  return rows;
}

/** 일별 행 → 버전·디바이스 그룹 집계. 행이 없으면 null (= 첨부할 신호 없음). */
export function aggregateCrashDigest(
  rows: CrashRow[],
  maxGroups = MAX_CRASH_GROUPS,
): CrashDigest | null {
  if (rows.length === 0) return null;
  const groups = new Map<string, CrashGroup>();
  let from = "";
  let to = "";
  let total = 0;
  for (const r of rows) {
    total += r.crashes;
    if (r.date) {
      if (!from || r.date < from) from = r.date;
      if (!to || r.date > to) to = r.date;
    }
    const key = `${r.appVersion}|${r.device}|${r.platformVersion}`;
    const g = groups.get(key);
    if (g) {
      g.crashes += r.crashes;
      g.uniqueDevices += r.uniqueDevices;
    } else {
      groups.set(key, {
        appVersion: r.appVersion,
        device: r.device,
        platformVersion: r.platformVersion,
        crashes: r.crashes,
        uniqueDevices: r.uniqueDevices,
      });
    }
  }
  const sorted = [...groups.values()]
    .filter((g) => g.crashes > 0)
    .sort((a, b) => b.crashes - a.crashes)
    .slice(0, maxGroups);
  return { from, to, totalCrashes: total, groups: sorted };
}

/**
 * 이 앱의 ONGOING analytics 보고서 요청 id. 없으면(또는 비활성으로 정지됐으면) 새로
 * 만들고 null — 생성 직후엔 보고서가 아직 없다 (Apple 비동기 생성, 보통 1~2일).
 */
async function ensureOngoingReportRequest(
  cfg: AscConfig,
  appId: string,
): Promise<string | null> {
  const data = (await ascGet(
    cfg,
    `/v1/apps/${appId}/analyticsReportRequests?filter[accessType]=ONGOING`,
  )) as {
    data?: Array<{ id: string; attributes?: { stoppedDueToInactivity?: boolean } }>;
  };
  const active = data.data?.find((r) => !r.attributes?.stoppedDueToInactivity);
  if (active) return active.id;
  await ascPost(cfg, `/v1/analyticsReportRequests`, {
    data: {
      type: "analyticsReportRequests",
      attributes: { accessType: "ONGOING" },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  });
  console.log(`[po] crash: ONGOING 보고서 요청 생성 — 데이터는 다음 사이클부터 app=${appId}`);
  return null;
}

/** 세그먼트 presigned URL 다운로드 — gzip 이면 풀고 아니면 그대로 (인증 헤더 불필요). */
async function downloadSegment(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`segment ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return (isGzip ? gunzipSync(buf) : buf).toString("utf8");
}

/**
 * 최근 크래시 집계 — «App Crashes» 보고서의 최신 일별 인스턴스 최대 7개를 합산한다.
 * null = 아직 데이터 없음 (보고서 요청 방금 생성 / 보고서·인스턴스 미생성) — 에러 아님.
 */
export async function fetchCrashDigest(
  cfg: AscConfig,
  appIdOrBundleId: string,
  maxInstances = MAX_CRASH_INSTANCES,
): Promise<CrashDigest | null> {
  const app = await resolveAscAppId(cfg, appIdOrBundleId);
  const requestId = await ensureOngoingReportRequest(cfg, app.id);
  if (!requestId) return null;

  const reports = (await ascGet(
    cfg,
    `/v1/analyticsReportRequests/${requestId}/reports?filter[name]=${encodeURIComponent("App Crashes")}`,
  )) as { data?: Array<{ id: string }> };
  const reportId = reports.data?.[0]?.id;
  if (!reportId) return null;

  const instances = (await ascGet(
    cfg,
    `/v1/analyticsReports/${reportId}/instances?filter[granularity]=DAILY`,
  )) as { data?: Array<{ id: string; attributes?: { processingDate?: string } }> };
  const recent = (instances.data ?? [])
    .map((i) => ({ id: i.id, date: i.attributes?.processingDate ?? "" }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxInstances);
  if (recent.length === 0) return null;

  const rows: CrashRow[] = [];
  for (const inst of recent) {
    const segments = (await ascGet(
      cfg,
      `/v1/analyticsReportInstances/${inst.id}/segments`,
    )) as { data?: Array<{ attributes?: { url?: string } }> };
    for (const seg of segments.data ?? []) {
      const url = seg.attributes?.url;
      if (!url) continue;
      rows.push(...parseCrashReportCsv(await downloadSegment(url)));
    }
  }
  return aggregateCrashDigest(rows);
}
