/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import type { JsonObject } from '@/misc/json-value.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatCanvasService } from '@/core/PaintChatCanvasService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import type { StrokeData } from '@/core/PaintChatCanvasService.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

// ランダム絵チャット用WebSocketチャネル
@Injectable({ scope: Scope.TRANSIENT })
export class PaintChatChannel extends Channel {
	public readonly chName = 'paintChat';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';

	private roomId: string | null = null;
	private participantId: string | null = null;

	// レート制限用
	private lastCursorMove: number = 0;
	private lastDrawingProgress: number = 0;

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private paintChatService: PaintChatService,
		private paintChatCanvasService: PaintChatCanvasService,
		private globalEventService: GlobalEventService,
	) {
		super(request);
	}

	// チャネル接続時。ルームアクセス制御とラッパーユーザーID解決を行う。
	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (typeof params.roomId !== 'string') return false;
		if (!this.user) return false;

		this.roomId = params.roomId;

		// ルームへのアクセス権限チェック
		const canAccess = await this.paintChatService.canAccessRoom(this.roomId, this.user.id);
		if (!canAccess) return false;

		// ラッパーユーザーIDを解決
		const participant = await this.paintChatService.resolveParticipant(this.roomId, this.user.id);
		if (participant == null) return false;

		this.participantId = participant.id;

		// paintChatストリームを購読
		(this.subscriber as any).on(`paintChatStream:${this.roomId}`, this.onEvent);

		return true;
	}

	// クライアントからのメッセージ処理
	@bindThis
	public async onMessage(type: string, body: JsonObject): Promise<void> {
		if (this.roomId == null || this.participantId == null) return;

		switch (type) {
			case 'drawingStroke':
				await this.onDrawingStroke(body);
				break;
			case 'drawingProgress':
				this.onDrawingProgress(body);
				break;
			case 'cursorMove':
				this.onCursorMove(body);
				break;
			case 'clearCanvas':
				await this.onClearCanvas();
				break;
			case 'undoStroke':
				await this.onUndoStroke();
				break;
			case 'presence':
				this.onPresence(body);
				break;
		}
	}

	// ストロークデータのバリデーション
	private validateStrokeData(body: JsonObject): boolean {
		if (typeof body.id !== 'string' || body.id.length > 100) return false;
		if (!Array.isArray(body.points) || body.points.length === 0 || body.points.length > 10000) return false;
		if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) return false;
		if (typeof body.width !== 'number' || body.width < 1 || body.width > 100) return false;
		if (typeof body.opacity !== 'number' || body.opacity < 0 || body.opacity > 1) return false;
		if (body.tool !== 'pen' && body.tool !== 'eraser') return false;
		return true;
	}

	// ストローク完了イベント処理
	private async onDrawingStroke(body: JsonObject): Promise<void> {
		if (this.roomId == null || this.participantId == null) return;
		if (!this.validateStrokeData(body)) return;

		const stroke: StrokeData = {
			id: body.id as string,
			participantId: this.participantId,
			points: body.points as any[],
			color: body.color as string,
			width: body.width as number,
			opacity: body.opacity as number,
			tool: body.tool as 'pen' | 'eraser',
		};

		await this.paintChatCanvasService.addStroke(this.roomId, stroke);

		// 相手にブロードキャスト（strokeにはparticipantIdが含まれている）
		this.broadcastToRoom('stroke', stroke);
	}

	// 描画進行中イベント処理（50msレート制限）
	private onDrawingProgress(body: JsonObject): void {
		const now = Date.now();
		if (now - this.lastDrawingProgress < 50) return;
		this.lastDrawingProgress = now;

		this.broadcastToRoom('progress', {
			participantId: this.participantId,
			points: body.points,
		});
	}

	// カーソル移動イベント処理（50msレート制限）
	private onCursorMove(body: JsonObject): void {
		const now = Date.now();
		if (now - this.lastCursorMove < 50) return;
		this.lastCursorMove = now;

		this.broadcastToRoom('cursor', {
			participantId: this.participantId,
			x: body.x,
			y: body.y,
		});
	}

	// キャンバスクリアイベント処理
	private async onClearCanvas(): Promise<void> {
		if (this.roomId == null) return;
		await this.paintChatCanvasService.clearCanvas(this.roomId);
		this.broadcastToRoom('canvasCleared', {
			participantId: this.participantId,
		});
	}

	// アンドゥイベント処理
	private async onUndoStroke(): Promise<void> {
		if (this.roomId == null || this.participantId == null) return;
		const strokeId = await this.paintChatCanvasService.undoStroke(this.roomId, this.participantId);
		if (strokeId != null) {
			this.broadcastToRoom('undone', {
				participantId: this.participantId,
				strokeId,
			});
		}
	}

	// プレゼンスイベント処理
	private onPresence(body: JsonObject): void {
		this.broadcastToRoom('presenceUpdate', {
			participantId: this.participantId,
			status: body.status,
		});
	}

	// ルーム全体にイベントをブロードキャスト（GlobalEventService経由でRedis Pub/Subで配信）
	private broadcastToRoom(type: string, body: object): void {
		if (this.roomId == null) return;
		this.globalEventService.publishPaintChatStream(this.roomId, type, body as any);
	}

	// paintChatStreamからのイベントを受信
	// stroke/progress/cursorは自分のイベントを除外。canvasCleared/undone/publish系等は全員に配信。
	@bindThis
	private onEvent(data: { type: string; body: any }): void {
		const selfFilterTypes = ['stroke', 'progress', 'cursor'];
		if (selfFilterTypes.includes(data.type) && data.body?.participantId === this.participantId) return;
		this.send(data.type, data.body);
	}

	// チャネル切断時。相手にpartnerLeft通知を送り、30秒後にsessionEndedを送出する。
	@bindThis
	public dispose(): void {
		if (this.roomId != null) {
			// 相手に退出を通知
			this.broadcastToRoom('partnerLeft', {});

			// 30秒後にsessionEndedを送出（タイムアウト処理）
			const roomId = this.roomId;
			setTimeout(() => {
				this.globalEventService.publishPaintChatStream(roomId, 'sessionEnded', {
					reason: 'timeout',
				} as any);
			}, 30000);

			(this.subscriber as any).off(`paintChatStream:${roomId}`, this.onEvent);
		}
	}
}
