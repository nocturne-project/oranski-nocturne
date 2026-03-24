/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatMatchingService } from '@/core/PaintChatMatchingService.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApiError } from '@/server/api/error.js';

// マッチング待機キューに参加する
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		alreadyWaiting: {
			message: 'You are already waiting for a match.',
			code: 'ALREADY_WAITING',
			id: '0e8c48b3-ed42-4e0d-b848-6fc9bcd1221f',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			status: {
				type: 'string',
				optional: false, nullable: false,
				enum: ['waiting', 'matched'],
			},
			roomId: {
				type: 'string',
				optional: true, nullable: true,
				format: 'id',
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private paintChatMatchingService: PaintChatMatchingService,
		private paintChatService: PaintChatService,
		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// キューに参加
			try {
				await this.paintChatMatchingService.joinQueue(me.id);
			} catch (e: any) {
				if (e.message === 'alreadyWaiting') {
					throw new ApiError(meta.errors.alreadyWaiting);
				}
				throw e;
			}

			// マッチングを試行
			const matchedUserId = await this.paintChatMatchingService.tryMatch(me.id);

			if (matchedUserId == null) {
				return { status: 'waiting' as const, roomId: null };
			}

			// マッチング成立: ルーム作成
			const { room, participantA, participantB } = await this.paintChatService.createRoom(me.id, matchedUserId);

			// 両ユーザーにマッチング成立を通知（GlobalEventService経由）
			this.globalEventService.publishMainStream(me.id, 'paintChatMatched' as any, {
				roomId: room.id,
				myParticipantId: participantA.id,
				myAnonymousName: participantA.anonymousName,
				partnerParticipantId: participantB.id,
				partnerAnonymousName: participantB.anonymousName,
			});

			this.globalEventService.publishMainStream(matchedUserId, 'paintChatMatched' as any, {
				roomId: room.id,
				myParticipantId: participantB.id,
				myAnonymousName: participantB.anonymousName,
				partnerParticipantId: participantA.id,
				partnerAnonymousName: participantA.anonymousName,
			});

			return { status: 'matched' as const, roomId: room.id };
		});
	}
}
