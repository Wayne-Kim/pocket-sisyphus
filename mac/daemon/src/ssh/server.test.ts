import { describe, it, expect } from "vitest";
import { isOurSshdCommand } from "./server.js";

// reclaimSshPort 가 «우리 sshd» 만 골라 죽이는 안전장치의 핵심 판별.
// 회귀: 옛/유령 sshd(포트 충돌로 새 daemon 의 sshd 가 bind 못 하게 만드는 주범)는 죽이고,
// 시스템 sshd(:22)나 무관한 프로세스는 절대 못 죽이게 고정한다.
describe("isOurSshdCommand", () => {
  const OUR_CONFIG =
    "/Users/soloway/Library/Application Support/PocketSisyphus/ssh/sshd_config";

  it("우리 sshd_config 로 띄운 listener sshd 는 우리 것으로 본다", () => {
    // 실제 유령 프로세스의 `ps -o command=` 출력 (Xcode Debug 빌드 잔존, 포트 22022 점유).
    const cmd =
      "sshd: /Users/soloway/Library/Developer/Xcode/DerivedData/PocketSisyphusMac-xxx/" +
      "Build/Products/Debug/PocketSisyphusMac.app/Contents/Resources/daemon/bin/sshd " +
      `-f ${OUR_CONFIG} -D -e [listener] 0 of 10-100 startups`;
    expect(isOurSshdCommand(cmd, OUR_CONFIG)).toBe(true);
  });

  it("설치본(.app) sshd 도 같은 config 를 쓰면 우리 것", () => {
    const cmd =
      "/Applications/PocketSisyphusMac.app/Contents/Resources/daemon/bin/sshd " +
      `-f ${OUR_CONFIG} -D -e`;
    expect(isOurSshdCommand(cmd, OUR_CONFIG)).toBe(true);
  });

  it("시스템 sshd(:22) 는 절대 우리 것이 아니다", () => {
    expect(isOurSshdCommand("/usr/sbin/sshd -D", OUR_CONFIG)).toBe(false);
    // launchd 로 뜬 시스템 sshd 세션
    expect(
      isOurSshdCommand("sshd: soloway [priv]", OUR_CONFIG),
    ).toBe(false);
  });

  it("sshd 가 아닌 무관한 프로세스는 우리 것이 아니다", () => {
    // 우연히 config 경로가 커맨드에 있어도 sshd 가 아니면 제외.
    expect(
      isOurSshdCommand(`/bin/cat ${OUR_CONFIG}`, OUR_CONFIG),
    ).toBe(false);
    expect(isOurSshdCommand("node /path/to/daemon/src/index.ts", OUR_CONFIG)).toBe(
      false,
    );
  });

  it("sshd 이지만 다른 config(다른 설치/프로필) 면 우리 것이 아니다", () => {
    const cmd = "/opt/homebrew/sbin/sshd -f /etc/ssh/sshd_config -D -e";
    expect(isOurSshdCommand(cmd, OUR_CONFIG)).toBe(false);
  });
});
