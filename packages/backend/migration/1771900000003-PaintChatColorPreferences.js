/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class PaintChatColorPreferences1771900000003 {
	name = 'PaintChatColorPreferences1771900000003';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "paint_chat_participant" ADD "colorPreferences" jsonb DEFAULT NULL`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "paint_chat_participant" DROP COLUMN "colorPreferences"`);
	}
}
