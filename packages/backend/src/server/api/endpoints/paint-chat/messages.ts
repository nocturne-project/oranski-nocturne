/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { DI } from '@/di-symbols.js';
import type { PaintChatMessagesRepository } from '@/models/_.js';
import { ApiError } from '@/server/api/error.js';

// テキストチャットメッセージ一覧取得
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'read:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: 'c0f1ace9-abef-4d86-8178-87f3ca2b6d96',
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
		sinceId: { type: 'string', format: 'misskey:id' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.paintChatMessagesRepository)
		private paintChatMessagesRepository: PaintChatMessagesRepository,

		private paintChatService: PaintChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const canAccess = await this.paintChatService.canAccessRoom(ps.roomId, me.id);
			if (!canAccess) throw new ApiError(meta.errors.accessDenied);

			const query = this.paintChatMessagesRepository.createQueryBuilder('msg')
				.where('msg.roomId = :roomId', { roomId: ps.roomId })
				.orderBy('msg.createdAt', 'ASC');

			if (ps.sinceId) {
				query.andWhere('msg.id > :sinceId', { sinceId: ps.sinceId });
			}

			const messages = await query.take(ps.limit ?? 50).getMany();

			return {
				messages: messages.map(m => ({
					id: m.id,
					participantId: m.participantId,
					type: m.type,
					content: m.content,
					createdAt: m.createdAt.toISOString(),
				})),
			};
		});
	}
}
