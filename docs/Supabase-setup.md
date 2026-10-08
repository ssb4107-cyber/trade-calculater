# Supabase 적용 안내

추가 적용(2026-10-08): 계정별 **휴지통**과 P3 개선을 적용했습니다. 삭제한 종목·포지션·매도·계산 기록을 복원할 수 있습니다. 중복 조회 감소, 실제 시세 시각과 접근성, 고정 의존성·자동 검증 후 배포도 반영했습니다. 설정의 비밀번호 변경과 로그인 화면의 복구 흐름을 추가했으나 **실제 복구 메일 발송은 외부 SMTP 설정이 남아 있습니다.** [P3·휴지통 보고서](P3-and-trash-2026-10-08.md)를 확인하세요.

추가 적용(2026-10-07): 전체 재점검 P2 7건을 개선하고 `20261007104227_account_snapshots.sql`을 서버에 적용했습니다. **설정 → 자료 백업·복원**에서 최신 서버 자료 다운로드, 서버 백업 보관과 복원을 사용할 수 있습니다. 일별 첫 변경 전 자동 백업, 복원 직전 백업, 계정별 접근 제한과 복원 충돌·중복 방지를 검증했습니다. 사용 방법과 남은 개선 항목은 [P2 개선 결과](P2-improvements-2026-10-07.md)를 확인하세요.

현재 상태(2026-10-07): Free 프로젝트 `trade-calculater`를 서울 리전에 생성했고, 데이터베이스 변경 2건과 `market-data` 서버 함수를 실제 적용했습니다. `js/backendConfig.js`에는 공개 URL과 publishable key를 입력했습니다. 실제 데이터베이스 권한·계정 분리·충돌 방지·자료 이전과 익명 HTTP 접근 차단 검증을 통과했습니다. 사용자 선택에 따라 공개 회원가입을 허용 상태로 유지합니다. 이메일 확인이 완료된 계정 1개가 등록된 것을 확인했고, 사이트 주소·시세 키 설정은 사용자에게 완료 답변을 받았습니다. 운영 브랜치 반영과 GitHub Pages 배포를 완료했으며 실제 사이트의 로그인 화면·로그인 실패 안내·보호된 페이지 접근 차단을 검증했습니다. 실제 이용자 계정으로 로그인·자료 저장·시세 조회에 성공하는지 확인하는 것은 첫 사용 시 진행합니다.

프로젝트: [Supabase 관리 화면](https://supabase.com/dashboard/project/pyerygphflowylaqtpht). API URL: `https://pyerygphflowylaqtpht.supabase.co`. 실제 적용 결과와 남은 항목은 [서버 적용 보고](Supabase-deployment-2026-10-07.md)에 정리했습니다.

## 실제 적용 순서

1. 사용자 계정의 조직에 `trade-calculater`라는 **Free** 프로젝트를 생성합니다. 요금제를 변경하지 않습니다.
2. `supabase/migrations`의 SQL 파일을 파일명 순서대로 적용합니다. 첫 파일에는 사용자 자료 테이블, 복구 백업, 충돌 방지 저장 함수와 사용자별 읽기 권한이 포함됩니다. 후속 파일은 권한이 높은 내부 함수를 Data API에 노출하지 않는 `silver_private` 스키마로 옮기며, 공개 함수는 호출자의 권한으로 이 함수를 호출합니다. 백업과 저장 요청의 사용자별 조회 인덱스도 추가합니다.
3. Auth에서 공개 회원가입을 허용 상태로 유지하고 익명 로그인은 비활성화합니다. 사용자 선택에 따라 Email 제공자의 **Confirm email**을 끄고 이메일·비밀번호로 가입하면 바로 로그인하도록 합니다. 실제 공개 Auth 설정에서도 이메일 인증이 꺼진 것을 확인했습니다. 앱의 **회원가입** 버튼에서 이메일과 8자 이상의 비밀번호·비밀번호 확인을 입력합니다. 가입 시 인증 메일을 발송하지 않습니다. 자료 접근은 계정별로 제한됩니다. 비밀번호는 채팅이나 저장소에 기록하지 않습니다.
4. `market-data` Edge Function을 배포합니다. `supabase/config.toml`의 `verify_jwt = false` 설정을 사용하며 함수 내부의 `auth.getUser()`가 모든 시세 요청을 검증합니다. 프로젝트 인증에 최신 `SUPABASE_PUBLISHABLE_KEYS`의 기본 키를 우선 사용하고 기존 공개 키에도 호환됩니다. 브라우저의 publishable key만으로 시세 함수에 접근할 수 없습니다.
5. 공개된 기존 Finnhub 키를 공급자 관리 화면에서 폐기하고 새 키를 발급합니다. 새 `FINNHUB_API_KEY`는 Supabase의 Edge Function Secrets 화면에 직접 등록합니다. 새 키를 채팅, 코드, SQL, PR 본문에 넣지 않습니다. 기본 허용 출처는 `https://ssb4107-cyber.github.io`입니다. 필요한 경우 `ALLOWED_ORIGINS`를 쉼표로 구분한 정확한 출처 목록으로 등록합니다.
6. 프로젝트의 공개 URL과 **publishable key**만 `js/backendConfig.js`에 입력합니다. secret key 또는 service_role key는 사용하지 않습니다.
7. 실제 프로젝트의 계정별 저장 권한과 익명 접근 차단, 통제된 SDK 브라우저 환경의 저장 충돌·자료 이전·로그아웃/계정 전환을 검증한 뒤 GitHub Pages 운영 브랜치에 반영합니다. 배포 후 실제 이용자 계정으로 로그인·다른 컴퓨터의 저장·시세 요청·자료 이전을 확인합니다.

## 공식 관리 프로그램으로 연결하는 경우

2026-10-07에 Supabase 관리 연결을 확인하고, 사용자가 선택한 Free 조직 `ssb4107-cyber's Org`에 프로젝트를 생성했습니다. 새 프로젝트 비용은 월 0원으로 확인했습니다. 데이터베이스와 Edge Function은 연결된 관리 기능으로 적용했습니다. 현재 연결된 기능에는 Auth 계정 생성·설정 변경과 Edge Function 비밀키 등록 기능이 없으므로 해당 항목은 관리 화면에서 입력해야 합니다.

CLI를 직접 사용하는 경우 플러그인의 계정 인증은 Supabase CLI에 자동으로 전달되지 않습니다. 공식 CLI 2.119.0을 별도의 로컬 도구 폴더에 설치했으며 다음 절차는 CLI를 통한 별도 관리가 필요한 경우에 사용합니다.

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

`config.toml`에는 사이트 주소, 공개 회원가입 허용, 이메일 인증 없이 가입, 익명 로그인 제한, 시세 함수의 인증 방식만 선언합니다. `config diff` 결과를 확인한 뒤 적용합니다. 저장 권한 점검 SQL은 사용자 자료를 읽거나 변경하지 않습니다.

## 사용 방식

- 계정이 없으면 **회원가입**을 누르고 이메일·비밀번호·비밀번호 확인을 입력합니다. 비밀번호는 8자 이상이며 확인값이 일치해야 합니다. 가입 성공 후 바로 로그인합니다. 이미 가입한 계정은 이메일과 비밀번호로 로그인합니다. 로그인 상태는 브라우저에 유지되며, 종목·거래·계산 기록·정렬과 화면 설정의 원본은 서버에 저장합니다.
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
node tests/server.public.cjs
node tests/audit-p2.browser.cjs
```

브라우저 검증에는 Playwright와 Edge가 필요합니다. PostgreSQL 검증에는 임시 검증 환경의 `@electric-sql/pglite`가 필요합니다. `server.browser.cjs`는 공식 Supabase SDK와 통제된 Auth/PostgREST 응답을 사용하며, 실제 Supabase 계정/프로젝트 검증을 대신하지 않습니다. `server.sql.cjs`는 실제 PostgreSQL 엔진에서 마이그레이션과 RLS 권한을 실행합니다. `server.public.cjs`는 실제 배포된 서버의 익명 접근 차단과 로그인 설정 상태만 확인하며, 계정을 만들거나 이메일을 발송하지 않습니다.

`supabase/checks/server-isolation.sql`은 실제 서버에서도 실행했습니다. 검사에 필요한 임시 Auth 식별자와 문서는 하나의 트랜잭션 안에서만 생성하고 전체를 롤백합니다. 두 계정의 데이터베이스 권한과 저장 함수는 검증하지만 실제 비밀번호 로그인이나 다른 컴퓨터의 브라우저 세션 검증을 대신하지 않습니다.

`supabase/checks/account-snapshots.sql`도 같은 방식으로 실제 서버의 백업 권한·계정 분리·일별 보관·복원 충돌·중복 방지·복원 전 자료 보관을 검증하고 롤백했습니다. `audit-p2.browser.cjs`는 실제 이용자 계정을 사용하지 않는 통제된 SDK 브라우저 검증입니다.

회원가입 수정본은 실제 Supabase에 연결한 별도 브라우저 환경에서 임시 계정으로 검증했습니다. 가입 직후 자동 로그인, 실제 포트폴리오·고정 설정 저장, 서로 분리된 두 브라우저 세션의 같은 계정 로그인/복원과 인증된 Finnhub 시세 조회에 성공했습니다. 검증 후 로그아웃하고 임시 계정·자료·요청 기록을 정리해 모두 0건임을 확인했습니다. 기존 이용자 계정은 유지했습니다. 비밀번호·토큰·시세 키는 검증 기록에 저장하지 않았습니다.

참고: [Supabase 비밀번호 로그인](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), [사용자별 데이터 권한](https://supabase.com/docs/guides/database/postgres/row-level-security), [함수 인증](https://supabase.com/docs/guides/functions/auth), [서버 비밀 값](https://supabase.com/docs/guides/functions/secrets).
