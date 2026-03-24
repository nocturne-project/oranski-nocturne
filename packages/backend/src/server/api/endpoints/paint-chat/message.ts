/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { DI } from '@/di-symbols.js';
import type { PaintChatMessagesRepository } from '@/models/_.js';
import { ApiError } from '@/server/api/error.js';

// テキストチャットメッセージ送信
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'aada5cb8-3b26-4c70-97ca-01b9168537e9',
		},
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: 'a22590ed-9a5b-4232-8ec8-5efa7eceb437',
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
		content: { type: 'string', minLength: 1, maxLength: 500 },
	},
	required: ['roomId', 'content'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.paintChatMessagesRepository)
		private paintChatMessagesRepository: PaintChatMessagesRepository,

		private paintChatService: PaintChatService,
		private globalEventService: GlobalEventService,
		private idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// アクセス権限チェック
			const participant = await this.paintChatService.resolveParticipant(ps.roomId, me.id);
			if (participant == null) throw new ApiError(meta.errors.accessDenied);

			// メッセージ保存
			const msgId = this.idService.gen();
			await this.paintChatMessagesRepository.insert({
				id: msgId,
				roomId: ps.roomId,
				participantId: participant.id,
				type: 'text',
				content: ps.content,
			});

			const message = {
				id: msgId,
				participantId: participant.id,
				type: 'text' as const,
				content: ps.content,
				createdAt: new Date().toISOString(),
			};

			// WebSocketでルーム全体に配信
			this.globalEventService.publishPaintChatStream(ps.roomId, 'message', message as any);

			return { message };
		});
	}
}
