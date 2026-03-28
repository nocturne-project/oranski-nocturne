/*
 * マイグレーション: グループチャットお絵描き機能アップグレード
 *
 * 変更内容:
 * 1. drawing_room_settings: canvasWidth/canvasHeightのデフォルト値を1600/1200に変更、既存レコード更新
 * 2. drawing_user_settings: colorHistory, pressureEnabled, penStrokeWidth, eraserStrokeWidthカラム追加
 * 3. chat_room: canvasStrokes, canvasMergedImagesカラム追加（Redis→DB退避用）
 */
export class UpgradeDrawingSettings1772000000000 {
	name = 'UpgradeDrawingSettings1772000000000';

	async up(queryRunner) {
		// 1. drawing_room_settings: デフォルト値変更 + 既存レコード更新
		await queryRunner.query(`ALTER TABLE "drawing_room_settings" ALTER COLUMN "canvasWidth" SET DEFAULT 1600`);
		await queryRunner.query(`ALTER TABLE "drawing_room_settings" ALTER COLUMN "canvasHeight" SET DEFAULT 1200`);
		await queryRunner.query(`UPDATE "drawing_room_settings" SET "canvasWidth" = 1600, "canvasHeight" = 1200`);

		// 2. drawing_user_settings: 新カラム追加
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" ADD COLUMN IF NOT EXISTS "colorHistory" jsonb DEFAULT '[]'::jsonb`);
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" ADD COLUMN IF NOT EXISTS "pressureEnabled" boolean DEFAULT true`);
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" ADD COLUMN IF NOT EXISTS "penStrokeWidth" smallint DEFAULT 5`);
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" ADD COLUMN IF NOT EXISTS "eraserStrokeWidth" smallint DEFAULT 20`);

		// 3. chat_room: キャンバスDB退避カラム追加
		await queryRunner.query(`ALTER TABLE "chat_room" ADD COLUMN IF NOT EXISTS "canvasStrokes" jsonb DEFAULT NULL`);
		await queryRunner.query(`ALTER TABLE "chat_room" ADD COLUMN IF NOT EXISTS "canvasMergedImages" jsonb DEFAULT NULL`);
	}

	async down(queryRunner) {
		// 3. chat_room: カラム削除
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN IF EXISTS "canvasMergedImages"`);
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN IF EXISTS "canvasStrokes"`);

		// 2. drawing_user_settings: カラム削除
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" DROP COLUMN IF EXISTS "eraserStrokeWidth"`);
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" DROP COLUMN IF EXISTS "penStrokeWidth"`);
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" DROP COLUMN IF EXISTS "pressureEnabled"`);
		await queryRunner.query(`ALTER TABLE "drawing_user_settings" DROP COLUMN IF EXISTS "colorHistory"`);

		// 1. drawing_room_settings: デフォルト値を元に戻す
		await queryRunner.query(`ALTER TABLE "drawing_room_settings" ALTER COLUMN "canvasWidth" SET DEFAULT 800`);
		await queryRunner.query(`ALTER TABLE "drawing_room_settings" ALTER COLUMN "canvasHeight" SET DEFAULT 600`);
		await queryRunner.query(`UPDATE "drawing_room_settings" SET "canvasWidth" = 800, "canvasHeight" = 600`);
	}
}
