/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as Redis from 'ioredis';
import { Like } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { DriveService } from '@/core/DriveService.js';
import { ChatService } from '@/core/ChatService.js';
import type { MiUser, MiChatRoom, DriveFilesRepository, ChatRoomsRepository } from '@/models/_.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';

interface DrawingPoint {
	x: number;
	y: number;
	pressure?: number;
}

interface DrawingStroke {
	id: string; // ストロークの一意ID
	userId: string;
	userName: string;
	points: DrawingPoint[];
	tool: 'pen' | 'eraser' | 'eyedropper';
	color: string;
	strokeWidth: number;
	opacity: number;
	timestamp: number;
	layer: number;
}

interface CanvasData {
	strokes: DrawingStroke[];
	lastActivity: number;
	participants: Set<string>;
}

// ストロークマージ時の最大退避ストローク数
const MAX_ARCHIVE_STROKES = 5000;
// Redisバッチ書き込みサイズ
const RPUSH_BATCH_SIZE = 100;
// paintchat標準のアンドゥ回数上限
const MAX_UNDO = 3;
// キャンバス固定サイズ: 横1600 x 縦1200
const MAX_COORDINATE_X = 1600;
const MAX_COORDINATE_Y = 1200;
// ストローク幅の上限
const MAX_STROKE_WIDTH = 200;
// Redis→DBアーカイブまでのアイドル時間（1時間）
const ARCHIVE_IDLE_THRESHOLD = 60 * 60 * 1000;

@Injectable()
export class DrawingCanvasService {
	private readonly CANVAS_EXPIRY = 7 * 24 * 60 * 60; // 7日間（秒）
	private readonly AUTO_SAVE_THRESHOLD = 30 * 60 * 1000; // 30分間非アクティブで自動保存（ミリ秒）
	private readonly MAX_LAYER_INDEX = 2;
	private readonly MAX_POINTS_PER_STROKE = 1024;
	private readonly canvasCache = new Map<string, CanvasData>();
	private readonly saveTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		private driveService: DriveService,
		private chatService: ChatService,
	) {
		// 定期的な自動保存チェック（5分間隔）
		this.autoSaveInterval = setInterval(() => {
			this.checkAutoSave();
		}, 5 * 60 * 1000);
	}

	private autoSaveInterval: NodeJS.Timeout | null = null;

	@bindThis
	private getCanvasKey(roomId: string): string {
		return `drawing:canvas:${roomId}`;
	}

	@bindThis
	private getMetaKey(roomId: string): string {
		return `drawing:meta:${roomId}`;
	}

	// レイヤー別ユーザーアンドゥバッファのRedisキー
	@bindThis
	private getUndoBufferKey(roomId: string, userId: string, layerIndex?: number): string {
		if (layerIndex !== undefined) {
			return `drawing:undo:${roomId}:${userId}:layer:${layerIndex}`;
		}
		// 後方互換: レイヤー未指定の場合はlayer:0をデフォルトにする
		return `drawing:undo:${roomId}:${userId}:layer:0`;
	}

	// レイヤー別マージ済み画像のRedisキー
	@bindThis
	private getMergedImageKey(roomId: string, layerIndex: number): string {
		return `drawing:merged:${roomId}:layer:${layerIndex}`;
	}

	// ユーザー間チャットIDかどうかを判定
	private isUserToUserChatId(drawingId: string): boolean {
		return drawingId.startsWith('user-') && drawingId.split('-').length === 3;
	}

	// 描画アクセス権限をチェック
	@bindThis
	public async canUserAccessCanvas(drawingId: string, userId: string): Promise<boolean> {
		try {
			if (this.isUserToUserChatId(drawingId)) {
				// user-userId1-userId2 形式の場合
				const parts = drawingId.split('-');
				if (parts.length === 3) {
					const [, userId1, userId2] = parts;
					// 自分がいずれかのユーザーに含まれているかチェック
					return userId === userId1 || userId === userId2;
				}
				return false;
			} else {
				// 通常のルームIDの場合
				const room = await this.chatService.findRoomById(drawingId);
				if (!room) return false;
				return await this.chatService.isRoomMember(room, userId);
			}
		} catch (error) {
			console.error('Canvas access check failed:', error);
			return false;
		}
	}

	@bindThis
	public async addStroke(roomId: string, stroke: DrawingStroke): Promise<void> {
		try {
			const normalizedStroke: DrawingStroke = {
				...stroke,
				layer: this.clampLayerIndex(stroke.layer),
				points: stroke.points.map(point => ({
					x: this.clampCoordinateX(point.x),
					y: this.clampCoordinateY(point.y),
					pressure: typeof point.pressure === 'number' ? Math.min(Math.max(point.pressure, 0), 1) : undefined,
				})),
			};
			// Redisにストロークを追加
			const canvasKey = this.getCanvasKey(roomId);
			const metaKey = this.getMetaKey(roomId);

			await this.redisClient.lpush(canvasKey, JSON.stringify(normalizedStroke));
			await this.redisClient.expire(canvasKey, this.CANVAS_EXPIRY);

			// メタデータ更新
			const metaData = {
				lastActivity: Date.now(),
				participantCount: await this.redisClient.scard(`${metaKey}:participants`),
			};

			await this.redisClient.sadd(`${metaKey}:participants`, normalizedStroke.userId);
			await this.redisClient.hmset(metaKey, metaData);
			await this.redisClient.expire(metaKey, this.CANVAS_EXPIRY);

			// レイヤー別ユーザーアンドゥバッファに追加（paintchat標準: 最新3ストロークを保持）
			const undoBufferKey = this.getUndoBufferKey(roomId, normalizedStroke.userId, normalizedStroke.layer);
			const currentUndoLen = await this.redisClient.llen(undoBufferKey);

			// アンドゥ上限を超えた古いストロークはマージ対象としてフラット化する
			if (currentUndoLen >= MAX_UNDO) {
				await this.mergeOldestUndoStroke(roomId, normalizedStroke.userId, normalizedStroke.layer);
			}

			await this.redisClient.lpush(undoBufferKey, JSON.stringify(normalizedStroke));
			await this.redisClient.ltrim(undoBufferKey, 0, MAX_UNDO - 1); // paintchat標準: 最新3ストロークのみ保持
			await this.redisClient.expire(undoBufferKey, this.CANVAS_EXPIRY);

			// ローカルキャッシュ更新
			this.updateLocalCache(roomId, normalizedStroke);

			// 自動保存タイマーをリセット
			this.resetAutoSaveTimer(roomId);

			console.log(`[Drawing] Added stroke to canvas ${roomId} by user ${normalizedStroke.userId} on layer ${normalizedStroke.layer}`);
		} catch (error) {
			console.error(`[Drawing] Failed to add stroke to canvas ${roomId}:`, error);
		}
	}

	// アンドゥバッファの最古ストロークをレイヤー別マージ画像に統合する
	// paintchat標準: アンドゥ上限（3回）を超えた古いストロークはレイヤーごとの合成画像にフラット化される
	@bindThis
	private async mergeOldestUndoStroke(roomId: string, userId: string, layerIndex: number): Promise<void> {
		try {
			const undoBufferKey = this.getUndoBufferKey(roomId, userId, layerIndex);

			// アンドゥバッファ末尾（最古）のストロークを取得して削除
			const oldestStrokeData = await this.redisClient.rpop(undoBufferKey);
			if (!oldestStrokeData) return;

			// マージ済みストロークリストに追加（レイヤー別）
			// 実際のラスタライズはフロントエンドで行うため、バックエンドではストロークデータとして蓄積する
			const mergedKey = this.getMergedImageKey(roomId, layerIndex);
			await this.redisClient.rpush(mergedKey, oldestStrokeData);
			await this.redisClient.expire(mergedKey, this.CANVAS_EXPIRY);

			console.log(`[Drawing] Merged oldest stroke to layer ${layerIndex} for room ${roomId}`);
		} catch (error) {
			console.error(`[Drawing] Failed to merge oldest stroke for room ${roomId}:`, error);
		}
	}

	// レイヤー別マージ済みストロークを取得する
	@bindThis
	public async getMergedStrokes(roomId: string, layerIndex: number): Promise<DrawingStroke[]> {
		try {
			const mergedKey = this.getMergedImageKey(roomId, layerIndex);
			const data = await this.redisClient.lrange(mergedKey, 0, -1);
			return data
				.map(d => { try { return JSON.parse(d) as DrawingStroke; } catch { return null; } })
				.filter((s): s is DrawingStroke => s !== null);
		} catch (error) {
			console.error(`[Drawing] Failed to get merged strokes for room ${roomId} layer ${layerIndex}:`, error);
			return [];
		}
	}

	public getMaxLayerIndex(): number {
		return this.MAX_LAYER_INDEX;
	}

	@bindThis
	public normalizeStrokeData(roomId: string, user: Pick<MiUser, 'id' | 'username' | 'name'>, payload: any): DrawingStroke | null {
		if (!payload || typeof payload !== 'object') {
			console.warn(`[Drawing] Invalid stroke payload received for ${roomId}`);
			return null;
		}

		const rawPoints = Array.isArray(payload.points) ? payload.points : null;
		if (!rawPoints || rawPoints.length === 0 || rawPoints.length > this.MAX_POINTS_PER_STROKE) {
			console.warn(`[Drawing] Stroke points not valid for ${roomId}`);
			return null;
		}

		const points: DrawingPoint[] = [];
		for (const point of rawPoints) {
			if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
				console.warn(`[Drawing] Stroke point missing coordinates for ${roomId}`);
				return null;
			}

			const normalizedPoint: DrawingPoint = {
				x: this.clampCoordinateX(point.x),
				y: this.clampCoordinateY(point.y),
			};

			if (typeof point.pressure === 'number' && Number.isFinite(point.pressure)) {
				normalizedPoint.pressure = Math.min(Math.max(point.pressure, 0), 1);
			}

			points.push(normalizedPoint);
		}

		const allowedTools: Array<DrawingStroke['tool']> = ['pen', 'eraser', 'eyedropper'];
		const tool: DrawingStroke['tool'] = allowedTools.includes(payload.tool) ? payload.tool : 'pen';
		if (tool === 'eyedropper') {
			console.warn(`[Drawing] Ignoring eyedropper stroke for ${roomId}`);
			return null;
		}

		if (typeof payload.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(payload.color)) {
			console.warn(`[Drawing] Stroke color invalid for ${roomId}`);
			return null;
		}

		if (typeof payload.strokeWidth !== 'number' || !Number.isFinite(payload.strokeWidth)) {
			console.warn(`[Drawing] Stroke width invalid for ${roomId}`);
			return null;
		}
		const strokeWidth = Math.min(Math.max(payload.strokeWidth, 1), MAX_STROKE_WIDTH);

		if (typeof payload.opacity !== 'number' || !Number.isFinite(payload.opacity)) {
			console.warn(`[Drawing] Stroke opacity invalid for ${roomId}`);
			return null;
		}
		const opacity = Math.min(Math.max(payload.opacity, 0.05), 1);

		const layer = this.clampLayerIndex(payload.layer);
		const timestamp = typeof payload.timestamp === 'number' ? payload.timestamp : Date.now();

		return {
			id: typeof payload.id === 'string' ? payload.id : randomUUID(),
			userId: user.id,
			userName: user.username ?? user.name ?? 'Unknown',
			points,
			tool,
			color: payload.color,
			strokeWidth,
			opacity,
			timestamp,
			layer,
		};
	}

	// キャンバス固定サイズに基づくX座標クランプ（0〜1600）
	private clampCoordinateX(value: number): number {
		if (!Number.isFinite(value)) return 0;
		return Math.min(Math.max(value, 0), MAX_COORDINATE_X);
	}

	// キャンバス固定サイズに基づくY座標クランプ（0〜1200）
	private clampCoordinateY(value: number): number {
		if (!Number.isFinite(value)) return 0;
		return Math.min(Math.max(value, 0), MAX_COORDINATE_Y);
	}

	private clampLayerIndex(value: number): number {
		if (!Number.isFinite(value)) return 0;
		return Math.min(Math.max(Math.floor(value), 0), this.MAX_LAYER_INDEX);
	}

	@bindThis
	public async clearCanvas(roomId: string, userId: string): Promise<void> {
		try {
			const canvasKey = this.getCanvasKey(roomId);
			const metaKey = this.getMetaKey(roomId);

			// Redisからキャンバスデータを削除
			await this.redisClient.del(canvasKey);
			await this.redisClient.del(`${metaKey}:participants`);

			// レイヤー別マージ済み画像を削除
			for (let i = 0; i <= this.MAX_LAYER_INDEX; i++) {
				await this.redisClient.del(this.getMergedImageKey(roomId, i));
			}

			// レイヤー別アンドゥバッファを削除（全ユーザー分をパターンマッチで削除）
			const undoPattern = `drawing:undo:${roomId}:*`;
			const undoKeys = await this.redisClient.keys(undoPattern);
			if (undoKeys.length > 0) {
				await this.redisClient.del(...undoKeys);
			}

			// メタデータ更新
			const metaData = {
				lastActivity: Date.now(),
				clearedBy: userId,
				clearedAt: Date.now(),
			};
			await this.redisClient.hmset(metaKey, metaData);
			await this.redisClient.expire(metaKey, this.CANVAS_EXPIRY);

			// ローカルキャッシュ削除
			this.canvasCache.delete(roomId);

			// 自動保存タイマーをリセット
			this.resetAutoSaveTimer(roomId);

			console.log(`[Drawing] Canvas ${roomId} cleared by user ${userId}`);
		} catch (error) {
			console.error(`[Drawing] Failed to clear canvas ${roomId}:`, error);
		}
	}

	@bindThis
	public async getCanvasData(roomId: string): Promise<DrawingStroke[]> {
		try {
			// まずRedisから確認
			const canvasKey = this.getCanvasKey(roomId);
			const strokesData = await this.redisClient.lrange(canvasKey, 0, -1);

			if (strokesData.length > 0) {
				// Redisにデータがある場合
				const strokes: DrawingStroke[] = strokesData
					.map(data => {
						try {
							return JSON.parse(data) as DrawingStroke;
						} catch {
							return null;
						}
					})
					.filter((stroke): stroke is DrawingStroke => stroke !== null)
					.reverse(); // 最新が最後になるように逆順

				// メモリ節約: 最大500ストロークに制限
				const MAX_RETURN_STROKES = 500;
				const limited = strokes.length > MAX_RETURN_STROKES
					? strokes.slice(strokes.length - MAX_RETURN_STROKES)
					: strokes;
				console.log(`[Drawing] Retrieved ${limited.length}/${strokes.length} strokes from Redis for canvas ${roomId}`);
				return limited;
			}

			// Redisにデータがない場合、まずDBから復元を試みる
			const restored = await this.restoreCanvasFromDb(roomId);
			if (restored && restored.strokes.length > 0) {
				console.log(`[Drawing] Restored ${restored.strokes.length} strokes from DB for canvas ${roomId}`);
				return restored.strokes;
			}

			// DBにもない場合、Driveから最新のファイルを検索して復元
			console.log(`[Drawing] No Redis/DB data found, searching Drive for canvas ${roomId}`);
			return await this.loadCanvasFromDrive(roomId);
		} catch (error) {
			console.error(`[Drawing] Failed to get canvas data for ${roomId}:`, error);
			return [];
		}
	}

	@bindThis
	private async loadCanvasFromDrive(roomId: string): Promise<DrawingStroke[]> {
		try {
			// ルーム情報を取得してオーナーを特定
			const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
			if (!room) {
				console.warn(`[Drawing] Room ${roomId} not found for Drive loading`);
				return [];
			}

			// 最新のキャンバスファイルを検索
			const latestCanvasFile = await this.driveFilesRepository.findOne({
				where: {
					userId: room.ownerId,
					name: Like(`drawing-${roomId}-%`),
					comment: Like(`%お絵かきキャンバス - ルーム ${roomId}%`),
				},
				order: { id: 'DESC' },
			});

			if (!latestCanvasFile) {
				console.log(`[Drawing] No previous canvas file found for room ${roomId}`);
				return [];
			}

			console.log(`[Drawing] Found previous canvas file ${latestCanvasFile.id} for room ${roomId}`);

			// JSONファイルからストロークデータを復元
			if (latestCanvasFile.type === 'application/json') {
				console.warn(`[Drawing] Drive file reading not implemented yet for room ${roomId}`);
			}

			return [];
		} catch (error) {
			console.error(`[Drawing] Failed to load canvas from Drive for room ${roomId}:`, error);
			return [];
		}
	}

	@bindThis
	private updateLocalCache(roomId: string, stroke: DrawingStroke): void {
		if (!this.canvasCache.has(roomId)) {
			this.canvasCache.set(roomId, {
				strokes: [],
				lastActivity: Date.now(),
				participants: new Set(),
			});
		}

		const canvasData = this.canvasCache.get(roomId)!;
		canvasData.strokes.push(stroke);
		canvasData.lastActivity = Date.now();
		canvasData.participants.add(stroke.userId);

		// メモリ使用量制限（1000ストローク）
		if (canvasData.strokes.length > 1000) {
			canvasData.strokes = canvasData.strokes.slice(-1000);
		}
	}

	@bindThis
	private resetAutoSaveTimer(roomId: string): void {
		// 既存のタイマーをクリア
		const existingTimer = this.saveTimers.get(roomId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		// 新しいタイマーを設定
		const timer = setTimeout(() => {
			this.autoSaveCanvas(roomId);
		}, this.AUTO_SAVE_THRESHOLD);

		this.saveTimers.set(roomId, timer);
	}

	@bindThis
	private async checkAutoSave(): Promise<void> {
		const now = Date.now();

		// Redisからすべてのキャンバスメタデータを取得
		const pattern = 'drawing:meta:*';
		const keys = await this.redisClient.keys(pattern);

		for (const metaKey of keys) {
			try {
				const roomId = metaKey.replace('drawing:meta:', '');
				const metaData = await this.redisClient.hgetall(metaKey);

				if (metaData.lastActivity) {
					const lastActivity = parseInt(metaData.lastActivity);

					// 1時間以上アイドルの場合、Redis→DBアーカイブを実行（グループチャットのみ）
					if (now - lastActivity > ARCHIVE_IDLE_THRESHOLD && !this.isUserToUserChatId(roomId)) {
						await this.archiveCanvasToDb(roomId);
					}

					// 30分以上アイドルの場合、Drive保存
					if (now - lastActivity > this.AUTO_SAVE_THRESHOLD) {
						await this.autoSaveCanvas(roomId);
					}
				}
			} catch (error) {
				console.error(`[Drawing] Failed to check auto save for ${metaKey}:`, error);
			}
		}
	}

	@bindThis
	private async autoSaveCanvas(roomId: string): Promise<void> {
		try {
			console.log(`[Drawing] Auto-saving canvas ${roomId} due to inactivity`);

			// キャンバスデータを取得
			const strokes = await this.getCanvasData(roomId);
			if (strokes.length === 0) {
				console.log(`[Drawing] No strokes to save for canvas ${roomId}`);
				return;
			}

			// ユーザー間チャットかルームチャットかで処理を分岐
			if (this.isUserToUserChatId(roomId)) {
				// ユーザー間チャット: user-userId1-userId2 形式
				const parts = roomId.split('-');
				if (parts.length === 3) {
					const [, userId1, userId2] = parts;
					// 両ユーザーのDriveに保存
					await this.saveCanvasToImage(roomId, strokes, userId1);
					await this.saveCanvasToImage(roomId, strokes, userId2);
					console.log(`[Drawing] Saved canvas ${roomId} to both users' Drives: ${userId1}, ${userId2}`);
				}
			} else {
				// ルームチャット: ルームオーナーのDriveに保存
				const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
				if (!room) {
					console.warn(`[Drawing] Room ${roomId} not found for auto-save`);
					return;
				}
				await this.saveCanvasToImage(roomId, strokes, room.ownerId);
			}

			// Redisからキャンバスデータを削除しない（キャンバスを維持するため）
			// 自動保存後もRedisにデータを残しておくことで、ユーザーがキャンバスを継続して使用できる
			// Redisには7日間のEXPIREが設定されているため、長期間使用されないキャンバスは自動的に削除される
			// await this.cleanupCanvasData(roomId);

			console.log(`[Drawing] Successfully auto-saved canvas ${roomId}`);
		} catch (error) {
			console.error(`[Drawing] Failed to auto-save canvas ${roomId}:`, error);
		}
	}

	@bindThis
	private async saveCanvasToImage(roomId: string, strokes: DrawingStroke[], ownerId: string): Promise<void> {
		try {
			// JSONとSVGの両方で保存
			const timestamp = Date.now();

			// 1. JSONファイルとして保存（復元用）
			const jsonData = JSON.stringify(strokes, null, 2);
			const jsonFilename = `drawing-${roomId}-${timestamp}.json`;
			const jsonBuffer = Buffer.from(jsonData, 'utf-8');

			const jsonFile = await this.driveService.addFile({
				user: { id: ownerId } as MiUser,
				path: jsonFilename,
				name: jsonFilename,
				// buffer: jsonBuffer, // TODO: AddFileArgsにbufferパラメータを追加する必要があります
				type: 'application/json',
				isPrivate: false,
				folder: null,
				uri: null,
				sensitive: false,
				comment: `お絵かきキャンバス - ルーム ${roomId}`,
			} as any);

			// 2. SVGファイルとしても保存（表示用）
			const svgContent = this.generateSVGFromStrokes(strokes);
			const svgFilename = `drawing-${roomId}-${timestamp}.svg`;
			const svgBuffer = Buffer.from(svgContent, 'utf-8');

			const svgFile = await this.driveService.addFile({
				user: { id: ownerId } as MiUser,
				path: svgFilename,
				name: svgFilename,
				// buffer: svgBuffer, // TODO: AddFileArgsにbufferパラメータを追加する必要があります
				type: 'image/svg+xml',
				isPrivate: false,
				folder: null,
				uri: null,
				sensitive: false,
				comment: `お絵かきキャンバス表示用 - ルーム ${roomId}`,
			} as any);

			console.log(`[Drawing] Canvas saved as JSON (${jsonFile.id}) and SVG (${svgFile.id}) for room ${roomId}`);
		} catch (error) {
			console.error(`[Drawing] Failed to save canvas files:`, error);
		}
	}

	// ストロークデータからSVGを生成する（キャンバス固定サイズ: 1600x1200）
	@bindThis
	private generateSVGFromStrokes(strokes: DrawingStroke[]): string {
		const width = MAX_COORDINATE_X;
		const height = MAX_COORDINATE_Y;

		let pathElements = '';

		for (const stroke of strokes) {
			if (stroke.tool === 'pen' && stroke.points.length > 0) {
				const pathData = stroke.points.map((point, index) => {
					return index === 0 ? `M ${point.x} ${point.y}` : `L ${point.x} ${point.y}`;
				}).join(' ');

				pathElements += `<path d="${pathData}" stroke="${stroke.color}" stroke-width="${stroke.strokeWidth}" stroke-opacity="${stroke.opacity}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
			}
		}

		return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
	<rect width="100%" height="100%" fill="white"/>
	${pathElements}
	<text x="10" y="${height - 10}" font-family="Arial" font-size="12" fill="#888">Generated: ${new Date().toISOString()}</text>
</svg>`;
	}

	@bindThis
	private async cleanupCanvasData(roomId: string): Promise<void> {
		try {
			const canvasKey = this.getCanvasKey(roomId);
			const metaKey = this.getMetaKey(roomId);

			await this.redisClient.del(canvasKey);
			await this.redisClient.del(`${metaKey}:participants`);
			await this.redisClient.del(metaKey);

			// レイヤー別マージ済み画像を削除
			for (let i = 0; i <= this.MAX_LAYER_INDEX; i++) {
				await this.redisClient.del(this.getMergedImageKey(roomId, i));
			}

			// レイヤー別アンドゥバッファを削除
			const undoPattern = `drawing:undo:${roomId}:*`;
			const undoKeys = await this.redisClient.keys(undoPattern);
			if (undoKeys.length > 0) {
				await this.redisClient.del(...undoKeys);
			}

			// ローカルキャッシュとタイマーもクリア
			this.canvasCache.delete(roomId);
			const timer = this.saveTimers.get(roomId);
			if (timer) {
				clearTimeout(timer);
				this.saveTimers.delete(roomId);
			}

			console.log(`[Drawing] Cleaned up canvas data for room ${roomId}`);
		} catch (error) {
			console.error(`[Drawing] Failed to cleanup canvas data for ${roomId}:`, error);
		}
	}

	// Redis→DB退避: グループチャットのキャンバスデータを1時間アイドル後にDBに退避する
	// chat_roomテーブルのcanvasStrokes/canvasMergedImagesカラムに保存
	@bindThis
	public async archiveCanvasToDb(roomId: string): Promise<boolean> {
		try {
			// ユーザー間チャットはDB退避対象外
			if (this.isUserToUserChatId(roomId)) return false;

			const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
			if (!room) {
				console.warn(`[Drawing] Room ${roomId} not found for archival`);
				return false;
			}

			// Redisからストロークデータを取得
			const canvasKey = this.getCanvasKey(roomId);
			const strokesData = await this.redisClient.lrange(canvasKey, 0, -1);
			const strokes: DrawingStroke[] = strokesData
				.map(d => { try { return JSON.parse(d) as DrawingStroke; } catch { return null; } })
				.filter((s): s is DrawingStroke => s !== null)
				.reverse();

			// レイヤー別マージ済みストロークを取得
			const mergedImages: Record<string, DrawingStroke[]> = {};
			for (let i = 0; i <= this.MAX_LAYER_INDEX; i++) {
				const mergedKey = this.getMergedImageKey(roomId, i);
				const mergedData = await this.redisClient.lrange(mergedKey, 0, -1);
				if (mergedData.length > 0) {
					mergedImages[String(i)] = mergedData
						.map(d => { try { return JSON.parse(d) as DrawingStroke; } catch { return null; } })
						.filter((s): s is DrawingStroke => s !== null);
				}
			}

			// ストロークもマージ画像もない場合は保存不要
			if (strokes.length === 0 && Object.keys(mergedImages).length === 0) return false;

			// データサイズガード
			if (strokes.length > MAX_ARCHIVE_STROKES) {
				console.warn(`[Drawing] Skipping canvas archive for room ${roomId}: too many strokes (${strokes.length})`);
				return false;
			}

			// DBに退避
			await this.chatRoomsRepository.update(roomId, {
				canvasStrokes: strokes as object[],
				canvasMergedImages: mergedImages as object,
			});

			// 退避成功後にRedisからキャンバスデータを削除
			await this.cleanupCanvasData(roomId);

			console.log(`[Drawing] Archived canvas to DB for room ${roomId}: ${strokes.length} strokes, ${Object.keys(mergedImages).length} merged layers`);
			return true;
		} catch (error) {
			console.error(`[Drawing] Failed to archive canvas to DB for room ${roomId}:`, error);
			return false;
		}
	}

	// DB→Redis復元: DBに退避されたキャンバスデータをRedisに復元する（再入室時用）
	// SETNX（SET NX）ベースのロックで競合状態を防止
	@bindThis
	public async restoreCanvasFromDb(roomId: string): Promise<{ strokes: DrawingStroke[]; mergedImages: Record<string, DrawingStroke[]> } | null> {
		try {
			// ユーザー間チャットはDB退避対象外
			if (this.isUserToUserChatId(roomId)) return null;

			const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
			if (!room || !room.canvasStrokes) return null;

			const strokes = room.canvasStrokes as DrawingStroke[];
			const mergedImages = (room.canvasMergedImages ?? {}) as Record<string, DrawingStroke[]>;

			// ロックを取得して競合状態を防止（30秒TTL）
			const lockKey = `drawing:restoreLock:${roomId}`;
			const lockAcquired = await this.redisClient.set(lockKey, '1', 'EX', 30, 'NX');
			if (lockAcquired == null) {
				// 別リクエストが復元中。Redisにデータがあるはずなのでそちらを参照
				console.log(`[Drawing] Restore lock already held for room ${roomId}, skipping`);
				return { strokes, mergedImages };
			}

			try {
				// ロック取得後に再確認（別リクエストが復元済みの可能性）
				const canvasKey = this.getCanvasKey(roomId);
				const existingLen = await this.redisClient.llen(canvasKey);
				if (existingLen > 0) {
					console.log(`[Drawing] Canvas already restored in Redis for room ${roomId}, skipping`);
					return { strokes, mergedImages };
				}

				// Redisにストロークをバッチで復元
				if (strokes.length > 0) {
					const serialized = strokes.map(s => JSON.stringify(s));
					for (let i = 0; i < serialized.length; i += RPUSH_BATCH_SIZE) {
						const batch = serialized.slice(i, i + RPUSH_BATCH_SIZE);
						await this.redisClient.rpush(canvasKey, ...batch);
					}
					await this.redisClient.expire(canvasKey, this.CANVAS_EXPIRY);
				}

				// Redisにレイヤー別マージ済みストロークを復元
				for (const [layerIndex, layerStrokes] of Object.entries(mergedImages)) {
					if (layerStrokes.length > 0) {
						const mergedKey = this.getMergedImageKey(roomId, parseInt(layerIndex));
						const serialized = layerStrokes.map(s => JSON.stringify(s));
						for (let i = 0; i < serialized.length; i += RPUSH_BATCH_SIZE) {
							const batch = serialized.slice(i, i + RPUSH_BATCH_SIZE);
							await this.redisClient.rpush(mergedKey, ...batch);
						}
						await this.redisClient.expire(mergedKey, this.CANVAS_EXPIRY);
					}
				}

				// 復元成功後にDBの退避データをクリア
				await this.chatRoomsRepository.update(roomId, {
					canvasStrokes: null,
					canvasMergedImages: null,
				});

				// メタデータを復元
				const metaKey = this.getMetaKey(roomId);
				await this.redisClient.hmset(metaKey, { lastActivity: Date.now() });
				await this.redisClient.expire(metaKey, this.CANVAS_EXPIRY);

				console.log(`[Drawing] Restored canvas from DB for room ${roomId}: ${strokes.length} strokes, ${Object.keys(mergedImages).length} merged layers`);
				return { strokes, mergedImages };
			} finally {
				await this.redisClient.del(lockKey);
			}
		} catch (error) {
			console.error(`[Drawing] Failed to restore canvas from DB for room ${roomId}:`, error);
			return null;
		}
	}

	@bindThis
	public async forceServerCanvasData(roomId: string): Promise<void> {
		console.log(`[Drawing] Force saving canvas data for room ${roomId}`);
		await this.autoSaveCanvas(roomId);
	}

	// レイヤー指定のアンドゥ（paintchat標準: レイヤー別バッファから取り消す）
	@bindThis
	public async performUndo(roomId: string, userId: string, layerIndex?: number): Promise<DrawingStroke | null> {
		try {
			// レイヤー未指定の場合はlayer:0をデフォルトにする（後方互換）
			const layer = layerIndex !== undefined ? this.clampLayerIndex(layerIndex) : 0;
			const undoBufferKey = this.getUndoBufferKey(roomId, userId, layer);

			// ユーザーのレイヤー別アンドゥバッファから最新のストロークを取得
			const latestStrokeData = await this.redisClient.lpop(undoBufferKey);

			if (!latestStrokeData) {
				console.log(`[Drawing] No strokes to undo for user ${userId} in room ${roomId} layer ${layer}`);
				return null;
			}

			const strokeToUndo: DrawingStroke = JSON.parse(latestStrokeData);
			console.log(`[Drawing] Undoing stroke ${strokeToUndo.id} for user ${userId} in room ${roomId} layer ${layer}`);

			// メインキャンバスからも該当ストロークを削除
			await this.removeStrokeFromCanvas(roomId, strokeToUndo.id);

			return strokeToUndo;
		} catch (error) {
			console.error(`[Drawing] Failed to perform undo for user ${userId} in room ${roomId}:`, error);
			return null;
		}
	}

	@bindThis
	private async removeStrokeFromCanvas(roomId: string, strokeId: string): Promise<void> {
		try {
			const canvasKey = this.getCanvasKey(roomId);

			// 全てのストロークを取得
			const allStrokes = await this.redisClient.lrange(canvasKey, 0, -1);

			// 削除対象以外のストロークをフィルタリング
			const filteredStrokes = allStrokes.filter(strokeData => {
				try {
					const stroke = JSON.parse(strokeData);
					return stroke.id !== strokeId;
				} catch {
					return true; // パースエラーの場合は保持
				}
			});

			// Redisリストを再構築
			await this.redisClient.del(canvasKey);
			if (filteredStrokes.length > 0) {
				await this.redisClient.lpush(canvasKey, ...filteredStrokes.reverse());
				await this.redisClient.expire(canvasKey, this.CANVAS_EXPIRY);
			}

			console.log(`[Drawing] Removed stroke ${strokeId} from canvas ${roomId}`);
		} catch (error) {
			console.error(`[Drawing] Failed to remove stroke ${strokeId} from canvas ${roomId}:`, error);
		}
	}

	// アプリケーション終了時のクリーンアップ
	@bindThis
	public async onApplicationShutdown(): Promise<void> {
		// 自動保存インターバルをクリア
		if (this.autoSaveInterval) {
			clearInterval(this.autoSaveInterval);
			this.autoSaveInterval = null;
		}

		// すべての個別保存タイマーをクリア
		for (const timer of this.saveTimers.values()) {
			clearTimeout(timer);
		}
		this.saveTimers.clear();
	}
}
