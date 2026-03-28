/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatPublishService } from '@/core/PaintChatPublishService.js';
import { ApiError } from '@/server/api/error.js';

// 自分の絵のみをbot経由で匿名投稿する（相手の同意不要、自分のストロークのみ）
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '7c1f3a2d-9e4b-4f8c-a6d5-3b2e1f0c8a7d',
		},
		noImage: {
			message: 'Image data is required.',
			code: 'NO_IMAGE',
			id: '8d2e4b3c-a5f6-4d7e-b8c9-1a0f2e3d4c5b',
		},
		botNotConfigured: {
			message: 'Bot account is not configured.',
			code: 'BOT_NOT_CONFIGURED',
			id: '9e3f5c4d-b6a7-4e8f-c9d0-2b1a3e4f5d6c',
		},
		alreadyPublished: {
			message: 'Already published my art for this room.',
			code: 'ALREADY_PUBLISHED',
			id: 'a4b5c6d7-e8f9-4a0b-c1d2-3e4f5a6b7c8d',
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
		imageBase64: { type: 'string', maxLength: 10_000_000 },
	},
	required: ['roomId', 'imageBase64'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private paintChatService: PaintChatService,
		private paintChatPublishService: PaintChatPublishService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const participant = await this.paintChatService.resolveParticipant(ps.roomId, me.id);
			if (participant == null) throw new ApiError(meta.errors.accessDenied);

			if (!ps.imageBase64) throw new ApiError(meta.errors.noImage);

			// 連続投稿制限: 1ルーム1ユーザーにつき1回のみ（Redis SET NX、TTL 7日）
			const myArtKey = `paintChat:myArtPublished:${ps.roomId}:${me.id}`;
			const alreadyPublished = await this.redisClient.set(myArtKey, '1', 'EX', 604800, 'NX');
			if (!alreadyPublished) throw new ApiError(meta.errors.alreadyPublished);

			const imageBuffer = Buffer.from(ps.imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');

			// bot経由で自分の絵のみを匿名投稿（ステガノグラフィ付き、ルームID記録）
			let noteId: string | null;
			try {
				noteId = await this.paintChatPublishService.publishMyArt(
					ps.roomId,
					imageBuffer,
					participant.anonymousName,
					participant.id,
				);
			} catch (err) {
				// 例外発生時もRedisフラグを削除して再試行可能にする
				await this.redisClient.del(myArtKey);
				throw err;
			}

			if (noteId == null) {
				await this.redisClient.del(myArtKey);
				throw new ApiError(meta.errors.botNotConfigured);
			}

			return { success: true };
		});
	}
}
