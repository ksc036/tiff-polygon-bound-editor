# TIFF Polygon Bound Editor

TIFF 이미지 시퀀스의 boundary, mask, subimage, alignment, density, heatmap을 다루는 로컬 React + Express 애플리케이션입니다. 원본 이미지와 분석 결과는 **Express 서버를 실행하는 컴퓨터의 폴더**에서 읽고 저장합니다.

| 화면 | 주소 | 주요 작업 |
| --- | --- | --- |
| 메인 편집기 | <http://localhost:3000/> | Boundary 편집, mask 확인, skeleton/ROI 분석, subimage, heatmap, 데이터 ZIP |
| Inference | <http://localhost:3000/inferencePage> | 외부 모델에 TIFF 전송, 확률맵 확인, threshold 설정, mask 생성, 이미지 ZIP |

이 저장소에는 모델 추론 서버가 포함되어 있지 않습니다. `Run inference`는 별도 서버에 요청하며, 기본 주소는 `http://192.168.1.157:8001/`입니다. 이미 mask가 있다면 inference 없이 메인 페이지의 분석 기능을 사용할 수 있습니다.

### 바로 찾기

- [설치, 시작, 종료, 업데이트](#1-설치-및-서버-실행)
- [환경 변수와 설정 저장 범위](#환경-변수와-설정-저장-범위)
- [데이터 폴더 구조](#2-데이터-폴더-준비와-root-선택) / [권장 작업 순서](#3-권장-작업-순서)
- [Boundary](#4-메인-편집기-boundary와-표시-설정) / [Inference](#5-inference-확률맵에서-mask-생성) / [Subimage](#6-subimage-공통-crop과-개별-이동)
- [ROI와 Alignment](#7-calculate-roi-분석과-alignment) / [Heatmap과 농도 수식](#8-heatmap과-추정-collagen-density)
- [ZIP 출력](#9-download-as-zip) / [저장 위치와 백업](#10-저장-위치와-백업)
- [오류 해결](#11-자주-발생하는-문제) / [개발과 테스트](#12-개발과-테스트)

### 어떤 서버를 실행하는가

```text
Browser (localhost:3000)
  -> Local Express server (3000): UI, file I/O, analysis, export
       -> Dataset folders on this computer
       -> External inference server (192.168.1.157:8001): Run inference only
```

`3000`은 이 저장소에서 실행하는 앱이고, `8001`은 별도로 운영하는 모델 서버입니다. 앱의 `PORT`를 바꿔도 모델 서버 주소는 바뀌지 않습니다. 모델 요청은 브라우저에서 직접 보내는 것이 아니라 **로컬 Express 서버가 TIFF를 읽어 외부 서버로 전송**합니다. 외부 서버의 실행 환경과 모델 설치는 이 README의 대상이 아닙니다.

## 1. 설치 및 서버 실행

### 준비 사항

| 항목 | 요구 사항 |
| --- | --- |
| 실행 환경 | 이 작업 폴더에서 확인한 환경은 Windows, Node.js `22.14.0`, npm `10.9.2`입니다. |
| Node.js / npm | Node.js 22 계열 기준. 현재 잠금 파일의 `sharp`는 Node.js `>=20.9.0`을 요구합니다. 패키지는 `npm ci`로 잠금 파일에 맞춰 설치합니다. |
| Git | 저장소 clone/pull에 필요합니다. |
| 파일 권한 | 저장소의 `node_modules/`, `dist/`, `data/`와 선택한 데이터셋을 읽고 쓸 수 있어야 합니다. |
| 네트워크 | clone/pull 및 패키지 다운로드에는 인터넷 접근이 필요합니다. `Run inference`에는 서버 컴퓨터에서 외부 모델 서버로의 연결이 추가로 필요합니다. |
| 데스크톱 세션 | OS 폴더 선택 창을 사용하려면 로그인된 사용자 세션이 필요합니다. 경로 직접 입력은 별도로 지원합니다. |
| 이미지 처리 | `sharp`/libvips를 npm 의존성으로 사용합니다. 이 로컬 앱 자체는 Python, CUDA, GPU 또는 별도 DB 설치를 요구하지 않습니다. |

프런트엔드는 React 18/Vite 6, 백엔드는 Express 4이며, 실제 설치 버전은 `package-lock.json`을 기준으로 합니다. 다른 컴퓨터의 `node_modules`를 복사하지 말고 대상 컴퓨터에서 설치합니다.

버전 확인:

```powershell
git --version
node --version
npm.cmd --version
```

Windows 명령은 PowerShell 기준입니다. `npm.cmd`는 `npm.ps1` 실행 정책 문제를 피하기 위한 표기이며, CMD나 다른 셸에서는 `npm`을 사용해도 됩니다. 이 앱을 위해 실행 정책이나 방화벽을 전체 해제할 필요는 없습니다.

### 실행 명령 선택

아래 명령은 모두 **`package.json`이 있는 저장소 폴더**에서 실행합니다. 서버는 현재 작업 폴더를 기준으로 `dist/`와 `data/`를 찾으므로, 다른 폴더에서 `node C:\...\server\index.js`만 실행하지 않습니다.

| 상황 | 명령 |
| --- | --- |
| 처음 실행하거나 의존성까지 다시 설치 | `npm.cmd start` |
| 코드 변경 없이 서버만 재시작 | `npm.cmd run server` |
| 소스만 변경했고 의존성은 동일 | `npm.cmd run build` 후 `npm.cmd run server` |
| Git 업데이트 후 실행 | 서버 종료 후 `git status --short`, `git pull --ff-only`, `npm.cmd start` 순서 |
| 서버 종료 | 실행한 터미널에서 `Ctrl+C` |

### 이미 받아 둔 현재 작업 폴더에서 실행

이 컴퓨터의 작업 폴더 예시입니다. 다른 컴퓨터에서는 실제 저장소 경로로 바꿉니다.

```powershell
Set-Location "C:\Users\ksc\Documents\Codex\2026-07-09\d\tiff-polygon-bound-editor-clone"
npm.cmd start
```

`npm start`는 다음 작업을 순서대로 실행합니다.

1. `npm ci`: `package-lock.json`에 맞춰 의존성을 다시 설치합니다.
2. `npm run build`: 프런트엔드를 `dist/`에 빌드합니다.
3. `npm run server`: Express 서버를 실행합니다.

터미널에 `Server listening on http://localhost:3000`이 나오면 브라우저에서 위 주소를 엽니다. 서버를 사용하는 동안 터미널을 열어 둡니다. 종료하려면 해당 터미널에서 `Ctrl+C`를 누릅니다.

`npm ci`는 기존 `node_modules`를 재설치하지만, 데이터셋이나 `data/`의 Root/농도 모델 설정을 초기화하는 명령은 아닙니다. 설치 또는 빌드가 실패하면 서버 실행 단계로 넘어가지 않으므로 터미널의 첫 오류를 확인합니다.

### 처음 내려받는 컴퓨터

프로젝트를 보관할 상위 폴더에서 실행합니다. 같은 저장소 폴더가 이미 있으면 이 과정 대신 기존 폴더를 사용합니다.

```powershell
git clone https://github.com/ksc036/tiff-polygon-bound-editor.git
Set-Location .\tiff-polygon-bound-editor
npm.cmd start
```

macOS/Linux에서는 동일하게 `git clone`, `cd tiff-polygon-bound-editor`, `npm start`를 사용합니다.

### 다음 실행 / 코드 업데이트

코드, 의존성, 빌드가 바뀌지 않았다면 빠르게 서버만 시작할 수 있습니다.

```powershell
npm.cmd run server
```

최신 코드를 받을 때는 실행 중인 서버를 `Ctrl+C`로 종료하고, **같은 저장소 폴더에서** 다음을 실행합니다. `git pull --ff-only`는 현재 브랜치에 설정된 원격 브랜치를 업데이트하며, 브랜치를 자동으로 바꾸지 않습니다.

```powershell
git status --short
git pull --ff-only
npm.cmd start
```

`git pull`이 로컬 수정이나 분기 차이 때문에 실패하면 그 상태를 먼저 해결해야 합니다. 변경 내용을 보존한 뒤 커밋/병합 여부를 판단하고, 강제 reset이나 폴더 삭제로 해결하지 않습니다. `npm run server`만으로는 변경된 프런트엔드가 빌드되지 않습니다.

### 포트 변경과 실행 확인

기본 포트는 `3000`입니다. 다른 프로그램이 사용 중이면 다른 포트를 지정할 수 있습니다.

```powershell
$env:PORT = "3001"
npm.cmd run server
```

이 경우 주소는 `http://localhost:3001/` 및 `http://localhost:3001/inferencePage`입니다. 이후 기본값으로 돌아가려면 서버 종료 후 `Remove-Item Env:PORT`를 실행합니다.

별도 터미널에서 상태 확인:

```powershell
Invoke-RestMethod "http://localhost:3000/api/health"
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

Health 응답의 `ok: true`는 로컬 서버 상태만 의미합니다. 모델 서버 연결이나 이미지 분석 성공까지 보장하지는 않습니다. 포트 점유 프로세스를 종료할 때는 `OwningProcess`와 `Get-Process -Id <PID>`로 이 앱의 프로세스인지 먼저 확인합니다. `Get-NetTCPConnection` 자체가 권한 오류를 내는 경우에는 서버가 꺼졌다고 단정하지 말고 HTTP 응답과 실행 터미널도 확인합니다.

### 실행 계정과 보안

일반적으로 관리자 권한이 아니라, 데이터에 접근할 수 있는 **현재 로그인 사용자의 일반 터미널**에서 실행하면 됩니다. 폴더 선택 창은 서버 컴퓨터의 데스크톱에 표시됩니다. 서비스 계정, 비대화형 세션, 원격 서버에서는 창이 표시되지 않을 수 있으므로 절대 경로를 직접 입력합니다.

이 앱은 로컬 파일을 읽고 쓰며 별도 사용자 인증이 없습니다. 현재 `app.listen(port)`에는 loopback 전용 바인딩이 없으므로, `localhost`라는 안내 문구만으로 외부 접근이 차단되는 것은 아닙니다. 신뢰하는 로컬 환경에서 사용하고, 인터넷 공개나 포트 포워딩은 하지 않습니다. 파일 접근이나 외부 API 연결이 막힌 경우 해당 경로/네트워크 권한을 확인하며, 관리자 실행이나 보안 기능 전체 해제로 해결하지 않습니다.

### 환경 변수와 설정 저장 범위

현재 앱은 **`.env` 파일을 자동으로 읽지 않습니다.** 환경 변수는 서버를 시작할 PowerShell에서 지정하며, 변경 후에는 서버를 재시작합니다. 아래 값은 현재 셸과 그 셸에서 실행하는 프로세스에 적용됩니다.

| 환경 변수 | 기본값 / 적용 범위 |
| --- | --- |
| `PORT` | `3000`. 로컬 Express 서버 포트이며 외부 추론 서버 포트와 무관합니다. |
| `BOUND_EDITOR_ROOT` | 미설정 시 `data/settings.json`의 Root 사용. 지정하면 서버 시작 시 저장된 Root보다 우선합니다. 절대 경로를 사용합니다. |
| `MAX_IMAGE_PIXELS` | `536870912`. 이미지 입출력 픽셀 제한입니다. 양의 정수로 지정하며, `0`은 무제한이 아니라 기본값으로 처리됩니다. 제한을 올려도 메모리 부족이 해결되지는 않습니다. |

```powershell
# 필요한 항목만 설정한 뒤 같은 터미널에서 시작합니다.
$env:PORT = "3000"
$env:BOUND_EDITOR_ROOT = "C:\data\dataset-root"
npm.cmd start
```

위 데이터 경로는 예시입니다. 실제 폴더로 바꾸거나 Root 환경 변수를 생략하고 화면에서 선택합니다. 값을 해제하려면 서버 종료 후 `Remove-Item Env:PORT -ErrorAction SilentlyContinue` 또는 `Remove-Item Env:BOUND_EDITOR_ROOT -ErrorAction SilentlyContinue`를 실행합니다.

환경 변수가 아닌 화면 설정은 다음과 같이 구분됩니다.

| 설정 | 변경 위치 | 저장 범위 / 재실행 동작 |
| --- | --- | --- |
| 데이터셋 Root | 메인/Inference의 Root 선택 | 서버 `data/settings.json`. 두 화면이 공유합니다. |
| 추론 서버 URL | Inference의 서버 주소 입력란 | 현재 페이지 상태. 새로고침하면 기본값 `http://192.168.1.157:8001/`로 돌아갑니다. |
| 농도 회귀 모델 High/Low | 두 화면의 전역 농도 모델 선택 | 서버 `data/collagen-density-settings.json`. Root와 무관하게 이 서버를 사용하는 화면들이 공유하며 재시작 후에도 유지됩니다. |
| Heatmap 격자 크기 | Heatmap batch의 Small / Medium / Large 숫자 입력 | 브라우저 localStorage. 기본 `20 / 50 / 100` px이며 각각 `1~4096`의 정수로 변경할 수 있습니다. |
| Heatmap 농도 색상 Max | 메인 Heatmap 설정 | 브라우저 localStorage. 기본 `8`, 입력 범위 `0.1~10`. 모델을 바꿔도 자동 변경하지 않습니다. Low는 `3`, High는 `8` 등 사용자가 직접 지정합니다. |
| 그룹 표시 / Overlay / Heatmap 표시 지표 | 각 화면의 표시 설정 | 브라우저 localStorage. 그룹 표시 상태는 Root와 이미지별로 구분합니다. |

브라우저 저장값은 접속 주소와 포트에 따라 분리됩니다. 예를 들어 `localhost:3000`, `localhost:3001`, 서버 IP 주소는 서로 다른 UI 설정을 가질 수 있습니다. 같은 저장소에서 시작한 서버라면 `data/`의 설정은 유지되지만, 다른 clone 폴더는 별도의 설정 파일을 사용합니다. **색상 Max는 표시 상한이며, 농도 변환식의 계수나 실제 유한 추정값을 바꾸지 않습니다.**

## 2. 데이터 폴더 준비와 Root 선택

### 올바른 Root 구조

```text
dataset-root/                       <- 이 폴더를 Root로 선택
  sample_T01/
    image/
      frame001.tif
    mask/                           <- 기존 mask가 있으면 사용 가능
      frame001.png
  sample_T02/
    image/
      frame002.tif
    mask/
      frame002.png
```

- Root의 **바로 아래 하위 폴더**에 `image/`가 있어야 합니다.
- `image/`에는 `.tif` 또는 `.tiff` 파일이 있어야 합니다.
- `sample_T01`이라는 이름 자체가 필수는 아닙니다. 폴더 계층이 중요합니다.
- `image/` 자체나 `sample_T01/`을 Root로 선택하면 위 구조와 맞지 않습니다.
- 메인 편집기는 각 하위 폴더에서 이름순 첫 TIFF를 사용합니다. Inference는 각 `image/`의 TIFF들을 순회하므로, 두 화면을 일관되게 사용하려면 **하위 폴더마다 TIFF 한 장**으로 구성하는 것을 권장합니다.
- 전체 Z-stack의 MIP를 자동 생성하는 워크플로는 아닙니다. 분석할 2D 이미지를 준비합니다.

### 선택 방법

1. `Find root`로 폴더 선택 창을 열거나, 경로 입력란에 Root의 절대 경로를 넣습니다.
2. 직접 입력했다면 `Set root`를 누릅니다. 입력란에는 경로를 감싸는 따옴표를 넣지 않습니다.
3. 이미지 목록이 로드되는지 확인합니다.

메인 편집기와 inference 화면은 서버의 동일한 Root 설정을 사용합니다. 선택 경로는 저장소의 `data/settings.json`에 저장되어 다음 실행에서도 읽습니다. 반면 Heatmap batch의 `Choose Folder`는 별도 일괄 처리 경로이며 메인 Root를 바꾸지 않습니다.

시작 시 Root를 지정할 수도 있습니다.

```powershell
$env:BOUND_EDITOR_ROOT = "C:\data\dataset-root"
npm.cmd start
```

```sh
BOUND_EDITOR_ROOT=/absolute/path/to/dataset-root npm start
```

`BOUND_EDITOR_ROOT`가 있으면 저장된 Root보다 우선합니다. PowerShell에서 해제하려면 서버 종료 후 `Remove-Item Env:BOUND_EDITOR_ROOT`를 사용합니다.

폴더 선택 구현은 Windows의 Common Item Dialog, macOS의 `osascript`, Linux의 `zenity` 또는 `kdialog`를 사용합니다. Linux에 해당 프로그램이 없거나 화면 없는 환경이면 경로를 직접 입력합니다. 다른 컴퓨터의 브라우저로 접속하더라도 선택 대상은 **서버 컴퓨터의 파일**입니다.

## 3. 권장 작업 순서

1. Root를 선택하고 원본 이미지가 올바르게 보이는지 확인합니다.
2. 전역 농도 모델을 High 또는 Low로 선택하고 표시된 수식을 확인합니다. Heatmap의 색상 Max는 별도로 직접 설정합니다.
3. Mask가 없다면 `/inferencePage`에서 추론, threshold 설정, cell boundary 제외 영역 설정, `Generate masks`를 진행합니다.
4. 메인 `/`에서 boundary 그룹을 만들고 저장합니다. 필요하면 전체 이미지에 일괄 적용합니다.
5. `Calculate`로 현재 이미지의 mask에서 skeleton과 ROI 분석을 계산합니다.
6. `Subimage`에서 확대할 공통 crop을 지정하고 생성합니다.
7. `Heatmap batch`에서 폴더를 지정하고 `Generate Heatmaps`를 실행합니다.
8. Heatmap의 표시 지표, 비교 모드, 추정 농도 상한을 확인합니다.
9. 필요한 결과가 준비되면 각 페이지의 ZIP 버튼을 사용합니다. 내보내기 시 선택한 농도 모델과 수동 Max가 적용되는 범위는 [ZIP 출력](#9-download-as-zip)을 확인합니다.

**저장, mask 생성, 분석 계산, heatmap 생성, ZIP 다운로드는 별도 작업입니다.** Mask나 boundary를 바꾸었다고 기존 분석/heatmap이 자동으로 모두 갱신되는 것은 아닙니다.

## 4. 메인 편집기: Boundary와 표시 설정

### 그룹 생성과 편집

1. 이미지를 선택하고 `Add group`으로 그룹을 추가합니다. 새 그룹에는 구분 가능한 팔레트 색이 배정됩니다.
2. 이미지에서 점을 클릭해 추가합니다. 점은 저장된 순서대로 연결되며 마지막 점에서 첫 점으로 닫힙니다.
3. 점을 드래그해 위치를 옮기거나 Point order에서 순서/삭제를 조절합니다.
4. 그룹별 이름, `Outside`/`Inside`, 필요한 경우 migration vector를 설정합니다.
5. `Save`로 저장합니다. 분석용 polygon은 최소 세 점이 필요하며 자기 교차가 없어야 합니다.

Bounds의 연결 방식은 `input-order-cycle`입니다. 저장 위치는 `<이미지 폴더>/bound/<이미지 폴더명>.bounds.json`입니다.

### 전체 이미지에 같은 Boundary 추가

`Apply boundary to all (N)`은 현재 이미지의 boundary 그룹들을 같은 픽셀 좌표로 전체 이미지에 **추가**합니다. 대상에 있던 별도 그룹을 통째로 지우거나 교체하지 않습니다.

- 일괄 적용된 그룹은 `sharedBoundaryId`로 연결됩니다.
- 연결된 그룹의 점 위치/개수/순서를 어느 이미지에서 수정하든, `Save` 시 다른 연결된 복사본에도 geometry가 동기화됩니다.
- 다시 일괄 적용할 때 이미 연결된 그룹은 갱신하며 무조건 중복 추가하지 않습니다.
- 그룹 이름, 색, 분석 설정은 이미지별 설정으로 유지됩니다. 기존 독립 그룹이 이름만 같다고 자동으로 연결되지는 않습니다.
- 그룹 삭제는 해당 이미지의 작업이며 연결된 모든 그룹을 전역 삭제하는 기능은 아닙니다.
- 대상 이미지 크기가 다르거나 파일을 읽을 수 없으면 해당 대상이 실패할 수 있습니다. 적용 결과의 실패 목록을 확인합니다.

### 표시 On/Off와 Mask overlay

Boundary 전체 표시, 그룹별 Draw/Stats/Vector 표시, Original 뷰의 `Mask overlay`와 불투명도 조절을 사용할 수 있습니다. Original mask overlay는 빨간색이며 불투명도 기본값은 55%입니다.

- 그룹 표시 상태는 브라우저에 **Root + 이미지별**로 기억됩니다.
- 표시를 끈다고 저장된 boundary나 mask가 삭제되지는 않습니다.
- 메인 ZIP에서는 그룹의 Draw 또는 Stats가 꺼져 있으면 그 그룹을 그룹별 ROI/통계 출력에서 제외합니다. Vector 표시 상태만으로 그룹을 제외하지 않습니다.
- Boundary 전체 숨김은 화면 표시용이며, 그 자체로 모든 그룹을 ZIP에서 제외하는 설정은 아닙니다.
- 브라우저 저장 상태는 다른 브라우저나 다른 포트의 주소와 공유되지 않습니다.

## 5. Inference: 확률맵에서 Mask 생성

### 실행 절차

1. `/inferencePage`에서 Root를 확인합니다.
2. 모델 서버 주소를 확인합니다. 기본값은 `http://192.168.1.157:8001/`입니다.
3. `Run inference`를 누릅니다. TIFF 원본을 순차 전송하고 이미지별 성공/실패 상태를 표시합니다.
4. 완료된 이미지에서 threshold를 조절하며 overlay와 histogram을 확인합니다.
5. 필요하면 공통 사각형 ROI와 이미지별 cell boundary를 지정하고 저장합니다.
6. 기준 이미지의 area fraction에 다른 이미지들을 맞추려면 reference 기반 threshold 설정 기능을 사용합니다.
7. `Generate masks`를 눌러 PNG mask를 실제 파일로 저장합니다.

`Run inference`는 확률맵 생성이고, `Generate masks`는 threshold를 적용한 mask 저장입니다. 두 작업은 다릅니다. 기존 mask가 있다는 이유만으로 추론을 건너뛰거나 실패시키지 않습니다.

### 외부 모델 API 계약

요청은 브라우저가 아니라 **로컬 Express 서버에서 모델 서버로** 전송됩니다.

```text
POST http://192.168.1.157:8001/v1/inference/probability-map
Content-Type: multipart/form-data; boundary=...
Accept: application/x-npy

file: 원본 TIFF 바이트
```

주소 입력란에는 모델 서버의 기본 URL을 넣습니다. 코드는 URL의 루트 기준 `/v1/inference/probability-map`을 사용하므로 `/docs`나 다른 API 경로를 입력한다고 해당 경로를 그대로 호출하지 않습니다.

응답 조건:

- HTTP 성공 상태
- `Content-Type: application/x-npy`
- NPY 버전 1.0 또는 2.0
- Little-endian float32 (`<f4`), C-order (`fortran_order: False`)
- 배열 shape은 `[height, width]`인 2차원 배열
- 크기는 전송한 원본 TIFF와 동일
- 모든 값은 유한한 `0..1` 확률값

PNG, JSON, float64, 채널 차원이 붙은 배열, 크기가 다른 결과는 허용하지 않습니다. 서버의 첫 화면이 열리는 것과 이 endpoint가 올바른 데이터를 반환하는 것은 별개입니다.

### Histogram, ROI, Cell boundary

Histogram은 **원본 밝기 분포가 아니라 해당 이미지 확률맵의 확률 분포**입니다. X축은 `0..1`, threshold 왼쪽은 미선택, 오른쪽은 선택 영역이며 threshold 선을 표시합니다.

- `Whole image`: 해당 이미지 전체에서 cell boundary polygon 내부를 제외한 영역
- `ROI`: 공통 사각형 ROI 내부에서 cell boundary polygon 내부를 제외한 영역
- `Area fraction`: 유효 영역 중 `probability >= threshold`인 픽셀 수 / 유효 영역 전체 픽셀 수
- Cell boundary의 화면 표시를 꺼도 제외 영역 자체가 해제되지는 않습니다.
- ROI는 review/기준값 비교용입니다. 생성 mask는 ROI로 잘린 이미지가 아니라 cell boundary를 제외한 전체 크기 mask입니다.

기준 이미지로 다른 threshold를 설정하는 기능은 **숫자 threshold를 그대로 복사하는 기능이 아닙니다.** ROI가 있으면 ROI, 없으면 Whole image의 area fraction이 기준과 가까워지도록 각 이미지의 threshold를 찾습니다.

Inference의 사각형 ROI/Cell boundary는 메인 편집기의 subimage/boundary와 별도로 저장됩니다. 서로 같은 영역으로 자동 동기화되지 않습니다.

### 재실행 시 기존 파일 처리

| 작업 | 기존 결과 처리 |
| --- | --- |
| `Run inference` | 기존 map이 있어도 요청합니다. 성공한 이미지의 확률맵을 교체하고, 실패한 이미지의 기존 map을 먼저 삭제하지는 않습니다. |
| Threshold 변경 | 확률맵 자체를 수정하지 않고 이미지별 threshold 설정을 저장합니다. |
| `Generate masks` | 완료된 이미지의 현재 threshold와 저장된 cell boundary로 새 mask를 만들고 대상 파일을 교체합니다. 해당 원본에 대응하는 이전 mask 이름 변형도 정리합니다. 전체 mask 폴더를 비우지는 않습니다. |
| 메인의 `Calculate` | 현재 mask로 skeleton과 분석을 다시 계산합니다. |
| `Generate Heatmaps` | 요청한 cell size의 결과를 다시 계산하고 같은 결과 파일을 교체합니다. 다른 size의 파일 전체를 삭제하는 방식은 아닙니다. |

생성 mask의 기본 이름은 `mask/<원본 확장자를 뺀 이름>.png`입니다. 같은 stem의 `.tif`와 `.tiff`가 함께 있는 충돌 상황에서는 원본 확장자를 포함한 이름을 사용합니다. Mask를 다시 생성했다면 필요한 이미지에서 `Calculate`와 heatmap 생성을 다시 실행합니다.

## 6. Subimage: 공통 Crop과 개별 이동

1. 메인 편집기에서 **어느 이미지든** 선택하고 `Subimage` 뷰를 엽니다.
2. `Set crop`을 누르고 이미지 위에서 드래그하여 범위를 잡습니다. Crop은 원본의 종횡비를 유지합니다.
3. 지정한 사각형을 드래그해 위치를 옮깁니다. 처음 만든 범위도 이동할 수 있습니다.
4. `Create all subimages`로 아직 없는 subimage를 생성합니다. 유효하게 저장된 기존 subimage는 보존합니다.
5. 특정 이미지만 위치를 옮겼다면 `Save subimage`로 그 이미지에 저장합니다.
6. 전체를 현재 범위로 바꾸려면 `Replace all subimages`와 `Apply replacement`를 사용합니다. 이 작업은 기존 crop을 교체하므로 확인 창이 표시됩니다.

일괄 생성/교체 시 현재 crop의 픽셀 좌표와 크기를 사용합니다. 모든 원본은 같은 크기의 **단일 채널 16-bit grayscale TIFF**여야 하며 범위가 이미지 안에 들어가야 합니다. RGB/8-bit TIFF, 서로 다른 해상도, 손상된 기존 crop 정보는 먼저 확인해야 합니다.

```text
sample_T01/
  image/frame001.tif
  subimage/frame001.tif
  subimage/crop.json
```

Subimage는 리사이즈하지 않은 16-bit grayscale TIFF로 저장됩니다. 좌표와 크기는 `crop.json`에 저장하며, 현재 ZIP에는 subimage TIFF/PNG와 크기 정보도 포함됩니다. `Create all subimages`와 `Replace all subimages`의 결과에서 `Created`, `Preserved`, `Replaced`, `Failed`를 확인합니다. 배치 전체가 항상 하나의 트랜잭션으로 성공하는 것은 아닙니다.

## 7. Calculate: ROI 분석과 Alignment

`Calculate`는 현재 boundary를 저장한 뒤 현재 이미지의 mask로 skeleton과 분석을 재계산합니다. 적어도 하나의 유효한 polygon, 원본과 크기가 맞는 mask, 유효한 ROI 설정이 필요합니다.

Mask는 0을 배경, 0이 아닌 색상 값을 foreground로 읽습니다. 분석용으로는 원본과 동일한 크기의 흑백 mask를 사용합니다. Mask 선택 순서는 같은 stem의 PNG, 첫 PNG, 같은 stem의 TIFF, 첫 TIFF이므로, 관계없는 파일 여러 개를 `mask/`에 섞어 두지 않습니다.

### ROI와 Density

- `Outside`: boundary 바깥쪽 거리 band를 사용합니다. 기본 상한은 Near 20 px, Mid 50 px, Far 100 px입니다.
- `Inside`: polygon 내부를 분석합니다. Outside 거리 설정을 사용하지 않습니다.
- 거리, 면적, crop 좌표는 픽셀 단위입니다. 자동 물리 단위 보정값으로 해석하지 않습니다.
- `Area fraction / Pixel density = mask 픽셀 수 / 해당 유효 ROI 전체 픽셀 수`입니다. 예를 들어 유효한 20 x 20 영역에서 mask가 100 px이면 `0.25 = 25%`입니다.

`Inside groups do not use outside ROI settings.`는 Inside 모드에서 거리 설정을 사용하지 않는다는 안내입니다. 그 문구 자체가 분석 실패를 뜻하지는 않습니다.

### 현재 Alignment 계산 방식

현재 구현은 **이진 mask의 skeleton 경로를 기본 4 px 길이로 나눈 국소 선분**을 이용합니다. 전체 연결 fiber 하나에 각도 하나를 부여하는 방식도, 원본 밝기의 structure tensor를 계산하는 방식도 아닙니다.

선분 길이를 `L_i`, 이미지 좌표계의 방향각을 `theta_i`라고 하면:

```text
C = sum(L_i * cos(2 * theta_i)) / sum(L_i)
S = sum(L_i * sin(2 * theta_i)) / sum(L_i)
ROI alignment = sqrt(C*C + S*S)
```

ROI alignment는 `0..1`이며 1에 가까울수록 선분 방향이 한 축으로 정렬됩니다. 이 값만으로 boundary에 수직인지 평행인지는 알 수 없습니다.

Radial alignment는 선분에 대응하는 **가까운 boundary의 바깥쪽 법선 방향**과 선분 방향의 차이를 `delta_i`로 두고 `sum(L_i * cos(2 * delta_i)) / sum(L_i)`로 계산합니다.

| Radial 값 | 의미 |
| --- | --- |
| +1 | Boundary에 수직 |
| 0 | 약 45도이거나, 여러 방향의 기여가 상쇄 |
| -1 | Boundary에 평행 |

이 기준은 세포 중심을 향하는 반지름과 일반적으로 같지 않습니다. 원형 boundary라면 가까워질 수 있지만 비원형에서는 다릅니다. Tangential은 접선, Migration은 설정한 이동 벡터가 기준입니다. Inside 등 기준 법선이 없는 항목은 값이 없을 수 있습니다. 구현은 `server/analysisGeometry.js`와 `server/analysisService.js`를 확인합니다.

## 8. Heatmap과 추정 Collagen Density

### 생성과 화면 표시

`Heatmap batch`의 `Choose Folder` 또는 절대 경로 입력으로 처리 폴더를 지정한 뒤 `Generate Heatmaps`를 실행합니다. 이 작업은 하위 경로를 탐색하여 `image/`와 `mask/`를 가진 이미지 묶음을 처리합니다.

Small / Medium / Large의 기본 Cell size는 `20 / 50 / 100` px입니다. 각 숫자 입력란에서 원하는 정수(`1~4096` px)로 바꾸고 Enter를 누르거나 입력란 밖을 클릭하면 적용됩니다. 예를 들어 Small을 `30`으로 설정하면 `30 x 30` px 단위로 계산합니다. 변경값은 브라우저에 저장되어 새로고침 후에도 유지되며, 화면의 크기 선택 버튼도 함께 바뀝니다. 같은 크기를 중복 지정하면 한 번만 생성/내보냅니다.

크기 변경 자체가 파일을 생성하지는 않습니다. 새 크기를 설정한 뒤 `Generate Heatmaps`를 실행해야 해당 결과를 화면과 ZIP에서 사용할 수 있습니다. 생성 완료 후 현재 화면의 heatmap을 다시 불러옵니다. 기존 다른 크기의 저장 파일은 삭제하지 않습니다. 작은 격자에서 셀 수가 너무 많아지는 경우 기존 1,000,000개 셀 제한이 적용됩니다.

새 heatmap은 가로와 세로 모두 전체 크기의 셀들을 가운데 정렬하고, 남는 픽셀을 양쪽 가장자리 칸으로 나눕니다. 예를 들어 길이 10을 4 px로 나누면 `1 | 4 | 4 | 1`, 길이 11은 `1 | 4 | 4 | 2`입니다. 홀수 나머지의 추가 1 px은 오른쪽/아래에 두며, 이미지 한 변이 셀 크기보다 작으면 해당 변을 하나의 칸으로 유지합니다. 가장자리 농도도 실제 칸의 면적을 분모로 계산하므로 버리거나 중복 집계하는 픽셀은 없습니다. 화면, 마우스 정보, Compare, ZIP의 전체/ROI 이미지와 보고서는 같은 좌표를 사용합니다.

기존 왼쪽/위 정렬 heatmap(JSON schema 1)은 그대로 읽을 수 있습니다. 가운데 정렬(schema 2)을 적용하려면 `Generate Heatmaps`를 다시 실행해야 하며, 기존 결과는 해당 크기의 새 결과로 교체됩니다. 서로 다른 위치에 나뉜 격자는 전체 Compare에서 섞어 계산하지 않으므로 비교할 이미지들을 함께 재생성합니다.

각 cell의 density는 mask 픽셀 수 / cell의 실제 픽셀 수입니다. 이미지 가장자리의 불완전한 cell은 실제 포함된 픽셀 수를 분모로 사용합니다. 저장 파일은 다음과 같습니다.

```text
sample_T01/heatmap/20x20/sample_T01.heatmap.json
sample_T01/heatmap/50x50/sample_T01.heatmap.json
sample_T01/heatmap/100x100/sample_T01.heatmap.json
```

화면에서는 `Pixel Density`와 `Estimated Collagen Density`를 선택할 수 있고, 이전 이미지와 비교할 수 있습니다. Heatmap 본체와 스케일 표시는 분리되어 있습니다. 원본/mask가 변경되면 저장 heatmap도 다시 생성해야 합니다.

### 공통 농도 모델

메인 편집기와 Inference 페이지의 전역 농도 모델 설정에서 `High density` 또는 `Low density`를 선택합니다. 선택한 수식도 함께 표시합니다. 최초 기본값은 High이며, 선택은 서버의 `data/collagen-density-settings.json`에 저장됩니다. Root를 변경하거나 서버를 다시 시작해도 유지됩니다. 다른 탭은 포커스를 받거나 주기적으로 설정을 새로 읽습니다.

계수와 변환 함수는 `shared/collagenDensity.js`에 있습니다. 농도 `c`의 단위는 mg/mL, Area Fraction `f`는 0..1 비율입니다. 예를 들어 10%는 `0.10`입니다.

```text
High: f(c) = 0.2631 - 0.2431 * exp(-0.2662 * c)
Low:  f(c) = 0.1087 - 0.1070 * exp(-1.630 * c)

c(f) = -ln((plateau - f) / (-amplitude)) / k
```

High의 기준값 `f(0)`은 2%, 점근값은 26.31%입니다. Low의 기준값은 0.17%, 점근값은 10.87%입니다. 점근값은 농도가 무한대로 커질 때 접근하는 값이지, 유한한 특정 농도에서 도달하는 최대값이 아닙니다.

모델을 바꾸면 기존 Area Fraction을 새 수식으로 해석합니다. 분석 표, heatmap/compare, Inference 농도, ZIP과 Excel에 같은 선택을 적용합니다. 저장된 mask, Area Fraction, boundary, subimage, alignment는 변경하거나 재생성하지 않습니다. 외부 ML inference 서버로 보내는 영상/threshold 계산도 변경하지 않습니다.

`Estimated density max (mg/ml)`의 기본값은 **8**, 입력 범위는 **0.1..10**입니다. 옆의 Area Fraction 표시는 현재 상한 `M`을 정방향 식 `f(M)`에 넣은 값입니다.

- 이 상한을 바꾸면 heatmap의 색 매핑과 ZIP의 추정 농도 heatmap/스케일에도 반영됩니다.
- **Max는 수동 설정입니다. 모델을 바꿔도 자동 변경하지 않습니다.** Low에서 3, High에서 8을 쓰려면 직접 입력합니다. Max는 브라우저에 저장하며 모델 선택만 서버 전체에 공유합니다.
- Max는 색상 상한만 제한합니다. 예를 들어 Max 8에서 추정 농도 10은 상한 색으로 표시하지만 숫자 10 자체는 유지합니다. Compare도 양쪽의 제한 없는 유한 농도를 뺀 값입니다.
- 유효한 Area Fraction이 기준값 이하이면 농도 0입니다. 점근값 이상은 유한한 농도를 역산할 수 없으므로 분석 농도 숫자는 비워 두고 `model-range-exceeded`로 기록합니다. 일반 heatmap에는 상한 색으로 표시하고, Compare에서는 사용자가 설정한 Max 농도로 대체한 뒤 현재 값에서 이전 값을 뺍니다. 양쪽 모두 범위를 넘으면 차이는 0입니다. 화면과 ZIP의 전체/ROI 비교 및 스케일에 동일하게 적용하며, 실제 데이터가 없거나 유효 면적이 없는 칸만 회색으로 표시합니다. 정상적으로 역산되는 유한 농도는 Max를 넘더라도 기존 값을 유지합니다. ZIP 메타데이터의 `heatmapComparison`에 이 대체 규칙과 적용 Max를 기록합니다.
- 잘못된 값이나 유효 픽셀이 없는 영역은 `no-data`이며 중립 회색으로 표시합니다. 실제 농도 0과 구분합니다. 유한한 값이 색상 Max만 넘으면 `color-max-exceeded`로 기록합니다.
- 유효 ROI 면적이 있고 mask 픽셀만 0개라면 측정된 Area Fraction은 0이며 추정 농도도 0입니다. 분석의 `empty` 표시는 fiber가 없다는 뜻일 수 있어, 이것만으로 농도를 No data로 바꾸지 않습니다.
- 역변환이 비선형이므로 Pixel Density와 추정 농도의 색 분포/대비는 달라질 수 있습니다.

`y0`는 `amplitude + plateau`로 계산합니다. `halfLife`, `tau` 같은 중복 계수는 저장하지 않습니다. 두 모델 사이의 선택은 재빌드 없이 적용됩니다. 계수 자체를 코드에서 수정한다면 프런트엔드 재빌드와 서버 재시작이 필요합니다.

설정을 읽지 못하면 기본 모델로 몰래 대체하지 않고 오류를 표시합니다. 저장 실패 시 마지막으로 확인된 선택을 유지합니다. 설정 API는 `GET/PUT /api/settings/collagen-density`이며 저장 시 `{modelId, revision}`을 보냅니다. 오래된 revision으로 저장하거나 내보내려 하면 409 오류로 최신 설정 확인을 요구합니다.

## 9. Download as ZIP

### 메인 페이지: 데이터셋 ZIP

메인 `Download as ZIP`은 **서버에서** 현재 Root의 이미지별 자료를 모아 생성합니다. 현재 이미지의 편집 중인 bounds는 먼저 저장하지만, 모든 이미지의 분석/heatmap을 자동으로 새로 계산하는 기능은 아닙니다.

ZIP은 `<Root 이름>_export_<시각>.zip` 형태이며, 내부 주요 파일은 다음과 같습니다. 입력 결과가 없거나 유효하지 않으면 해당 항목은 제외될 수 있습니다.

| 이미지별 경로 | 내용 |
| --- | --- |
| `original/original_16bit.tif` | 원본 TIFF 복사본. 이름이 원본을 16-bit로 변환한다는 뜻은 아닙니다. |
| `original/original_8bit.png` | 표시용 원본 PNG |
| `original/original_with_subimage.png` | 전체 원본에 subimage 위치를 표시한 PNG |
| `original/original_with_mask_overlay.png` | 원본 + 빨간 mask overlay, 불투명도 55% |
| `subimage/subimage_16bit.tif` | 저장된 subimage TIFF |
| `subimage/subimage_8bit.png` | Subimage 표시용 PNG |
| `subimage/subimage_with_mask_overlay.png` | Subimage + 빨간 mask overlay, 불투명도 55% |
| `subimage/dimensions.csv` | 원본/subimage 픽셀 크기와 crop 위치 |
| `mask/<선택된 mask 파일>` | 전체 mask |
| `mask/subimage_mask.png` | Subimage 범위로 자른 mask |
| `roi/<이미지 폴더명>_ROI_overview.png` | 내보내기에 포함된 boundary/ROI 개요 |
| `heatmap/<크기>x<크기>/full.png` | 전체 추정 농도 heatmap |
| `heatmap/<크기>x<크기>/full_with_subimage.png` | 전체 heatmap에 subimage 위치 표시 |
| `heatmap/<크기>x<크기>/subimage.png` | Subimage 영역의 heatmap |
| `compare/<크기>x<크기>/full_current_minus_previous.png` | 현재 - 이전의 전체 추정 농도 차이 |
| `compare/<크기>x<크기>/full_with_subimage_current_minus_previous.png` | 전체 비교 heatmap에 subimage 위치 표시 |
| `compare/<크기>x<크기>/subimage_current_minus_previous.png` | Subimage 영역의 비교 heatmap |
| `statistics/<이미지 폴더명>_statistics.xlsx` | 저장된 분석 결과와 내보내기 관련 정보 |

ZIP 루트의 `export_report.xlsx`에는 결과 포함/제외 및 사유 등이 들어갑니다. 스케일은 `scales/estimated_collagen_density.png`, `scales/comparison_<크기>x<크기>.png`처럼 **별도 PNG**로 제공합니다.

`calibration_metadata.json`은 내보내기에서 사용한 모델 ID/계수/수식/revision, 단위, 수치 처리 정책, 수동 Max와 Area Fraction 입력/결과 상태를 기록합니다. 한 ZIP은 시작 시 고정한 모델을 끝까지 사용합니다. 이미지별 Excel도 같은 모델과 제한 없는 유한 농도 및 상태를 사용합니다.

`Download as ZIP`은 ZIP 루트의 `heatmap_data/`에 **격자 크기별 JSON 하나씩**을 넣습니다. 예를 들어 Small / Medium / Large가 32 / 64 / 128이면 아래처럼 저장합니다. 사용자 지정 크기로 바꾸면 파일명도 그 크기를 따릅니다.

```text
heatmap_data/
  32x32.json
  64x64.json
  128x128.json
```

각 JSON의 `images`에는 **전체 이미지 목록**이 순서대로 들어갑니다. 크기에 해당하는 JSON 하나를 선택하면 그 안의 이미지별 `width`, `height`, `rows`, `columns`, `gridAlignment`, `cells`로 heatmap을 재현할 수 있습니다. 셀에는 좌표/크기, 전체 픽셀 수, mask 픽셀 수, Area Fraction, 추정 농도, 표시값, 색상, 계산 상태가 들어갑니다. 공통 `calibration`에는 내보내기 시점의 농도 수식/계수/revision/Max, `display`에는 표시 범위와 색상 정보가 들어갑니다. 사용법은 ZIP 루트의 `heatmap_data_README.txt`를 참고합니다.

중복되는 이미지별 `heatmap/<크기>/data.json`과 `cells.csv`는 넣지 않습니다. 기존 PNG, Excel 보고서, subimage의 `dimensions.csv`는 유지합니다.

- 좌표는 원본 이미지의 왼쪽 위를 `(0, 0)`으로 하는 픽셀 좌표이며, 행 우선 순서입니다. 가운데 정렬 때문에 가장자리 칸이 작을 수 있으므로 각 칸의 `x`, `y`, `width`, `height`를 그대로 사용합니다.
- `pixelDensity`는 `maskPixelCount / areaPx`입니다. `estimatedCollagenDensity`는 유한하게 계산된 실제 추정 농도이며 Max로 잘리지 않습니다.
- `heatmapValue`는 비교에 사용하는 값입니다. 역산 범위를 넘는 칸은 현재 Max로 대체합니다. `displayValue`는 이를 `0 ~ Max`로 제한한 전체 히트맵 색상용 값입니다. `displayColor`는 해당 셀의 내보내기 PNG와 같은 `#RRGGBB` 색상입니다. JSON `null`은 값 없음이며 0과 다릅니다.
- Subimage는 전체 격자를 저장된 crop 좌표로 잘라 재현합니다. Compare는 호환되는 격자의 현재 `heatmapValue`에서 이전 값을 빼며, 색상용으로 이미 제한된 `displayValue`끼리 빼면 안 됩니다.
- 유효한 격자는 `status: "included"`로 수치를 넣습니다. 저장 격자가 없거나 유효하지 않은 이미지도 목록에 남기되 `status: "unavailable"`, `reason`, 빈 `cells`로 표시합니다. 이 항목을 농도 0인 이미지로 그리면 안 됩니다.
- 이 데이터 내보내기는 원본 mask나 저장된 heatmap JSON을 수정하거나 격자를 새로 계산하지 않습니다. PNG와 JSON은 동일하게 읽은 격자와 내보내기 설정을 사용합니다.

Heatmap과 compare, 별도 비교 스케일바는 **현재 Small / Medium / Large에 지정한 크기**를 기준으로 내보냅니다. 기존 보고서형 heatmap도 같은 크기를 사용합니다. 해당 크기의 저장 결과가 없거나 오래된 경우 내보내기에서 제외하고 보고서에 사유를 남기므로, 먼저 `Generate Heatmaps`로 필요한 결과를 생성합니다.

- 위 표의 `full.png`, `subimage.png` 및 `compare/` 그림은 화면에서 Pixel Density를 선택했더라도 **Estimated Collagen Density 기준**입니다. 사용자가 지정한 현재 농도 상한을 적용합니다.
- 이 분리형 heatmap 본체에는 제목, 파일명, grid, 축, 스케일을 붙이지 않습니다.
- ROI 위치가 없는 원본 heatmap과 ROI 위치를 표시한 버전을 둘 다 제공합니다. 위치 표시는 노란색 5 px 점선입니다.
- Compare는 이름순 이미지의 **현재 - 이전**입니다. 첫 이미지는 이전 이미지가 없으므로 compare를 만들지 않습니다. 두 결과의 크기/grid가 맞지 않아도 제외됩니다.
- Subimage 관련 결과는 유효하게 저장된 crop이 있어야 합니다. 화면에서 드래그만 하고 저장하지 않은 변경은 사용하지 않습니다.
- 메인 ZIP의 mask overlay 불투명도는 55% 고정이며 화면의 overlay 슬라이더를 그대로 캡처하는 방식이 아닙니다.
- 8-bit PNG는 표시/발표용입니다. 원본 intensity를 보존한 분석에는 TIFF를 사용합니다.

현재 구현은 위 분리형 이미지 외에 기존 보고서형 heatmap도 함께 출력합니다. `heatmap/<크기>x<크기>/<이미지명>_cell_<크기>px_pixel_density.png`, `..._collagen_density.png` 및 `_vs_<이전이미지명>.png` 형태이며, Pixel Density와 Estimated Collagen Density 둘 다 포함할 수 있습니다. 이 보고서형 그림에는 제목/스케일 등이 붙습니다. 따라서 ZIP 전체가 농도 그림만 포함하거나 모든 PNG가 무장식이라고 해석하면 안 됩니다. 원본 파일명 그대로의 `image/<원본파일명>` 복사본도 포함합니다.

### Inference 페이지: 이미지 출력 ZIP

Inference 출력은 **클라이언트 canvas + JSZip**으로 만듭니다. ROI와 완료된 확률맵이 필요하며, cell boundary를 수정했다면 먼저 저장해야 합니다. Cell boundary를 반드시 하나 이상 그려야 하는 것은 아닙니다. `Download all inference ZIP`은 완료된 이미지들을 한 ZIP으로 묶습니다.

| 파일 | 내용 |
| --- | --- |
| `*_whole_original_roi.png` | 전체 원본에 사각형 ROI 표시 |
| `*_whole_mask_overlay.png` | 전체 원본 + 현재 threshold mask overlay, boundary 선은 표시하지 않음 |
| `*_roi_mask_overlay.png` | ROI로 자른 원본 + mask overlay |
| `*_histograms.png` | Whole image/ROI histogram, 좌우 선택 색, threshold 선/값, 픽셀 수, area fraction, 선택한 모델의 추정 농도 |

이 ZIP은 현재 확률맵/threshold의 시각화 결과입니다. 디스크에 저장된 mask 파일을 복사하는 메인 데이터셋 ZIP과는 다르며, 실제 mask 저장은 `Generate masks`로 수행합니다. 전체 다운로드 이름은 `inference_outputs.zip`입니다. 이미지 수/해상도가 크면 브라우저 메모리 사용량이 증가합니다.

Inference ZIP도 다운로드 전에 현재 모델 revision을 확인하고 하나의 모델을 고정합니다. `calibration_metadata.json`에 이미지별 threshold, ROI, 유효 픽셀 수, Area Fraction과 추정 농도/상태를 기록합니다. 이 출력에는 농도 heatmap 색상 Max를 적용하지 않아 metadata의 `colorMax`는 `null`입니다.

## 10. 저장 위치와 백업

| 위치 | 저장 내용 |
| --- | --- |
| 저장소 `data/settings.json` | 마지막으로 선택한 Root |
| 저장소 `data/collagen-density-settings.json` | 서버 전역 High/Low 농도 모델 선택과 revision |
| `<Root>/inference-roi.json` | Inference 공통 사각형 ROI |
| `<이미지 폴더>/bound/` | 메인 boundary 그룹/좌표/설정 |
| `<이미지 폴더>/probability-maps/` | `원본파일명.probability.npy`, `원본파일명.mask-setting.json` |
| `<이미지 폴더>/cell boundary/` | Inference의 이미지별 제외 polygon JSON |
| `<이미지 폴더>/mask/` | 생성하거나 준비한 mask |
| `<이미지 폴더>/Skeletonize/` | 재계산한 skeleton PNG |
| `<이미지 폴더>/analysis/` | 분석 JSON |
| `<이미지 폴더>/heatmap/` | Cell size별 pixel density JSON |
| `<이미지 폴더>/subimage/` | Crop TIFF와 `crop.json` |
| 브라우저 localStorage | 그룹 표시, opacity, heatmap 표시 지표/상한 등 UI 설정 |

Bounds/분석/확률맵 등은 저장소가 아니라 **선택한 데이터셋 안에 저장되는 항목이 많습니다.** 저장소만 백업하거나 git push하는 것으로 데이터 백업이 되지 않습니다. 원본을 포함한 데이터셋 폴더를 별도로 백업합니다. 생성 결과는 재실행으로 교체될 수 있으므로 중요한 비교 결과는 먼저 별도 보관합니다.

컴퓨터나 저장소 폴더를 옮길 때는 데이터셋과 저장소의 `data/`를 각각 보관합니다. `data/`, `dist/`, `node_modules/`, `outputs/`는 Git 추적 대상에서 제외되어 있으므로 clone/pull만으로 복원되지 않습니다. 새 위치에서는 의존성과 빌드를 다시 만들고, 저장된 Root의 절대 경로도 새 컴퓨터에 맞게 선택합니다. 복사 중 파일이 갱신되지 않도록 분석/내보내기 완료 후 서버를 종료하고 백업합니다.

## 11. 자주 발생하는 문제

| 증상 | 확인할 사항 |
| --- | --- |
| 브라우저에 연결할 수 없음 | 터미널의 서버 실행 로그, 포트, `/api/health`를 확인합니다. 설치/빌드 단계가 실패하면 서버까지 시작되지 않습니다. |
| `EADDRINUSE` | 같은 포트의 기존 서버를 확인해서 정상 종료하거나 `PORT`를 바꿉니다. 다른 작업의 Node 프로세스를 일괄 종료하지 않습니다. |
| 업데이트 후 예전 화면 | 올바른 저장소에서 실행했는지 확인하고 `npm start`로 재빌드합니다. 이후 브라우저 새로고침을 합니다. |
| `npm.ps1` 실행 정책 오류 | `npm.cmd`를 사용합니다. 전역 실행 정책을 해제하지 않아도 됩니다. |
| `.env` 값을 바꿨는데 반영되지 않음 | 자동 `.env` 로더가 없습니다. 서버를 시작하는 셸에서 환경 변수를 지정하고 재시작합니다. |
| `Invalid root` / 이미지 목록이 비어 있음 | 절대 경로, 폴더 존재/접근 권한, Root 바로 아래 `하위폴더/image/*.tif` 구조를 확인합니다. |
| 폴더 선택 취소/실패 또는 창이 안 보임 | 취소인지 오류인지 구분하고 서버가 로그인된 데스크톱에서 실행되는지 확인합니다. Windows에서는 전면 표시를 시도하지만 OS가 거절할 수도 있습니다. 경로 직접 입력으로도 작업할 수 있습니다. |
| `Run inference` 실패 | 모델 URL, LAN 접근, 실제 POST endpoint, HTTP 오류, 응답 Content-Type/NPY dtype/shape/값 범위를 확인합니다. 서버 첫 화면이 열린다는 것만으로 충분하지 않습니다. |
| Threshold를 바꿨는데 저장 mask가 그대로임 | Preview 변경과 파일 생성은 별개입니다. `Generate masks`를 다시 실행합니다. |
| `Unable to calculate analysis metrics.` | Mask 존재/선택 파일, 원본과 mask 크기, polygon 점 수/자기 교차, ROI 상한 순서를 확인하고 서버 터미널의 상세 오류를 봅니다. |
| `No analysis loaded` | 저장 분석이 없거나 현재 데이터와 호환되지 않을 수 있습니다. 입력을 확인하고 `Calculate`를 실행합니다. |
| `Unable to save subimage.` | 원본 TIFF의 16-bit/단일 채널 여부, 동일한 이미지 크기, crop 범위, 쓰기 권한, 디스크 여유, 다른 프로그램의 파일 점유를 확인합니다. 배치 실패 목록과 서버 로그도 확인합니다. |
| Mask를 갱신했는데 skeleton/heatmap이 예전 결과 | `Calculate`와 `Generate Heatmaps`를 다시 실행합니다. |
| ZIP에 특정 그림/통계가 없음 | 그룹 On/Off, 저장된 subimage/analysis/heatmap 여부를 확인하고 `export_report.xlsx`의 제외 사유를 봅니다. |
| 추정 농도 heatmap이 한 색으로 포화 | 모델의 비선형 역변환, 현재 상한, 해당 상한의 Area Fraction을 확인합니다. 상한색이 실제 농도 측정을 보장하는 것은 아닙니다. |
| Low로 바꿨는데 Max가 여전히 8 | 정상 동작입니다. 농도 모델과 색상 상한은 독립 설정입니다. 필요하면 Max를 직접 3으로 바꿉니다. |
| `Collagen calibration changed` / HTTP 409 | 다른 화면에서 모델이 변경되어 revision이 맞지 않는 상태입니다. 최신 설정을 새로 읽고 선택 모델/Max를 확인한 후 다시 시도합니다. |
| 농도 모델 설정 읽기/저장 실패 | 저장소 `data/`의 접근 권한과 `collagen-density-settings.json`의 유효성을 확인합니다. 기존 파일을 먼저 보존하며, 오류를 숨기기 위해 다른 모델로 계산하거나 설정을 임의 삭제하지 않습니다. |

### 로그와 문제 확인 순서

`npm start` / `npm run server`의 기본 로그 위치는 **실행한 터미널**입니다. 로그 파일을 자동 생성하는 전용 운영 스크립트는 없습니다. 오류를 확인할 때는 아래 순서로 구분합니다.

1. 설치/빌드 실패인지, 서버 시작 후 API 실패인지 확인합니다.
2. `/api/health`로 로컬 서버를 확인하고, 추론 문제일 때만 외부 모델 연결도 확인합니다.
3. 서버 터미널의 오류와 브라우저 개발자 도구 Network 탭의 실패 요청/응답을 함께 확인합니다.
4. 실행한 저장소 경로, `git branch --show-current`, `git rev-parse --short HEAD`, Node/npm 버전과 실패 파일/작업을 기록합니다. 로컬 수정이 있는 경우 `git status --short`도 함께 확인합니다.

오류 응답이 일반 문구만 담고 있어도 원인이 같다는 뜻은 아닙니다. 데이터 삭제나 캐시 전체 초기화보다 상세 오류와 저장 경로를 먼저 확인합니다.

### 모델 연결 확인 예시

PowerShell에서:

```powershell
Test-NetConnection 192.168.1.157 -Port 8001
```

이는 TCP 연결 확인일 뿐입니다. 실제 추론은 이미지 전송과 모델 실행을 수반하므로 앱에서 실행하고 이미지별 실패 메시지를 확인합니다. 로컬 앱의 모든 기능을 위해 모델 서버가 필요한 것은 아닙니다.

### Windows의 긴 경로

이 코드에는 `server/sharpPath.js`의 Windows namespaced path 처리와 짧은 임시 파일 이름 처리가 적용되어 있습니다. 이미지 입출력 라이브러리는 npm 의존성인 `sharp`이며, 네이티브 이미지 처리는 libvips를 사용합니다.

레지스트리에서 긴 경로를 허용했더라도 사용하는 프로그램/라이브러리/파일시스템의 제한, 개별 파일명 길이, 접근 권한, 파일 잠금까지 모두 해제되는 것은 아닙니다. 긴 경로라는 이유만으로 데이터를 자동 이동하거나 사용자 경로를 강제 제한하지 않습니다. 오류가 계속되면 서버 로그의 실패 경로/작업을 확인하고, 필요하면 짧은 임시 테스트 경로의 복사본으로 원인을 분리합니다. 원본을 삭제하지 않습니다.

### 캐시와 초기화 주의

- 의존성 문제는 서버를 종료한 뒤 `npm ci`와 빌드로 먼저 확인합니다.
- `data/` 또는 데이터셋의 `bound/`, `mask/`, `analysis/`, `subimage/`는 단순 브라우저 캐시가 아닙니다. 문제 해결을 위해 무작정 삭제하지 않습니다.
- 브라우저 사이트 데이터를 지우면 저장된 UI 표시 설정도 사라집니다. Root/모델 URL/데이터 문제가 아닌지 먼저 확인합니다.

## 12. 개발과 테스트

### 명령어

| 명령 | 동작 |
| --- | --- |
| `npm start` | 잠금 의존성 재설치 + 프런트엔드 빌드 + 서버 실행 |
| `npm run server` | 현재 `dist/`를 제공하는 Express 서버 실행 |
| `npm run build` | 프런트엔드 프로덕션 빌드 |
| `npm test` | Vitest 전체 테스트를 한 번 실행 |
| `npm run dev` | Vite 개발 서버만 실행 |

현재 `vite.config.js`에는 `/api` 프록시가 없습니다. 따라서 `npm run dev`만으로 파일 선택/분석 API를 포함한 전체 앱이 실행되는 것은 아닙니다. 전체 워크플로는 빌드 결과를 Express에서 제공하는 방식으로 확인합니다.

프런트엔드 변경을 자동 빌드하려면 두 터미널을 사용할 수 있습니다.

```powershell
# 터미널 A: 변경 시 dist 재빌드
npm.cmd run build -- --watch
```

```powershell
# 터미널 B: http://localhost:3000 에서 제공
npm.cmd run server
```

이 방식은 HMR이 아니므로 빌드 완료 후 브라우저를 새로고침합니다. 서버 코드 변경 시에는 터미널 B의 서버도 재시작합니다. 테스트 실행:

```powershell
npm.cmd test
npm.cmd run build
```

### 주요 구현 위치

| 경로 | 역할 |
| --- | --- |
| `package.json` | 실행/빌드/테스트 명령과 의존성 |
| `server/index.js`, `server/app.js` | 서버 시작, API, 정적 파일 제공 |
| `server/storage.js`, `server/folderPicker.js` | Root, 파일 저장, OS 폴더 선택 |
| `server/sharpPath.js` | Windows용 sharp 경로 처리 |
| `src/App.jsx` | 메인 편집기, 분석/heatmap/subimage UI |
| `src/InferencePage.jsx` | Inference UI와 기본 모델 URL |
| `server/inferenceService.js`, `server/probabilityMap.js` | 모델 요청, NPY 검증, threshold/mask/histogram |
| `server/boundaryBatchService.js` | Boundary 일괄 추가와 연결된 좌표 동기화 |
| `src/lib/groupDisplayPreferences.js` | 이미지별 그룹 표시와 export 제외 설정 |
| `server/subimageService.js`, `src/components/SubimagePanel.jsx` | Crop 저장과 일괄 생성/교체 |
| `server/maskSkeleton.js`, `server/analysisGeometry.js`, `server/analysisService.js` | Mask, skeleton, ROI/alignment 계산 |
| `server/maskHeatmap.js`, `server/heatmapService.js` | Pixel density heatmap 생성 |
| `shared/collagenDensity.js` | 공통 농도 모델과 정/역변환, 표시 상한 |
| `shared/heatmapSettings.js` | Heatmap 기본 격자 크기와 입력 범위 검증 |
| `shared/heatmapGrid.js` | 가운데 정렬 격자의 축별 위치, 크기, 픽셀 조회 |
| `server/collagenSettings.js` | 전역 농도 모델 저장, revision 검증 |
| `src/lib/useCollagenCalibration.js`, `src/components/CollagenCalibrationControl.jsx` | 전역 농도 설정 조회/동기화, 선택 UI와 수식 표시 |
| `server/exportCalibration.js` | ZIP 내보내기 농도 모델 고정과 metadata 생성 |
| `server/exportService.js`, `server/exportHeatmapAssets.js`, `server/exportRasterAssets.js` | 메인 데이터셋 ZIP과 이미지 생성 |
| `server/exportRoiMarker.js` | Export ROI 위치 표시 스타일 |
| `src/lib/inferenceDownloads.js` | Inference 이미지와 클라이언트 ZIP 생성 |

현재 README는 작업 폴더의 구현 기준입니다. 이후 코드에서 모델 계수, endpoint, 파일 형식, 기본값을 바꿀 때 이 문서도 함께 갱신합니다.
