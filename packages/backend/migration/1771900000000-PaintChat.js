/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 仕様: ランダム絵チャット機能のテーブルを作成する
// paint_chat_ プレフィックスで既存チャット機能と完全分離

export class PaintChat1771900000000 {
	name = 'PaintChat1771900000000'

	async up(queryRunner) {
		await queryRunner.query(`
			CREATE TABLE "paint_chat_room" (
				"id" character varying(32) NOT NULL,
				"status" character varying(16) NOT NULL DEFAULT 'active',
				"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"endedAt" TIMESTAMP WITH TIME ZONE,
				"isReported" boolean NOT NULL DEFAULT false,
				"isPublished" boolean NOT NULL DEFAULT false,
				CONSTRAINT "PK_paint_chat_room" PRIMARY KEY ("id")
			)
		`);

		await queryRunner.query(`
			CREATE TABLE "paint_chat_participant" (
				"id" character varying(32) NOT NULL,
				"roomId" character varying(32) NOT NULL,
				"userId" character varying(32) NOT NULL,
				"anonymousName" character varying(64) NOT NULL,
				"joinedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"leftAt" TIMESTAMP WITH TIME ZONE,
				CONSTRAINT "PK_paint_chat_participant" PRIMARY KEY ("id")
			)
		`);
		await queryRunner.query(`CREATE INDEX "IDX_paint_chat_participant_roomId" ON "paint_chat_participant" ("roomId")`);
		await queryRunner.query(`CREATE INDEX "IDX_paint_chat_participant_userId" ON "paint_chat_participant" ("userId")`);
		await queryRunner.query(`ALTER TABLE "paint_chat_participant" ADD CONSTRAINT "FK_paint_chat_participant_roomId" FOREIGN KEY ("roomId") REFERENCES "paint_chat_room"("id") ON DELETE CASCADE`);
		await queryRunner.query(`ALTER TABLE "paint_chat_participant" ADD CONSTRAINT "FK_paint_chat_participant_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE`);

		await queryRunner.query(`
			CREATE TABLE "paint_chat_message" (
				"id" character varying(32) NOT NULL,
				"roomId" character varying(32) NOT NULL,
				"participantId" character varying(32),
				"type" character varying(16) NOT NULL DEFAULT 'text',
				"content" character varying(500) NOT NULL,
				"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_paint_chat_message" PRIMARY KEY ("id")
			)
		`);
		await queryRunner.query(`CREATE INDEX "IDX_paint_chat_message_roomId" ON "paint_chat_message" ("roomId")`);
		await queryRunner.query(`ALTER TABLE "paint_chat_message" ADD CONSTRAINT "FK_paint_chat_message_roomId" FOREIGN KEY ("roomId") REFERENCES "paint_chat_room"("id") ON DELETE CASCADE`);
		await queryRunner.query(`ALTER TABLE "paint_chat_message" ADD CONSTRAINT "FK_paint_chat_message_participantId" FOREIGN KEY ("participantId") REFERENCES "paint_chat_participant"("id") ON DELETE SET NULL`);

		await queryRunner.query(`
			CREATE TABLE "paint_chat_report" (
				"id" character varying(32) NOT NULL,
				"roomId" character varying(32) NOT NULL,
				"reporterParticipantId" character varying(32) NOT NULL,
				"reporterUserId" character varying(32) NOT NULL,
				"targetUserId" character varying(32) NOT NULL,
				"reason" character varying(1000),
				"status" character varying(16) NOT NULL DEFAULT 'pending',
				"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_paint_chat_report" PRIMARY KEY ("id")
			)
		`);
		await queryRunner.query(`CREATE INDEX "IDX_paint_chat_report_roomId" ON "paint_chat_report" ("roomId")`);
		await queryRunner.query(`CREATE INDEX "IDX_paint_chat_report_targetUserId" ON "paint_chat_report" ("targetUserId")`);
		await queryRunner.query(`ALTER TABLE "paint_chat_report" ADD CONSTRAINT "FK_paint_chat_report_roomId" FOREIGN KEY ("roomId") REFERENCES "paint_chat_room"("id") ON DELETE CASCADE`);
		await queryRunner.query(`ALTER TABLE "paint_chat_report" ADD CONSTRAINT "FK_paint_chat_report_reporterUserId" FOREIGN KEY ("reporterUserId") REFERENCES "user"("id") ON DELETE CASCADE`);
		await queryRunner.query(`ALTER TABLE "paint_chat_report" ADD CONSTRAINT "FK_paint_chat_report_targetUserId" FOREIGN KEY ("targetUserId") REFERENCES "user"("id") ON DELETE CASCADE`);

		await queryRunner.query(`
			CREATE TABLE "paint_chat_block" (
				"id" character varying(32) NOT NULL,
				"reporterUserId" character varying(32) NOT NULL,
				"targetUserId" character varying(32) NOT NULL,
				"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_paint_chat_block" PRIMARY KEY ("id"),
				CONSTRAINT "UQ_paint_chat_block" UNIQUE ("reporterUserId", "targetUserId")
			)
		`);
		await queryRunner.query(`CREATE INDEX "IDX_paint_chat_block_reporterUserId" ON "paint_chat_block" ("reporterUserId")`);
		await queryRunner.query(`CREATE INDEX "IDX_paint_chat_block_targetUserId" ON "paint_chat_block" ("targetUserId")`);
		await queryRunner.query(`ALTER TABLE "paint_chat_block" ADD CONSTRAINT "FK_paint_chat_block_reporterUserId" FOREIGN KEY ("reporterUserId") REFERENCES "user"("id") ON DELETE CASCADE`);
		await queryRunner.query(`ALTER TABLE "paint_chat_block" ADD CONSTRAINT "FK_paint_chat_block_targetUserId" FOREIGN KEY ("targetUserId") REFERENCES "user"("id") ON DELETE CASCADE`);

		await queryRunner.query(`
			CREATE TABLE "paint_chat_publish" (
				"id" character varying(32) NOT NULL,
				"roomId" character varying(32) NOT NULL,
				"participant1Id" character varying(32) NOT NULL,
				"participant1Agreed" boolean NOT NULL DEFAULT false,
				"participant1Message" character varying(100),
				"participant2Id" character varying(32) NOT NULL,
				"participant2Agreed" boolean NOT NULL DEFAULT false,
				"participant2Message" character varying(100),
				"publishedAt" TIMESTAMP WITH TIME ZONE,
				"noteId" character varying(32),
				CONSTRAINT "PK_paint_chat_publish" PRIMARY KEY ("id"),
				CONSTRAINT "UQ_paint_chat_publish_roomId" UNIQUE ("roomId")
			)
		`);
		await queryRunner.query(`ALTER TABLE "paint_chat_publish" ADD CONSTRAINT "FK_paint_chat_publish_roomId" FOREIGN KEY ("roomId") REFERENCES "paint_chat_room"("id") ON DELETE CASCADE`);
		await queryRunner.query(`ALTER TABLE "paint_chat_publish" ADD CONSTRAINT "FK_paint_chat_publish_participant1Id" FOREIGN KEY ("participant1Id") REFERENCES "paint_chat_participant"("id") ON DELETE CASCADE`);
		await queryRunner.query(`ALTER TABLE "paint_chat_publish" ADD CONSTRAINT "FK_paint_chat_publish_participant2Id" FOREIGN KEY ("participant2Id") REFERENCES "paint_chat_participant"("id") ON DELETE CASCADE`);

		await queryRunner.query(`
			CREATE TABLE "paint_chat_setting" (
				"id" character varying(32) NOT NULL,
				"botAccountId" character varying(32),
				"topicList" text NOT NULL DEFAULT '',
				"noticeText" text NOT NULL DEFAULT '',
				"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_paint_chat_setting" PRIMARY KEY ("id")
			)
		`);
		await queryRunner.query(`ALTER TABLE "paint_chat_setting" ADD CONSTRAINT "FK_paint_chat_setting_botAccountId" FOREIGN KEY ("botAccountId") REFERENCES "user"("id") ON DELETE SET NULL`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE IF EXISTS "paint_chat_setting" CASCADE`);
		await queryRunner.query(`DROP TABLE IF EXISTS "paint_chat_publish" CASCADE`);
		await queryRunner.query(`DROP TABLE IF EXISTS "paint_chat_report" CASCADE`);
		await queryRunner.query(`DROP TABLE IF EXISTS "paint_chat_block" CASCADE`);
		await queryRunner.query(`DROP TABLE IF EXISTS "paint_chat_message" CASCADE`);
		await queryRunner.query(`DROP TABLE IF EXISTS "paint_chat_participant" CASCADE`);
		await queryRunner.query(`DROP TABLE IF EXISTS "paint_chat_room" CASCADE`);
	}
}
