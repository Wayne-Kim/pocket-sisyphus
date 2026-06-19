/**
 * 데모 데이터 시드/정리 CLI — 문서 속 수동 INSERT/DELETE 절차를 단일 커맨드로 대체한다.
 *
 *   tsx src/cli/demo.ts seed        # 대표 데모 데이터 멱등 삽입
 *   tsx src/cli/demo.ts teardown    # demo-store- prefix 행만 삭제
 *   tsx src/cli/demo.ts status      # 현재 데모 행 수 출력
 *
 * seed/teardown 은 «격리 DB» 가드를 거친다 — POCKET_CLAUDE_CONFIG_DIR 로 격리 디렉터리를
 * 가리키지 않으면(=실 DB) 쓰기를 거부한다. 정말 실 DB 에 써야 하면 `--force`
 * (또는 DEMO_ALLOW_REAL_DB=1) 로 명시한다. status 는 읽기 전용이라 가드 대상이 아니다.
 *
 * 캡처/검증은 «격리 DB» 위에서 돌려야 한다 — 실 DB 를 열지 않도록 격리 디렉터리를 가리킨 뒤
 * 실행한다:
 *
 *   POCKET_CLAUDE_CONFIG_DIR=/tmp/ps-demo tsx src/cli/demo.ts seed
 *
 * 모든 쓰기는 db() 를 거쳐 schema.sql + applyMigrations 를 통과한다 (마이그레이션 우회 없음).
 */
import { DB_FILE, isIsolatedConfigDir } from "../config.js";
import {
  seedDemo,
  teardownDemo,
  countDemoRows,
  DEMO_PREFIX,
  DemoRealDbGuardError,
} from "../dev/demo-data.js";

function usage(): void {
  console.log("Usage: demo <seed|teardown|status> [--force]");
  console.log("");
  console.log("  seed      대표 데모 데이터를 멱등 삽입 (기존 데모 prefix 행은 먼저 정리)");
  console.log("  teardown  demo-store- prefix 행만 삭제 (전체 wipe 아님)");
  console.log("  status    현재 데모 prefix 행 수 출력 (읽기 전용 — 가드 없음)");
  console.log("");
  console.log("  --force   격리 미설정이어도 «실 DB» 에 쓰기를 강제 (DEMO_ALLOW_REAL_DB=1 동치)");
  console.log("");
  console.log(`  대상 DB: ${DB_FILE}`);
  console.log(`  격리 상태: ${isIsolatedConfigDir() ? "격리 DB ✔" : "실(=운영) DB ✘"}`);
  console.log("  격리 DB 로 돌리려면 POCKET_CLAUDE_CONFIG_DIR 을 먼저 지정하세요.");
}

function main(): void {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const cmd = args.find((a) => !a.startsWith("--"));
  console.log(`[demo] DB: ${DB_FILE}`);
  try {
    switch (cmd) {
      case "seed": {
        const r = seedDemo({ force });
        console.log(
          `✔ seeded — sessions=${r.sessions} messages=${r.messages} briefs=${r.briefs} (prefix '${DEMO_PREFIX}')`,
        );
        console.log(`  demo rows now: ${countDemoRows()}`);
        break;
      }
      case "teardown": {
        const r = teardownDemo({ force });
        console.log(`✔ teardown — deleted ${r.deleted} demo row(s) (prefix '${DEMO_PREFIX}')`);
        console.log(`  demo rows now: ${countDemoRows()}`);
        break;
      }
      case "status": {
        console.log(`demo rows: ${countDemoRows()} (prefix '${DEMO_PREFIX}')`);
        break;
      }
      default:
        usage();
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    if (e instanceof DemoRealDbGuardError) {
      console.error(`\n✘ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
