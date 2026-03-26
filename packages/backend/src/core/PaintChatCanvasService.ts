/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { PaintChatRoomsRepository } from '@/models/_.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';

// ストロークデータの型定義
export interface PressurePoint {
	x: number;
	y: number;
	pressure: number;
}

export interface StrokeData {
	id: string;
	participantId: string;
	points: PressurePoint[];
	color: string;
	width: number;
	opacity: number;
	tool: 'pen' | 'eraser';
	layer?: number; // レイヤー番号（0-2、未指定は0）
}

const CANVAS_TTL = 604800; // 7日間（秒）
const MAX_UNDO = 3;
// DB退避時のデータサイズ上限
const MAX_ARCHIVE_STROKES = 10000;
const MAX_MERGED_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
// rpushのバッチサイズ（スプレッド演算子のスタック制限回避）
const RPUSH_BATCH_SIZE = 500;
// 最終アクティビティキーのTTL（アイドル判定用、2時間）
const LAST_ACTIVITY_TTL = 7200;

// アクティビティ更新の間引き間隔（5分）
const ACTIVITY_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// キャンバスデータ管理（Redis操作、ストロークデータ管理、DB退避/復元）を担当するサービス
@Injectable()
export class PaintChatCanvasService {
	private logger: Logger;
	// ルームごとの最終アクティビティ更新時刻（インメモリ、Redis書き込みの間引き用）
	private lastActivityUpdatedAt = new Map<string, number>();

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.paintChatRoomsRepository)
		private paintChatRoomsRepository: PaintChatRoomsRepository,

		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('paint-chat-canvas');
	}

	// ルームの最終アクティビティ時刻を更新する（アイドル判定用、5分間隔で間引き）
	@bindThis
	public async updateLastActivity(roomId: string): Promise<void> {
		const now = Date.now();
		const lastUpdated = this.lastActivityUpdatedAt.get(roomId);
		if (lastUpdated != null && now - lastUpdated < ACTIVITY_UPDATE_INTERVAL_MS) {
			return; // 前回の更新から5分以内なのでスキップ
		}
		await this.redisClient.set(`paintChat:lastActivity:${roomId}`, now.toString(), 'EX', LAST_ACTIVITY_TTL);
		this.lastActivityUpdatedAt.set(roomId, now);
	}

	// ルームの最終アクティビティ時刻を取得する（アイドル判定用）
	@bindThis
	public async getLastActivity(roomId: string): Promise<number | null> {
		const val = await this.redisClient.get(`paintChat:lastActivity:${roomId}`);
		return val != null ? parseInt(val, 10) : null;
	}

	// ストロークをキャンバスに追加する
	@bindThis
	public async addStroke(roomId: string, stroke: StrokeData): Promise<void> {
		const key = `paintChat:canvas:${roomId}`;
		await this.redisClient.rpush(key, JSON.stringify(stroke));
		await this.redisClient.expire(key, CANVAS_TTL);

		// アンドゥバッファにも追加
		const undoKey = `paintChat:undo:${roomId}:${stroke.participantId}`;
		await this.redisClient.rpush(undoKey, stroke.id);
		// アンドゥバッファは最大3つに制限
		const undoLen = await this.redisClient.llen(undoKey);
		if (undoLen > MAX_UNDO) {
			await this.redisClient.lpop(undoKey);
		}
		await this.redisClient.expire(undoKey, CANVAS_TTL);

		// アイドル判定用の最終アクティビティ時刻を更新
		await this.updateLastActivity(roomId);
	}

	// キャンバスの全ストロークを取得する（不正JSONはスキップ）
	@bindThis
	public async getStrokes(roomId: string): Promise<StrokeData[]> {
		const key = `paintChat:canvas:${roomId}`;
		const data = await this.redisClient.lrange(key, 0, -1);
		const strokes: StrokeData[] = [];
		for (const d of data) {
			try {
				strokes.push(JSON.parse(d) as StrokeData);
			} catch (e) {
				console.warn(`[PaintChat] Invalid stroke data in canvas, skipping:`, d.substring(0, 100));
			}
		}
		return strokes;
	}

	// マージ済み画像を取得する
	@bindThis
	public async getMergedImage(roomId: string): Promise<string | null> {
		return await this.redisClient.get(`paintChat:merged:${roomId}`);
	}

	// マージ済み画像を保存する
	@bindThis
	public async setMergedImage(roomId: string, imageBase64: string): Promise<void> {
		const key = `paintChat:merged:${roomId}`;
		await this.redisClient.set(key, imageBase64);
		await this.redisClient.expire(key, CANVAS_TTL);
	}

	// アンドゥ: 最後のストロークを取り消す
	@bindThis
	public async undoStroke(roomId: string, participantId: string): Promise<string | null> {
		const undoKey = `paintChat:undo:${roomId}:${participantId}`;
		const strokeId = await this.redisClient.rpop(undoKey);
		if (strokeId == null) return null;

		// キャンバスから該当ストロークを削除
		const canvasKey = `paintChat:canvas:${roomId}`;
		const strokes = await this.redisClient.lrange(canvasKey, 0, -1);
		const filtered = strokes.filter(s => {
			try {
				const parsed = JSON.parse(s) as StrokeData;
				return parsed.id !== strokeId;
			} catch (e) {
				console.warn(`[PaintChat] Invalid stroke data in undo, keeping:`, s.substring(0, 100));
				return true;
			}
		});

		// キャンバスを再構築
		await this.redisClient.del(canvasKey);
		if (filtered.length > 0) {
			await this.redisClient.rpush(canvasKey, ...filtered);
			await this.redisClient.expire(canvasKey, CANVAS_TTL);
		}

		return strokeId;
	}

	// 指定されたstrokeIdのストロークを削除する（レイヤー対応undo用）
	@bindThis
	public async removeStroke(roomId: string, participantId: string, strokeId: string): Promise<string | null> {
		const canvasKey = `paintChat:canvas:${roomId}`;
		const strokes = await this.redisClient.lrange(canvasKey, 0, -1);

		// 指定ストロークが存在し、所有者が一致するか確認
		let found = false;
		const filtered = strokes.filter(s => {
			try {
				const parsed = JSON.parse(s) as StrokeData;
				if (parsed.id === strokeId && parsed.participantId === participantId) {
					found = true;
					return false; // 削除
				}
				return true;
			} catch {
				return true;
			}
		});

		if (!found) return null;

		// キャンバスを再構築
		await this.redisClient.del(canvasKey);
		if (filtered.length > 0) {
			await this.redisClient.rpush(canvasKey, ...filtered);
			await this.redisClient.expire(canvasKey, CANVAS_TTL);
		}

		return strokeId;
	}

	// キャンバスをクリアする
	@bindThis
	public async clearCanvas(roomId: string): Promise<void> {
		await this.redisClient.del(`paintChat:canvas:${roomId}`);
		await this.redisClient.del(`paintChat:merged:${roomId}`);
	}

	// ストローク数を取得する（品質ガード用）
	@bindThis
	public async getStrokeCount(roomId: string): Promise<number> {
		const key = `paintChat:canvas:${roomId}`;
		return await this.redisClient.llen(key);
	}

	// 特定参加者のストロークのみ取得する（自分の絵のみダウンロード用）
	@bindThis
	public async getStrokesByParticipant(roomId: string, participantId: string): Promise<StrokeData[]> {
		const strokes = await this.getStrokes(roomId);
		return strokes.filter(s => s.participantId === participantId);
	}

	// 通報されたルームのTTLを無期限にする
	@bindThis
	public async removeExpiry(roomId: string): Promise<void> {
		await this.redisClient.persist(`paintChat:canvas:${roomId}`);
		await this.redisClient.persist(`paintChat:merged:${roomId}`);
	}

	// RedisのキャンバスデータをDBに退避する（アイドルルーム用）
	@bindThis
	public async saveCanvasToDb(roomId: string): Promise<boolean> {
		const strokes = await this.getStrokes(roomId);
		const mergedImage = await this.getMergedImage(roomId);

		// ストロークもマージ画像もない場合は保存不要
		if (strokes.length === 0 && mergedImage == null) return false;

		// データサイズガード
		if (strokes.length > MAX_ARCHIVE_STROKES) {
			this.logger.warn(`Skipping canvas archive for room ${roomId}: too many strokes (${strokes.length})`);
			return false;
		}
		if (mergedImage != null && mergedImage.length > MAX_MERGED_IMAGE_SIZE) {
			this.logger.warn(`Skipping canvas archive for room ${roomId}: merged image too large (${mergedImage.length} bytes)`);
			return false;
		}

		const result = await this.paintChatRoomsRepository.query(
			`UPDATE "paint_chat_room" SET "canvasStrokes" = $1::jsonb, "canvasMergedImage" = $2 WHERE "id" = $3`,
			[JSON.stringify(strokes), mergedImage, roomId],
		) as { rowCount?: number }[];

		this.logger.info(`Archived canvas for room ${roomId}: ${strokes.length} strokes, merged=${mergedImage != null}`);
		return true;
	}

	// DBに退避されたキャンバスデータをRedisに復元する（再入室時用）
	// SETNX（SET NX）ベースのロックで競合状態（2人同時アクセスによるデータ重複）を防止
	@bindThis
	public async restoreCanvasFromDb(roomId: string): Promise<{ strokes: StrokeData[]; mergedImage: string | null } | null> {
		const room = await this.paintChatRoomsRepository.findOneBy({ id: roomId });
		if (room == null || room.canvasStrokes == null) return null;

		const strokes = room.canvasStrokes as StrokeData[];
		const mergedImage = room.canvasMergedImage;

		// ロックを取得して競合状態を防止（30秒TTL）
		const lockKey = `paintChat:restoreLock:${roomId}`;
		const lockAcquired = await this.redisClient.set(lockKey, '1', 'EX', 30, 'NX');
		if (lockAcquired == null) {
			// 別リクエストが復元中。Redisにデータがあるはずなのでそちらを参照
			this.logger.info(`Restore lock already held for room ${roomId}, skipping`);
			return { strokes, mergedImage };
		}

		try {
			// ロック取得後に再確認（別リクエストが復元済みの可能性）
			const canvasKey = `paintChat:canvas:${roomId}`;
			const existingLen = await this.redisClient.llen(canvasKey);
			if (existingLen > 0) {
				this.logger.info(`Canvas already restored in Redis for room ${roomId}, skipping`);
				return { strokes, mergedImage };
			}

			// Redisにストロークをバッチで復元
			if (strokes.length > 0) {
				const serialized = strokes.map(s => JSON.stringify(s));
				for (let i = 0; i < serialized.length; i += RPUSH_BATCH_SIZE) {
					const batch = serialized.slice(i, i + RPUSH_BATCH_SIZE);
					await this.redisClient.rpush(canvasKey, ...batch);
				}
				await this.redisClient.expire(canvasKey, CANVAS_TTL);
			}

			// Redisにマージ画像を復元
			if (mergedImage != null) {
				const mergedKey = `paintChat:merged:${roomId}`;
				await this.redisClient.set(mergedKey, mergedImage);
				await this.redisClient.expire(mergedKey, CANVAS_TTL);
			}

			// 復元成功後にDBの退避データをクリア
			await this.paintChatRoomsRepository.query(
				`UPDATE "paint_chat_room" SET "canvasStrokes" = NULL, "canvasMergedImage" = NULL WHERE "id" = $1`,
				[roomId],
			);

			this.logger.info(`Restored canvas from DB for room ${roomId}: ${strokes.length} strokes, merged=${mergedImage != null}`);
			return { strokes, mergedImage };
		} finally {
			await this.redisClient.del(lockKey);
		}
	}

	// ルームに関連する全Redisキーを削除する（アイドルルームクリーンアップ用）
	@bindThis
	public async cleanupRoom(roomId: string, participantIds: string[]): Promise<number> {
		this.lastActivityUpdatedAt.delete(roomId);

		const keys: string[] = [
			`paintChat:canvas:${roomId}`,
			`paintChat:merged:${roomId}`,
			`paintChat:lastActivity:${roomId}`,
		];

		// 各参加者のundoバッファとmyArtPublishedキーを削除
		for (const pid of participantIds) {
			keys.push(`paintChat:undo:${roomId}:${pid}`);
			keys.push(`paintChat:myArtPublished:${roomId}:${pid}`);
		}

		if (keys.length === 0) return 0;
		return await this.redisClient.del(...keys);
	}
}
