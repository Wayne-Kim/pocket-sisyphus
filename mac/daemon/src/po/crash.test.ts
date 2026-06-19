import { describe, expect, it } from "vitest";
import { aggregateCrashDigest, parseCrashReportCsv } from "./crash.js";

/** ASC Analytics «App Crashes» 일별 보고서 형태의 TSV (실제 파일이 탭 구분). */
const TSV = [
  "Date\tApp Name\tApp Apple Identifier\tApp Version\tDevice\tPlatform Version\tCrashes\tUnique Devices",
  "2026-06-08\tPocket Sisyphus\t123\t2.13.0\tiPhone15,3\tiOS 19.1\t12\t9",
  "2026-06-09\tPocket Sisyphus\t123\t2.13.0\tiPhone15,3\tiOS 19.1\t8\t6",
  "2026-06-09\tPocket Sisyphus\t123\t2.13.0\tiPhone14,2\tiOS 18.7\t3\t3",
  "2026-06-09\tPocket Sisyphus\t123\t2.12.0\tiPhone15,3\tiOS 19.1\t1\t1",
].join("\n");

describe("parseCrashReportCsv", () => {
  it("탭 구분 보고서를 컬럼 «이름» 으로 파싱한다 (순서 의존 없음)", () => {
    const rows = parseCrashReportCsv(TSV);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      date: "2026-06-08",
      appVersion: "2.13.0",
      device: "iPhone15,3",
      platformVersion: "iOS 19.1",
      crashes: 12,
      uniqueDevices: 9,
    });
  });

  it("콤마 구분 폴백도 동작한다", () => {
    // 셀 안에 콤마가 없는 단순 케이스 (Apple 원본은 탭 — 콤마는 방어적 폴백).
    const csv =
      "Date,App Version,Device,Platform Version,Crashes,Unique Devices\n" +
      "2026-06-09,2.13.0,iPad,iPadOS 19.1,5,4";
    const rows = parseCrashReportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].crashes).toBe(5);
    expect(rows[0].device).toBe("iPad");
  });

  it("crashes 컬럼이 없는(다른 보고서) 파일은 빈 배열", () => {
    const other =
      "Date\tApp Version\tSessions\n2026-06-09\t2.13.0\t100";
    expect(parseCrashReportCsv(other)).toEqual([]);
  });

  it("crashes 가 숫자가 아닌 행은 건너뛴다", () => {
    const broken = TSV + "\n2026-06-10\tPS\t123\t2.13.0\tiPhone15,3\tiOS 19.1\tN/A\t0";
    expect(parseCrashReportCsv(broken)).toHaveLength(4);
  });

  it("헤더만 있거나 빈 입력은 빈 배열", () => {
    expect(parseCrashReportCsv("")).toEqual([]);
    expect(parseCrashReportCsv(TSV.split("\n")[0])).toEqual([]);
  });
});

describe("aggregateCrashDigest", () => {
  it("버전·디바이스로 묶어 합산하고 crashes 내림차순 정렬", () => {
    const digest = aggregateCrashDigest(parseCrashReportCsv(TSV));
    expect(digest).not.toBeNull();
    expect(digest!.totalCrashes).toBe(24);
    expect(digest!.from).toBe("2026-06-08");
    expect(digest!.to).toBe("2026-06-09");
    expect(digest!.groups).toHaveLength(3);
    // 2.13.0 + iPhone15,3 이 12+8=20 으로 1위 (일별 행이 한 그룹으로 합산).
    expect(digest!.groups[0]).toEqual({
      appVersion: "2.13.0",
      device: "iPhone15,3",
      platformVersion: "iOS 19.1",
      crashes: 20,
      uniqueDevices: 15,
    });
    expect(digest!.groups[2].crashes).toBe(1);
  });

  it("그룹 상한(maxGroups)을 지키되 totalCrashes 는 전체 합", () => {
    const digest = aggregateCrashDigest(parseCrashReportCsv(TSV), 1);
    expect(digest!.groups).toHaveLength(1);
    expect(digest!.totalCrashes).toBe(24);
  });

  it("crashes 0 뿐인 행은 그룹에서 빠진다 (totalCrashes 0)", () => {
    const zero =
      "Date\tApp Version\tDevice\tPlatform Version\tCrashes\tUnique Devices\n" +
      "2026-06-09\t2.13.0\tiPhone15,3\tiOS 19.1\t0\t0";
    const digest = aggregateCrashDigest(parseCrashReportCsv(zero));
    expect(digest!.totalCrashes).toBe(0);
    expect(digest!.groups).toEqual([]);
  });

  it("행이 없으면 null (= 첨부할 신호 없음)", () => {
    expect(aggregateCrashDigest([])).toBeNull();
  });
});
