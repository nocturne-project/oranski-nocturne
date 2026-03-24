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

// サイコロを振ってチャットに投稿する（1〜6のランダムな数字）
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '1fb872ec-ba1a-4ed1-ac84-18c68cc443cf',
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
		@Inject(DI.paintChatMessagesRepository)
		private paintChatMessagesRepository: PaintChatMessagesRepository,

		private paintChatService: PaintChatService,
		private globalEventService: GlobalEventService,
		private idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const canAccess = await this.paintChatService.canAccessRoom(ps.roomId, me.id);
			if (!canAccess) throw new ApiError(meta.errors.accessDenied);

			// サイコロを振る（サーバー側で生成して公平性を保証）
			const value = Math.floor(Math.random() * 6) + 1;

			// 振った人の参加者情報取得
			const participant = await this.paintChatService.resolveParticipant(ps.roomId, me.id);

			// メッセージ保存
			const msgId = this.idService.gen();
			await this.paintChatMessagesRepository.insert({
				id: msgId,
				roomId: ps.roomId,
				participantId: participant?.id ?? null,
				type: 'dice',
				content: String(value),
			});

			const message = {
				id: msgId,
				participantId: participant?.id ?? null,
				type: 'dice' as const,
				content: String(value),
				createdAt: new Date().toISOString(),
			};

			this.globalEventService.publishPaintChatStream(ps.roomId, 'message', message as any);

			return { message, value };
		});
	}
}
