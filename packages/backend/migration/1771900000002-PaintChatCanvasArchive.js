/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 仕様: アイドルルームのキャンバスデータをRedisからDBに退避するためのカラム追加
// canvasStrokes: ストロークデータのJSON配列
// canvasMergedImage: マージ済み画像のBase64文字列

export class PaintChatCanvasArchive1771900000002 {
	name = 'PaintChatCanvasArchive1771900000002'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "paint_chat_room" ADD COLUMN IF NOT EXISTS "canvasStrokes" jsonb DEFAULT NULL`);
		await queryRunner.query(`ALTER TABLE "paint_chat_room" ADD COLUMN IF NOT EXISTS "canvasMergedImage" text DEFAULT NULL`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "paint_chat_room" DROP COLUMN IF EXISTS "canvasStrokes"`);
		await queryRunner.query(`ALTER TABLE "paint_chat_room" DROP COLUMN IF EXISTS "canvasMergedImage"`);
	}
}
