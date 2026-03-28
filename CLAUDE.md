<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# CLAUDE.md - Misskey noc.ski プロジェクト ルール

## アップデート履歴

### 2025-09-22: システム整備
- **LANGS未定義エラー**: GitHub issue #10367修正、Dockerfileバリデーション追加
- **ワークスペース整理**: Claudeファイルを`claude/`ディレクトリに統合
- **.dockerignore修正**: .config除外問題を解決
- **cronジョブ更新**: パス変更対応

## Claudeワークスペース管理

**Claudeでの作業は `claude/` ディレクトリを使用すること**
- Claude作成のスクリプト: `claude/scripts/`
- Claude作成のテストファイル: `claude/tests/`
- Claude作成のドキュメント: `claude/docs/`
- Claude作成の一時ファイル: `claude/tmp/`
- 既存プロジェクトファイルとClaude作業を明確に分離

## 基本ルール

- 日本語回答、絵文字禁止、箇条書き多用
- 疑問は作業中断して質問、新機能は必ずdocs化
- 実在しない機能の提案禁止、大げさな表現禁止
- rm -rf実行前は必ずユーザー確認
- mermaid図表: 日本語コメント、色分け（水色→オレンジ→緑→紫）
- コードを修正したら、そのコードの仕様をすぐ上にコメントとして残すこと

## Git・コミットルール

- **勝手なコミット絶対禁止**: ユーザー明示指示がある場合のみ実行
- Conventional Commits形式: feat/fix/docs/style/refactor/test/chore
- **`claude/`ディレクトリはコミット禁止**: AI作業用ファイルのため、gitに含めない
- **パスワード・クレデンシャルをデフォルト値としてもコードに含めない**: `process.env.X || 'password'`のようなフォールバックも禁止。環境変数のみで参照し、デフォルト値が必要な場合は`changeme`等のダミー値を使うこと

### PR作成ルール
- **PRは必ず `nocturne-project/oranski-nocturne` リポジトリに作成すること**
- `upstream`（misskey-dev/misskey）には絶対にPRを出さない
- `gh pr create` 実行時は必ず `--repo nocturne-project/oranski-nocturne` を指定すること
- ベースブランチは `develop`

## ペルソナ・語調

- **基本**: 知的で穏やか、丁寧語、一人称「自分」
- **語尾**: 「〜ですね」「〜かな」「〜しちゃう」多用
- **感嘆**: 「おお！」「もう！」「そうそうそう」

## プロジェクト設定

### 環境構成
- noc.ski (PostgreSQL 17, 16GB RAM, Docker マルチインスタンス)
- 主要機能: 内緒の会話、ToS同意、エラー通知、ユーザー監視

### ビルドルール
**ビルドチェック必須ルール**:
- 全変更後必ずtypecheckとbuild実行、エラー時は修正完了まで作業停止
- スキップ・無効化・迂回は絶対禁止

**Docker Build前必須テスト:**
```bash
cd packages/frontend && npm run build
cd packages/backend && npm run build
```

**リモートビルドテスト（build_server）:**
```bash
# 全テスト（frontend build + backend build + backend-test + typecheck + lint）
./claude/scripts/remote-build-test.sh all

# 個別実行
./claude/scripts/remote-build-test.sh frontend      # フロントエンドビルドのみ
./claude/scripts/remote-build-test.sh backend       # バックエンドビルドのみ
./claude/scripts/remote-build-test.sh backend-test  # バックエンドテストサーバービルド
./claude/scripts/remote-build-test.sh typecheck     # 型チェックのみ
./claude/scripts/remote-build-test.sh lint          # ESLintチェック（backend + frontend）
./claude/scripts/remote-build-test.sh lint-fix      # ESLint自動修正（backend + frontend）
```
- build_server（SSH経由）にrsyncでソース同期し、リモートでビルドテストを実行
- ローカルのCPU/メモリを消費せずにビルドチェック可能
- 初回実行時は依存パッケージのインストールで時間がかかる（2回目以降は高速）
- NestJS起動テストはDB接続が必要なためリモート化不可（ローカル専用）

**NestJS起動テスト必須ルール**:
- バックエンドのサービス追加・変更時は必ず起動テストを実行
- NestJSのDIエラーはランタイムでしか検出できないため、typecheckだけでは不十分
- 実行コマンド: `./claude/scripts/test-backend-startup.sh`
- テスト対象の変更:
  - CoreModule.ts の変更
  - NoctownModule.ts の変更
  - 新しい@Injectableサービスの追加
  - モジュールのproviders/exports の変更
- テスト失敗時はデプロイ禁止、修正完了まで作業継続

### 禁止事項
- Dockerネットワーク操作、docker compose操作
- **デプロイ関連コマンド実行禁止（./scripts/deploy.sh、docker compose等）**
- **コンテナ停止・削除・再作成禁止**
- **デプロイはユーザーが実行するため、Claudeはデプロイ作業を行わない**
- **SQLiteのDBファイル（*.db）を初期化・削除しない**
- PostgreSQLのDBファイルを初期化・削除しない

### 技術要件
- Node.js 22.12+、nvm使用
- **エンティティ追加手順（全ステップ必須、1つでも漏れるとテーブル未作成やDIエラーになる）**:
  1. エンティティファイル作成（`packages/backend/src/models/`）
  2. `models/_.ts` にインポート・エクスポート・Repository型定義追加
  3. `di-symbols.ts` にRepository DI定数追加
  4. `models/RepositoryModule.ts` にProvider定義・providers・exports追加
  5. **`postgres.ts` のentities配列にエンティティクラス追加**（これを忘れるとTypeORMがテーブルを認識しない）
  6. `core/CoreModule.ts` に関連サービス登録（該当する場合）
  7. **`migration/` にマイグレーションファイル作成**（最重要。本番は`synchronize: false`のためマイグレーションがないとテーブルが作成されない）
  8. `scripts/check_migrations_clean.js` の `customPatterns` にテーブル名プレフィックス追加（Migration CIスキップ用）

### データベースアクセス

**PostgreSQL直接アクセス方法**:
```bash
# 基本接続
PGPASSWORD='cYJAfEo2PKC3GGbkE7fi' psql -h localhost -U misskey -d misskey

# 単発クエリ実行
PGPASSWORD='cYJAfEo2PKC3GGbkE7fi' psql -h localhost -U misskey -d misskey -c "SELECT文"
```

**接続情報**:
- ホスト: localhost（Docker外から）/ host.docker.internal（Docker内から）
- ポート: 5432
- データベース名: misskey
- ユーザー名: misskey
- パスワード: .config/default.yml参照

**モデレーションログ確認例**:
```bash
# 特定IDのログ取得
PGPASSWORD='cYJAfEo2PKC3GGbkE7fi' psql -h localhost -U misskey -d misskey -c "
SELECT
  ml.id,
  ml.type,
  u.username AS moderator_username,
  ml.info
FROM moderation_log ml
LEFT JOIN \"user\" u ON ml.\"userId\" = u.id
WHERE ml.id = 'ログID';
"

# 最新ログ取得
PGPASSWORD='cYJAfEo2PKC3GGbkE7fi' psql -h localhost -U misskey -d misskey -c "
SELECT * FROM moderation_log ORDER BY id DESC LIMIT 10;
"
```

### ロケール編集ルール
- **ロケールファイル編集後は必ずロケールインターフェース生成を実行**
- 実行コマンド: `cd packages/i18n && pnpm generate`
- TypeScript型定義の自動更新が必須
- 実行忘れによるTypeScriptエラーを防止

### APIエンドポイント追加時のmisskey-js更新ルール
- **新しいAPIエンドポイントを追加した場合、misskey-jsの自動生成ファイルの更新が必須**
- CI（check-misskey-js-autogen）がautogenファイルの差分を検出して失敗する
- 実行手順:
  1. `pnpm --filter backend build` (バックエンドビルド)
  2. `pnpm --filter backend generate-api-json` (API JSON生成)
  3. `cp packages/backend/built/api.json packages/misskey-js/generator/api.json`
  4. `pnpm run --filter misskey-js-type-generator generate` (型生成)
  5. `cp -r packages/misskey-js/generator/built/autogen/* packages/misskey-js/src/autogen/` (コピー)
  6. `pnpm --filter misskey-js build` (misskey-jsビルド)
  7. `cd packages/misskey-js && pnpm api` (api.md更新、--localモード)
- コミット対象: `packages/misskey-js/src/autogen/` と `packages/misskey-js/etc/misskey-js.api.md`
- **または簡易コマンド**: `pnpm --filter misskey-js update-autogen-code` (ただしapi.md更新は別途必要)

### Pre-commit ESLint自動修正フック
- **git commit実行前にbuild_serverでESLint --fixを自動実行する**
- `.claude/settings.local.json`のPreToolUseフックで設定済み
- `git commit`コマンドを検出すると`./claude/scripts/remote-build-test.sh lint-fix`をリモート実行
- frontend + backendの両方のESLintエラーを自動修正してからコミットが実行される
- タイムアウト: 300秒

## Claude Code制限

- git push禁止、ローカル操作のみ
- 最小限ファイル作成、既存編集優先

## ファイル管理

### claude/ディレクトリ構造
```
claude/
├── tests/ - test-*.js/.mjs/.ts
├── scripts/ - deploy-*.sh, rolebot/, user-monitor/
├── sqls/ - SQLファイル
├── tmp/ - 一時ファイル
└── docs/ - ドキュメント
```

## 品質管理・定期検査

### お絵かきチャット座標調整ログ
**目的**: ペン座標の精度を継続的に検査し、座標ズレ問題を早期発見

**検査頻度**: 週次レビュー推奨

**ドキュメント**: `claude/docs/お絵かきチャットにおける座標調整ログ.md`

**検査項目**:
- 座標精度チェック（許容誤差: ±5px以内）
- Transform状態チェック（transformedSize = displaySize × zoomLevel）
- 正規化座標チェック（範囲: 0.0〜1.0）
- デバイス互換性チェック（PC/スマホ/タブレット）

**ログ確認方法**:
```bash
# 開発環境のブラウザコンソールでリアルタイム確認
# または、デバッグログをJSONファイルとしてエクスポート
```

**問題発生時の対応**:
1. ユーザー報告を受けたら即座にログを確認
2. 該当タイムスタンプ前後のログを抽出
3. 座標変換の各ステップを検証
4. トラブルシューティングガイドに従って修正
5. 問題パターンをドキュメントに追加

**重要**: 座標変換ロジックを修正した場合は必ずログを確認し、各種デバイスで動作確認すること

## スクリプト・cron

### デプロイスクリプト
- `deploy.sh` - ゼロダウンタイム（推奨）
- `deploy-rollout.sh` - ローリング
- `deploy-with-lock.sh` - 排他制御
- `rolebot/`, `user-monitor/` - cron実行

### cronジョブ設定
```bash
# user-monitor
* * * * * cd /path/to/claude/scripts/user-monitor && /usr/bin/node monitor.js --once >> logs/cron.log 2>&1
# rolebot
* * * * * cd /path/to/claude/scripts/rolebot && /usr/bin/node bot.js >> logs/cron.log 2>&1
```

## トラブルシューティング

- **LANGS未定義**: boot.jsでエラー → Dockerfileバリデーション機構で自動修復
- **.dockerignore**: .config除外問題 → .dockerignoreから.config削除
- **コンテナ競合**: `docker rm -f container-name`

## スパム対策・セキュリティ

### UFWファイアウォール
```bash
# ブロック済み: インドISP（49.37.128.0/17, 58.84.60.0/24, 122.179.31.0/24）
# 手順: whois確認 → sudo ufw deny from [CIDR] → 確認
```

### ユーザー凍結強化
- suspend reason必須化（admin-user.vue修正）
- 凍結前バリデーション追加

### スパム対応記録
| ユーザー | ネットワーク | ブロック範囲 |
|----------|-------------|-------------|
| @camillaharper | Reliance Jio | 49.37.128.0/17 |
| @bfsi21 | Tata Play | 58.84.60.0/24 |
| @gatibose | ABTS Bengalore | 122.179.31.0/24 |

### 監視項目
- UFWルール確認: `sudo ufw status numbered`
- スパムパターン: インドISP、大量作成、短期投稿

## Active Technologies
- TypeScript 5.x (Node.js 22.12+) (001-noctown)
- PostgreSQL 17 (Misskeyと同一DB、`noctown_`プレフィックスのテーブル) (001-noctown)
- PostgreSQL（Misskey共通DB、noctown_プレフィックスの専用テーブル） (001-noctown)
- TypeScript 5.x, Node.js 22.12+ (003-noctown-2)
- PostgreSQL（noctown_players、noctown_map_chunksテーブル） (003-noctown-2)
- TypeScript 5.x, Node.js 22.12+ + NestJS (backend), Vue.js 3.x (frontend), TypeORM, Three.js（既存のnoctown 3Dレンダリング） (005-noctown-fishing)
- PostgreSQL 17（noctown_プレフィックスのテーブル） (005-noctown-fishing)
- TypeScript 5.x (Node.js 22.12+) + Three.js (3D rendering), Vue.js 3 (reactive state), PostgreSQL 17 (noctown_map_chunks テーブル), NestJS (backend DI) (006-006-noctown-map-generation)
- PostgreSQL 17 の noctown_map_chunks テーブル（terrainData カラムに地形タイプを記録） (006-006-noctown-map-generation)
- TypeScript 5.x (Node.js 22.12+) + NestJS (backend), Vue.js 3.x (frontend), Three.js (3D rendering), TypeORM (006-006-noctown-map-generation)
- PostgreSQL 17 (NoctownPetエンティティ) (006-006-noctown-map-generation)
- TypeScript 5.x (Node.js 22.12+) + Three.js (3D rendering), Vue.js 3 (frontend), NestJS (backend), TypeORM (006-006-noctown-map-generation)
- PostgreSQL 17 (noctown_map_chunks, noctown_chat_log テーブル) (006-006-noctown-map-generation)
- TypeScript 5.x (Node.js 22.12+) + NestJS (backend), Vue.js 3.x (frontend), TypeORM, Three.js (007-noctown-trade)
- PostgreSQL 17 (noctown_trade, noctown_trade_item, noctown_transaction_log テーブル) (007-noctown-trade)
- PostgreSQL 17 (`noq_` プレフィックスのテーブル) (009-noq)
- PostgreSQL 17 (既存の`page`テーブル拡張) (010-page-visibility)
- TypeScript 5.x (Node.js 22.12+) + NestJS (backend DI), Vue.js 3.x (frontend), TypeORM, Canvas 2D API (011-random-drawing-chat)
- PostgreSQL 17 (paint_chat_* テーブル), Redis (ストロークデータ、マッチングキュー、プレゼンス) (011-random-drawing-chat)

## Recent Changes
- 001-noctown: Added TypeScript 5.x (Node.js 22.12+)
