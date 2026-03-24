/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
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
}

const CANVAS_TTL = 604800; // 7日間（秒）
const MAX_UNDO = 3;

// キャンバスデータ管理（Redis操作、ストロークデータ管理、マージ処理）を担当するサービス
@Injectable()
export class PaintChatCanvasService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,
	) {
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
}
