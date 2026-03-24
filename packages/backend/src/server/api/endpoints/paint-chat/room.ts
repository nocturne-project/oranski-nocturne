/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { DI } from '@/di-symbols.js';
import type { PaintChatRoomsRepository } from '@/models/_.js';
import { ApiError } from '@/server/api/error.js';

// ルーム情報取得。ラッパーユーザーIDベースで応答する。
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'read:account',

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'c0795cc4-5288-4ad4-a2b5-432b089da4df',
		},
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '7e26a36d-9c0e-48c8-a4a7-33fa83e648b7',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			room: {
				type: 'object',
				optional: false, nullable: false,
			},
			participants: {
				type: 'array',
				optional: false, nullable: false,
			},
			myParticipantId: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
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
		@Inject(DI.paintChatRoomsRepository)
		private paintChatRoomsRepository: PaintChatRoomsRepository,

		private paintChatService: PaintChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// ルーム存在チェック
			const room = await this.paintChatRoomsRepository.findOneBy({ id: ps.roomId });
			if (room == null) throw new ApiError(meta.errors.noSuchRoom);

			// アクセス権限チェック
			const canAccess = await this.paintChatService.canAccessRoom(ps.roomId, me.id);
			if (!canAccess) throw new ApiError(meta.errors.accessDenied);

			// 参加者取得（ラッパーユーザーIDと匿名名のみ。実ユーザーIDは非露出。）
			const participants = await this.paintChatService.getRoomParticipants(ps.roomId);
			const myParticipant = participants.find(p => p.userId === me.id);

			if (myParticipant == null) throw new ApiError(meta.errors.accessDenied);

			return {
				room: {
					id: room.id,
					status: room.status,
					createdAt: room.createdAt.toISOString(),
				},
				participants: participants.map(p => ({
					id: p.id, // ラッパーユーザーID
					anonymousName: p.anonymousName,
				})),
				myParticipantId: myParticipant.id,
			};
		});
	}
}
