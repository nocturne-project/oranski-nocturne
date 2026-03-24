/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatPublishService } from '@/core/PaintChatPublishService.js';
import { PaintChatCanvasService } from '@/core/PaintChatCanvasService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApiError } from '@/server/api/error.js';

// 投稿に同意する
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: 'ae0412fa-253f-4323-8f6c-28f0c2613c2b',
		},
		alreadyPublished: {
			message: 'Already published.',
			code: 'ALREADY_PUBLISHED',
			id: '11c5cef6-73e4-42a0-b62b-d005b47276a6',
		},
		canvasNotReady: {
			message: 'Canvas is empty or not enough drawing.',
			code: 'CANVAS_NOT_READY',
			id: 'b268fa51-d460-44b1-875b-b02e7b74d8bd',
		},
		botNotConfigured: {
			message: 'Bot account is not configured.',
			code: 'BOT_NOT_CONFIGURED',
			id: '6297110e-0ec3-45d1-9d00-980f04e8f7a1',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private paintChatService: PaintChatService,
		private paintChatPublishService: PaintChatPublishService,
		private paintChatCanvasService: PaintChatCanvasService,
		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const participant = await this.paintChatService.resolveParticipant(ps.roomId, me.id);
			if (participant == null) throw new ApiError(meta.errors.accessDenied);

			// 既に投稿済みチェック
			if (await this.paintChatPublishService.isPublished(ps.roomId)) {
				throw new ApiError(meta.errors.alreadyPublished);
			}

			// botアカウント設定チェック
			if (!(await this.paintChatPublishService.isBotConfigured())) {
				throw new ApiError(meta.errors.botNotConfigured);
			}

			// 品質ガード: ストロークが十分か
			const strokeCount = await this.paintChatCanvasService.getStrokeCount(ps.roomId);
			if (strokeCount === 0) {
				throw new ApiError(meta.errors.canvasNotReady);
			}

			// 参加者全員を取得
			const participants = await this.paintChatService.getRoomParticipants(ps.roomId);
			const partner = participants.find(p => p.id !== participant.id);
			if (!partner) throw new ApiError(meta.errors.accessDenied);

			// 同意リクエスト作成/更新
			await this.paintChatPublishService.createPublishRequest(
				ps.roomId,
				participants[0],
				participants[1],
				participant.id,
			);

			// 同意状態確認
			const status = await this.paintChatPublishService.getPublishStatus(ps.roomId);

			if (status.bothAgreed) {
				// 双方同意: メッセージ入力フェーズへ
				this.globalEventService.publishPaintChatStream(ps.roomId, 'publishAgreed', {} as any);
				return { status: 'both_agreed' as const };
			} else {
				// 相手に同意リクエストを通知
				this.globalEventService.publishPaintChatStream(ps.roomId, 'publishRequested', {
					participantId: participant.id,
				} as any);
				return { status: 'waiting_partner' as const };
			}
		});
	}
}
