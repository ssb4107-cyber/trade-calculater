# Supabase 적용 안내

현재 상태: 로그인·서버 저장·자료 이전·시세 서버 코드 구현 완료. 실제 Supabase 프로젝트는 아직 생성/적용하지 않았습니다. `js/backendConfig.js`가 비어 있으므로 현재 코드를 실행하면 기존 로컬 저장 방식이 사용됩니다. 서버 전환 완료로 판단하면 안 됩니다.

## 실제 적용 순서

1. 사용자 계정의 조직에 `trade-calculater`라는 **Free** 프로젝트를 생성합니다. 요금제를 변경하지 않습니다.
2. `supabase/migrations/202610060001_server_storage.sql`을 데이터베이스 마이그레이션으로 적용합니다. 이 파일에는 사용자 자료 테이블, 복구 백업, 충돌 방지 저장 함수와 사용자별 읽기 권한이 포함됩니다.
3. Auth에서 공개 회원 가입을 비활성화합니다. 관리자 화면에서 이용자 3~4명의 이메일/비밀번호 계정을 생성하고 이메일을 확인 완료로 등록합니다. 이 방식에는 로그인 때 이메일을 발송하는 과정이 없습니다. 비밀번호는 채팅이나 저장소에 기록하지 않습니다.
4. `market-data` Edge Function을 배포합니다. `supabase/config.toml`의 `verify_jwt = false` 설정을 사용하며 함수 내부의 `auth.getUser()`가 모든 시세 요청을 검증합니다. 브라우저의 publishable key만으로 시세 함수에 접근할 수 없습니다.
5. 공개된 기존 Finnhub 키를 공급자 관리 화면에서 폐기하고 새 키를 발급합니다. 새 `FINNHUB_API_KEY`는 Supabase의 Edge Function Secrets 화면에 직접 등록합니다. 새 키를 채팅, 코드, SQL, PR 본문에 넣지 않습니다. 기본 허용 출처는 `https://ssb4107-cyber.github.io`입니다. 필요한 경우 `ALLOWED_ORIGINS`를 쉼표로 구분한 정확한 출처 목록으로 등록합니다.
6. 프로젝트의 공개 URL과 **publishable key**만 `js/backendConfig.js`에 입력합니다. secret key 또는 service_role key는 사용하지 않습니다.
7. 실제 프로젝트에서 두 계정 간 접근 차단, 같은 계정의 서로 다른 컴퓨터 저장, 로그아웃/계정 전환, 시세 요청, 자료 이전을 검증한 뒤 GitHub Pages 운영 브랜치에 반영합니다.

## 공식 관리 프로그램으로 연결하는 경우

플러그인의 계정 인증은 Supabase CLI에 자동으로 전달되지 않습니다. 2026-10-06에는 플러그인 관리 기능과 브라우저 조작 기능을 사용할 수 없어 공식 CLI 2.119.0을 별도의 로컬 도구 폴더에 설치했습니다. CLI 계정 인증은 아직 완료하지 않았으며, 이 설치만으로 프로젝트가 생성되거나 서버가 적용되는 것은 아닙니다.

Codex 터미널에서 다음 명령을 실행하고 새로 열린 브라우저에서 인증합니다. 브라우저에 표시되는 확인 코드는 같은 터미널에만 입력합니다. 비밀번호, 확인 코드와 access token은 채팅으로 전달하지 않습니다.

```powershell
npx --yes supabase@2.119.0 login --name trade-calculater --agent no
```

인증 후 조직과 기존 프로젝트를 조회하여 **Free 조직과 무료 프로젝트 여유가 확인된 경우에만** 새 프로젝트를 생성합니다. 서울 리전 `ap-northeast-2`를 사용하며 유료 크기, 고가용성 옵션 또는 요금제 변경은 적용하지 않습니다.

생성한 프로젝트를 연결한 다음 다음 순서로 적용합니다. `<project-ref>`는 실제 생성 결과로 바꿉니다. 데이터베이스 비밀번호는 공식 프로그램의 입력 창이나 안전한 로컬 인증 저장소로만 전달합니다.

```powershell
supabase db push --dry-run
supabase db push
supabase config diff --project-ref <project-ref>
supabase config push --project-ref <project-ref>
supabase functions deploy market-data --project-ref <project-ref> --use-api
supabase db query --project-ref <project-ref> --file supabase/checks/server-storage.sql
```

`config.toml`에는 사이트 주소, 공개 회원가입/익명 로그인 제한, 시세 함수의 인증 방식만 선언합니다. `config diff` 결과를 확인한 뒤 적용합니다. 저장 권한 점검 SQL은 사용자 자료를 읽거나 변경하지 않습니다. 실제 두 계정 로그인·저장·시세 확인은 별도로 수행해야 합니다.

## 사용 방식

- 이메일과 비밀번호로 로그인합니다. 로그인 상태는 브라우저에 유지되며, 종목·거래·계산 기록·정렬과 화면 설정의 원본은 서버에 저장합니다.
- 처음 로그인한 계정의 서버가 비어 있고 이 컴퓨터에 기존 자료가 있으면 자료를 옮길지 선택합니다. 화면에 대상 계정 이메일을 표시합니다.
- 정상 자료와 손상된 원본 백업을 **한 번의 서버 트랜잭션**으로 이전합니다. 읽을 수 없는 자료는 자동으로 덮어쓰지 않습니다. 기존 로컬 원본도 삭제하지 않습니다.
- 서버에 자료가 이미 있는 계정에는 로컬 자료를 덮어쓰지 않습니다. 다른 컴퓨터에서 로그인하면 서버 자료를 읽습니다.
- 동시 저장은 서버 버전을 비교하고 충돌 시 최신 자료에 변경 작업을 다시 적용합니다. 응답이 끊긴 요청은 같은 요청 ID로 재시도하므로 중복 거래를 만들지 않습니다.
- 다른 창/컴퓨터의 변경은 활성 화면에서 5초 주기로 확인하고 화면으로 돌아오면 즉시 확인합니다. 저장 실패 때 입력 창을 유지하며 성공 표시를 띄우지 않습니다.

## 보관 및 제한

현재 규모에서 기존 자료 구조를 그대로 보존하도록 사용자별 포트폴리오·설정·계산 기록 세 문서로 저장합니다. 자료를 통째로 무조건 덮어쓰지 않고 서버 버전 비교로 저장합니다. 거래 항목별 테이블은 향후 검색·집계 규모가 커질 때 별도 마이그레이션으로 분리할 수 있습니다.

문서당 5MB, 최초 이전 원본 합계 15MB를 제한합니다. 시세 요청은 계정별 분당 12회로 제한합니다. 시세 키와 원본 백업은 사용자 화면에 공개하지 않습니다. 원본 백업은 해당 사용자 또는 프로젝트 관리자만 읽을 수 있습니다. 데이터베이스 전체 장애/삭제에 대한 외부 백업은 별도 운영 절차가 필요합니다.

## 검증 실행

```powershell
node --test tests/domain.test.cjs tests/market.test.cjs
node tests/portfolio.browser.cjs
node tests/p2.browser.cjs
node tests/server.browser.cjs
node tests/server.sql.cjs
```

브라우저 검증에는 Playwright와 Edge가 필요합니다. PostgreSQL 검증에는 임시 검증 환경의 `@electric-sql/pglite`가 필요합니다. `server.browser.cjs`는 공식 Supabase SDK와 통제된 Auth/PostgREST 응답을 사용하며, 실제 Supabase 계정/프로젝트 검증을 대신하지 않습니다. `server.sql.cjs`는 실제 PostgreSQL 엔진에서 마이그레이션과 RLS 권한을 실행합니다.

참고: [Supabase 비밀번호 로그인](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), [사용자별 데이터 권한](https://supabase.com/docs/guides/database/postgres/row-level-security), [함수 인증](https://supabase.com/docs/guides/functions/auth), [서버 비밀 값](https://supabase.com/docs/guides/functions/secrets).
