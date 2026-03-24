#!/usr/bin/env node

/**
 * ランダム絵チャット データ自動削除スクリプト (FR-017)
 *
 * セッション終了後7日間経過したルームのデータを削除する。
 * 通報されたルーム(isReported=true)は削除対象外。
 *
 * cronジョブとして1日1回実行を推奨:
 * 0 3 * * * cd /path/to/project && /usr/bin/node claude/scripts/paint-chat-cleanup.js >> claude/scripts/logs/paint-chat-cleanup.log 2>&1
 */

const { Client } = require('pg');

const DB_CONFIG = {
	host: 'localhost',
	port: 5432,
	database: 'misskey',
	user: 'misskey',
	password: process.env.PGPASSWORD || 'cYJAfEo2PKC3GGbkE7fi',
};

const RETENTION_DAYS = 7;

async function main() {
	const client = new Client(DB_CONFIG);
	await client.connect();

	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
	const cutoff = cutoffDate.toISOString();

	console.log(`[${new Date().toISOString()}] ランダム絵チャット データ削除開始 (基準日: ${cutoff})`);

	try {
		// 削除対象ルームの取得（終了済み + 7日経過 + 通報されていない）
		const targetRooms = await client.query(`
			SELECT id FROM paint_chat_room
			WHERE status = 'ended'
			AND "endedAt" < $1
			AND "isReported" = false
		`, [cutoff]);

		if (targetRooms.rows.length === 0) {
			console.log('削除対象のルームはありません。');
			await client.end();
			return;
		}

		const roomIds = targetRooms.rows.map(r => r.id);
		console.log(`削除対象: ${roomIds.length}ルーム`);

		// 関連テーブルを依存関係順に削除
		// 1. paint_chat_publish（roomId参照）
		const publishResult = await client.query(
			`DELETE FROM paint_chat_publish WHERE "roomId" = ANY($1)`,
			[roomIds],
		);
		console.log(`  paint_chat_publish: ${publishResult.rowCount}件削除`);

		// 2. paint_chat_report（roomId参照）
		const reportResult = await client.query(
			`DELETE FROM paint_chat_report WHERE "roomId" = ANY($1)`,
			[roomIds],
		);
		console.log(`  paint_chat_report: ${reportResult.rowCount}件削除`);

		// 3. paint_chat_message（roomId参照）
		const messageResult = await client.query(
			`DELETE FROM paint_chat_message WHERE "roomId" = ANY($1)`,
			[roomIds],
		);
		console.log(`  paint_chat_message: ${messageResult.rowCount}件削除`);

		// 4. paint_chat_participant（roomId参照）
		const participantResult = await client.query(
			`DELETE FROM paint_chat_participant WHERE "roomId" = ANY($1)`,
			[roomIds],
		);
		console.log(`  paint_chat_participant: ${participantResult.rowCount}件削除`);

		// 5. paint_chat_room（最後に削除）
		const roomResult = await client.query(
			`DELETE FROM paint_chat_room WHERE id = ANY($1)`,
			[roomIds],
		);
		console.log(`  paint_chat_room: ${roomResult.rowCount}件削除`);

		console.log('削除完了。');
	} catch (err) {
		console.error('エラー:', err);
		process.exit(1);
	} finally {
		await client.end();
	}
}

main();
