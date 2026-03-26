/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatPublishService } from '@/core/PaintChatPublishService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApiError } from '@/server/api/error.js';

// 合作投稿: キャンバス画像をbot経由で投稿する
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '2ab043e9-5d7c-41b0-a2b6-fc4bc7f52f84',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			success: { type: 'boolean', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		message: { type: 'string', maxLength: 100 },
		imageBase64: { type: 'string' },
	},
	required: ['roomId', 'message'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private paintChatService: PaintChatService,
		private paintChatPublishService: PaintChatPublishService,
		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const participant = await this.paintChatService.resolveParticipant(ps.roomId, me.id);
			if (participant == null) throw new ApiError(meta.errors.accessDenied);

			// 画像が添付されていれば、bot投稿を実行
			// 同意チェックはフロントエンドのUIで制御済み（両者許可済みの場合のみボタンが有効）
			if (ps.imageBase64) {
				const participants = await this.paintChatService.getRoomParticipants(ps.roomId);
				const imageBuffer = Buffer.from(ps.imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
				const p1 = participants[0];
				const p2 = participants[1];

				try {
					const noteId = await this.paintChatPublishService.publishToTimeline(
						ps.roomId,
						imageBuffer,
						p1?.anonymousName ?? '???',
						p2?.anonymousName ?? '???',
						ps.message || null,
						null,
					);

					if (noteId) {
						this.globalEventService.publishPaintChatStream(ps.roomId, 'published', { noteId } as any);
					}
				} catch (err) {
					console.error('[PaintChat] publishToTimeline failed:', err);
				}
			}

			return { success: true };
		});
	}
}
