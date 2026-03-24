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

// 一言メッセージを設定する（投稿確定はフロントエンドの判断に委ねる）
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
		messageTooLong: {
			message: 'Message is too long. Maximum 100 characters.',
			code: 'MESSAGE_TOO_LONG',
			id: '0f7b8f1f-acf3-455f-9a9d-47012a535e04',
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

			if (ps.message.length > 100) {
				throw new ApiError(meta.errors.messageTooLong);
			}

			// 一言メッセージを保存
			await this.paintChatPublishService.setMessage(ps.roomId, participant.id, ps.message);

			// 画像が添付されていれば、bot投稿を実行（双方のメッセージが揃った後に呼び出される）
			if (ps.imageBase64) {
				const participants = await this.paintChatService.getRoomParticipants(ps.roomId);
				const publishStatus = await this.paintChatPublishService.getPublishStatus(ps.roomId);

				if (publishStatus.bothAgreed && !publishStatus.published) {
					const imageBuffer = Buffer.from(ps.imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
					const p1 = participants[0];
					const p2 = participants[1];

					// 投稿同意レコードからメッセージ取得
					const record = await this.paintChatPublishService.getPublishRecord(ps.roomId);

					const noteId = await this.paintChatPublishService.publishToTimeline(
						ps.roomId,
						imageBuffer,
						p1?.anonymousName ?? '???',
						p2?.anonymousName ?? '???',
						record?.participant1Message ?? null,
						record?.participant2Message ?? null,
					);

					if (noteId) {
						this.globalEventService.publishPaintChatStream(ps.roomId, 'published', { noteId } as any);
					}
				}
			}

			return { success: true };
		});
	}
}
