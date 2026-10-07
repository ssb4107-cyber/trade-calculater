# Supabase 서버 적용 보고 — 2026-10-07

무료 프로젝트 생성, 서버 저장 구조와 시세 함수의 실제 적용을 완료했습니다. 이메일 확인이 완료된 계정 1개가 등록된 것을 확인했습니다. 사용자 선택에 따라 공개 회원가입 허용을 유지하며 설정 파일과 안내에도 반영했습니다. 사이트 주소·새 시세 키 설정 확인과 운영 사이트 반영은 남아 있습니다.

## 적용 결과

| 항목 | 실제 상태 |
| --- | --- |
| 조직 | `ssb4107-cyber's Org`, Free |
| 프로젝트 | `trade-calculater`, `pyerygphflowylaqtpht`, 정상 작동 |
| 지역 / 비용 | 서울 `ap-northeast-2`, 생성 비용 월 0원 확인 |
| 데이터베이스 | PostgreSQL 17.11, 사용자 자료·원본 백업·중복 요청 기록·시세 요청 제한 적용 |
| 서버 변경 이력 | `20261006195706_server_storage`, `20261006195713_private_storage_functions` |
| 시세 서버 | `market-data` 버전 1, ACTIVE |
| 웹 연결 | 공개 URL과 publishable key 입력; 비밀키는 브라우저 코드에 없음 |
| 운영 사이트 | 서버 전환 수정본을 검토용 브랜치에 보관; 운영 반영 대기 |

서버 변경 번호와 로컬 SQL 파일명을 일치시켰습니다. 이후 공식 관리 프로그램으로 적용할 때 같은 변경을 다시 실행하지 않도록 합니다.

## 실제 서버에서 확인한 사항

- 모든 자료 테이블의 RLS와 읽기·쓰기·함수 실행 권한 검사 통과.
- 두 임시 계정 식별자를 사용해 다른 계정의 문서·저장 요청 결과가 보이지 않는지 확인.
- 오래된 버전의 저장 거절, 같은 요청의 중복 실행 방지와 최신 버전 갱신 확인.
- 직접 테이블 수정과 익명 저장 함수 호출 차단, 보유 수량 초과 매도 거절 확인.
- 세 문서의 일괄 이전과 정확한 원본 텍스트 백업, 계정별 시세 요청 제한 확인.
- 임시 자료는 전체 롤백. 초기 검사 직후 사용자·문서·백업·요청 기록·시세 제한 행이 모두 0건임을 확인. 이후 실제 이용자 계정 1개의 등록과 이메일 확인 완료를 별도로 확인.
- 실제 HTTP API에서 익명 문서·백업·저장 함수 접근이 차단됨을 확인.
- 시세 함수의 로그인 누락·잘못된 토큰·잘못된 출처·잘못된 호출 방식 차단과 브라우저 사전 요청 응답 확인.
- 실제 Auth 서버의 잘못된 로그인 거절과 화면의 한국어 안내 확인.

이 검증은 실제 사용자 비밀번호 로그인 성공, 다른 컴퓨터에서의 로그인·저장, 새 Finnhub 키로 조회한 실제 시세 성공까지 검증한 것은 아닙니다. 기존 SDK·브라우저 연동 검증은 통제된 서버 응답으로 별도로 통과했으며 실제 사용자 확인이 남아 있습니다.

## 남은 입력

현재 연결된 관리 기능이 Auth 계정·설정 변경과 서버 비밀키 등록을 지원하지 않아 다음 항목은 사용자 관리 화면 입력이 필요합니다.

회원가입 허용은 유지합니다. 익명 로그인은 꺼져 있고 이메일 로그인은 켜져 있습니다. 계정 1개는 등록 및 이메일 확인을 완료했습니다. 추가 이용자가 필요하면 [사용자](https://supabase.com/dashboard/project/pyerygphflowylaqtpht/auth/users)에서 **Add user → Create user**로 생성하고 **Auto Confirm User**를 켭니다. 비밀번호를 채팅이나 저장소에 기록하지 않습니다. 현재 앱에 회원가입 버튼은 없습니다.

1. [사이트 주소](https://supabase.com/dashboard/project/pyerygphflowylaqtpht/auth/url-configuration)의 Site URL에 `https://ssb4107-cyber.github.io/trade-calculater/`를 저장합니다.
2. [서버 비밀 값](https://supabase.com/dashboard/project/pyerygphflowylaqtpht/functions/secrets)에 새 Finnhub 키를 `FINNHUB_API_KEY`라는 이름으로 등록합니다. 기존 공개 키 폐기·재발급은 Finnhub 계정에서 처리해야 합니다. 새 키는 브라우저 코드나 SQL에 넣지 않습니다.

계정 등록과 시세 설정을 확인한 뒤 운영 사이트에 반영하고 실제 사용자 로그인·자료 이전·시세 조회를 확인합니다. Supabase 프로젝트 생성과 운영 사이트 전환은 서로 다른 단계입니다.

## 서버 진단 결과

보안과 성능 진단에 ERROR/WARN 항목은 없었습니다. 다음 INFO 항목은 새 프로젝트와 내부 접근 차단 구조에 따른 상태입니다.

- 내부 `silver_mutations`, `silver_market_limits` 두 테이블에는 일반 사용자의 직접 접근 권한과 허용 정책이 없습니다. RLS 기본 거절을 사용하고, 본인 식별자를 확인하는 비공개 저장 함수만 접근합니다. 실제 권한 검사도 통과했습니다. [RLS 정책 없는 테이블 진단](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
- 새 백업·저장 요청 인덱스 두 개는 아직 실제 자료가 없어 사용 이력이 없습니다. 사용자별 조회·백업 정리와 외래키 처리를 위해 유지합니다. [미사용 인덱스 진단](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)

브라우저의 동시 매도 점검은 비활성 탭에서 기본 경고창이 숨겨질 수 있어, 실제 경고 호출·저장 수량·실패한 입력창 유지 여부를 함께 검사하도록 보완했습니다. [Chromium 경고창 정책](https://developer.chrome.com/blog/dialogs-policy)
