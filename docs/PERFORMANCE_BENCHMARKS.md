# Dorongi 성능 벤치마크

이 문서는 화면 제출률과 실제 계산 처리량을 구분해 기록한다. `presentation FPS`는 브라우저가 표시 기회를 받은 횟수이고, `completed tick/s`는 작품의 논리 틱이 끝까지 완료된 횟수다.

## 2026-10-14 — Real Time Ray Tracing.ent

측정 환경:

- CPU: Intel Core Ultra 7 258V, 8 cores / 8 logical processors
- GPU: Intel Arc 140V
- RAM: 32 GB
- viewport: 1280×800
- Dorongi 무대 backing store: 942×638
- 작품: `Real Time Ray Tracing.ent`
- 네이티브 컴파일: 24/24 사용자 함수
- 표본: 각 모드 3초, 로컬 HTTP 서버, Playwright headless Chromium/Edge
- 연산 규모: 4단계

| 브라우저 | 모드 | 화면 제출 | 완료 논리 틱 | 25ms 초과 rAF 간격 |
|---|---:|---:|---:|---:|
| Chrome | 1배속, 도로롱 끔 | 59.9 fps | 59.9 tick/s | 0회 |
| Chrome | 4배속, 도로롱 켬 | 59.9 fps | 139.9 tick/s | 0회 |
| Edge | 1배속, 도로롱 끔 | 60.2 fps | 60.2 tick/s | 0회 |
| Edge | 4배속, 도로롱 켬 | 60.1 fps | 76.4 tick/s | 1회 |

Chrome에서는 화면 제출률을 유지하면서 완료 논리 처리량이 약 2.3배가 됐다. Edge에서도 약 60fps를 유지하며 약 1.27배의 완료 틱을 처리했다. 브라우저, 전원 정책, GPU 드라이버, 화면 주사율과 작품 상태에 따라 결과는 달라진다.

## 12,000-face OBJ 검증 상태

`obj__Notextures.ent`의 retained GPU preview는 34,698 vertices, 11,566 triangles를 한 VBO로 유지한다. Chrome과 Edge에서 드래그 중 GPU preview, release 뒤 완성 펜 버퍼 복귀, 정점 수 보존을 회귀 검사한다. 2026-10-14의 새 드래그 FPS 자동 측정은 프로젝트 로딩 종료 조건이 간헐적으로 대기하는 문제가 남아 있어 수치를 공개 표에 넣지 않았다. 측정이 안정화되기 전 숫자를 성능 주장으로 사용하지 않는다.

## 재현 방법

Eniwan 개발 저장소에서 로컬 서버를 실행한 뒤 다음을 사용한다.

```bash
npm run start
node tools/eniwanvm/verify-local-render-regressions.mjs --ray-only
node tools/eniwanvm/verify-local-render-regressions.mjs --edge --ray-only
```

검증 항목에는 실행 오류, 네이티브 함수 수, 논리 틱, 화면 제출, 실제 paint, rAF 간격, 펜 버퍼 복사 수, 렌더 크기가 포함된다.

## 해석 범위

- 이 결과는 특정 실작품과 특정 장치의 측정값이며 모든 Entry 작품의 배속을 보장하지 않는다.
- 로직 처리량이 화면 주사율보다 높아도 중간 논리 상태를 모두 표시한다는 뜻은 아니다. Dorongi는 마지막으로 완료된 화면을 표시한다.
- 현재 안정 경로는 긴 네이티브 반복을 협력적으로 나누어 브라우저의 표시 기회를 보존한다. VM 전체와 WebGL을 Worker/OffscreenCanvas로 옮기는 구조는 아직 공개 완료 기능으로 주장하지 않는다.
