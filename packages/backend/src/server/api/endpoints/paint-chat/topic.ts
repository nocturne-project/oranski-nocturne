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

// ランダムお題をチャットに投稿する
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '7e786130-cadb-40eb-b506-3ab7fe08dc11',
		},
		noTopicsConfigured: {
			message: 'No topics configured.',
			code: 'NO_TOPICS_CONFIGURED',
			id: '4c44427e-228a-43ee-bedf-1d80d13b579c',
		},
		alreadyUsed: {
			message: 'Topic has already been used in this room.',
			code: 'TOPIC_ALREADY_USED',
			id: '5d55538f-339b-54ff-ceef-2e91e24c690d',
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

			// 1部屋1回制限: 既にお題が出されているかチェック
			const existingTopic = await this.paintChatMessagesRepository.findOneBy({
				roomId: ps.roomId,
				type: 'topic',
			});
			if (existingTopic != null) {
				throw new ApiError(meta.errors.alreadyUsed);
			}

			// お題リスト取得（汎用 + 現在の季節を結合）
			const topicListText = await this.paintChatService.getCurrentTopicList();
			const topics = topicListText.split('\n').map(t => t.trim()).filter(t => t.length > 0);

			if (topics.length === 0) {
				throw new ApiError(meta.errors.noTopicsConfigured);
			}

			// ランダムに1つ選択
			const topic = topics[Math.floor(Math.random() * topics.length)];

			// メッセージ保存
			const msgId = this.idService.gen();
			await this.paintChatMessagesRepository.insert({
				id: msgId,
				roomId: ps.roomId,
				participantId: null, // システムメッセージ
				type: 'topic',
				content: topic,
			});

			const message = {
				id: msgId,
				participantId: null,
				type: 'topic' as const,
				content: topic,
				createdAt: new Date().toISOString(),
			};

			// WebSocketでルーム全体に配信
			this.globalEventService.publishPaintChatStream(ps.roomId, 'message', message as any);

			return { message };
		});
	}
}
