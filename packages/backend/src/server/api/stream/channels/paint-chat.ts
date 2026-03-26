/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import type { PaintChatMessagesRepository } from '@/models/_.js';
import type { JsonObject } from '@/misc/json-value.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatCanvasService } from '@/core/PaintChatCanvasService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
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
	private lastPresenceStatus: 'online' | 'offline' | null = null;

	// レート制限用
	private lastCursorMove: number = 0;
	private lastDrawingProgress: number = 0;

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		@Inject(DI.paintChatMessagesRepository)
		private paintChatMessagesRepository: PaintChatMessagesRepository,

		private paintChatService: PaintChatService,
		private paintChatCanvasService: PaintChatCanvasService,
		private globalEventService: GlobalEventService,
		private idService: IdService,
	) {
		super(request);
	}

	// チャネル接続時。ルームアクセス制御とラッパーユーザーID解決を行う。
	// 接続成功時にプレゼンスonlineを自動送信する。
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

		// 接続時にプレゼンスonlineを自動通知（再接続時も含む）+ DB保存
		this.broadcastToRoom('presenceUpdate', {
			participantId: this.participantId,
			status: 'online',
		});
		this.savePresenceMessage('online');

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
				await this.onUndoStroke(body);
				break;
			case 'presence':
				this.onPresence(body);
				break;
			case 'publishConsent':
				this.onPublishConsent(body);
				break;
		}
	}

	// ストロークデータのバリデーション
	private validateStrokeData(body: JsonObject): boolean {
		if (typeof body.id !== 'string' || body.id.length > 100) return false;
		if (!Array.isArray(body.points) || body.points.length === 0 || body.points.length > 10000) return false;
		if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) return false;
		if (typeof body.width !== 'number' || body.width < 1 || body.width > 400) return false;
		if (typeof body.opacity !== 'number' || body.opacity < 0 || body.opacity > 1) return false;
		if (body.tool !== 'pen' && body.tool !== 'eraser') return false;
		// レイヤー番号（0-2、未指定の場合は0として扱う）
		if (body.layer != null && (typeof body.layer !== 'number' || body.layer < 0 || body.layer > 2)) return false;
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
			layer: (typeof body.layer === 'number' ? body.layer : 0),
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

	// アンドゥイベント処理（クライアントが指定したstrokeIdを削除する）
	private async onUndoStroke(body?: JsonObject): Promise<void> {
		if (this.roomId == null || this.participantId == null) return;
		const targetStrokeId = (body && typeof body.strokeId === 'string' && body.strokeId.length > 0) ? body.strokeId : null;
		const strokeId = targetStrokeId
			? await this.paintChatCanvasService.removeStroke(this.roomId, this.participantId, targetStrokeId)
			: await this.paintChatCanvasService.undoStroke(this.roomId, this.participantId);
		if (strokeId != null) {
			this.broadcastToRoom('undone', {
				participantId: this.participantId,
				strokeId,
			});
		}
	}

	// 投稿同意通知（WebSocket経由で相手に通知するだけ。DB操作なし。）
	private onPublishConsent(body: JsonObject): void {
		if (typeof body.consent !== 'boolean') return;
		this.broadcastToRoom('publishConsentUpdate', {
			participantId: this.participantId,
			consent: body.consent,
		});
	}

	// プレゼンスイベント処理（statusはonline/offlineのみ許可）+ DB保存
	private onPresence(body: JsonObject): void {
		if (body.status !== 'online' && body.status !== 'offline') return;
		this.broadcastToRoom('presenceUpdate', {
			participantId: this.participantId,
			status: body.status,
		});
		this.savePresenceMessage(body.status as 'online' | 'offline');
	}

	// ルーム全体にイベントをブロードキャスト（GlobalEventService経由でRedis Pub/Subで配信）
	private broadcastToRoom(type: string, body: object): void {
		if (this.roomId == null) return;
		this.globalEventService.publishPaintChatStream(this.roomId, type, body as any);
	}

	// 入退室のシステムメッセージをDBに保存しWebSocket配信する（状態変化時のみ）
	private async savePresenceMessage(status: 'online' | 'offline'): Promise<void> {
		if (this.roomId == null || this.participantId == null) return;
		if (this.lastPresenceStatus === status) return; // 同じ状態の連続保存を防止
		this.lastPresenceStatus = status;

		// 匿名名を取得してメッセージに含める
		let name = '???';
		try {
			const participant = await this.paintChatService.getParticipantById(this.participantId);
			if (participant) name = participant.anonymousName;
		} catch { /* ignore */ }
		const content = status === 'online' ? `${name} が入室しました` : `${name} が退室しました`;
		const msgId = this.idService.gen();
		try {
			await this.paintChatMessagesRepository.insert({
				id: msgId,
				roomId: this.roomId,
				participantId: this.participantId,
				type: 'system',
				content,
			});
			this.broadcastToRoom('message', {
				id: msgId,
				participantId: this.participantId,
				type: 'system',
				content,
				createdAt: new Date().toISOString(),
			});
		} catch { /* ignore */ }
	}

	// paintChatStreamからのイベントを受信
	// stroke/progress/cursorは自分のイベントを除外。canvasCleared/undone/publish系等は全員に配信。
	@bindThis
	private onEvent(data: { type: string; body: any }): void {
		const selfFilterTypes = ['stroke', 'progress', 'cursor'];
		if (selfFilterTypes.includes(data.type) && data.body?.participantId === this.participantId) return;
		this.send(data.type, data.body);
	}

	// チャネル切断時。相手にプレゼンスoffline通知のみ送信する。
	// partnerLeftは明示的なleave API呼び出し時のみ送信される。
	// 一時的な切断（ダウンロード、タブ切替等）ではクライアントが自動再接続するため、
	// sessionEndedは送信しない。
	@bindThis
	public dispose(): void {
		if (this.roomId != null) {
			// 相手にプレゼンスofflineを通知 + DB保存
			this.broadcastToRoom('presenceUpdate', {
				participantId: this.participantId,
				status: 'offline',
			});
			this.savePresenceMessage('offline');

			(this.subscriber as any).off(`paintChatStream:${this.roomId}`, this.onEvent);
		}
	}
}
