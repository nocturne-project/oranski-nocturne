/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 仕様: お題リストを春夏秋冬の4季節に分割する
// topicList → topicListSpring, topicListSummer, topicListAutumn, topicListWinter

export class PaintChatSeasonalTopics1771900000001 {
	name = 'PaintChatSeasonalTopics1771900000001'

	async up(queryRunner) {
		// 既存のtopicListを残したまま4カラムを追加
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" ADD COLUMN IF NOT EXISTS "topicListSpring" text NOT NULL DEFAULT ''`);
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" ADD COLUMN IF NOT EXISTS "topicListSummer" text NOT NULL DEFAULT ''`);
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" ADD COLUMN IF NOT EXISTS "topicListAutumn" text NOT NULL DEFAULT ''`);
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" ADD COLUMN IF NOT EXISTS "topicListWinter" text NOT NULL DEFAULT ''`);

		// 既存のtopicListの内容を全季節にコピー（データ移行）
		await queryRunner.query(`UPDATE "paint_chat_setting" SET "topicListSpring" = "topicList", "topicListSummer" = "topicList", "topicListAutumn" = "topicList", "topicListWinter" = "topicList" WHERE "topicList" != ''`);

		// topicListは汎用（全季節共通）として残す
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" DROP COLUMN IF EXISTS "topicListSpring"`);
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" DROP COLUMN IF EXISTS "topicListSummer"`);
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" DROP COLUMN IF EXISTS "topicListAutumn"`);
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" DROP COLUMN IF EXISTS "topicListWinter"`);
	}
}
